import savedBridges from "./saved-shared-bridges.json" with { type: "json" };
import { matchesRuntime } from "./runtimeCode.ts";
import { getAddress, isAddress, keccak256, toHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import type { TreasuryDeployment } from "./deployment.ts";
import profile from "./shared-network.json" with { type: "json" };

/** Only known full runtimes are accepted. Peer and immutable bindings are still
 * checked independently at a canonical block before this identity permits reuse. */
export function matchesSharedBridge(d: TreasuryDeployment, code: Hex) {
  return d.runtimeMatches(code, "SharedTreasuryBridge") || savedBridges.some(artifact => matchesRuntime(code, { ...artifact, runtime: artifact.runtime as Hex }));
}
export type SharedInfrastructure = {
  tokenL1: Address; tokenL2: Address; bridgeL1: Address; bridgeL2: Address;
  registration: { blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex };
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const eventTopic = keccak256(toHex("TreasuryInfrastructureRegistered(address,address,address)"));
const addressTopic = (value: Address) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
export function validSharedBinding(value: SharedInfrastructure) {
  return value && [value.tokenL1, value.tokenL2, value.bridgeL1, value.bridgeL2].every(a => isAddress(a) && a !== zeroAddress)
    && value.registration && [value.registration.blockHash, value.registration.transactionHash].every(h => /^0x[\da-f]{64}$/i.test(h))
    && [value.registration.blockNumber, value.registration.logIndex].every(h => /^0x[\da-f]+$/i.test(h));
}
type Block = { number: Hex; hash: Hex };
type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };

/** Verify both sides, including immutable execution values and frozen peers.
 * Reads use fixed safe blocks, checked again after inspection to detect reorgs.
 */
export async function verifySharedInfrastructure(d: TreasuryDeployment, binding: SharedInfrastructure) {
  check(validSharedBinding(binding), "Invalid shared treasury infrastructure");
  const blocks = await Promise.all((["l1", "l2"] as const).map(chain => d.rpc<Block>(chain, "eth_getBlockByNumber", ["safe", false])));
  check(blocks.every(Boolean), "Shared infrastructure confirmation is unavailable");
  for (const [index, chain] of (["l1", "l2"] as const).entries()) {
    const block = blocks[index]!, bridge = chain === "l1" ? binding.bridgeL1 : binding.bridgeL2;
    const peer = chain === "l1" ? binding.bridgeL2 : binding.bridgeL1;
    const expectedManager = chain === "l1" ? profile.registry : profile.manager;
    const code = await d.rpc<Hex>(chain, "eth_getCode", [bridge, block.number]);
    check(matchesSharedBridge(d, code), "Shared bridge code is not confirmed or does not match this build");
    const read = <T>(name: string) => d.read<T>(chain, bridge, "SharedTreasuryBridge", name, [], block.number);
    const [token, manager, local, remote, admin, configuredPeer] = await Promise.all([
      read<Address>("canonicalToken"), read<Address>("manager"), read<bigint>("rollupId"), read<bigint>("treasuryRollupId"), read<Address>("admin"), read<Address>("canonicalBridgeAddress"),
    ]);
    check(same(token, binding.tokenL1) && same(manager, expectedManager) && local === (chain === "l1" ? 0n : BigInt(profile.rollupId))
      && remote === BigInt(profile.rollupId) && admin === zeroAddress && same(configuredPeer, peer), "Shared bridge configuration changed or is not sealed");
  }
  const l1Tag = blocks[0]!.number, l2Tag = blocks[1]!.number;
  check(d.runtimeMatches(await d.rpc<Hex>("l1", "eth_getCode", [binding.tokenL1, l1Tag]), "SharedTestUSDC"), "Unverified shared Test USDC");
  const [registeredL1, registeredL2, wrapped, origin] = await Promise.all([
    d.read<Address>("l1", binding.tokenL1, "SharedTestUSDC", "bridgeL1", [], l1Tag),
    d.read<Address>("l1", binding.tokenL1, "SharedTestUSDC", "bridgeL2", [], l1Tag),
    d.read<Address>("l2", binding.bridgeL2, "SharedTreasuryBridge", "getWrappedToken", [binding.tokenL1, 0n], l2Tag),
    d.read<[Address, bigint]>("l2", binding.bridgeL2, "SharedTreasuryBridge", "wrappedTokenInfo", [binding.tokenL2], l2Tag),
  ]);
  check(same(registeredL1, binding.bridgeL1) && same(registeredL2, binding.bridgeL2) && same(wrapped, binding.tokenL2)
    && same(origin[0], binding.tokenL1) && origin[1] === 0n, "Shared token and bridge mapping mismatch");
  check(d.runtimeMatches(await d.rpc<Hex>("l2", "eth_getCode", [binding.tokenL2, l2Tag]), "WrappedToken"), "Unverified shared wrapped Test USDC");
  check(same(await d.read<Address>("l2", binding.tokenL2, "WrappedToken", "BRIDGE", [], l2Tag), binding.bridgeL2), "Shared wrapped token mint authority mismatch");
  {
    const block = await d.rpc<Block>("l1", "eth_getBlockByNumber", [binding.registration.blockNumber, false]);
    check(block && block.hash === binding.registration.blockHash && BigInt(block.number) <= BigInt(l1Tag), "Shared infrastructure registration is not canonical");
    const logs = await d.rpc<Log[]>("l1", "eth_getLogs", [{ address: binding.tokenL1, blockHash: block.hash, topics: [eventTopic] }]);
    check(logs.some(log => !log.removed && same(log.address, binding.tokenL1) && log.transactionHash === binding.registration.transactionHash && log.logIndex === binding.registration.logIndex
      && log.topics.length === 4 && same(log.topics[1]!, addressTopic(binding.tokenL1)) && same(log.topics[2]!, addressTopic(binding.bridgeL1))
      && same(log.topics[3]!, addressTopic(binding.bridgeL2))), "Shared infrastructure registration changed");
  }
  for (const [index, chain] of (["l1", "l2"] as const).entries()) {
    const current = await d.rpc<Block>(chain, "eth_getBlockByNumber", [blocks[index]!.number, false]);
    check(current?.hash === blocks[index]!.hash, "Shared infrastructure changed during verification; retry setup");
  }
}

/** On-chain discovery works across wallets and browsers. A failed query must
 * never be treated as absence and authorize another infrastructure deployment.
 */
export async function discoverSharedInfrastructure(d: TreasuryDeployment, fromBlock = BigInt(profile.chains.l1.checkpoint.number)): Promise<SharedInfrastructure | undefined> {
  const head = await d.rpc<Block>("l1", "eth_getBlockByNumber", ["safe", false]);
  check(head, "Shared infrastructure discovery is unavailable");
  const last = BigInt(head.number);
  for (let start = fromBlock; start <= last; start += 2000n) {
    const end = start + 1999n < last ? start + 1999n : last;
    const logs = await d.rpc<Log[]>("l1", "eth_getLogs", [{ fromBlock: toHex(start), toBlock: toHex(end), topics: [eventTopic] }]);
    check(Array.isArray(logs) && logs.length <= 128, "Shared infrastructure discovery returned an unsupported result");
    logs.sort((a, b) => BigInt(a.blockNumber) === BigInt(b.blockNumber) ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1);
    for (const log of logs) {
      if (log.removed || log.topics.length !== 4 || !same(log.topics[1]!, addressTopic(log.address))) continue;
      const code = await d.rpc<Hex>("l1", "eth_getCode", [log.address, head.number]);
      // Other contracts can emit the same event. Only the reviewed faucet code
      // establishes a candidate; after that, uncertainty blocks new deployment.
      if (!d.runtimeMatches(code, "SharedTestUSDC")) continue;
      const bridgeL1 = getAddress(`0x${log.topics[2]!.slice(-40)}`), bridgeL2 = getAddress(`0x${log.topics[3]!.slice(-40)}`);
      const localCode = await d.rpc<Hex>("l1", "eth_getCode", [bridgeL1, head.number]);
      if (!matchesSharedBridge(d, localCode)) continue;
      const [manager, rollup] = await Promise.all([
        d.read<Address>("l1", bridgeL1, "SharedTreasuryBridge", "manager", [], head.number),
        d.read<bigint>("l1", bridgeL1, "SharedTreasuryBridge", "treasuryRollupId", [], head.number),
      ]);
      // Other EEZ deployments can use this same public faucet code on Chiado.
      if (!same(manager, profile.registry) || rollup !== BigInt(profile.rollupId)) continue;
      const tokenL2 = await d.read<Address>("l2", bridgeL2, "SharedTreasuryBridge", "getWrappedToken", [log.address, 0n], "safe");
      const binding: SharedInfrastructure = { tokenL1: getAddress(log.address), tokenL2: getAddress(tokenL2), bridgeL1, bridgeL2,
        registration: { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex } };
      await verifySharedInfrastructure(d, binding);
      return binding;
    }
  }
  check((await d.rpc<Block>("l1", "eth_getBlockByNumber", [head.number, false]))?.hash === head.hash, "Shared infrastructure discovery changed; retry setup");
  return undefined;
}
