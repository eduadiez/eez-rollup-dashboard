import { decodeEventLog, getAddress, isAddress, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import type { DeploymentIO } from './deploymentIO.ts';

const contracts = {
  singletonL2: 'Safe', factoryL2: 'SafeProxyFactory',
  multiSendL2: 'MultiSendCallOnly', moduleL2: 'AllowanceModule',
} as const;
type Key = keyof typeof contracts;
export type SafeInfrastructure = Partial<Record<Key, { address: Address; hash: Hex }>>;
const created = parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)']);
const topic = keccak256(new TextEncoder().encode('Created(uint256,address,bytes32)'));
type Block = { number: Hex; hash: Hex };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

/** Bootstrap logs locate candidates; only exact runtime code authorizes reuse.
 * These four contracts have no treasury-specific constructor arguments. Search
 * the selected network's validated history, freezing all reads at one block.
 * Missing contracts are created by the connected wallet's normal setup batches;
 * their existing Created events make them discoverable by every later wallet.
 */
export async function discoverSafeInfrastructure(d: Pick<DeploymentIO, 'rpc' | 'artifacts'>, chainId: number, fromBlock: Hex): Promise<SafeInfrastructure> {
  check(BigInt(await d.rpc<Hex>('l2', 'eth_chainId')) === BigInt(chainId), 'EEZ-X infrastructure belongs to a different network');
  const block = await d.rpc<Block | null>('l2', 'eth_getBlockByNumber', ['latest', false]);
  check(block?.number && block.hash, 'EEZ-X infrastructure state is unavailable');
  const matches = new Map(Object.entries(contracts).map(([key, name]) => [keccak256(d.artifacts.contracts[name]!.bytecode), key as Key]));
  const bindings: SafeInfrastructure = {};
  const first = BigInt(fromBlock);
  // The public RPC caps getLogs at 100,000 blocks. Search newest ranges first
  // and stop as soon as all four code identities have been found.
  for (let end = BigInt(block.number); end >= first && Object.keys(bindings).length < 4;) {
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
      if (bytes !== d.artifacts.contracts[contracts[key]]!.runtime) continue;
      bindings[key] = { address: getAddress(args.target), hash: keccak256(bytes) };
    }
    end = start - 1n;
  }
  const again = await d.rpc<Block | null>('l2', 'eth_getBlockByNumber', [block.number, false]);
  check(again?.hash === block.hash, 'EEZ-X infrastructure changed during inspection; try again');
  return bindings;
}

export async function validateSafeInfrastructure(d: Pick<DeploymentIO, 'rpc' | 'artifacts'>, bindings: SafeInfrastructure, addresses: Record<string, Address>) {
  for (const [key, binding] of Object.entries(bindings)) {
    check(Object.prototype.hasOwnProperty.call(contracts, key) && binding && isAddress(binding.address) && addresses[key]?.toLowerCase() === binding.address.toLowerCase(), 'Invalid shared EEZ-X infrastructure binding');
    const expected = d.artifacts.contracts[contracts[key as Key]]!.runtime;
    check(binding.hash === keccak256(expected), 'Shared EEZ-X infrastructure does not match this release');
    const bytes = await d.rpc<Hex>('l2', 'eth_getCode', [binding.address, 'latest']);
    check(keccak256(bytes) === binding.hash, 'Shared EEZ-X infrastructure code changed');
  }
}
