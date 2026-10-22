import { appendSourceRequest, retainSourceRequests } from "./sourceVerification.ts";
import type { SourceRequest } from "./sourceVerification.ts";
import { matchesRuntime } from "./runtimeCode.ts";
export { matchesRuntime } from "./runtimeCode.ts";
import { decodeSafeExecution } from "./safeEvents.ts";
import { decodeEventLog, decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, parseAbi, toHex, zeroAddress } from "viem";
import type { Abi, Address, Hex } from "viem";
import profile from "./shared-network.json" with { type: "json" };
import officialSafe from "./official-safe-deployments.json" with { type: "json" };
import { probeComposer } from "../composerDiscovery.ts";
import { quoteCrossChainFees } from "../fees/payment.mjs";
import { TreasuryClient, parseTreasuryConfig } from "./client.ts";
import { paymentState } from "./payments.ts";
import { assertSetupProgress } from "./setupTransactions.ts";
import type { SetupInclusion } from "./setupTransactions.ts";
import type { Approval, TreasuryConfig } from "./client.ts";
import { adoptL1Owners, inspectSafe, matchingSafeCode, ownerFingerprint, packSafeCalls } from "./safeSetup.ts";
import { groupedSteps, materializeGroup, encodeGroup } from "./deploymentGroups.ts";
import type { GroupReceipt } from "./deploymentGroups.ts";
import { discoverSharedInfrastructure, verifySharedInfrastructure, validSharedBinding } from "./sharedInfrastructure.ts";
import type { SharedInfrastructure } from "./sharedInfrastructure.ts";
import { discoverAssetInfrastructure, verifyAssetInfrastructure, validAssetBinding } from "./assetInfrastructure.ts";
import type { AssetInfrastructure } from "./assetInfrastructure.ts";
import type { SafeInspection } from "./safeSetup.ts";
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, packOwnerApprovals, safeTypedDataJSON, safeTransactionHash } from "./safeTransactions.ts";

export type Chain = "l1" | "l2";
export type Artifact = { proxyCreationCode?: Hex; abi: Abi; bytecode: Hex; runtime: Hex; immutables: { start: number; length: number }[]; immutableGroups?: { start: number; length: number }[][] };
export type DeploymentArtifacts = { build?: string; version: number; core: string; safe: string; modules: string; contracts: Record<string, Artifact> };
export type DeploymentTarget = { l1: { rpc: string; front: string }; l2: { rpc: string; front: string }; fees: { l1: string; l2: string } };
export type Call = { id: string; label: string; chain: Chain; artifact: string; args: () => unknown[];
  group?: { create: boolean; executor: string; actions: Call[]; finish: boolean }; batch?: Call[]; operation?: 0 | 1; method?: string; target?: () => Address; safe?: () => Address; quoted?: boolean; migration?: boolean; output?: string; special?: "safe" | "alias" | "wrapped" };
export type DeploymentPending = { group?: GroupReceipt; id: string; chain: Chain; sender: Address; nonce: Hex; data: Hex; to?: Address; hash?: Hex; safeHash?: Hex };
export type SetupReview = { id: string; chain: Chain; safe: Address; to: Address; data: Hex; operation: 0 | 1;
  nonce: string; owners: Address[]; threshold: number; adapter?: Address; fingerprint: string; localFingerprint: string;
  safeHash: Hex; approvals: Approval[] };
export type OfficialBinding = { address: Address; codeHash: Hex };
export type FaucetRequest = { amount: string; recipient: Address; destination: Chain; faucet?: Address };
export type DeploymentState = { build?: string; sourceRequests?: SourceRequest[]; faucetRequests?: Record<string, FaucetRequest>; bidirectional?: true; version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10; fundingSkipped?: { source: DeploymentState }; asset?: { source: DeploymentState; binding: AssetInfrastructure; fundingBase: { l1: string; l2: string } }; shared?: { source: DeploymentState; binding?: SharedInfrastructure; fundingBase: { l1: string; l2: string } }; grouping?: { source: DeploymentState; walletPreparation?: { nonce: string; calls: number } }; identity: Hex; deployer: Address; salt: Hex; reuse: { l1?: SafeInspection; l2?: SafeInspection };
  simplification?: { preserved: number; official: Record<string, OfficialBinding> };
  completed: string[]; addresses: Record<string, Address>; transactions: Hex[]; inclusions?: Record<string, SetupInclusion>; pending?: DeploymentPending; review?: SetupReview };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const quantity = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]+$/i.test(value);
