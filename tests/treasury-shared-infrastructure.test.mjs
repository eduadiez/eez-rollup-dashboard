import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toHex, zeroAddress } from 'viem';
import { TreasuryDeployment, deploymentIdentity, readDeployment, saveDeployment, sharedDeploymentKey, previousSharedInfrastructureKey } from '../src/lib/treasury/deployment.ts';
import { discoverSharedInfrastructure, verifySharedInfrastructure } from '../src/lib/treasury/sharedInfrastructure.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const address = n => getAddress(toHex(n, { size: 20 }));
const hash = s => keccak256(toHex(s));
const target = { l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2' }, fees: { l1: '1', l2: '1' } };
const registration = { blockNumber: '0x20', blockHash: hash('registration'), transactionHash: hash('register'), logIndex: '0x0' };
const binding = { tokenL1: address(100), tokenL2: address(101), bridgeL1: address(102), bridgeL2: address(103), registration };
async function fixture() {
  const d = new TreasuryDeployment(target, artifacts);
  d.validate = async () => {}; d.validateImports = async () => {};
  const state = await d.group({ version: 2, identity: deploymentIdentity, deployer: address(99), salt: hash('current'), reuse: {}, completed: ['singletonL1'], transactions: [hash('confirmed')], addresses: { singletonL1: address(200) } });
  return { d, state };
}
test('shared infrastructure adoption keeps the confirmed implementation, history and salt', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => binding;
  const next = await d.share(state);
  assert.equal(next.version, 5); assert.equal(next.salt, state.salt); assert.equal(next.deployer, state.deployer);
  assert.deepEqual(next.completed, state.completed); assert.deepEqual(next.transactions, state.transactions);
  assert.equal(next.addresses.singletonL1, state.addresses.singletonL1);
  assert.deepEqual(readDeployment(JSON.stringify(next)), next);
  const actions = d.steps(next).flatMap(s => s.group?.actions ?? []);
  for (const id of ['tokenL1', 'bridgeL1', 'bridgeL2', 'pairL1', 'pairL2', 'releaseL1', 'releaseL2']) assert(!actions.some(a => a.id === id), id);
  assert(actions.some(a => a.id === 'claimTestUSDC'));
  assert(actions.some(a => a.id === 'fundL2'));
  const raw = JSON.stringify(state), saved = new Map([[sharedDeploymentKey, raw]]);
  saveDeployment({ getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }, next);
  assert.equal(saved.get(`${previousSharedInfrastructureKey}:${state.salt}`), raw);
  assert.throws(() => saveDeployment({ getItem: () => raw, setItem: () => { throw Error('quota'); } }, next), /quota/);
  const changed = structuredClone(next); changed.addresses.singletonL1 = address(201);
  assert.throws(() => readDeployment(JSON.stringify(changed)), /replaced confirmed progress/);
  const forged = structuredClone(next); forged.addresses.bridgeL1 = address(202);
  assert.throws(() => readDeployment(JSON.stringify(forged)), /shared infrastructure binding/);
});
test('first setup creates the reusable faucet and seals both bridges before registration', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => undefined;
  const next = await d.share(state), actions = d.steps(next).flatMap(s => s.group?.actions ?? []);
  assert.equal(actions.find(a => a.id === 'tokenL1').artifact, 'SharedTestUSDC');
  for (const chain of ['L1', 'L2']) {
    assert.equal(actions.find(a => a.id === 'bridge' + chain).artifact, 'SharedTreasuryBridge');
    assert.equal(actions.find(a => a.id === 'release' + chain).method, 'seal');
  }
  assert(actions.findIndex(a => a.id === 'registerShared') > actions.findIndex(a => a.id === 'fundL2'));
  assert.deepEqual(readDeployment(JSON.stringify(next)), next);
});
test('pending, reviewed and private-asset setups keep exact plans and never trigger discovery', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => { throw Error('should not query'); };
  for (const next of [{ ...state, pending: { id: 'contractsBatchL1', data: '0x1234' } }, { ...state, review: { safeHash: hash('review') } },
    { ...state, addresses: { ...state.addresses, tokenL1: address(300) } }, { ...state, addresses: { ...state.addresses, bridgeL1: address(301) } }]) {
    assert.equal(await d.share(next), next);
  }
});
test('discovery failure does not create another token or replace the journal', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => { throw Error('RPC unavailable'); };
  const before = JSON.stringify(state);
  await assert.rejects(d.share(state), /RPC unavailable/); assert.equal(JSON.stringify(state), before);
});
test('existing Safe balances form an additive funding baseline for the shared asset', async () => {
  const { d, state } = await fixture(); state.addresses.safeL1 = address(401); state.addresses.safeL2 = address(402);
  d.findSharedInfrastructure = async () => binding;
  d.read = async chain => chain === 'l1' ? 17_000_000n : 23_000_000n;
  const next = await d.share(state);
  assert.deepEqual(next.shared.fundingBase, { l1: '17000000', l2: '23000000' });
});
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

test('a waiting first-install plan adopts infrastructure registered before its wallet submission', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => undefined;
  const waiting = await d.share(state);
  assert.equal(await d.share(waiting), waiting);
  d.findSharedInfrastructure = async () => binding;
  const next = await d.share(waiting);
  assert.deepEqual(next.shared.binding, binding); assert.equal(next.salt, waiting.salt);
  assert.deepEqual(readDeployment(JSON.stringify(next)), next);
  assert(!d.steps(next).flatMap(s => s.group?.actions ?? []).some(s => s.id === 'bridgeL1'));
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
test('direct legacy-to-shared migration retains the original journal before replacing it', async () => {
  const { d, state } = await fixture(); d.findSharedInfrastructure = async () => undefined;
  const before = state.grouping.source, next = await d.share(state), raw = JSON.stringify(before), saved = new Map([[sharedDeploymentKey, raw]]);
  saveDeployment({ getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }, next);
  assert([...saved.entries()].some(([k, v]) => k !== sharedDeploymentKey && v === raw));
});
