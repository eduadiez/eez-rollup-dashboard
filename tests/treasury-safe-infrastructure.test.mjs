import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex, zeroHash } from 'viem';
import { discoverSafeInfrastructure, validateSafeInfrastructure } from '../src/lib/treasury/safeInfrastructure.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const names = { singletonL2: 'Safe', factoryL2: 'SafeProxyFactory', multiSendL2: 'MultiSendCallOnly', moduleL2: 'AllowanceModule' };
const event = parseAbi(['event Created(uint256 indexed index,address indexed target,bytes32 initHash)']);
const address = n => getAddress(toHex(n, { size: 20 }));
function fixture() {
  const calls = [], logs = [], code = new Map();
  const d = { artifacts, rpc: async (chain, method, params = []) => {
    calls.push({ chain, method, params }); assert.equal(chain, 'l2');
    if (method === 'eth_chainId') return toHex(696990);
    if (method === 'eth_getBlockByNumber') return { number: toHex(200_010), hash: zeroHash };
    if (method === 'eth_getLogs') return logs.filter(l => l.block >= BigInt(params[0].fromBlock) && l.block <= BigInt(params[0].toBlock));
    if (method === 'eth_getCode') return code.get(params[0].toLowerCase()) ?? '0x';
    throw Error(method);
  }};
  function created(key, n, block = 200_005n, bytes = artifacts.contracts[names[key]].runtime) {
    const target = address(n), artifact = artifacts.contracts[names[key]];
    logs.push({ topics: encodeEventTopics({ abi: event, eventName: 'Created', args: { index: BigInt(n), target } }),
      data: encodeAbiParameters([{ type: 'bytes32' }], [keccak256(artifact.bytecode)]), block });
    code.set(target.toLowerCase(), bytes); return target;
  }
  return { d, logs, code, calls, created };
}
test('empty EEZ-X discovers nothing; contracts prepared by one wallet are reusable by later wallets', async () => {
  const f = fixture(); assert.deepEqual(await discoverSafeInfrastructure(f.d, 696990, '0x0'), {});
  const expected = Object.fromEntries(Object.entries(names).map(([key, name], i) => [key, { address: f.created(key, i + 100), hash: keccak256(artifacts.contracts[name].runtime) }]));
  f.calls.length = 0;
  const first = await discoverSafeInfrastructure(f.d, 696990, '0x0');
  assert.deepEqual(first, expected); assert.deepEqual(await discoverSafeInfrastructure(f.d, 696990, '0x0'), expected);
  assert.equal(f.calls.filter(c => c.method === 'eth_getLogs').length, 2, 'one newest range per wallet');
  assert(f.calls.filter(c => c.method === 'eth_getCode').every(c => c.params[1] === toHex(200_010)));
  await validateSafeInfrastructure(f.d, first, Object.fromEntries(Object.entries(first).map(([key, b]) => [key, b.address])));
});
test('discovery searches bounded ranges and rejects spoofed, removed, malformed and wrong-runtime candidates', async () => {
  const f = fixture(), valid = f.created('moduleL2', 100, 1n);
  f.created('moduleL2', 101, 200_005n, '0x6000');
  f.created('singletonL2', 102); f.logs.at(-1).removed = true;
  f.logs.push({ topics: [], data: '0x', block: 200_005n });
  const found = await discoverSafeInfrastructure(f.d, 696990, '0x0');
  assert.deepEqual(Object.keys(found), ['moduleL2']); assert.equal(found.moduleL2.address, valid);
  const ranges = f.calls.filter(c => c.method === 'eth_getLogs').map(c => c.params[0]);
  assert.deepEqual(ranges.map(r => [BigInt(r.fromBlock), BigInt(r.toBlock)]), [[100_011n, 200_010n], [11n, 100_010n], [0n, 10n]]);
  assert(ranges.every(r => BigInt(r.toBlock) - BigInt(r.fromBlock) < 100_000n));
});
test('RPC failure, another chain or changed canonical history cannot authorize redeployment or reuse', async () => {
  for (const kind of ['rpc', 'chain', 'reorg']) {
    const f = fixture(), original = f.d.rpc;
    f.d.rpc = (chain, method, params) => {
      if (kind === 'rpc' && method === 'eth_getLogs') throw Error('RPC unavailable');
      if (kind === 'chain' && method === 'eth_chainId') return '0x1';
      if (kind === 'reorg' && method === 'eth_getBlockByNumber' && params[0] !== 'latest') return { number: toHex(200_010), hash: keccak256('0x00') };
      return original(chain, method, params);
    };
    await assert.rejects(discoverSafeInfrastructure(f.d, 696990, '0x0'), /RPC unavailable|different network|changed during inspection/);
  }
});
test('saved shared bindings reject another address, release hash or changed code before use', async () => {
  const f = fixture(), target = f.created('moduleL2', 100), bindings = await discoverSafeInfrastructure(f.d, 696990, '0x0');
  await assert.rejects(validateSafeInfrastructure(f.d, bindings, { moduleL2: address(101) }), /binding/);
  await assert.rejects(validateSafeInfrastructure(f.d, { moduleL2: { address: target, hash: zeroHash } }, { moduleL2: target }), /release/);
  f.code.set(target.toLowerCase(), '0x6000');
  await assert.rejects(validateSafeInfrastructure(f.d, bindings, { moduleL2: target }), /code changed/);
  await assert.rejects(validateSafeInfrastructure(f.d, { unknown: { address: target, hash: zeroHash } }, {}), /binding/);
});
