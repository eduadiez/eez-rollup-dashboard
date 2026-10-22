import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, stringToHex, toHex, getContractAddress } from 'viem';
import { TreasuryDeployment, deploymentIdentity, readDeployment, saveDeployment, sharedDeploymentKey, previousGroupedDeploymentKey } from '../src/lib/treasury/deployment.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const address = n => toHex(n, { size: 20 });
const hash = s => keccak256(stringToHex(s));
const target = { l1: { rpc: 'http://127.0.0.1/l1', front: 'http://127.0.0.1/l1' }, l2: { rpc: 'http://127.0.0.1/l2', front: 'http://127.0.0.1/l2' }, fees: { l1: '1', l2: '1' } };
function fixture() {
  const d = new TreasuryDeployment(target, artifacts);
  d.validate = async () => {}; d.validateImports = async () => {};
  const state = { version: 2, identity: deploymentIdentity, deployer: address(99), salt: hash('retained'), reuse: {}, completed: [], transactions: [], addresses: {} };
  return { d, state };
}
test('every legacy prefix before test-token creation retains history and can batch remaining deployments', async () => {
  const { d, state } = fixture();
  const old = d.steps(state);
  for (let i = 0; i <= old.findIndex(s => s.id === 'tokenL1'); i++) {
    const saved = structuredClone(state);
    saved.completed = old.slice(0, i).map(s => s.id);
    saved.transactions = old.slice(0, i).map(s => hash(s.id));
    for (const step of old.slice(0, i)) if (step.output) saved.addresses[step.output] = address(100 + Object.keys(saved.addresses).length);
    const grouped = await d.group(saved), parsed = readDeployment(JSON.stringify(grouped));
    assert.equal(parsed.version, 4);
    assert.deepEqual(parsed.completed, saved.completed); assert.deepEqual(parsed.transactions, saved.transactions);
    assert.deepEqual(parsed.addresses, saved.addresses); assert.equal(parsed.salt, saved.salt);
    assert.deepEqual(d.steps(parsed).slice(0, i).map(s => s.id), saved.completed);
    assert.equal(d.steps(parsed).length - i, i ? 5 : 6);
    assert.equal(await d.group(parsed), parsed);
  }
});
test('pending requests, saved reviews and old wallet-owned token setups retain their original plan', async () => {
  const { d, state } = fixture();
  const pending = { ...state, pending: { id: 'singletonL1', chain: 'l1', sender: state.deployer, nonce: '0x0', data: '0x1234' } };
  assert.equal(await d.group(pending), pending);
  const reviewed = { ...state, review: { safeHash: hash('immutable review') } };
  assert.equal(await d.group(reviewed), reviewed);
  const later = { ...state, addresses: { tokenL1: address(555) } };
  assert.equal(await d.group(later), later);
});
test('version-3 journals archive exactly before grouping; quota failures preserve the original', async () => {
  const { d, state } = fixture();
  state.version = 3; state.simplification = { preserved: 1, official: {} };
  state.completed = ['singletonL1']; state.transactions = [hash('already confirmed')]; state.addresses.singletonL1 = address(100);
  const grouped = await d.group(state);
  const raw = JSON.stringify(state), map = new Map([[sharedDeploymentKey, raw]]);
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  saveDeployment(storage, grouped);
  assert.equal(map.get(`${previousGroupedDeploymentKey}:${state.salt}`), raw);
  assert.deepEqual(readDeployment(map.get(sharedDeploymentKey)), grouped);
  assert.throws(() => saveDeployment({ getItem: () => raw, setItem: () => { throw Error('quota'); } }, grouped), /quota/);
  for (const change of [s => s.addresses.singletonL1 = address(999), s => s.transactions[0] = hash('replacement'), s => s.deployer = address(998)]) {
    const bad = structuredClone(grouped); change(bad);
    assert.throws(() => readDeployment(JSON.stringify(bad)), /replaced confirmed progress/);
    assert.throws(() => saveDeployment({ ...storage, getItem: () => raw }, bad), /cannot replace/);
  }
});
test('an existing EEZ-X Safe keeps its separate current-quorum owner-adoption step', async () => {
  const { d, state } = fixture();
  state.reuse.l2 = { address: address(222), singleton: address(223) };
  state.addresses.safeL2 = address(222); state.addresses.singletonL2 = address(223);
  const grouped = await d.group(state), plan = d.steps(grouped);
  assert.equal(plan.filter(s => s.migration).length, 1);
  assert.equal(plan.find(s => s.migration).id, 'adoptL2');
  assert(!plan.find(s => s.id === 'contractsBatchL2').group.actions.some(s => s.id === 'safeL2' || s.id === 'singletonL2'));
});

test('occupied CREATE addresses become required proxy calls while confirmed grouped phases remain unchanged', async () => {
  const { d, state } = fixture();
  state.completed = ['singletonL1']; state.transactions = [hash('first')]; state.addresses.singletonL1 = address(100);
  let grouped = await d.group(state);
  grouped.completed.push('contractsBatchL1'); grouped.transactions.push(hash('contracts'));
  grouped.addresses.bootstrapL1 = address(101); grouped.addresses.safeL1 = address(102); grouped.addresses.bridgeL1 = address(103);
  const created = [0n, 1n].map(nonce => getContractAddress({ from: state.deployer, nonce }).toLowerCase());
  d.rpc = async (_chain, method, params) => method === 'eth_getCode' ? created.includes(params[0].toLowerCase()) ? '0x6000' : '0x' : '0x0';
  const next = await d.prepareWallet(grouped);
  assert.equal(next.grouping.walletPreparation.calls, 2);
  assert.deepEqual(next.completed, grouped.completed); assert.deepEqual(next.transactions, grouped.transactions);
  assert.equal(d.steps(next).length, 8);
  assert.deepEqual(d.steps(next).slice(2, 4).map(s => s.id), ['prepareWalletL2_0', 'prepareWalletL2_1']);
  assert.deepEqual(d.steps(next)[2].args(), [address(102), 0n]);
  assert.deepEqual(d.steps(next)[3].args(), [address(103), 0n]);
  assert.equal(await d.prepareWallet(next), next);
  assert.deepEqual(readDeployment(JSON.stringify(next)), next);
  const pending = { ...grouped, pending: { id: 'contractsBatchL2' } };
  assert.equal(await d.prepareWallet(pending), pending);
  d.rpc = async (_chain, method) => method === 'eth_getCode' ? '0x6000' : '0x0';
  await assert.rejects(d.prepareWallet(grouped), /More than two/);
});
