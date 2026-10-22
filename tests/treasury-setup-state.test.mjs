import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toHex } from 'viem';
import { deploymentIdentity, legacyDeploymentKey, legacyManifestKey, loadDeployment, sharedDeploymentKey, sharedManifestKey, saveDeployment } from '../src/lib/treasury/deployment.ts';
import { restartSetup, loadActiveManifest, setupSnapshot, withActiveTreasury } from '../src/lib/treasury/setupState.ts';
const address = n => toHex(n, { size: 20 });
const hash = value => keccak256(toHex(value));
const wallet = address(44);
const fresh = (label = 'fresh') => ({ version: 2, identity: deploymentIdentity, deployer: wallet, salt: hash(label), reuse: {}, addresses: {}, completed: [], transactions: [] });
function fixture() {
  const state = { ...fresh('previous'), completed: ['singletonL1'], transactions: [hash('confirmed')], addresses: { singletonL1: address(10), safeL1: address(11), safeL2: address(12) } };
  const manifest = { version: 1, environment: 'isolated-devnet', instance: hash(`${state.salt}:${state.addresses.safeL1}:${state.addresses.safeL2}`),
    l1: { chainId: 1337, rpc: 'http://127.0.0.1:1234/l1', genesis: hash('l1') },
    l2: { chainId: 420691, rpc: 'http://127.0.0.1:1234/l2', front: 'http://127.0.0.1:1234/composer', genesis: hash('l2') },
    registry: address(1), manager: address(2), safeL1: address(11), safeL2: address(12), adapter: address(13), action: address(14), ownerLabels: {},
    code: [11, 12, 13, 14].map(n => ({ chain: n === 11 ? 'l1' : 'l2', address: address(n), hash: hash(n) })) };
  const historyKey = `eez:treasury:history:${manifest.instance}`;
  const values = new Map([[sharedDeploymentKey, JSON.stringify(state)], [sharedManifestKey, JSON.stringify(manifest)], [historyKey, '{"retained":"history"}'], ['unrelated', 'keep']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { state, manifest, values, storage, historyKey };
}
test('restart selects the chooser with one write and leaves retained records untouched', () => {
  const f = fixture(), before = new Map(f.values);
  restartSetup(f.storage, setupSnapshot(f.storage));
  assert.equal(loadDeployment(f.storage), null); assert.equal(loadActiveManifest(f.storage), null);
  assert.equal(f.values.get(sharedDeploymentKey), '');
  before.set(sharedDeploymentKey, ''); assert.deepEqual(f.values, before);
  const next = fresh(); saveDeployment(f.storage, next);
  assert.equal(loadDeployment(f.storage).deployer, wallet);
  assert.notEqual(loadDeployment(f.storage).salt, f.state.salt);
  assert.equal(loadActiveManifest(f.storage), null);
});
test('restart handles partial deployments and completed manifests without a journal', () => {
  for (const partial of [true, false]) {
    const f = fixture();
    if (partial) { f.state.addresses = { singletonL1: address(10) }; f.values.set(sharedDeploymentKey, JSON.stringify(f.state)); f.values.delete(sharedManifestKey); }
    else f.values.delete(sharedDeploymentKey);
    restartSetup(f.storage, setupSnapshot(f.storage));
    assert.equal(loadActiveManifest(f.storage), null); assert.equal(loadDeployment(f.storage), null);
  }
});
test('legacy fallback cannot resurrect the old treasury after restart or reload', () => {
  const f = fixture();
  f.values.set(legacyDeploymentKey, f.values.get(sharedDeploymentKey)); f.values.delete(sharedDeploymentKey);
  f.values.set(legacyManifestKey, f.values.get(sharedManifestKey)); f.values.delete(sharedManifestKey);
  assert.equal(loadActiveManifest(f.storage).instance, f.manifest.instance);
  restartSetup(f.storage, setupSnapshot(f.storage));
  assert.equal(loadDeployment(f.storage), null); assert.equal(loadActiveManifest(f.storage), null);
  assert.equal(f.values.get(legacyManifestKey), JSON.stringify(f.manifest));
  assert.throws(() => restartSetup(f.storage, setupSnapshot(f.storage)), /no saved treasury/);
});
test('a manifest must match the selected salt even when both Safe addresses match', () => {
  const f = fixture(); f.values.set(sharedDeploymentKey, JSON.stringify({ ...f.state, salt: hash('different') }));
  assert.equal(loadActiveManifest(f.storage), null);
});
test('pending setup requests with or without hashes and live payment/owner requests block all restart writes', () => {
  for (const kind of ['unknown', 'submitted', 'payment', 'owner']) {
    const f = fixture();
    if (kind === 'unknown' || kind === 'submitted') {
      f.state.pending = { id: 'factoryL1', chain: 'l1', sender: wallet, nonce: '0x1', data: '0x6000', ...(kind === 'submitted' ? { hash: hash('pending') } : {}) };
      f.values.set(sharedDeploymentKey, JSON.stringify(f.state));
    } else f.values.set(`eez:treasury:${kind === 'owner' ? 'owners' : 'submission'}:${f.manifest.instance}`, '{}');
    const copy = new Map(f.values), before = setupSnapshot(f.storage);
    assert.ok(before.blocked); assert.throws(() => restartSetup(f.storage, before), /pending|Finish/);
    assert.deepEqual(f.values, copy);
  }
});
test('stale snapshots cannot reset a newer request or overwrite a new setup', () => {
  for (const change of ['setup', 'request']) {
    const f = fixture(), before = setupSnapshot(f.storage);
    if (change === 'setup') f.values.set(sharedDeploymentKey, JSON.stringify(fresh('other tab')));
    else f.values.set(`eez:treasury:submission:${f.manifest.instance}`, '{}');
    const copy = new Map(f.values);
    assert.throws(() => restartSetup(f.storage, before), change === 'setup' ? /changed in another tab/ : /pending verification/);
    if (change === 'setup') assert.throws(() => saveDeployment(f.storage, f.state), /changed in another tab/);
    assert.deepEqual(f.values, copy);
  }
});
test('background progress refresh of the same treasury does not prevent restarting', () => {
  const f = fixture(), before = setupSnapshot(f.storage);
  f.values.set(sharedDeploymentKey, JSON.stringify({ ...f.state, addresses: { ...f.state.addresses, singletonL2: address(80) } }));
  restartSetup(f.storage, before);
  assert.equal(loadDeployment(f.storage), null); assert.equal(loadActiveManifest(f.storage), null);
});
test('selection storage failure retains the original active setup and permits retry', () => {
  const f = fixture(), before = setupSnapshot(f.storage), copy = new Map(f.values);
  const broken = { ...f.storage, setItem() { throw new Error('Storage full'); } };
  assert.throws(() => restartSetup(broken, before), /Storage full/);
  assert.deepEqual(f.values, copy); assert.equal(loadActiveManifest(f.storage).instance, f.manifest.instance);
  restartSetup(f.storage, before); assert.equal(loadDeployment(f.storage), null);
});
test('unused archives from older builds are neither read nor modified by restart', () => {
  const f = fixture(), key = `eez:treasury:archives:${deploymentIdentity}`, old = '{invalid old archive';
  f.values.set(key, old);
  restartSetup(f.storage, setupSnapshot(f.storage));
  assert.equal(f.values.get(key), old); assert.equal(loadActiveManifest(f.storage), null);
});
test('live actions hold the setup lock and stale/contending tabs never invoke their action', async () => {
  const f = fixture(); let held = false, calls = 0;
  const locks = { async request(name, options, fn) {
    assert.equal(name, sharedDeploymentKey); assert.equal(options.ifAvailable, true);
    if (held) return fn(null);
    held = true; try { return await fn({ name }); } finally { held = false; }
  } };
  await withActiveTreasury(f.storage, locks, f.manifest.instance, async () => {
    assert.equal(held, true); calls++;
    await assert.rejects(withActiveTreasury(f.storage, locks, f.manifest.instance, async () => { calls++; }), /Another treasury action/);
  });
  restartSetup(f.storage, setupSnapshot(f.storage));
  await assert.rejects(withActiveTreasury(f.storage, locks, f.manifest.instance, async () => { calls++; }), /no longer active/);
  assert.equal(calls, 1); assert.equal(held, false);
});
