import { decodeEventLog, encodeDeployData, encodeFunctionData, formatUnits, getAddress, isAddress, keccak256, maxUint256, parseAbi, parseUnits, toHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { TreasuryDeployment, deploymentIdentity, readDeployment } from "./deployment.ts";
import type { Call, DeploymentState, FaucetRequest } from "./deployment.ts";
import { verifySharedInfrastructure } from "./sharedInfrastructure.ts";
import type { SharedInfrastructure } from "./sharedInfrastructure.ts";
import { verifyAssetInfrastructure } from "./assetInfrastructure.ts";
import type { AssetInfrastructure } from "./assetInfrastructure.ts";
import profile from "./shared-network.json" with { type: "json" };

export const networkDeploymentKey = `eez:treasury:network-predeployment:${deploymentIdentity}`;
export function readNetworkDeployment(raw: string | null) {
  const state = readDeployment(raw);
  if (state && (state.version !== 4 || state.shared || state.asset || Object.keys(state.reuse).length || state.review
    || state.completed.some(id => !["networkL1", "networkL2", "networkConnectL1"].includes(id)))) throw new Error("Invalid network predeployment journal; preserve it for recovery");
  return state;
}
/** Operator-only provisioning, with its own journal. No treasury Safe is created
 * or funded here. The one-unit seed creates the wrapped ERC-20 representation.
 */
export class TreasuryNetworkDeployment extends TreasuryDeployment {
  async start(deployer: Address): Promise<DeploymentState> {
    await this.validate();
    if (await this.findSharedInfrastructure()) throw new Error("Shared infrastructure already exists; reuse it");
    const source: DeploymentState = { ...(this.artifacts.build ? { build: this.artifacts.build } : {}), version: 2, identity: deploymentIdentity, deployer: getAddress(deployer), salt: toHex(crypto.getRandomValues(new Uint8Array(32))), reuse: {}, addresses: {}, completed: [], transactions: [] };
    return { ...source, version: 4, grouping: { source: structuredClone(source) } };
  }
  steps(state: DeploymentState): Call[] {
    const a = (key: string): Address => { const value = state.addresses[key]; if (!value) throw new Error(`Missing network deployment: ${key}`); return value; };
    const deploy = (id: string, label: string, chain: "l1" | "l2", artifact: string, args: () => unknown[] = () => []): Call => ({ id, label, chain, artifact, args, output: id });
    const call = (id: string, label: string, chain: "l1" | "l2", artifact: string, target: () => Address, method: string, args: () => unknown[], extra: Partial<Call> = {}): Call => ({ id, label, chain, artifact, target, method, args, ...extra });
    const rollup = BigInt(profile.rollupId);
    const l1 = [deploy("tokenL1", "Deploy the shared Test USDC faucet", "l1", "SharedTestUSDC"),
      deploy("bridgeL1", "Deploy the shared Chiado bridge", "l1", "SharedTreasuryBridge", () => [a("tokenL1"), rollup, getAddress(profile.registry), 0n, a("bootstrapL1")])];
    const l2 = [deploy("bridgeL2", "Deploy the shared EEZ-X bridge", "l2", "SharedTreasuryBridge", () => [a("tokenL1"), rollup, getAddress(profile.manager), rollup, a("bootstrapL2")]),
      call("pairL2", "Connect the EEZ-X bridge", "l2", "SharedTreasuryBridge", () => a("bridgeL2"), "setCanonicalBridgeAddress", () => [a("bridgeL1")]),
      call("sealL2", "Permanently seal the EEZ-X bridge connection", "l2", "SharedTreasuryBridge", () => a("bridgeL2"), "seal", () => [])];
    const connect = [call("pairL1", "Connect the Chiado bridge", "l1", "SharedTreasuryBridge", () => a("bridgeL1"), "setCanonicalBridgeAddress", () => [a("bridgeL2")]),
      call("sealL1", "Permanently seal the Chiado bridge connection", "l1", "SharedTreasuryBridge", () => a("bridgeL1"), "seal", () => []),
      call("approveSeed", "Approve a 0.000001-token bridge seed", "l1", "ERC20", () => a("tokenL1"), "approve", () => [a("bridgeL1"), 1n]),
      call("seedWrapped", "Create the wrapped representation with 0.000001 Test USDC", "l1", "SharedTreasuryBridge", () => a("bridgeL1"), "bridgeTokens", () => [a("tokenL1"), 1n, rollup, state.deployer], { output: "tokenL2", special: "wrapped" }),
      call("registerNetwork", "Publish the shared network binding", "l1", "SharedTestUSDC", () => a("tokenL1"), "registerBridges", () => [a("bridgeL1"), a("bridgeL2")]),
      call("returnTokens", "Send the remaining 449.999999 Test USDC to the deployment wallet", "l1", "ERC20", () => a("tokenL1"), "transfer", () => [state.deployer, 449_999_999n])];
    const group = (id: string, label: string, chain: "l1" | "l2", create: boolean, actions: Call[], finish: boolean): Call => ({ id, label, chain, artifact: "TreasuryBootstrap", args: () => [], group: { create, executor: chain === "l1" ? "bootstrapL1" : "bootstrapL2", actions, finish } });
    const steps = [group("networkL1", "Deploy shared Chiado infrastructure", "l1", true, l1, false),
      group("networkL2", "Deploy and seal the shared EEZ-X bridge", "l2", true, l2, false),
      { ...group("networkConnectL1", "Connect and publish the shared bridge pair", "l1", false, connect, true), quoted: true }];
    if (!state.completed.every((id, i) => steps[i]?.id === id)) throw new Error("Network deployment order changed");
    return steps;
  }
  async binding(state: DeploymentState): Promise<SharedInfrastructure> {
    if (state.pending || state.completed.length !== this.steps(state).length) throw new Error("Finish network predeployment first");
    const { tokenL1, tokenL2, bridgeL1, bridgeL2 } = state.addresses;
    const receipt = await this.rpc<{ logs: { address: Address; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; topics: Hex[] }[] }>("l1", "eth_getTransactionReceipt", [state.transactions[state.transactions.length - 1]]);
    const log = receipt?.logs.find(log => log.address.toLowerCase() === tokenL1!.toLowerCase() && log.topics[0] === keccak256(toHex("TreasuryInfrastructureRegistered(address,address,address)")));
    if (!log) throw new Error("Network registration is unavailable");
    const binding = { tokenL1: tokenL1!, tokenL2: tokenL2!, bridgeL1: bridgeL1!, bridgeL2: bridgeL2!, registration: { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex } };
    await verifySharedInfrastructure(this, binding); return binding;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function parseFaucetAmount(value: string): bigint {
  check(value.length <= 85 && /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value), "Enter a positive amount with up to 6 decimals");
  const amount = parseUnits(value, 6);
  check(amount > 0n && amount <= maxUint256, "Enter a positive ERC-20 amount");
  return amount;
}
export function checkedFaucetRequest(value: FaucetRequest): FaucetRequest {
  check(value && typeof value.amount === "string" && /^[1-9]\d{0,77}$/.test(value.amount)
    && BigInt(value.amount) <= maxUint256, "Invalid faucet amount");
  check(isAddress(value.recipient) && value.recipient !== zeroAddress, "Enter a valid recipient address");
  check(value.destination === "l1" || value.destination === "l2", "Choose Chiado or EEZ-X");
  check(value.faucet === undefined || isAddress(value.faucet) && value.faucet !== zeroAddress, "Invalid saved faucet address");
  return { ...value, recipient: getAddress(value.recipient) };
}

/** The selected request is persisted before sending. Legacy direct/fixed claims
 * retain their exact calldata; new deliveries reuse a dispenser and its reserve.
 */
export class TreasuryFaucetDeployment extends TreasuryDeployment {
  protected async assertProgress(state: DeploymentState) {
    // Claims are independent. Old receipts may be pruned; current dispenser code
    // and bindings are verified by validateImports before each new request.
    // A pending request still blocks prepare and must reconcile its exact receipt.
    this.steps(state);
  }
  selectRequest(state: DeploymentState, asset: AssetInfrastructure, value: FaucetRequest): DeploymentState {
    check(!state.pending, "Wait for the pending faucet request");
    this.steps(state);
    const request = checkedFaucetRequest(value);
    check(request.faucet === undefined, "The faucet address is selected from confirmed history");
    for (const key of ["tokenL1", "tokenL2", "bridgeL1", "bridgeL2"] as const)
      check(!state.addresses[key] || same(state.addresses[key], asset[key]), "Faucet asset bindings changed");
    return { ...state, addresses: { ...state.addresses, tokenL1: asset.tokenL1, tokenL2: asset.tokenL2, bridgeL1: asset.bridgeL1, bridgeL2: asset.bridgeL2 },
      faucetRequests: { ...state.faucetRequests, [state.completed.length]: { ...request,
        ...(state.addresses.faucet ? { faucet: state.addresses.faucet } : {}) } } };
  }
  steps(state: DeploymentState): Call[] {
    check(state.version === 2 && !state.review && !Object.keys(state.reuse).length && state.addresses.tokenL1,
      "Invalid saved faucet request; preserve it for recovery");
    const requests = state.faucetRequests ?? {};
    check(typeof requests === "object" && !Array.isArray(requests), "Invalid saved faucet requests");
    for (const [index, request] of Object.entries(requests)) {
      check(/^(0|[1-9]\d*)$/.test(index) && Number(index) <= state.completed.length, "Invalid saved faucet request index");
      checkedFaucetRequest(request);
      check(Number(index) === state.completed.length || [`faucetRequest_${index}`, `faucetPrepare_${index}`].includes(state.completed[Number(index)]!), "Faucet request history changed");
      check(state.addresses.bridgeL1 && state.addresses.bridgeL2 && state.addresses.tokenL2, "Missing faucet bridge binding");
      if (request.faucet) check(same(request.faucet, state.addresses.faucet ?? ""), "Saved faucet address changed");
    }
    const legacy = (): Call => ({ id: "faucetClaim", label: "Get 450 Test USDC from the faucet", chain: "l1", artifact: "SharedTestUSDC", target: () => state.addresses.tokenL1!, method: "claim", args: () => [] });
    const mint = (index: number): Call => ({ id: `faucetMint_${index}`, label: "Get 450 Test USDC from the faucet", chain: "l1", artifact: "TestUSDCClaim", args: () => [state.addresses.tokenL1!], output: `faucetMint_${index}` });
    const delivery = (index: number): Call => {
      const request = requests[index]; check(request, "Missing saved faucet request");
      const args = [request.recipient, BigInt(request.amount), request.destination === "l2"];
      return request.faucet
        ? { id: `faucetRequest_${index}`, label: `Receive ${formatUnits(BigInt(request.amount), 6)} Test USDC on ${request.destination === "l1" ? "Chiado" : "EEZ-X"}`,
          chain: "l1", artifact: "TestUSDCFaucet", quoted: request.destination === "l2", target: () => request.faucet!, method: "request", args: () => args }
        : { id: `faucetPrepare_${index}`, label: "Prepare the test-token faucet", chain: "l1", artifact: "TestUSDCFaucet",
          args: () => [state.addresses.tokenL1!, state.addresses.bridgeL1!], output: "faucet" };
    };
    const steps = state.completed.map((id, index) => {
      if (id === "faucetClaim" && index === 0) return legacy();
      if (id === `faucetMint_${index}`) return mint(index);
      if ([`faucetRequest_${index}`, `faucetPrepare_${index}`].includes(id)) {
        const step = delivery(index); check(step.id === id, "Faucet request type changed"); return step;
      }
      throw new Error("Invalid saved faucet request; preserve it for recovery");
    });
    if (requests[state.completed.length]) steps.push(delivery(state.completed.length));
    else if (state.pending?.id === "faucetClaim" && !state.completed.length) steps.push(legacy());
    else if (state.pending || !state.faucetRequests) steps.push(mint(state.completed.length));
    if (state.pending) check(state.pending.id === steps[state.completed.length]?.id && state.pending.chain === "l1"
      && same(state.pending.sender, state.deployer), "Pending faucet request changed");
    return steps;
  }
  async validateImports(state: DeploymentState) {
    await super.validateImports(state);
    const code = await this.rpc<Hex>("l1", "eth_getCode", [state.addresses.tokenL1, "safe"]);
    check(this.runtimeMatches(code, "SharedTestUSDC"), "This asset is not the reviewed test faucet");
    if (state.faucetRequests) {
      const a = state.addresses;
      await verifyAssetInfrastructure(this, { tokenL1: a.tokenL1!, tokenL2: a.tokenL2!, bridgeL1: a.bridgeL1!, bridgeL2: a.bridgeL2!, tokenCodeHash: keccak256(code) });
      if (a.faucet) await this.validateDispenser(state, a.faucet);
    }
  }
  private async validateDispenser(state: DeploymentState, address: Address, block: string = "latest") {
    check(this.runtimeMatches(await this.rpc<Hex>("l1", "eth_getCode", [address, block]), "TestUSDCFaucet"), "Faucet dispenser code changed");
    const [token, bridge, rollup] = await Promise.all([
      this.read<Address>("l1", address, "TestUSDCFaucet", "token", [], block),
      this.read<Address>("l1", address, "TestUSDCFaucet", "bridge", [], block),
      this.read<bigint>("l1", address, "TestUSDCFaucet", "destinationRollup", [], block),
    ]);
    check(same(token, state.addresses.tokenL1!) && same(bridge, state.addresses.bridgeL1!) && rollup === BigInt(profile.rollupId), "Faucet dispenser bindings changed");
  }
  async reconcile(state: DeploymentState) {
    const step = this.steps(state)[state.completed.length];
    if (!state.pending) return state;
    check(step, "Missing pending faucet request");
    if (step.artifact === "TestUSDCClaim" || step.artifact === "TestUSDCFaucet") {
      const data = step.method ? encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method, args: step.args() })
        : encodeDeployData({ abi: this.abi(step.artifact), bytecode: this.artifacts.contracts[step.artifact]!.bytecode, args: step.args() });
      check(same(state.pending.to ?? "", step.target?.() ?? "") && same(state.pending.data, data), "Faucet transaction does not match this token's mint request");
    }
    const next = await super.reconcile(state), request = state.faucetRequests?.[state.completed.length];
    if (next === state || !request) return next;
    const hash = state.pending.hash!, inclusion = next.inclusions![hash]!, faucet = request.faucet ?? next.addresses.faucet!;
    await this.validateDispenser(next, faucet, inclusion.blockNumber);
    if (step.output === "faucet") {
      // The fee RPC admits calls, not creation. Persist the original destination
      // across the one-time deployment; the next quoted call performs delivery.
      return { ...next, faucetRequests: { ...next.faucetRequests, [next.completed.length]: { ...request, faucet } } };
    }
    const receipt = await this.rpc<{ blockHash: Hex; logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[] }>("l1", "eth_getTransactionReceipt", [hash]);
    if (receipt?.blockHash !== inclusion.blockHash) return state;
    const deliveries = receipt.logs.filter(log => same(log.address, faucet)).flatMap(log => {
      try { const event = decodeEventLog({ abi: this.abi("TestUSDCFaucet"), ...log }); return event.eventName === "TokensRequested" ? [event.args as unknown as { requester: Address; recipient: Address; onL2: boolean; amount: bigint }] : []; } catch { return []; }
    });
    check(deliveries.length === 1 && same(deliveries[0]!.requester, state.pending.sender) && same(deliveries[0]!.recipient, request.recipient)
      && deliveries[0]!.onL2 === (request.destination === "l2") && deliveries[0]!.amount === BigInt(request.amount), "Missing matching faucet delivery");
    const tokenEvents = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    check(receipt.logs.some(log => {
      if (!same(log.address, state.addresses.tokenL1!)) return false;
      try { const { args } = decodeEventLog({ abi: tokenEvents, ...log }); return same(args.from, faucet)
        && same(args.to, request.destination === "l1" ? request.recipient : state.addresses.bridgeL1!) && args.value === BigInt(request.amount); } catch { return false; }
    }), "Missing exact token delivery or bridge lock");
    // The delivery event follows the synchronous bridge call. Its canonical L1
    // inclusion proves that call returned; independently verify replay in E2E.
    const block = await this.rpc<{ hash: Hex }>("l1", "eth_getBlockByNumber", [inclusion.blockNumber, false]);
    return block?.hash === inclusion.blockHash ? next : state;
  }
}