const RECOVERY_BLOCKS = 512n;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
// Preserve the previous fixed-owner journal only for migration. New deployment
// identity is network-only; the connected deployer is chosen in the setup UI.
const { initialOwner: legacyOwner, ...networkProfile } = profile;
const legacyIdentity = keccak256(toHex(JSON.stringify(profile)));
export const deploymentIdentity = keccak256(toHex(JSON.stringify(networkProfile)));
export const sharedDeploymentKey = `eez:treasury:deployment:${deploymentIdentity}`;
export const previousOptionalFundingKey = `${sharedDeploymentKey}:before-skipping-funding`;
export const previousWalletFundingKey = `${sharedDeploymentKey}:before-wallet-funding`;
export const previousSharedInfrastructureKey = `${sharedDeploymentKey}:before-shared-infrastructure`;
export const previousWalletPreparationKey = `${sharedDeploymentKey}:before-wallet-preparation`;
export const previousGroupedDeploymentKey = `${sharedDeploymentKey}:before-deployment-batches`;
export const previousDeploymentKey = `${sharedDeploymentKey}:before-simplification`;
export const sharedManifestKey = `eez:treasury:manifest:${deploymentIdentity}`;
export const legacyDeploymentKey = `eez:treasury:deployment:${legacyIdentity}`;
export const legacyManifestKey = `eez:treasury:manifest:${legacyIdentity}`;
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)", "function transferFrom(address,address,uint256) returns (bool)",
]);
const registryAbi = parseAbi([
  "function getOrCreateCrossChainProxy(address,uint64) returns (address)",
  "function computeCrossChainProxyAddress(address,uint64) view returns (address)",
  "function authorizedProxies(address) view returns (bool,address,uint64)",
]);
export function isSharedTarget(l1Id: string, l2Id: string, registry: string, manager: string) {
  return BigInt(l1Id) === BigInt(profile.chains.l1.chainId) && BigInt(l2Id) === BigInt(profile.chains.l2.chainId)
    && same(registry, profile.registry) && same(manager, profile.manager);
}
export function readDeployment(text: string | null): DeploymentState | null {
  if (!text) return null;
  let state = JSON.parse(text) as DeploymentState;
  if ((state as { version: number }).version === 1) {
    check(state.identity === legacyIdentity, "Unknown legacy deployment; preserve it for recovery");
    if (Array.isArray(state.completed) && state.completed.length === 0 && !state.pending) return null;
    state = { ...state, version: 2, identity: deploymentIdentity, deployer: getAddress(legacyOwner), salt: legacyIdentity, reuse: {} };
  }
  check(state.build === undefined || typeof state.build === "string" && /^[a-f\d]{64}$/.test(state.build), "Invalid deployment source build");
  check(state.bidirectional === undefined || state.bidirectional === true, "Invalid saved policy version");
  check([2, 3, 4, 5, 6, 7, 8, 9, 10].includes(state.version) && state.identity === deploymentIdentity && isAddress(state.deployer) && BigInt(state.deployer) > 1n
    && digest(state.salt) && state.reuse && Array.isArray(state.completed) && state.completed.every(id => typeof id === "string")
    && Array.isArray(state.transactions) && state.transactions.every(digest) && state.addresses
    && Object.values(state.addresses).every(value => isAddress(value)) && state.transactions.length === state.completed.length, "Invalid saved deployment; preserve it for recovery");
  for (const chain of ["l1", "l2"] as const) {
    const imported = state.reuse[chain];
    if (imported) check(isAddress(imported.address) && isAddress(imported.singleton) && digest(imported.proxyHash) && digest(imported.singletonHash)
      && Array.isArray(imported.owners) && imported.owners.every(owner => isAddress(owner))
      && Number.isSafeInteger(imported.threshold) && imported.threshold > 0 && imported.threshold <= imported.owners.length
      && same(state.addresses[chain === "l1" ? "safeL1" : "safeL2"] ?? "", imported.address), "Invalid saved existing Safe");
  }
  if (state.version === 3 || state.version >= 4 && state.simplification) {
    const simplified = state.simplification;
    check(simplified && Number.isSafeInteger(simplified.preserved) && simplified.preserved >= 0
      && simplified.preserved <= state.completed.length && simplified.official, "Invalid simplified deployment");
    for (const [key, binding] of Object.entries(simplified.official))
      check(/^(singleton|factory|multiSend)L[12]$/.test(key) && binding && isAddress(binding.address) && digest(binding.codeHash)
        && same(state.addresses[key] ?? "", binding.address) && officialSafe.deployments.some(item => key.startsWith(item.kind)
          && same(item.address, binding.address) && item.codeHash === binding.codeHash), "Invalid official Safe deployment binding");
  } else check(!state.simplification, "Unexpected simplified deployment data");
  if (state.version >= 4) {
    const source = state.grouping?.source;
    check(source && [2, 3].includes(source.version) && !source.grouping && !source.pending && !source.review, "Invalid grouped deployment source");
    readDeployment(JSON.stringify(source));
    const preparation = state.grouping!.walletPreparation;
    if (preparation) check(/^\d+$/.test(preparation.nonce) && Number.isSafeInteger(preparation.calls)
      && preparation.calls >= 0 && preparation.calls <= 2, "Invalid wallet preparation");
    check(source.bidirectional === state.bidirectional && source.salt === state.salt && same(source.deployer, state.deployer)
      && JSON.stringify(source.reuse) === JSON.stringify(state.reuse) && JSON.stringify(source.simplification) === JSON.stringify(state.simplification)
      && source.completed.every((id, i) => state.completed[i] === id && state.transactions[i] === source.transactions[i])
      && Object.entries(source.addresses).every(([key, value]) => same(state.addresses[key] ?? "", value)), "Grouped deployment replaced confirmed progress");
  } else check(!state.grouping, "Unexpected grouped deployment data");
  if (state.version === 5) {
    const shared = state.shared, source = shared?.source;
    check(shared && source?.version === 4 && !source.shared && !source.pending && !source.review
      && !source.addresses.tokenL1 && !source.addresses.bridgeL1 && !source.addresses.bridgeL2, "Invalid shared infrastructure migration");
    readDeployment(JSON.stringify(source));
    check(source.bidirectional === state.bidirectional && source.salt === state.salt && same(source.deployer, state.deployer)
      && JSON.stringify(source.reuse) === JSON.stringify(state.reuse) && JSON.stringify(source.grouping?.source) === JSON.stringify(state.grouping?.source)
      && source.completed.every((id, i) => state.completed[i] === id && state.transactions[i] === source.transactions[i])
      && Object.entries(source.addresses).every(([key, value]) => same(state.addresses[key] ?? "", value)), "Shared infrastructure replaced confirmed progress");
    check(shared.fundingBase && [shared.fundingBase.l1, shared.fundingBase.l2].every(value => /^\d+$/.test(value)), "Invalid shared funding baseline");
    if (shared.binding) check(validSharedBinding(shared.binding)
      && (["tokenL1", "tokenL2", "bridgeL1", "bridgeL2"] as const).every(key => same(state.addresses[key] ?? "", shared.binding![key])), "Invalid reused shared infrastructure binding");
  } else check(!state.shared, "Unexpected shared infrastructure data");
  if (state.version >= 6) {
    const asset = state.asset, source = asset?.source;
    check(asset && source && [4, 5].includes(source.version) && !source.asset && !source.pending && !source.review
      && !source.completed.includes("contractsBatchL1") && !source.addresses.bootstrapL1
      && (!source.addresses.tokenL1 || source.shared?.binding), "Invalid wallet funding migration");
    readDeployment(JSON.stringify(source));
    check(source.bidirectional === state.bidirectional && source.salt === state.salt && same(source.deployer, state.deployer)
      && JSON.stringify(source.reuse) === JSON.stringify(state.reuse) && JSON.stringify(source.grouping?.source) === JSON.stringify(state.grouping?.source)
      && source.completed.every((id, i) => state.completed[i] === id && state.transactions[i] === source.transactions[i])
      && Object.entries(source.addresses).every(([key, value]) => same(state.addresses[key] ?? "", value)), "Wallet funding replaced confirmed progress");
    check(validAssetBinding(asset.binding) && (["tokenL1", "tokenL2", "bridgeL1", "bridgeL2"] as const)
      .every(key => same(state.addresses[key] ?? "", asset.binding[key])), "Invalid predeployed asset binding");
    check(asset.fundingBase && [asset.fundingBase.l1, asset.fundingBase.l2].every(value => /^\d+$/.test(value)), "Invalid wallet funding baseline");
  } else check(!state.asset, "Unexpected wallet funding data");
  if (state.version >= 7) {
    const source = state.fundingSkipped?.source;
    check(source?.version === 6 && !source.fundingSkipped && !source.pending && !source.review
      && !source.completed.some(id => ["fundingBatchL1", "budgetBatchL2", "configureL1"].includes(id))
      && (state.version >= 8 || source.completed.includes("contractsBatchL2") && !source.completed.includes("approveFunding")),
    "Invalid setup without funding");
    readDeployment(JSON.stringify(source));
    check(source.bidirectional === state.bidirectional && source.salt === state.salt && same(source.deployer, state.deployer)
      && JSON.stringify(source.reuse) === JSON.stringify(state.reuse) && JSON.stringify(source.grouping) === JSON.stringify(state.grouping)
      && JSON.stringify(source.asset) === JSON.stringify(state.asset)
      && source.completed.every((id, i) => state.completed[i] === id && state.transactions[i] === source.transactions[i])
      && Object.entries(source.addresses).every(([key, value]) => same(state.addresses[key] ?? "", value)),
    "Skipping funding replaced confirmed progress");
  } else check(!state.fundingSkipped, "Unexpected skipped funding decision");
  if (state.inclusions !== undefined) check(state.inclusions && typeof state.inclusions === "object" && !Array.isArray(state.inclusions)
    && Object.entries(state.inclusions).every(([hash, inclusion]) => state.transactions.includes(hash as Hex)
      && inclusion && quantity(inclusion.blockNumber) && digest(inclusion.blockHash)), "Invalid setup inclusion record");
  const pending = state.pending;
  if (pending) check(typeof pending.id === "string" && ["l1", "l2"].includes(pending.chain) && isAddress(pending.sender)
    && /^0x[\da-f]+$/i.test(pending.nonce) && /^0x(?:[\da-f]{2})+$/i.test(pending.data) && (!pending.to || isAddress(pending.to))
    && (!pending.hash || digest(pending.hash)) && (!pending.safeHash || digest(pending.safeHash)), "Invalid pending deployment transaction");
  if (pending?.group) {
    const group = pending.group;
    check(state.version >= 4 && isAddress(group.executor) && typeof group.create === "boolean" && typeof group.finish === "boolean"
      && /^\d+$/.test(group.sequence) && digest(group.actionsHash) && Array.isArray(group.outputs) && group.outputs.length <= 32
      && group.outputs.every(output => typeof output.key === "string" && isAddress(output.address) && typeof output.artifact === "string"
        && Number.isSafeInteger(output.index) && output.index >= 0 && (!output.initHash || digest(output.initHash))
        && (!output.factory || isAddress(output.factory)) && (!output.singleton || isAddress(output.singleton))), "Invalid pending deployment batch");
  }
  if (state.review) check(digest(state.review.safeHash) && Array.isArray(state.review.approvals)
    && safeTransactionHash(reviewTransaction(state.review)) === state.review.safeHash, "Invalid saved setup approvals");
  return state;
}
export function loadDeployment(storage: Pick<Storage, "getItem">) {
  return readDeployment(storage.getItem(sharedDeploymentKey) ?? storage.getItem(legacyDeploymentKey));
}
/** Called under the UI's Web Lock. Archive before replacing an active old plan;
 * a storage failure leaves that plan available and never opens the wallet.
 */
export function saveDeployment(storage: Pick<Storage, "getItem" | "setItem">, next: DeploymentState) {
  const raw = storage.getItem(sharedDeploymentKey) ?? storage.getItem(legacyDeploymentKey);
  const before = readDeployment(raw);
  check(!before || before.build === next.build, "Keep this setup’s original source build");
  check(!before || before.bidirectional === next.bidirectional && before.salt === next.salt, "This treasury setup changed in another tab. Reload before continuing");
  check(!before || before.version < 7 || next.version === before.version, "Keep the setup without funding; restoring the old plan would reinstate token transfers");
  if (next.version >= 7) readDeployment(JSON.stringify(next));
  if (before?.version === 6 && next.version >= 7) {
    check(JSON.stringify(next.fundingSkipped?.source) === JSON.stringify(before), "Setup changed before funding was skipped");
    const backup = `${previousOptionalFundingKey}:${before.salt}`;
    if (!storage.getItem(backup)) storage.setItem(backup, raw!);
  }
  if (before && (before.version === 2 && next.version === 3 || before.version < 4 && next.version >= 4 || before.version === 4 && next.version === 5 || before.version < 6 && next.version === 6 || before.version >= 4 && !before.grouping?.walletPreparation && !!next.grouping?.walletPreparation)) {
    check(before.salt === next.salt && same(before.deployer, next.deployer)
      && JSON.stringify(before.completed) === JSON.stringify(next.completed)
      && JSON.stringify(before.transactions) === JSON.stringify(next.transactions)
      && Object.entries(before.addresses).every(([key, address]) => same(next.addresses[key] ?? "", address)), "Simplification cannot replace confirmed deployment progress");
    const backup = `${next.version === 6 ? previousWalletFundingKey : next.version === 5 && before.version === 4 ? previousSharedInfrastructureKey : before.version >= 4 ? previousWalletPreparationKey : next.version >= 4 ? previousGroupedDeploymentKey : previousDeploymentKey}:${before.salt}`;
    if (!storage.getItem(backup)) storage.setItem(backup, raw!);
  }
  retainSourceRequests(storage, next.sourceRequests);
  storage.setItem(sharedDeploymentKey, JSON.stringify(next));
}
function reviewTransaction(review: SetupReview) {
  return buildSafeTransaction({ chainId: BigInt(profile.chains[review.chain].chainId), safe: review.safe,
    to: review.to, data: review.data, operation: review.operation, nonce: BigInt(review.nonce) });
}

