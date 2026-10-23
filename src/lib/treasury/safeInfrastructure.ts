import { decodeEventLog, encodeDeployData, getAddress, isAddress, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import type { DeploymentIO } from './deploymentIO.ts';
import { matchesRuntime } from './runtimeCode.ts';

const contracts = {
  singletonL2: 'Safe', factoryL2: 'SafeProxyFactory',
  multiSendL2: 'MultiSendCallOnly', moduleL2: 'AllowanceModule',
} as const;
type Key = keyof typeof contracts | 'adapter';
type OwnerBinding = { manager: Address; safeL1: Address };
type InfrastructureIO = Pick<DeploymentIO, 'rpc' | 'read' | 'artifacts'>;
export type SafeInfrastructure = Partial<Record<Key, { address: Address; hash: Hex }>>;
const created = parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)']);
const topic = keccak256(new TextEncoder().encode('Created(uint256,address,bytes32)'));
type Block = { number: Hex; hash: Hex };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

/** Bootstrap logs locate candidates; runtime code and immutable bindings authorize reuse.
 * The owner adapter is shared only by mirrors of the same Safe and EEZ manager. Search
 * the selected network's validated history, freezing all reads at one block.
 * Missing contracts are created by the connected wallet's normal setup batches;
 * their existing Created events make them discoverable by every later wallet.
 */
export async function discoverSafeInfrastructure(d: InfrastructureIO, chainId: number, fromBlock: Hex, owners?: OwnerBinding): Promise<SafeInfrastructure> {
  check(BigInt(await d.rpc<Hex>('l2', 'eth_chainId')) === BigInt(chainId), 'EEZ-X infrastructure belongs to a different network');
  const block = await d.rpc<Block | null>('l2', 'eth_getBlockByNumber', ['latest', false]);
  check(block?.number && block.hash, 'EEZ-X infrastructure state is unavailable');
  const matches = new Map(Object.entries(contracts).map(([key, name]) => [keccak256(d.artifacts.contracts[name]!.bytecode), key as Key]));
  if (owners) {
    const adapter = d.artifacts.contracts.L1Owners!;
    matches.set(keccak256(encodeDeployData({ abi: adapter.abi, bytecode: adapter.bytecode, args: [owners.manager, owners.safeL1] })), 'adapter');
  }
  const bindings: SafeInfrastructure = {};
  const first = BigInt(fromBlock);
  // The public RPC caps getLogs at 100,000 blocks. Search newest ranges first
  // and stop once all requested identities have been found. An adapter can be absent
  // even when the chain-wide helpers already exist.
  for (let end = BigInt(block.number); end >= first && Object.keys(bindings).length < matches.size;) {
    const start = end - first >= 100_000n ? end - 99_999n : first;
    const logs = await d.rpc<{ topics: Hex[]; data: Hex; removed?: boolean }[]>('l2', 'eth_getLogs', [{ fromBlock: toHex(start), toBlock: toHex(end), topics: [topic] }]);
    for (const log of [...logs].reverse()) {
      if (log.removed) continue;
      let args;
      try { args = decodeEventLog({ abi: created, topics: log.topics as [Hex, ...Hex[]], data: log.data }).args; }
      catch { continue; }
      const key = matches.get(args.initHash);
      if (!key || bindings[key]) continue;
      const bytes = await d.rpc<Hex>('l2', 'eth_getCode', [args.target, block.number]);
      if (key === 'adapter' ? !matchesRuntime(bytes, d.artifacts.contracts.L1Owners!)
        || !await matchingOwnerBinding(d, args.target, owners!, block.number)
        : bytes !== d.artifacts.contracts[contracts[key]]!.runtime) continue;
      bindings[key] = { address: getAddress(args.target), hash: keccak256(bytes) };
    }
    end = start - 1n;
  }
  const again = await d.rpc<Block | null>('l2', 'eth_getBlockByNumber', [block.number, false]);
  check(again?.hash === block.hash, 'EEZ-X infrastructure changed during inspection; try again');
  return bindings;
}

export async function validateSafeInfrastructure(d: InfrastructureIO, bindings: SafeInfrastructure, addresses: Record<string, Address>, manager?: Address) {
  if (!Object.keys(bindings).length) return;
  const block = await d.rpc<Block>('l2', 'eth_getBlockByNumber', ['latest', false]);
  check(block?.number && block.hash, 'EEZ-X infrastructure state is unavailable');
  for (const [key, binding] of Object.entries(bindings)) {
    check((Object.prototype.hasOwnProperty.call(contracts, key) || key === 'adapter') && binding && isAddress(binding.address) && addresses[key]?.toLowerCase() === binding.address.toLowerCase(), 'Invalid shared EEZ-X infrastructure binding');
    const bytes = await d.rpc<Hex>('l2', 'eth_getCode', [binding.address, block.number]);
    if (key === 'adapter') {
      check(manager && addresses.safeL1 && matchesRuntime(bytes, d.artifacts.contracts.L1Owners!)
        && await matchingOwnerBinding(d, binding.address, { manager, safeL1: addresses.safeL1 }, block.number), 'Shared owner adapter binding changed');
    } else check(binding.hash === keccak256(d.artifacts.contracts[contracts[key as keyof typeof contracts]]!.runtime), 'Shared EEZ-X infrastructure does not match this release');
    check(keccak256(bytes) === binding.hash, 'Shared EEZ-X infrastructure code changed');
  }
  check((await d.rpc<Block>('l2', 'eth_getBlockByNumber', [block.number, false]))?.hash === block.hash, 'EEZ-X infrastructure changed during inspection; try again');
}

/** The event's initcode hash is only a hint: an arbitrary contract can emit it.
 * Check every immutable and the registered proxy, using only the trusted manager.
 * RPC uncertainty propagates rather than authorizing a replacement deployment.
 */
async function matchingOwnerBinding(d: InfrastructureIO, adapter: Address, expected: OwnerBinding, tag: Hex) {
  const [safe, manager, proxy, computed] = await Promise.all([
    d.read<Address>('l2', adapter, 'L1Owners', 'safeL1', [], tag),
    d.read<Address>('l2', adapter, 'L1Owners', 'manager', [], tag),
    d.read<Address>('l2', adapter, 'L1Owners', 'safeL1Proxy', [], tag),
    d.read<Address>('l2', expected.manager, 'Registry', 'computeCrossChainProxyAddress', [expected.safeL1, 0n], tag),
  ]);
  if (safe.toLowerCase() !== expected.safeL1.toLowerCase() || manager.toLowerCase() !== expected.manager.toLowerCase()
    || proxy.toLowerCase() !== computed.toLowerCase()) return false;
  const [registration, code] = await Promise.all([
    d.read<[boolean, Address, bigint]>('l2', expected.manager, 'Registry', 'authorizedProxies', [proxy], tag),
    d.rpc<Hex>('l2', 'eth_getCode', [proxy, tag]),
  ]);
  return registration[0] && registration[1].toLowerCase() === expected.safeL1.toLowerCase() && registration[2] === 0n && code !== '0x';
}
