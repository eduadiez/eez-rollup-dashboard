import { matchesSharedBridge } from '../src/lib/treasury/sharedInfrastructure.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toHex, zeroAddress } from 'viem';
import { TreasuryDeployment } from '../src/lib/treasury/deployment.ts';
import { discoverSharedInfrastructure, verifySharedInfrastructure } from '../src/lib/treasury/sharedInfrastructure.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const address = n => getAddress(toHex(n, { size: 20 }));
const hash = s => keccak256(toHex(s));
const target = { l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2' }, fees: { l1: '1', l2: '1' } };
const registration = { blockNumber: '0x20', blockHash: hash('registration'), transactionHash: hash('register'), logIndex: '0x0' };
const binding = { tokenL1: address(100), tokenL2: address(101), bridgeL1: address(102), bridgeL2: address(103), registration };
function verificationFixture() {
  const d = new TreasuryDeployment(target, artifacts), tag = { number: '0x40', hash: hash('head') };
  const topic = address => toHex(BigInt(address), { size: 32 });
  const log = { address: binding.tokenL1, topics: [hash('TreasuryInfrastructureRegistered(address,address,address)'), topic(binding.tokenL1), topic(binding.bridgeL1), topic(binding.bridgeL2)], ...registration, data: '0x' };
  d.rpc = async (_chain, method, params) => {
    if (method === 'eth_getBlockByNumber') return params[0] === registration.blockNumber ? { number: registration.blockNumber, hash: registration.blockHash } : tag;
    if (method === 'eth_getCode') return params[0] === binding.tokenL1 ? artifacts.contracts.SharedTestUSDC.runtime : params[0] === binding.tokenL2 ? artifacts.contracts.WrappedToken.runtime : artifacts.contracts.SharedTreasuryBridge.runtime;
    if (method === 'eth_getLogs') return [log];
    throw Error('Unexpected ' + method);
  };
  d.read = async (chain, _address, _artifact, method) => ({ canonicalToken: binding.tokenL1, manager: chain === 'l1' ? profile.registry : profile.manager,
    rollupId: chain === 'l1' ? 0n : BigInt(profile.rollupId), treasuryRollupId: BigInt(profile.rollupId), admin: zeroAddress,
    canonicalBridgeAddress: chain === 'l1' ? binding.bridgeL2 : binding.bridgeL1, bridgeL1: binding.bridgeL1, bridgeL2: binding.bridgeL2,
    getWrappedToken: binding.tokenL2, wrappedTokenInfo: [binding.tokenL1, 0n], BRIDGE: binding.bridgeL2 })[method];
  return { d, log, tag };
}
test('canonical discovery verifies both bridges and the wrapped mint authority', async () => {
  const { d } = verificationFixture();
  assert.deepEqual(await discoverSharedInfrastructure(d, 0n), binding);
});
test('unsealed, foreign-manager, foreign-peer and wrong-mint-authority candidates fail closed', async () => {
  for (const [method, value] of [['admin', address(500)], ['manager', address(501)], ['canonicalBridgeAddress', address(502)], ['BRIDGE', address(503)]]) {
    const { d } = verificationFixture(), original = d.read;
    d.read = (...args) => args[3] === method ? Promise.resolve(value) : original(...args);
    await assert.rejects(verifySharedInfrastructure(d, binding), /configuration|authority/);
  }
});
test('a reorged registration or failed log query cannot authorize reuse or new deployment', async () => {
  const { d } = verificationFixture(), original = d.rpc;
  d.rpc = (chain, method, params) => method === 'eth_getBlockByNumber' && params[0] === registration.blockNumber ? Promise.resolve({ number: registration.blockNumber, hash: hash('other') }) : original(chain, method, params);
  await assert.rejects(verifySharedInfrastructure(d, binding), /not canonical/);
  d.rpc = (chain, method, params) => method === 'eth_getLogs' ? Promise.reject(Error('history unavailable')) : original(chain, method, params);
  await assert.rejects(discoverSharedInfrastructure(d, 0n), /history unavailable/);
});
test('foreign rollup registrations do not hide a compatible later registration', async () => {
  const { d, log } = verificationFixture(), originalRpc = d.rpc, originalRead = d.read;
  const otherBridge = address(999);
  const foreign = { ...log, logIndex: '0x0', topics: [...log.topics] };
  foreign.topics[2] = toHex(BigInt(otherBridge), { size: 32 });
  d.rpc = (chain, method, params) => method === 'eth_getLogs' && params[0].fromBlock ? Promise.resolve([foreign, { ...log, logIndex: '0x1' }])
    : method === 'eth_getLogs' ? Promise.resolve([{ ...log, logIndex: '0x1' }]) : originalRpc(chain, method, params);
  d.read = (...args) => args[1] === otherBridge && args[3] === 'treasuryRollupId' ? Promise.resolve(999n) : originalRead(...args);
  assert.deepEqual(await discoverSharedInfrastructure(d, 0n), { ...binding, registration: { ...registration, logIndex: '0x1' } });
});

test('current discovery reuses exact archived shared bridges and rejects changed executable or metadata bytes',()=>{
 const saved=JSON.parse(readFileSync('src/lib/treasury/saved-shared-bridges.json'));
 const d=new TreasuryDeployment(target,artifacts);
 for(const bridge of saved){
  assert(matchesSharedBridge(d,bridge.runtime));
  assert(!matchesSharedBridge(d,`0x00${bridge.runtime.slice(4)}`));
  assert(!matchesSharedBridge(d,bridge.runtime.slice(0,-2)+(bridge.runtime.endsWith('00')?'01':'00')));
 }
});