/** Wallet-only deployer. Each click prepares one named transaction; a recorded
 * pending request blocks the next step until its exact canonical receipt resolves.
 * No private keys, unlocked RPC accounts, or automatic retries are used.
 */
export class TreasuryDeployment {
  readonly target: DeploymentTarget;
  readonly artifacts: DeploymentArtifacts;
  private recoveryLookup?: { key: string; hash?: Hex };
  constructor(target: DeploymentTarget, artifacts: DeploymentArtifacts) {
    this.target = target; this.artifacts = artifacts;
    check(artifacts.version === 1 && artifacts.core === "855fe0602484750861b4c31502a1a91355d33ed6"
      && artifacts.safe === "bf943f80fec5ac647159d26161446ac5d716a294"
      && artifacts.modules === "c95f03900bff99be090dadb9de1c74b162365485", "Unexpected treasury deployment artifacts");
  }
  async rpc<T>(chain: Chain, method: string, params: unknown[] = [], front = false): Promise<T> {
    const response = await fetch(front ? this.target[chain].front : this.target[chain].rpc, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    check(response.ok, `Deployment RPC HTTP ${response.status}`);
    const body = await response.json(); if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  abi(name: string) { return name === "ERC20" ? erc20Abi : name === "Registry" ? registryAbi : this.artifacts.contracts[name]!.abi; }
  async read<T>(chain: Chain, address: Address, artifact: string, method: string, args: unknown[] = [], tag = "latest"): Promise<T> {
    const abi = this.abi(artifact);
    const data = await this.rpc<Hex>(chain, "eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName: method, args }) }, tag]);
    return decodeFunctionResult({ abi, functionName: method, data }) as T;
  }
  async validate() {
    for (const chain of ["l1", "l2"] as const) {
      const p = profile.chains[chain];
      const [id, reference, slot, implementationCode, proxyCode] = await Promise.all([
        this.rpc<Hex>(chain, "eth_chainId"), this.rpc<{ hash: Hex }>(chain, "eth_getBlockByNumber", [p.checkpoint.number, false]),
        this.rpc<Hex>(chain, "eth_getStorageAt", [p.protocol.proxy, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]),
        this.rpc<Hex>(chain, "eth_getCode", [p.protocol.implementation, "latest"]),
        this.rpc<Hex>(chain, "eth_getCode", [p.protocol.proxy, "latest"]),
      ]);
      check(BigInt(id) === BigInt(p.chainId) && reference && same(reference.hash, p.checkpoint.hash)
        && same(`0x${slot.slice(-40)}`, p.protocol.implementation) && keccak256(implementationCode) === p.protocol.implementationCodeHash
        && keccak256(proxyCode) === p.protocol.proxyCodeHash,
      "The dashboard network or protocol deployment changed; refresh the preflight before deploying");
    }
  }
  runtimeMatches(code: Hex, name: string) { return matchesRuntime(code, this.artifacts.contracts[name]!); }
  async wallet(provider: EthereumProvider, chain: Chain, expected?: Address) {
    const [accounts, id] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    const sender = (accounts as string[])[0];
    check(sender && isAddress(sender) && (!expected || same(sender, expected)), expected ? "Reconnect the deployment wallet selected for this setup" : "Connect a wallet");
    check(BigInt(id as string) === BigInt(profile.chains[chain].chainId), `Switch to ${chain === "l1" ? "Chiado" : "EEZ-X"}`);
    const result = await probeComposer(provider, { l1ChainId: toHex(profile.chains.l1.chainId), l2ChainId: toHex(profile.chains.l2.chainId), registryAddress: profile.registry, l2Address: profile.manager });
    check(result.status === "detected", result.detail);
    return getAddress(sender);
  }
  async configure(deployer: Address, existingL1?: Address, existingL2?: Address): Promise<DeploymentState> {
    check(isAddress(deployer) && BigInt(deployer) > 1n, "Connect the wallet that will deploy the treasury");
    check(existingL1 && isAddress(existingL1), "Enter an existing Chiado Safe address");
    await this.validate();
    const reuse: DeploymentState["reuse"] = {};
    const addresses: Record<string, Address> = {};
    for (const [chain, address] of [["l1", existingL1], ["l2", existingL2]] as const) if (address) {
      check(isAddress(address), `Enter a valid ${chain.toUpperCase()} Safe address`);
      const inspection = await inspectSafe(this, chain, address);
      reuse[chain] = inspection;
      addresses[chain === "l1" ? "safeL1" : "safeL2"] = inspection.address;
      addresses[chain === "l1" ? "singletonL1" : "singletonL2"] = inspection.singleton;
    }
    if (reuse.l2?.adapter) {
      check(existingL1 && same(reuse.l2.adapter.safeL1, existingL1) && same(reuse.l2.adapter.manager, profile.manager),
        "This EEZ-X Safe already follows another L1 Safe. Select its matching L1 Safe");
      addresses.adapter = reuse.l2.adapter.address;
    }
    return this.simplify({ ...(this.artifacts.build ? { build: this.artifacts.build } : {}), version: 2, bidirectional: true, identity: deploymentIdentity, deployer: getAddress(deployer), salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
      reuse, addresses, completed: [], transactions: [] });
  }
  /** Preserve every confirmed step. An outstanding request/review keeps its old
   * plan until it is reconciled, so neither its calldata nor its signatures change.
   */
  async simplify(state: DeploymentState): Promise<DeploymentState> {
    const original = this.steps(state);
    if (state.version >= 3 || state.pending || state.review || state.completed.length === original.length) return state;
    await this.validate(); await this.validateImports(state);
    const addresses = { ...state.addresses }, official: Record<string, OfficialBinding> = {};
    for (const chain of ["l1", "l2"] as const) {
      const block = await this.rpc<{ number: Hex; hash: Hex }>(chain, "eth_getBlockByNumber", ["latest", false]);
      check(block, "Canonical infrastructure state is unavailable");
      for (const kind of ["singleton", "factory", "multiSend"] as const) {
        const key = `${kind}${chain === "l1" ? "L1" : "L2"}`;
        if (addresses[key] || kind !== "multiSend" && state.reuse[chain]) continue;
        for (const item of officialSafe.deployments.filter(item => item.kind === kind)) {
          const code = await this.rpc<Hex>(chain, "eth_getCode", [item.address, block.number]);
          if (code === "0x") continue;
          check(keccak256(code) === item.codeHash, "Official Safe address has unexpected bytecode; setup was not changed");
          addresses[key] = getAddress(item.address); official[key] = { address: addresses[key]!, codeHash: item.codeHash as Hex }; break;
        }
      }
      const again = await this.rpc<{ hash: Hex }>(chain, "eth_getBlockByNumber", [block.number, false]);
      check(again?.hash === block.hash, "Infrastructure changed during review; try again");
    }
    const next: DeploymentState = { ...state, version: 3, addresses, simplification: { preserved: state.completed.length, official } };
    if (addresses.policy && !addresses.alias) addresses.alias = await this.policyAlias(addresses.policy);
    this.steps(next); return next;
  }
  /** Upgrade only before the old wallet-owned test token exists. That asset's
   * ownership cannot be moved into an executor without a separate approval.
   * Outstanding requests/reviews and later legacy setups keep their exact plan.
   */
  async group(state: DeploymentState): Promise<DeploymentState> {
    const plan = this.steps(state);
    if (state.version >= 4 || state.pending || state.review || state.completed.length === plan.length
      || state.addresses.tokenL1) return state;
    await this.validate(); await this.validateImports(state);
    const source = structuredClone(state);
    const next: DeploymentState = { ...state, version: 4, addresses: { ...state.addresses }, grouping: { source } };
    this.steps(next); return next;
  }
  /** Adopt shared funding before any private asset exists. Outstanding wallet
   * requests and signatures retain their exact plan and can be reconciled first.
   */
  findSharedInfrastructure() { return discoverSharedInfrastructure(this); }
  async share(state: DeploymentState): Promise<DeploymentState> {
    if (![4, 5].includes(state.version) || state.shared?.binding || state.pending || state.review || state.addresses.tokenL1 || state.addresses.bridgeL1 || state.addresses.bridgeL2
      || state.completed.length === this.steps(state).length) return state;
    await this.validate(); await this.validateImports(state);
    const binding = await this.findSharedInfrastructure();
    if (state.version === 5 && !binding) return state;
    const fundingBase = { l1: "0", l2: "0" };
    if (binding) for (const chain of ["l1", "l2"] as const) {
      const suffix = chain === "l1" ? "L1" : "L2", safe = state.addresses[`safe${suffix}`];
      if (safe) fundingBase[chain] = String(await this.read<bigint>(chain, binding[`token${suffix}`], "SharedTestUSDC", "balanceOf", [safe], "latest"));
    }
    const next: DeploymentState = { ...state, version: 5, addresses: { ...state.addresses,
      ...(binding ? { tokenL1: binding.tokenL1, tokenL2: binding.tokenL2, bridgeL1: binding.bridgeL1, bridgeL2: binding.bridgeL2 } : {}) },
      shared: { source: state.shared?.source ?? structuredClone(state), ...(binding ? { binding } : {}), fundingBase } };
    this.steps(next); return next;
  }
  findAssetInfrastructure() { return discoverAssetInfrastructure(this); }
  /** Migrate only before tokens have entered the original executor. A pending
   * request is immutable even when it belongs to the older faucet-based plan.
   */
  async useExistingAsset(state: DeploymentState): Promise<DeploymentState> {
    if (![4, 5].includes(state.version) || state.pending || state.review || state.addresses.bootstrapL1
      || state.completed.includes("contractsBatchL1") || state.addresses.tokenL1 && !state.shared?.binding
      || state.completed.length === this.steps(state).length) return state;
    await this.validate(); await this.validateImports(state);
    const binding = await this.findAssetInfrastructure();
    check(binding, "Shared token and bridges are not ready. Complete network predeployment before treasury setup.");
    if (state.shared?.binding) check((["tokenL1", "tokenL2", "bridgeL1", "bridgeL2"] as const)
      .every(key => same(state.shared!.binding![key], binding[key])), "Keep the existing asset binding; network configuration changed");
    const fundingBase = { l1: "0", l2: "0" };
    for (const chain of ["l1", "l2"] as const) {
      const suffix = chain === "l1" ? "L1" : "L2", safe = state.addresses[`safe${suffix}`];
      if (safe) fundingBase[chain] = String(await this.read<bigint>(chain, binding[`token${suffix}`], "ERC20", "balanceOf", [safe], "latest"));
    }
    const next: DeploymentState = { ...state, version: 6, shared: undefined, addresses: { ...state.addresses,
      tokenL1: binding.tokenL1, tokenL2: binding.tokenL2, bridgeL1: binding.bridgeL1, bridgeL2: binding.bridgeL2 },
      asset: { source: structuredClone(state), binding, fundingBase } };
    this.steps(next); return next;
  }
  /** Remove unsubmitted funding work, retaining any confirmed approval in the
   * history. Never reinterpret a pending request or signed review. Version 8
   * makes older clients reject this plan instead of reinstating transfers.
   */
  withoutFunding(state: DeploymentState): DeploymentState {
    if (state.version !== 6 || !state.asset || state.pending || state.review || state.completed.includes("fundingBatchL1")) return state;
    this.steps(state);
    const next: DeploymentState = { ...state, version: state.build ? 10 : state.completed.length === 0 && state.bidirectional ? 9 : 8, fundingSkipped: { source: structuredClone(state) } };
    readDeployment(JSON.stringify(next)); this.steps(next);
    return next;
  }
  async fundingStatus(state: DeploymentState) {
    check(state.asset, "Wallet funding is not part of this saved setup");
    const balance = await this.read<bigint>("l1", state.asset.binding.tokenL1, "ERC20", "balanceOf", [state.deployer], "latest");
    const allowance = state.addresses.bootstrapL1 ? await this.read<bigint>("l1", state.asset.binding.tokenL1, "ERC20", "allowance", [state.deployer, state.addresses.bootstrapL1], "latest") : 0n;
    return { balance, allowance, amount: 450_000_000n };
  }
  /** Some shared genesis contracts occupy CREATE addresses without advancing
   * that wallet's nonce. Use required local proxy calls for up to two such nonces;
   * never alter the wallet nonce or protocol state through an operator RPC.
   */
  async prepareWallet(state: DeploymentState): Promise<DeploymentState> {
    if (state.version < 4 || state.grouping!.walletPreparation || state.pending || state.review) return state;
    let nonce = 0n, calls = 0;
    if (!state.completed.includes("contractsBatchL2")) {
      nonce = BigInt(await this.rpc<Hex>("l2", "eth_getTransactionCount", [state.deployer, "pending"]));
      while (calls <= 2) {
        const address = getContractAddress({ from: state.deployer, nonce: nonce + BigInt(calls) });
        const code = await this.rpc<Hex>("l2", "eth_getCode", [address, "latest"]);
        const accountNonce = await this.rpc<Hex>("l2", "eth_getTransactionCount", [address, "latest"]);
        if (code === "0x" && BigInt(accountNonce) === 0n) break;
        calls++;
      }
      check(calls <= 2, "More than two upcoming deployment addresses are occupied. Preserve this setup for review");
    }
    const next: DeploymentState = { ...state, grouping: { ...state.grouping!, walletPreparation: { nonce: nonce.toString(), calls } } };
    this.steps(next); return next;
  }
  async policyAlias(policy: Address) {
    return getAddress(await this.read<Address>("l1", getAddress(profile.registry), "Registry", "computeCrossChainProxyAddress", [policy, BigInt(profile.rollupId)], "latest"));
  }
  async validateImports(state: DeploymentState) {
    if (state.asset) await verifyAssetInfrastructure(this, state.asset.binding);
    if (state.shared?.binding) await verifySharedInfrastructure(this, state.shared.binding);
    for (const [key, binding] of Object.entries(state.simplification?.official ?? {})) {
      check(same(state.addresses[key] ?? "", binding.address) && officialSafe.deployments.some(item => key.startsWith(item.kind)
        && same(item.address, binding.address) && item.codeHash === binding.codeHash), "Invalid official Safe deployment binding");
      const code = await this.rpc<Hex>(key.endsWith("L1") ? "l1" : "l2", "eth_getCode", [binding.address, "latest"]);
      check(keccak256(code) === binding.codeHash, "Reused Safe infrastructure changed; preserve the setup for review");
    }
    for (const chain of ["l1", "l2"] as const) {
      const imported = state.reuse[chain]; if (!imported) continue;
      const [proxy, slot, implementation] = await Promise.all([
        this.rpc<Hex>(chain, "eth_getCode", [imported.address, "latest"]),
        this.rpc<Hex>(chain, "eth_getStorageAt", [imported.address, "0x0", "latest"]),
        this.rpc<Hex>(chain, "eth_getCode", [imported.singleton, "latest"]),
      ]);
      check(keccak256(proxy) === imported.proxyHash && same(`0x${slot.slice(-40)}`, imported.singleton)
        && keccak256(implementation) === imported.singletonHash, "An existing Safe implementation changed; preserve this setup for review");
    }
  }
  steps(state: DeploymentState): Call[] {
    check(!state.build || state.build === this.artifacts.build, "Restore the original deployment source build before continuing");
    if (state.version >= 4) {
      const result = groupedSteps(this, state);
      check(state.completed.every((id, index) => result[index]?.id === id) && state.completed.length <= result.length, "Saved grouped deployment order does not match this build");
      return result;
    }
    const a = (name: string) => { const result = state.addresses[name]; check(result, `Missing completed deployment: ${name}`); return result; };
    const deploy = (id: string, label: string, chain: Chain, artifact: string, args: () => unknown[] = () => []): Call => ({ id, label, chain, artifact, args, output: id });
    const call = (id: string, label: string, chain: Chain, artifact: string, target: () => Address, method: string, args: () => unknown[], more: Partial<Call> = {}): Call => ({ id, label, chain, artifact, target, method, args, ...more });
    const initializer = (owner: Address) => encodeFunctionData({ abi: this.abi("Safe"), functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
    const registry = () => getAddress(profile.registry), manager = () => getAddress(profile.manager), rollup = BigInt(profile.rollupId);
    const plan: Call[] = [
      ...(!state.reuse.l1 ? [
      deploy("singletonL1", "Deploy Safe 1.4.1 on Chiado", "l1", "Safe"),
      deploy("factoryL1", "Deploy the Safe factory on Chiado", "l1", "SafeProxyFactory"),
      call("safeL1", "Create the 1-of-1 L1 Safe owned by your deployment wallet", "l1", "SafeProxyFactory", () => a("factoryL1"), "createProxyWithNonce", () => [a("singletonL1"), initializer(state.deployer), BigInt(state.salt)], { output: "safeL1", special: "safe" }),
      ] : []),
      ...(!state.reuse.l2 ? [
      deploy("singletonL2", "Deploy Safe 1.4.1 on EEZ-X", "l2", "Safe"),
      deploy("factoryL2", "Deploy the Safe factory on EEZ-X", "l2", "SafeProxyFactory"),
      ] : []),
      call("safeProxy", "Provision the L1 Safe's EEZ-X proxy", "l2", "Registry", manager, "getOrCreateCrossChainProxy", () => [a("safeL1"), 0n]),
      ...(!state.reuse.l2?.adapter ? [deploy("adapter", "Deploy live L1 owner verification", "l2", "L1Owners", () => [manager(), a("safeL1")])] : []),
      call("adapterAlias", "Provision owner verification's L1 alias", "l1", "Registry", registry, "getOrCreateCrossChainProxy", () => [a("adapter"), rollup]),
      ...(!state.reuse.l2 ? [call("safeL2", "Deploy the EEZ-X mirror Safe", "l2", "SafeProxyFactory", () => a("factoryL2"), "createProxyWithNonce", () => [a("singletonL2"), initializer(a("adapter")), BigInt(state.salt)], { output: "safeL2", special: "safe" })] : state.reuse.l2.adapter ? [] : [
        deploy("multiSendL2", "Deploy Safe's call-only batch helper", "l2", "MultiSendCallOnly"),
        call("adoptL2", "Use the L1 owners for this existing EEZ-X Safe", "l2", "MultiSendCallOnly", () => a("multiSendL2"), "multiSend", () => [], { safe: () => a("safeL2"), migration: true }),
      ]),
      deploy("action", "Deploy the owner-verification example", "l2", "TreasuryOwnerAction", () => [a("safeL2")]),
      deploy("tokenL1", "Deploy 450 Test USDC for this treasury", "l1", "DevnetUSDC"),
      deploy("aliasReaderL1", "Deploy the L1 alias lookup helper", "l1", "TreasuryAliasReader", () => [registry()]),
      deploy("invoiceMerchant", "Deploy the optional invoice merchant", "l1", "InvoiceMerchant", () => [a("tokenL1")]),
      deploy("bridgeL1", "Deploy and initialize the treasury's Chiado bridge", "l1", "ConfiguredTreasuryBridge", () => [a("tokenL1"), rollup, registry(), 0n, state.deployer]),
      deploy("bridgeL2", "Deploy and initialize the treasury's EEZ-X bridge", "l2", "ConfiguredTreasuryBridge", () => [a("tokenL1"), rollup, manager(), rollup, state.deployer]),
      call("pairL1", "Bind the Chiado bridge to its EEZ-X counterpart", "l1", "ConfiguredTreasuryBridge", () => a("bridgeL1"), "setCanonicalBridgeAddress", () => [a("bridgeL2")]),
      call("pairL2", "Bind the EEZ-X bridge to its Chiado counterpart", "l2", "ConfiguredTreasuryBridge", () => a("bridgeL2"), "setCanonicalBridgeAddress", () => [a("bridgeL1")]),
      call("fundL1", "Fund the L1 Safe with 300 Test USDC", "l1", "DevnetUSDC", () => a("tokenL1"), "transfer", () => [a("safeL1"), 300_000_000n]),
      call("approveBridge", "Approve exactly 150 Test USDC for bridging", "l1", "DevnetUSDC", () => a("tokenL1"), "approve", () => [a("bridgeL1"), 150_000_000n]),
      call("fundL2", "Bridge 150 Test USDC into the EEZ-X Safe", "l1", "ConfiguredTreasuryBridge", () => a("bridgeL1"), "bridgeTokens", () => [a("tokenL1"), 150_000_000n, rollup, a("safeL2")], { quoted: true, output: "tokenL2", special: "wrapped" }),
      deploy("moduleL1", "Deploy the official L1 spending-limit module", "l1", "AllowanceModule"),
      deploy("moduleL2", "Deploy the official EEZ-X spending-limit module", "l2", "AllowanceModule"),
      deploy("policy", "Deploy the shared 150 Test USDC budget", "l2", state.bidirectional ? "BidirectionalTreasuryPolicy" : "TreasuryPolicy", () => [a("safeL1"), a("safeL2"), manager(), a("aliasReaderL1"), a("moduleL1"), a("moduleL2"), a("tokenL1"), a("bridgeL2"), state.version === 3 && !state.addresses.invoiceMerchant ? zeroAddress : a("invoiceMerchant")]),
      call("alias", "Provision the policy's L1 spending delegate", "l1", "Registry", registry, "getOrCreateCrossChainProxy", () => [a("policy"), rollup], { output: "alias", special: "alias" }),
      call("merchantPolicy", "Bind the merchant to this policy", "l1", "InvoiceMerchant", () => a("invoiceMerchant"), "bindPolicy", () => [a("alias")]),
    ];
    for (const chain of ["l1", "l2"] as const) {
      const suffix = chain === "l1" ? "L1" : "L2", safe = () => a(`safe${suffix}`), module = () => a(`module${suffix}`);
      const delegate = () => a(chain === "l1" ? "alias" : "policy");
      const options = { safe, quoted: chain === "l2" };
      plan.push(call(`enable${suffix}`, `Enable the official ${suffix} allowance module`, chain, "Safe", safe, "enableModule", () => [module()], options),
        call(`delegate${suffix}`, `Set the ${suffix} policy spending delegate`, chain, "AllowanceModule", module, "addDelegate", () => [delegate()], options),
        call(`limit${suffix}`, `Set the ${suffix} ceiling to 100 per ten minutes`, chain, "AllowanceModule", module, "setAllowance", () => [delegate(), a(`token${suffix}`), 100_000_000n, 10, 10], options));
    }
    let result = plan;
    if (state.version === 3) {
      check(state.simplification && Number.isSafeInteger(state.simplification.preserved) && state.simplification.preserved >= 0
        && state.simplification.preserved <= state.completed.length && state.simplification.preserved <= plan.length, "Invalid simplified deployment prefix");
      const prefix = plan.slice(0, state.simplification.preserved), retained = new Set(prefix.map(step => step.id));
      const remaining = plan.slice(prefix.length);
      const invoice = retained.has("invoiceMerchant");
      result = [...prefix, ...remaining.filter(step => !state.simplification!.official[step.id]
        && step.id !== "action" && (invoice || !["invoiceMerchant", "merchantPolicy", "alias"].includes(step.id))
        && !/^(enable|delegate|limit)L[12]$/.test(step.id))];
      for (const chain of ["l1", "l2"] as const) {
        const suffix = chain === "l1" ? "L1" : "L2", helper = `multiSend${suffix}`;
        const batch = remaining.filter(step => step.id.endsWith(suffix) && /^(enable|delegate|limit)L[12]$/.test(step.id));
        if (chain === "l1" && !invoice && !retained.has("alias")) batch.unshift(plan.find(step => step.id === "alias")!);
        if (!batch.length) continue;
        // A late migration with one call left needs no extra helper deployment.
        // Keep a previously submitted/reviewed version-3 batch exactly resumable.
        const configuration = `configure${suffix}`;
        const batchStarted = state.completed.includes(helper) || state.completed.includes(configuration)
          || [helper, configuration].includes(state.pending?.id ?? "") || state.review?.id === configuration;
        if (batch.length === 1 && !batchStarted) { result.push(batch[0]!); continue; }
        if (!result.some(step => step.id === helper) && !state.simplification.official[helper])
          result.push(deploy(helper, `Deploy Safe's call-only batch helper on ${chain === "l1" ? "Chiado" : "EEZ-X"}`, chain, "MultiSendCallOnly"));
        result.push(call(`configure${suffix}`, `Configure ${chain === "l1" ? "Chiado" : "EEZ-X"} spending: 100 Test USDC per ten minutes`, chain,
          "MultiSendCallOnly", () => a(helper), "multiSend", () => [packSafeCalls(batch.map(step => ({ to: step.target!(),
            data: encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method!, args: step.args() }) })))],
          { safe: () => a(`safe${suffix}`), operation: 1, batch, quoted: chain === "l2" }));
      }
    }
    check(state.completed.every((id, index) => result[index]?.id === id) && state.completed.length <= result.length, "Saved deployment order does not match this build");
    return result;
  }
  async reviewStep(state: DeploymentState): Promise<SetupReview> {
    check(!state.pending, "Resolve the pending deployment before reviewing another step");
    await this.assertProgress(state);
    await this.validate(); await this.validateImports(state);
    let step = this.steps(state)[state.completed.length]; check(step?.safe, "This step does not require Safe owner approvals");
    if (step.group) step = (await materializeGroup(this, state, step.id)).step;
    if (step.migration || step.operation === 1) {
      const code = await this.rpc<Hex>(step.chain, "eth_getCode", [step.target!(), "latest"]);
      check(this.runtimeMatches(code, "MultiSendCallOnly") || officialSafe.deployments.some(item => item.kind === "multiSend"
        && same(item.address, step.target!()) && item.codeHash === keccak256(code)), "Unverified Safe batch helper");
    }
    const local = await inspectSafe(this, step.chain, step.safe!());
    let authority = local, adapter: Address | undefined;
    if (step.chain === "l2" && !step.migration) {
      check(local.adapter && same(local.adapter.address, state.addresses.adapter!)
        && same(local.adapter.safeL1, state.addresses.safeL1!) && same(local.adapter.manager, profile.manager), "EEZ-X Safe owner adapter changed");
      authority = await inspectSafe(this, "l1", state.addresses.safeL1!); adapter = local.adapter.address;
    }
    const args = step.migration ? [adoptL1Owners(local.address, local.owners, state.addresses.adapter!)] : step.args();
    const data = encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method!, args });
    const review: SetupReview = { id: step.id, chain: step.chain, safe: local.address, to: step.target!(), data,
      operation: step.migration ? 1 : step.operation ?? 0, nonce: local.nonce, owners: [...authority.owners], threshold: authority.threshold,
      ...(adapter ? { adapter } : {}), fingerprint: ownerFingerprint(authority.owners, authority.threshold),
      localFingerprint: ownerFingerprint(local.owners, local.threshold), safeHash: "0x", approvals: [] };
    review.safeHash = safeTransactionHash(reviewTransaction(review));
    return review;
  }
  async currentReview(state: DeploymentState) {
    check(state.review, "Review this Safe transaction and collect its current-owner approvals first");
    const fresh = await this.reviewStep(state);
    check(fresh.safeHash === state.review.safeHash && fresh.fingerprint === state.review.fingerprint
      && fresh.localFingerprint === state.review.localFingerprint, "Safe owners, nonce or setup step changed. Review again and collect fresh approvals");
    return state.review;
  }
  async approve(state: DeploymentState, provider: EthereumProvider): Promise<Approval> {
    const review = await this.currentReview(state);
    const owner = await this.wallet(provider, review.chain);
    check(review.owners.some(a => same(a, owner)), "Only a current Safe owner can approve this step");
    check(!review.approvals.some(a => same(a.owner, owner)), "This owner has already approved");
    const tx = reviewTransaction(review);
    const signature = await provider.request({ method: "eth_signTypedData_v4", params: [owner, safeTypedDataJSON(tx)] }) as Hex;
    await this.wallet(provider, review.chain, owner); await this.currentReview(state);
    await packEOAApprovals(tx, review.owners, 1, [{ owner, signature }]);
    return { owner, signature };
  }
  protected async assertProgress(state: DeploymentState) { await assertSetupProgress(this, state); }
  async prepare(state: DeploymentState, provider: EthereumProvider) {
    check(!state.pending, "Resolve the pending deployment before continuing");
    await this.assertProgress(state);
    const step = this.steps(state)[state.completed.length]; check(step, "Deployment is already complete");
    await this.validate(); await this.validateImports(state);
    const sender = await this.wallet(provider, step.chain, step.safe && !step.group ? undefined : state.deployer);
    if (state.version === 6 && state.asset && ["approveFunding", "fundingBatchL1"].includes(step.id)) {
      const funds = await this.fundingStatus(state);
      check(funds.balance >= funds.amount, "Your wallet needs 450 Test USDC on Chiado to fund these Safes. Obtain tokens separately, then retry.");
      if (step.id === "fundingBatchL1") check(funds.allowance >= funds.amount, "The funding allowance is insufficient. Restore the reviewed 450-token approval before continuing.");
    }
    const balance = await this.rpc<Hex>(step.chain, "eth_getBalance", [sender, "latest"]);
    check(BigInt(balance) > 0n, `The submitting wallet needs test xDAI on ${step.chain === "l1" ? "Chiado" : "EEZ-X"}`);
    const nonce = await this.rpc<Hex>(step.chain, "eth_getTransactionCount", [sender, "pending"]);
    const grouped = step.group ? await materializeGroup(this, state, step.id, nonce) : undefined;
    let to = grouped ? undefined : step.target?.(), data: Hex, safeHash: Hex | undefined;
    if (step.safe) {
      const review = await this.currentReview(state), tx = reviewTransaction(review);
      const packed = review.adapter ? await packOwnerApprovals(tx, review.adapter, review.owners, review.threshold, review.approvals)
        : await packEOAApprovals(tx, review.owners, review.threshold, review.approvals);
      data = encodeSafeExecution(tx, packed); to = step.safe(); safeHash = review.safeHash;
    } else data = grouped ? "0x" : step.method ? encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method, args: step.args() })
      : encodeDeployData({ abi: this.abi(step.artifact), bytecode: this.artifacts.contracts[step.artifact]!.bytecode, args: step.args() });
    await this.wallet(provider, step.chain, sender);
    const batch = grouped ? encodeGroup(this, state, grouped, step.safe ? data : undefined) : undefined;
    if (batch) { data = batch.data; to = batch.to; }
    let request: Record<string, string> = { from: sender, chainId: toHex(profile.chains[step.chain].chainId), nonce, data, value: "0x0", ...(to ? { to } : {}) };
    let expiresAt: string | undefined;
    if (step.quoted) {
      const quote = await quoteCrossChainFees({ tx: request, from: sender, chainId: request.chainId!, wallet: provider,
        rpc: (method, params) => this.rpc(step.chain, method, params, true), maxTotalFee: BigInt(this.target.fees[step.chain]) });
      request = quote.transaction; expiresAt = quote.expiresAt;
    } else {
      const estimate = await this.rpc<Hex>(step.chain, "eth_estimateGas", [request], true);
      request.gas = toHex(BigInt(estimate) * 120n / 100n);
    }
    const pending: DeploymentPending = { id: step.id, chain: step.chain, sender, nonce, data, ...(to ? { to } : {}), ...(safeHash ? { safeHash } : {}), ...(batch ? { group: batch.receipt } : {}) };
    return { pending, request, expiresAt };
  }
  /** Discover a missing or repriced hash without resubmitting. The sender's
   * historical nonce narrows a bounded canonical-block window to one block. A hash
   * is only a tracking hint; reconcile still verifies canonical execution.
   */
  async trackPending<T extends { pending?: DeploymentPending }>(state: T): Promise<T> {
    const pending = state.pending; if (!pending) return state;
    if (pending.hash && await this.rpc(pending.chain, "eth_getTransactionReceipt", [pending.hash])) return state;
    const head = await this.rpc<{ number: Hex; hash: Hex } | null>(pending.chain, "eth_getBlockByNumber", ["latest", false]);
    check(head && quantity(head.number) && digest(head.hash), "The network's current block is unavailable. Automatic tracking will retry.");
    const key = [pending.chain, pending.sender.toLowerCase(), pending.nonce, pending.to?.toLowerCase(), keccak256(pending.data), head.hash].join(":");
    let hash: Hex | undefined;
    if (this.recoveryLookup?.key === key) hash = this.recoveryLookup.hash;
    else {
      const nonceAt = async (number: bigint) => {
        const value = await this.rpc<Hex>(pending.chain, "eth_getTransactionCount", [pending.sender, toHex(number)]);
        check(quantity(value), "The network's transaction history is unavailable. Automatic tracking will retry.");
        return BigInt(value);
      };
      let high = BigInt(head.number);
      let low = high > RECOVERY_BLOCKS ? high - RECOVERY_BLOCKS : 0n;
      const nonce = BigInt(pending.nonce);
      if (await nonceAt(high) > nonce && await nonceAt(low) <= nonce) {
        // Search only while the lower block precedes consumption and the upper
        // block includes it. Never infer transaction success from account nonce.
        while (high - low > 1n) {
          const middle = (high + low) / 2n;
          if (await nonceAt(middle) > nonce) high = middle; else low = middle;
        }
        type Transaction = { hash: Hex; from: Address; to: Address | null; input: Hex; nonce: Hex; value: Hex };
        const block = await this.rpc<{ number: Hex; hash: Hex; transactions: Transaction[] } | null>(pending.chain, "eth_getBlockByNumber", [toHex(high), true]);
        check(block && quantity(block.number) && BigInt(block.number) === high && digest(block.hash) && Array.isArray(block.transactions),
          "The network's transaction history is unavailable. Automatic tracking will retry.");
        const tx = block.transactions.find(tx => tx && isAddress(tx.from) && same(tx.from, pending.sender) && quantity(tx.nonce) && BigInt(tx.nonce) === nonce);
        if (tx) {
          check(digest(tx.hash) && (pending.to ? tx.to !== null && isAddress(tx.to) && same(tx.to, pending.to) : tx.to === null)
            && typeof tx.input === "string" && same(tx.input, pending.data) && quantity(tx.value) && BigInt(tx.value) === 0n,
          "This wallet nonce was used for a different transaction. Setup has not advanced.");
          hash = tx.hash;
        }
      }
      // A reorg changes the head hash and invalidates this lookup. Do not
      // cache failed RPCs or mismatches; neither establishes a completed search.
      const current = await this.rpc<{ hash: Hex } | null>(pending.chain, "eth_getBlockByNumber", [head.number, false]);
      if (current?.hash !== head.hash) return state;
      this.recoveryLookup = { key, hash };
    }
    return hash && hash !== pending.hash ? { ...state, pending: { ...pending, hash } } : state;
  }
  async reconcile(state: DeploymentState): Promise<DeploymentState> {
    const pending = state.pending; if (!pending) return state;
    check(pending.hash, "Wallet response missing. Automatic tracking will keep checking; do not deploy again.");
    const step = this.steps(state)[state.completed.length]!;
    check(step.id === pending.id && step.chain === pending.chain, "Pending deployment step changed");
    type Receipt = { status: Hex; blockNumber: Hex; blockHash: Hex; contractAddress: Address | null; logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[] };
    const receipt = await this.rpc<Receipt | null>(step.chain, "eth_getTransactionReceipt", [pending.hash]);
    if (!receipt) return state;
    const [tx, block] = await Promise.all([
      this.rpc<{ from: Address; to: Address | null; input: Hex; nonce: Hex; value: Hex }>(step.chain, "eth_getTransactionByHash", [pending.hash]),
      this.rpc<{ hash: Hex }>(step.chain, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    ]);
    check(tx && same(tx.from, pending.sender) && (pending.to ? tx.to && same(tx.to, pending.to) : !tx.to)
      && same(tx.input, pending.data) && BigInt(tx.nonce) === BigInt(pending.nonce) && BigInt(tx.value) === 0n,
    "The wallet transaction does not match the saved deployment request");
    if (!block || block.hash !== receipt.blockHash) return state;
    check(receipt.status === "0x1", "Deployment transaction reverted; preserve this record for diagnosis before any retry");
    if (pending.safeHash) {
      const success = receipt.logs.some(log => {
        if (!same(log.address, step.safe?.() ?? pending.to ?? "")) return false;
        const event = decodeSafeExecution(log);
        return event?.eventName === "ExecutionSuccess" && event.args.txHash === pending.safeHash;
      });
      check(success, "Missing matching successful Safe execution");
    }
    if (step.migration) {
      const [owners, threshold] = await Promise.all([
        this.read<Address[]>("l2", pending.to!, "Safe", "getOwners", [], receipt.blockNumber),
        this.read<bigint>("l2", pending.to!, "Safe", "getThreshold", [], receipt.blockNumber),
      ]);
      check(owners.length === 1 && same(owners[0]!, state.addresses.adapter!) && threshold === 1n, "L1 owner adoption did not complete");
    }
    if (state.asset && step.id === "approveFunding") check(await this.read<bigint>("l1", state.asset.binding.tokenL1, "ERC20", "allowance", [state.deployer, state.addresses.bootstrapL1], receipt.blockNumber) === 450_000_000n,
      "The exact funding allowance was not confirmed");
    const addresses = { ...state.addresses };
    if (step.group) {
      const group = pending.group;
      check(group && group.create === step.group.create && group.finish === step.group.finish, "Missing deployment batch identity");
      if (group.create) check(receipt.contractAddress && same(receipt.contractAddress, group.executor)
        && same(group.executor, getContractAddress({ from: pending.sender, nonce: BigInt(pending.nonce) })), "Unexpected deployment executor address");
      else check(pending.to && same(pending.to, group.executor) && same(state.addresses[step.group.executor] ?? "", group.executor), "Deployment executor mismatch");
      const events = receipt.logs.filter(log => same(log.address, group.executor)).flatMap(log => {
        try { return [decodeEventLog({ abi: this.abi("TreasuryBootstrap"), ...log })]; } catch { return []; }
      });
      check(events.some(event => event.eventName === "Executed" && (event.args as unknown as { sequence: bigint; actionsHash: Hex; closed: boolean }).sequence === BigInt(group.sequence)
        && (event.args as unknown as { actionsHash: Hex }).actionsHash === group.actionsHash && (event.args as unknown as { closed: boolean }).closed === group.finish), "Missing matching deployment batch execution");
      const executorCode = await this.rpc<Hex>(step.chain, "eth_getCode", [group.executor, receipt.blockNumber]);
      check(this.runtimeMatches(executorCode, "TreasuryBootstrap")
        && same(await this.read<Address>(step.chain, group.executor, "TreasuryBootstrap", "owner", [], receipt.blockNumber), state.deployer)
        && await this.read<boolean>(step.chain, group.executor, "TreasuryBootstrap", "closed", [], receipt.blockNumber) === group.finish
        && await this.read<bigint>(step.chain, group.executor, "TreasuryBootstrap", "sequence", [], receipt.blockNumber) === BigInt(group.sequence) + 1n,
      "Deployment executor state mismatch");
      addresses[step.group.executor] = group.executor;
      const expectedOutputs = step.group.actions.filter(action => action.output && action.special !== "wrapped");
      check(group.outputs.length === expectedOutputs.length && new Set(group.outputs.map(output => output.key)).size === expectedOutputs.length, "Missing or duplicate batch outputs");
      for (const output of group.outputs) {
        const expected = step.group.actions[output.index];
        check(expected?.output === output.key && output.artifact === (expected.special === "safe" ? "SafeProxy" : expected.artifact), "Unexpected batch output");
        if (output.initHash) check(events.some(event => event.eventName === "Created"
          && (event.args as unknown as { index: bigint }).index === BigInt(output.index)
          && same((event.args as unknown as { target: Address }).target, output.address)
          && (event.args as unknown as { initHash: Hex }).initHash === output.initHash), "Missing matching contract creation");
        else {
          check(output.factory && output.singleton && output.artifact === "SafeProxy", "Invalid Safe batch output");
          check(receipt.logs.some(log => {
            if (!same(log.address, output.factory!)) return false;
            for (const abi of [this.abi("SafeProxyFactory"), parseAbi(["event ProxyCreation(address proxy,address singleton)"])]) {
              try { const event = decodeEventLog({ abi, ...log }); const args = event.args as unknown as { proxy: Address; singleton: Address };
                if (event.eventName === "ProxyCreation" && same(args.proxy, output.address) && same(args.singleton, output.singleton!)) return true;
              } catch { /* The factory versions have different event indexing. */ }
            }
            return false;
          }), "Missing matching Safe creation");
        }
        const code = await this.rpc<Hex>(step.chain, "eth_getCode", [output.address, receipt.blockNumber]);
        check(output.artifact === "SafeProxy" ? matchingSafeCode(code, this.artifacts.contracts.SafeProxy!.runtime) : this.runtimeMatches(code, output.artifact), "Batch contract bytecode mismatch");
        addresses[output.key] = getAddress(output.address);
      }
      if (step.group.actions.some(action => action.special === "wrapped")) {
        const wrapped = await this.read<Address>("l2", addresses.bridgeL2!, "ConfiguredTreasuryBridge", "getWrappedToken", [addresses.tokenL1, 0n], "latest");
        if (same(wrapped, zeroAddress)) return state;
        check(this.runtimeMatches(await this.rpc<Hex>("l2", "eth_getCode", [wrapped, "latest"]), "WrappedToken"), "Wrapped token bytecode mismatch");
        addresses.tokenL2 = getAddress(wrapped);
      }
      if (addresses.policy && !addresses.alias) addresses.alias = await this.policyAlias(addresses.policy);
    }
    if (state.version === 6 && state.asset && step.id === "fundingBatchL1") {
      const [walletAllowance, bridgeAllowance, held] = await Promise.all([
        this.read<bigint>("l1", addresses.tokenL1!, "ERC20", "allowance", [state.deployer, addresses.bootstrapL1], receipt.blockNumber),
        this.read<bigint>("l1", addresses.tokenL1!, "ERC20", "allowance", [addresses.bootstrapL1, addresses.bridgeL1], receipt.blockNumber),
        this.read<bigint>("l1", addresses.tokenL1!, "ERC20", "balanceOf", [addresses.bootstrapL1], receipt.blockNumber),
      ]);
      check(walletAllowance === 0n && bridgeAllowance === 0n && held === 0n, "Funding left an unexpected allowance or executor balance");
    }
    if (step.output) {
      let address: Address, artifact = step.artifact;
      if (step.special === "safe") {
        const event = receipt.logs.filter(log => same(log.address, pending.to!)).flatMap(log => {
          try {
            const factory = state.simplification?.official[`factory${step.chain === "l1" ? "L1" : "L2"}`];
            const oldFactory = factory && officialSafe.deployments.some(item => item.kind === "factory" && item.version === "1.3.0" && same(item.address, factory.address));
            const abi = oldFactory ? parseAbi(["event ProxyCreation(address proxy,address singleton)"]) : this.abi("SafeProxyFactory");
            return [decodeEventLog({ abi, ...log })];
          } catch { return []; }
        }).find(event => event.eventName === "ProxyCreation");
        check(event && event.args && "proxy" in event.args, "Missing Safe creation event");
        const created = event.args as unknown as { proxy: Address; singleton: Address };
        check(same(created.singleton, state.addresses[step.chain === "l1" ? "singletonL1" : "singletonL2"]!), "Safe creation singleton mismatch");
        address = created.proxy; artifact = "SafeProxy";
      } else if (step.special === "alias") {
        address = await this.read<Address>(step.chain, getAddress(profile.registry), "Registry", "computeCrossChainProxyAddress", step.args());
        const [registered, original, rollup] = await this.read<[boolean, Address, bigint]>(step.chain, getAddress(profile.registry), "Registry", "authorizedProxies", [address]);
        check(registered && same(original, state.addresses.policy!) && rollup === BigInt(profile.rollupId), "Policy alias registration mismatch");
      } else if (step.special === "wrapped") {
        address = await this.read<Address>("l2", state.addresses.bridgeL2!, "ConfiguredTreasuryBridge", "getWrappedToken", [state.addresses.tokenL1, 0n], "latest");
        if (address === zeroAddress) return state;
        artifact = "WrappedToken";
      } else {
        check(receipt.contractAddress, "Missing contract deployment address"); address = receipt.contractAddress;
        check(same(address, getContractAddress({ from: pending.sender, nonce: BigInt(pending.nonce) })), "Unexpected contract address");
      }
      const code = await this.rpc<Hex>(step.special === "wrapped" ? "l2" : step.chain, "eth_getCode", [address, "latest"]);
      // A version-2 wallet request may contain the previous invoice-required
      // constructor. Its exact initcode identity plus the canonical CREATE receipt
      // establishes its deployed code; this exception never accepts other initcode.
      const legacyPolicy = state.version === 2 && step.id === "policy" && pending.data.length === 2 + 14231 * 2 + 9 * 64
        && keccak256(pending.data.slice(0, 2 + 14231 * 2) as Hex) === "0xb58d80044bddc062928c82f254871bab5fe782fadfc8ad1484b5589fb5b34d08";
      check(code !== "0x" && (legacyPolicy || step.special === "alias" || (step.special === "safe" ? matchingSafeCode(code, this.artifacts.contracts.SafeProxy!.runtime) : matchesRuntime(code, this.artifacts.contracts[artifact]!))), "Deployed bytecode does not match the reviewed artifacts");
      addresses[step.output] = getAddress(address);
      if (step.id === "policy" && state.version === 3 && !addresses.alias) addresses.alias = await this.policyAlias(address);
    }
    if (step.batch) {
      const suffix = step.chain === "l1" ? "L1" : "L2";
      const safe = addresses[`safe${suffix}`]!, module = addresses[`module${suffix}`]!, delegate = addresses[step.chain === "l1" ? "alias" : "policy"]!;
      const allowance = await this.read<bigint[]>(step.chain, module, "AllowanceModule", "getTokenAllowance", [safe, delegate, addresses[`token${suffix}`]], receipt.blockNumber);
      check(await this.read<boolean>(step.chain, safe, "Safe", "isModuleEnabled", [module], receipt.blockNumber)
        && allowance[0] === 100_000_000n && allowance[1] === 0n && allowance[2] === 10n && allowance[3]! % 10n === 0n,
      "Safe spending configuration did not complete");
      if (step.chain === "l1") {
        const [registered, original, rollup] = await this.read<[boolean, Address, bigint]>("l1", getAddress(profile.registry), "Registry", "authorizedProxies", [delegate], receipt.blockNumber);
        check(registered && same(original, addresses.policy!) && rollup === BigInt(profile.rollupId), "Policy alias registration mismatch");
      }
    }
    // Contract reads may span several RPC calls. Do not record their effects if
    // the receipt's block was reorganized while those checks were running.
    const current = await this.rpc<{ hash: Hex } | null>(step.chain, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (current?.hash !== receipt.blockHash) return state;
    return { ...state, ...(state.build ? { sourceRequests: appendSourceRequest(state.sourceRequests, state.build, profile.chains[step.chain].chainId, pending.hash) } : {}), addresses, completed: [...state.completed, step.id], transactions: [...state.transactions, pending.hash],
      inclusions: { ...state.inclusions, [pending.hash]: { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } }, pending: undefined, review: undefined };
  }
  async manifest(state: DeploymentState): Promise<TreasuryConfig> {
    check(!state.pending && state.completed.length === this.steps(state).length, "Finish deployment before enabling payments");
    await this.assertProgress(state);
    await this.validate(); await this.validateImports(state);
    const a = state.addresses;
    const names: [Chain, string[]][] = [["l1", ["safeL1", "singletonL1", "aliasReaderL1", "tokenL1", "moduleL1", "bridgeL1", "alias", ...(a.invoiceMerchant ? ["invoiceMerchant"] : [])]],
      ["l2", ["safeL2", "singletonL2", "adapter", ...(a.action ? ["action"] : []), "tokenL2", "moduleL2", "bridgeL2", "policy"]]];
    const code: TreasuryConfig["code"] = [];
    for (const [chain, keys] of names) for (const key of keys) {
      const address = a[key]!; const bytes = await this.rpc<Hex>(chain, "eth_getCode", [address, "latest"]);
      check(bytes !== "0x", `Missing deployed ${key}`); code.push({ chain, address, hash: keccak256(bytes) });
    }
    const protocol = (["l1", "l2"] as const).map(chain => ({ chain, proxy: getAddress(profile.chains[chain].protocol.proxy), implementation: getAddress(profile.chains[chain].protocol.implementation) }));
    for (const binding of protocol) for (const address of [binding.proxy, binding.implementation])
      code.push({ chain: binding.chain, address, hash: keccak256(await this.rpc<Hex>(binding.chain, "eth_getCode", [address, "latest"])) });
    const config = parseTreasuryConfig({ version: 1, environment: "dashboard-testnet", instance: keccak256(toHex(`${state.salt}:${a.safeL1}:${a.safeL2}`)),
      l1: { ...this.target.l1, chainId: profile.chains.l1.chainId, checkpoint: profile.chains.l1.checkpoint },
      l2: { ...this.target.l2, chainId: profile.chains.l2.chainId, checkpoint: profile.chains.l2.checkpoint },
      registry: profile.registry, manager: profile.manager, safeL1: a.safeL1, safeL2: a.safeL2, adapter: a.adapter, action: a.action,
      code, protocol, safeImplementations: { l1: a.singletonL1, l2: a.singletonL2 }, ownerLabels: {}, fees: { maxTotalWei: this.target.fees.l2, l1MaxTotalWei: this.target.fees.l1 },
      payments: { policy: a.policy, alias: a.alias, aliasReaderL1: a.aliasReaderL1, tokenL1: a.tokenL1, tokenL2: a.tokenL2,
        moduleL1: a.moduleL1, moduleL2: a.moduleL2, bridgeL1: a.bridgeL1, bridgeL2: a.bridgeL2, invoiceMerchant: a.invoiceMerchant,
        recipient: state.deployer, ...(state.bidirectional ? { l1Initiation: true } : {}), ...(state.version >= 9 ? { exactSplits: true } : {}), combinedL2: true, percentageRules: true, decimals: 6, period: 600, globalLimit: "150000000", assetLabel: "Test USDC" } });
    const client = new TreasuryClient(config); await client.validate();
    const snapshot = await client.snapshot();
    if (!state.reuse.l1) check(snapshot.threshold === 1 && snapshot.owners.length === 1 && same(snapshot.owners[0]!, state.deployer), "Initial Safe owner configuration changed");
    const funds = await paymentState(client, "latest");
    if (state.version < 7) check(funds.balanceL1 === 300_000_000n + BigInt(state.asset?.fundingBase.l1 ?? state.shared?.fundingBase.l1 ?? "0")
      && funds.balanceL2 === 150_000_000n + BigInt(state.asset?.fundingBase.l2 ?? state.shared?.fundingBase.l2 ?? "0"), "Initial funding does not match the deployment plan");
    check(funds.spent === 0n && funds.allowanceL1[0] === 100_000_000n && funds.allowanceL2[0] === 100_000_000n
      && funds.allowanceL1[1] === 0n && funds.allowanceL2[1] === 0n, "Initial allowances or spending do not match the deployment plan");
    return config;
  }
}
