// Retired handover plan used only by historical contract/integration tests.
// The dashboard creates split-capable policies during fresh setup.
import { encodeFunctionData, getAddress, keccak256, toHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { TreasuryClient, parseTreasuryConfig } from "../../src/lib/treasury/client.ts";
import type { TreasuryConfig } from "../../src/lib/treasury/client.ts";
import { TreasuryDeployment, deploymentIdentity } from "../../src/lib/treasury/deployment.ts";
import type { Chain, Call, DeploymentArtifacts, DeploymentState, DeploymentTarget } from "../../src/lib/treasury/deployment.ts";
import type { PolicyUpgrade } from "../../src/lib/treasury/upgrade.ts";
import { packSafeCalls } from "../../src/lib/treasury/safeSetup.ts";
import { assertSetupProgress } from "../../src/lib/treasury/setupTransactions.ts";
import profile from "../../src/lib/treasury/shared-network.json" with { type: "json" };
import official from "../../src/lib/treasury/official-safe-deployments.json" with { type: "json" };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** A separate journal and plan reuse the existing wallet/nonce/receipt machinery.
 * The original setup journal and its reviewed bytecode are never rewritten. */
export class TreasuryUpgrade extends TreasuryDeployment {
  readonly previous: TreasuryConfig;
  readonly helpers: Chain[];
  readonly version: 1 | 2;
  constructor(target: DeploymentTarget, artifacts: DeploymentArtifacts, previous: TreasuryConfig, helpers: Chain[] = [], version: 1 | 2 = 1) {
    super(target, artifacts); this.previous = previous; this.helpers = helpers; this.version = version;
  }
  async validateImports(_state: DeploymentState) { await new TreasuryClient(this.previous).validate(); }
  async begin(deployer: Address, setup: DeploymentState | null): Promise<PolicyUpgrade> {
    const c = this.previous, p = c.payments;
    check(p && (this.version === 1 ? !p.l1Initiation && !c.previousPayments : !p.exactSplits) && p.aliasReaderL1, "This treasury does not need this policy upgrade");
    check(!setup?.pending, "Resolve the outstanding setup transaction first");
    await this.validate(); await new TreasuryClient(c).validate();
    const addresses: Record<string, Address> = { safeL1: c.safeL1, safeL2: c.safeL2, adapter: c.adapter,
      moduleL1: p.moduleL1, moduleL2: p.moduleL2, tokenL1: p.tokenL1, tokenL2: p.tokenL2,
      bridgeL1: p.bridgeL1, bridgeL2: p.bridgeL2, aliasReaderL1: p.aliasReaderL1 };
    const helpers: Chain[] = [];
    for (const chain of ["l1", "l2"] as const) {
      const key = chain === "l1" ? "multiSendL1" : "multiSendL2";
      const candidates = [...new Set([...(setup?.addresses[key] ? [setup.addresses[key]!] : []),
        ...official.deployments.filter(item => item.kind === "multiSend").map(item => getAddress(item.address))])];
      for (const address of candidates) {
        const code = await this.rpc<Hex>(chain, "eth_getCode", [address, "latest"]);
        if (this.runtimeMatches(code, "MultiSendCallOnly") || official.deployments.some(item => item.kind === "multiSend"
          && same(item.address, address) && item.codeHash === keccak256(code))) { addresses[key] = address; break; }
      }
      if (!addresses[key]) helpers.push(chain);
    }
    return { version: this.version, previous: c, helpers, state: { version: 2, identity: deploymentIdentity, deployer,
      salt: keccak256(toHex(`${c.instance}:${p.policy}:${this.version === 2 ? "exact-split" : "bidirectional"}`)), reuse: {}, completed: [], addresses, transactions: [] } };
  }
  steps(state: DeploymentState): Call[] {
    const artifact = this.version === 2 ? "SplitTreasuryPolicyUpgrade" : "TreasuryPolicyUpgrade";
    const p = this.previous.payments!, a = (key: string) => state.addresses[key] ?? zeroAddress;
    const steps: Call[] = this.helpers.map(chain => ({ id: chain === "l1" ? "multiSendL1" : "multiSendL2", chain,
      label: `Prepare Safe batching on ${chain === "l1" ? "Chiado" : "EEZ-X"}`, artifact: "MultiSendCallOnly", args: () => [],
      output: chain === "l1" ? "multiSendL1" : "multiSendL2" }));
    steps.push({ id: "upgradePolicy", label: "Deploy the replacement payment policy", chain: "l2", artifact,
      args: () => this.version === 2 ? [p.policy, p.moduleL1, !!p.predecessor] : [p.policy, p.moduleL1], output: "policy" });
    for (const chain of ["l1", "l2"] as const) {
      const onL1 = chain === "l1", suffix = onL1 ? "L1" : "L2", token = onL1 ? p.tokenL1 : p.tokenL2;
      const module = onL1 ? p.moduleL1 : p.moduleL2, delegate = () => a(onL1 ? "alias" : "policy");
      const call = (id: string, label: string, artifact: string, target: () => Address, method: string, args: () => unknown[]): Call => ({ id, label, chain, artifact, target, method, args });
      const batch: Call[] = [
        ...(onL1 ? [call("registerUpgrade", "Connect the replacement policy to Chiado", "Registry", () => this.previous.registry,
          "getOrCreateCrossChainProxy", () => [a("policy"), BigInt(profile.rollupId)])] : []),
        call(`revoke${suffix}`, "Revoke the previous policy's spending allowance", "AllowanceModule", () => module, "setAllowance",
          () => [onL1 ? p.alias : p.policy, token, 0n, 10, 10]),
        call(`delegate${suffix}`, "Authorize the replacement policy", "AllowanceModule", () => module, "addDelegate", () => [delegate()]),
        call(`limit${suffix}`, "Keep the 100 Test USDC limit per ten minutes", "AllowanceModule", () => module, "setAllowance",
          () => [delegate(), token, 100_000_000n, 10, 10]),
        ...(!onL1 ? [call("activateUpgrade", this.version === 2 ? "Carry over spending and activate custom splits" : "Carry over spending and activate payments from either Safe", artifact, () => a("policy"), "activate", () => [])] : []),
      ];
      steps.push({ id: `upgrade${suffix}`, label: onL1 ? "Approve the Chiado handover" : (this.version === 2 ? "Approve EEZ-X and enable custom splits" : "Approve EEZ-X and enable both Safes"), chain,
        artifact: "MultiSendCallOnly", method: "multiSend", target: () => a(`multiSend${suffix}`), safe: () => a(`safe${suffix}`),
        args: () => [packSafeCalls(batch.map(step => ({ to: step.target!(), data: encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method!, args: step.args() }) })))],
        operation: 1, batch, quoted: !onL1 });
    }
    check(state.completed.every((id, index) => steps[index]?.id === id) && state.completed.length <= steps.length, "Saved policy upgrade order changed");
    return steps;
  }
  async reconcile(state: DeploymentState): Promise<DeploymentState> {
    const next = await super.reconcile(state);
    if (next === state) return state;
    if (next.addresses.policy && !next.addresses.alias) next.addresses.alias = await this.policyAlias(next.addresses.policy);
    if (state.pending?.id === "upgradeL1" || state.pending?.id === "upgradeL2") {
      const chain = state.pending.chain, p = this.previous.payments!;
      const tag = next.inclusions![state.pending.hash!]!.blockNumber;
      const old = await this.read<bigint[]>(chain, chain === "l1" ? p.moduleL1 : p.moduleL2, "AllowanceModule", "getTokenAllowance",
        [chain === "l1" ? this.previous.safeL1 : this.previous.safeL2, chain === "l1" ? p.alias : p.policy, chain === "l1" ? p.tokenL1 : p.tokenL2], tag);
      check(old[0] === 0n, "The previous policy's allowance was not revoked");
    }
    if (state.pending?.id === "upgradeL2") {
      const tag = next.inclusions![state.pending.hash!]!.blockNumber;
      check(await this.read<boolean>("l2", next.addresses.policy!, "TreasuryPolicyUpgrade", "active", [], tag), "Policy activation was not confirmed");
    }
    // The additional handover reads must stay bound to the same inclusion too.
    if (state.pending?.hash) {
      const inclusion = next.inclusions![state.pending.hash]!;
      const block = await this.rpc<{ hash: Hex } | null>(state.pending.chain, "eth_getBlockByNumber", [inclusion.blockNumber, false]);
      if (block?.hash !== inclusion.blockHash) return state;
    }
    return next;
  }
  async manifest(state: DeploymentState): Promise<TreasuryConfig> {
    check(!state.pending && state.completed.length === this.steps(state).length, "Complete both Safe approvals first");
    await assertSetupProgress(this, state); await this.validate(); await this.validateImports(state);
    const c = this.previous, p = c.payments!, a = state.addresses;
    const code = [...c.code];
    for (const [chain, address] of [["l1", a.alias!], ["l2", a.policy!]] as const) {
      const bytes = await this.rpc<Hex>(chain, "eth_getCode", [address, "latest"]);
      check(bytes !== "0x" && (chain === "l1" || this.runtimeMatches(bytes, this.version === 2 ? "SplitTreasuryPolicyUpgrade" : "TreasuryPolicyUpgrade")), "Replacement policy code changed");
      code.push({ chain, address, hash: keccak256(bytes) });
    }
    const { invoiceMerchant: _merchant, invoiceControl: _control, ...payments } = p;
    const config = parseTreasuryConfig({ ...c, l1: { ...c.l1, front: this.target.l1.front },
      fees: { ...c.fees, maxTotalWei: this.target.fees.l2, l1MaxTotalWei: this.target.fees.l1 }, code,
      olderPayments: c.previousPayments ? [c.previousPayments, ...(c.olderPayments ?? [])] : undefined,
      previousPayments: p, payments: { ...payments, policy: a.policy, alias: a.alias, predecessor: p.policy, ...(this.version === 2 ? { exactSplits: true } : {}), l1Initiation: true, combinedL2: true, percentageRules: true } });
    await new TreasuryClient(config).validate();
    for (const chain of ["l1", "l2"] as const) {
      const old = await this.read<bigint[]>(chain, chain === "l1" ? p.moduleL1 : p.moduleL2, "AllowanceModule", "getTokenAllowance",
        [chain === "l1" ? c.safeL1 : c.safeL2, chain === "l1" ? p.alias : p.policy, chain === "l1" ? p.tokenL1 : p.tokenL2]);
      check(old[0] === 0n, "The previous policy still has a spending allowance");
    }
    return config;
  }
}
