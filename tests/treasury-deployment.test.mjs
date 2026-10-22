import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, getAddress, getContractAddress, keccak256, stringToHex, toHex } from 'viem';
import { TreasuryDeployment, deploymentIdentity, isSharedTarget, matchesRuntime, readDeployment, loadDeployment, sharedDeploymentKey, legacyDeploymentKey, previousDeploymentKey, saveDeployment } from '../src/lib/treasury/deployment.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { matchingSafeCode } from '../src/lib/treasury/safeSetup.ts';
const artifacts = JSON.parse(readFileSync(new URL('../src/lib/treasury/deployment-artifacts.json', import.meta.url)));
const profile = JSON.parse(readFileSync(new URL('../src/lib/treasury/shared-network.json', import.meta.url)));
const target = { l1: { rpc: 'http://127.0.0.1/l1', front: 'http://127.0.0.1/composer/l1' }, l2: { rpc: 'http://127.0.0.1/l2', front: 'http://127.0.0.1/composer/l2' }, fees: { l1: '100000000000000000', l2: '100000000000000000' } };
const hash = text => keccak256(stringToHex(text));
const address = n => toHex(n, { size: 20 });
const create = () => new TreasuryDeployment(target, artifacts);
const selectedWallet = getAddress('0x000000000000000000000000000000000000a11c');
const empty = () => ({ version: 2, identity: deploymentIdentity, deployer: selectedWallet, salt: hash('chosen setup'), reuse: {}, completed: [], transactions: [], addresses: {} });
function receiptFixture() {
  const deployment = create(), pending = { id: 'singletonL1', chain: 'l1', sender: selectedWallet, nonce: '0x4', data: artifacts.contracts.Safe.bytecode, hash: hash('deployment') };
  const state = { ...empty(), pending };
  const tx = { from: selectedWallet, to: null, input: pending.data, nonce: pending.nonce, value: '0x0' };
  const receipt = { status: '0x1', blockNumber: '0x20', blockHash: hash('block'), contractAddress: getContractAddress({ from: selectedWallet, nonce: 4n }), logs: [] };
  const observed = { tx, receipt, block: { number: receipt.blockNumber, hash: receipt.blockHash, timestamp: '0x1234' }, head: { number: '0x20' }, code: artifacts.contracts.Safe.runtime };
  deployment.rpc = async (_chain, method, params) => {
    if (method === 'eth_getBlockByNumber') return params[0] === 'safe' ? observed.head : observed.block;
    return { eth_getTransactionReceipt: observed.receipt, eth_getTransactionByHash: observed.tx, eth_getCode: observed.code }[method];
  };
  return { deployment, state, observed };
}
test('shared deployment requires the reviewed network and all three artifact pins', () => {
  assert.equal(isSharedTarget('10200', '906969', profile.registry, profile.manager), true);
  assert.equal(isSharedTarget('10200', '906969', profile.registry, address(12)), false);
  for (const pin of ['core', 'safe', 'modules']) assert.throws(() => new TreasuryDeployment(target, { ...artifacts, [pin]: 'another revision' }), /artifacts/);
});
test('the setup creates the selected wallet as the sole L1 owner, binds bridges atomically and configures 100/150 with no Guard', () => {
  const deployment = create(), state = empty();
  const initial = deployment.steps(state);
  for (const step of initial) if (step.output) state.addresses[step.output] = address(100 + Object.keys(state.addresses).length);
  const steps = deployment.steps(state), byId = id => steps.find(s => s.id === id);
  assert.equal(steps.length, 31);
  const setup = decodeFunctionData({ abi: artifacts.contracts.Safe.abi, data: byId('safeL1').args()[1] });
  assert.deepEqual(setup.args.slice(0, 2), [[selectedWallet], 1n]);
  assert.equal(byId('bridgeL1').artifact, 'ConfiguredTreasuryBridge');
  assert.equal(byId('bridgeL1').args()[3], 0n); assert.equal(byId('bridgeL2').args()[3], 1n);
  assert.equal(byId('bridgeL1').args()[4], selectedWallet);
  assert.equal(byId('policy').args()[3], state.addresses.aliasReaderL1);
  assert.equal(byId('fundL2').args()[1], 150_000_000n);
  for (const id of ['limitL1', 'limitL2']) assert.deepEqual(byId(id).args().slice(2), [100_000_000n, 10, 10]);
  assert.equal(steps.some(s => s.method === 'setGuard' || s.method === 'initialize'), false);
  assert.deepEqual(steps.filter(s => s.quoted).map(s => s.id), ['fundL2', 'enableL2', 'delegateL2', 'limitL2']);
  assert.equal(byId('fundL1').args()[1], 300_000_000n);
});
test('saved progress must retain its deployment identity, transaction history and strict step order', () => {
  const saved = { ...empty(), completed: ['singletonL1'], addresses: { singletonL1: address(9) }, transactions: [hash('first')] };
  assert.deepEqual(readDeployment(JSON.stringify(saved)), saved);
  assert.throws(() => readDeployment(JSON.stringify({ ...saved, identity: hash('other network') })), /Invalid saved/);
  assert.throws(() => readDeployment(JSON.stringify({ ...saved, transactions: [] })), /Invalid saved/);
  assert.throws(() => create().steps({ ...saved, completed: ['factoryL1'] }), /order/);
  assert.throws(() => readDeployment(JSON.stringify({ ...saved, pending: { id: 'factoryL1', chain: 'l1', sender: 'invalid', nonce: '0x1', data: '0x1234' } })), /Invalid pending/);
});
test('an unresolved wallet request cannot trigger another preparation, even after reload', async () => {
  const { deployment, state } = receiptFixture(); delete state.pending.hash;
  deployment.validate = async () => assert.fail('must stop before network validation');
  await assert.rejects(deployment.prepare(readDeployment(JSON.stringify(state)), { request() { assert.fail('wallet must not be called'); } }), /pending deployment/);
  await assert.rejects(deployment.reconcile(state), /Wallet response missing/);
});
test('only an exact canonical confirmed transaction advances deployment', async () => {
  const f = receiptFixture();
  const next = await f.deployment.reconcile(f.state);
  assert.deepEqual(next.completed, ['singletonL1']); assert.equal(next.identity, deploymentIdentity);
  assert.equal(next.addresses.singletonL1, f.observed.receipt.contractAddress); assert.equal(next.pending, undefined);
  assert.equal(f.state.completed.length, 0, 'reconciliation does not mutate the saved request');
  for (const [field, wrong] of [['from', address(3)], ['to', address(5)], ['input', '0x1234'], ['nonce', '0x5'], ['value', '0x1']]) {
    const g = receiptFixture(); g.observed.tx[field] = wrong;
    await assert.rejects(g.deployment.reconcile(g.state), /does not match/);
  }
  for (const incomplete of ['noReceipt', 'reorg']) {
    const g = receiptFixture();
    if (incomplete === 'noReceipt') g.observed.receipt = null;
    if (incomplete === 'reorg') g.observed.block.hash = hash('reorg');
    assert.equal(await g.deployment.reconcile(g.state), g.state);
  }
});
test('a confirmed revert, wrong CREATE address or different runtime cannot be recorded as deployed', async () => {
  for (const failure of ['revert', 'address', 'code']) {
    const f = receiptFixture();
    if (failure === 'revert') f.observed.receipt.status = '0x0';
    if (failure === 'address') f.observed.receipt.contractAddress = address(12);
    if (failure === 'code') f.observed.code = '0x1234';
    await assert.rejects(f.deployment.reconcile(f.state), /reverted|Unexpected contract address|bytecode/);
  }
});
function trackingFixture() {
  const f = receiptFixture(), calls = [];
  const foundHash = hash('replacement');
  const lookup = { consumed: true, consumedAt: 1022n, historyAvailable: true, blockAvailable: true, count: undefined };
  f.observed.head = { number: '0x400', hash: hash('safe head') };
  f.observed.receipt.blockNumber = toHex(lookup.consumedAt);
  f.observed.block.number = f.observed.receipt.blockNumber;
  f.observed.tx.hash = foundHash;
  f.deployment.rpc = async (chain, method, params) => {
    calls.push({ chain, method, params });
    if (method === 'eth_getTransactionReceipt') return params[0] === foundHash ? f.observed.receipt : null;
    if (method === 'eth_getTransactionByHash') return params[0] === foundHash ? f.observed.tx : null;
    if (method === 'eth_getCode') return f.observed.code;
    if (method === 'eth_getTransactionCount') {
      if (!lookup.historyAvailable) throw new Error('historical state unavailable');
      if (lookup.count !== undefined) return lookup.count;
      return toHex(lookup.consumed && BigInt(params[1]) >= lookup.consumedAt ? 5 : 4);
    }
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest' || params[0] === f.observed.head.number) return f.observed.head;
      if (!params[1]) return f.observed.block;
      if (!lookup.blockAvailable) return null;
      return { number: params[0], hash: f.observed.receipt.blockHash,
        transactions: [{ ...f.observed.tx, from: address(999) }, f.observed.tx] };
    }
    assert.fail(`unexpected tracking RPC ${method}`);
  };
  return { ...f, calls, lookup, foundHash };
}
test('setup tracking keeps the known-receipt path and does nothing without a pending request', async () => {
  const f = trackingFixture();
  const done = empty(); assert.equal(await f.deployment.trackPending(done), done); assert.deepEqual(f.calls, []);
  f.state.pending.hash = f.foundHash;
  assert.equal(await f.deployment.trackPending(f.state), f.state);
  assert.deepEqual(f.calls.map(c => c.method), ['eth_getTransactionReceipt']);
});
test('setup tracking recovers lost responses and repricing by sender and nonce on either chain', async () => {
  for (const chain of ['l1', 'l2']) for (const missing of [true, false]) {
    const f = trackingFixture(); f.state.pending.chain = chain;
    if (missing) delete f.state.pending.hash;
    const original = structuredClone(f.state);
    const tracked = await f.deployment.trackPending(readDeployment(JSON.stringify(f.state)));
    assert.deepEqual(tracked, { ...original, pending: { ...original.pending, hash: f.foundHash } });
    assert.deepEqual(f.state, original); assert.deepEqual(tracked.completed, []);
    assert.deepEqual(readDeployment(JSON.stringify(tracked)), tracked, 'old journal versions retain the found hash after reload');
    assert.ok(f.calls.every(c => c.chain === chain));
    const blocks = f.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[1]);
    assert.deepEqual(blocks.map(c => c.params[0]), [toHex(f.lookup.consumedAt)]);
    assert.ok(f.calls.filter(c => c.method === 'eth_getTransactionCount').length <= 11, 'nonce search is logarithmic within 512 blocks');
    const start = f.calls.length;
    await f.deployment.trackPending(f.state);
    assert.ok(f.calls.slice(start).every(c => ['eth_getBlockByNumber', 'eth_getTransactionReceipt'].includes(c.method)));
    assert.ok(f.calls.slice(start).every(c => c.method !== 'eth_getBlockByNumber' || c.params[0] === 'latest'), 'unchanged canonical head reuses discovery');
  }
});
test('setup tracking still requires canonical execution and successful deployment validation', async () => {
  for (const failure of ['none', 'reorg', 'notSafe', 'revert', 'code', 'mismatch']) {
    const f = trackingFixture(); delete f.state.pending.hash;
    const tracked = await f.deployment.trackPending(f.state);
    assert.deepEqual(tracked.completed, [], 'discovery alone never completes setup');
    if (failure === 'reorg') f.observed.block.hash = hash('different canonical block');
    if (failure === 'notSafe') f.observed.head.number = toHex(f.lookup.consumedAt - 1n);
    if (failure === 'revert') f.observed.receipt.status = '0x0';
    if (failure === 'code') f.observed.code = '0x1234';
    if (failure === 'mismatch') f.observed.tx.input = '0xabcd';
    if (['revert', 'code', 'mismatch'].includes(failure)) {
      await assert.rejects(f.deployment.reconcile(tracked), /reverted|bytecode|does not match/);
      assert.equal(tracked.pending.hash, f.foundHash, 'failed execution remains inspectable');
    } else {
      const next = await f.deployment.reconcile(tracked);
      if (failure === 'none' || failure === 'notSafe') { assert.deepEqual(next.completed, ['singletonL1']); assert.deepEqual(next.transactions, [f.foundHash]); }
      else assert.equal(next, tracked);
    }
  }
});
test('setup tracking rejects cancellations and changed calls, without replacing the saved request', async () => {
  for (const [field, wrong] of [['to', selectedWallet], ['input', '0x'], ['value', '0x1'], ['hash', '0xab']]) {
    const f = trackingFixture(), original = structuredClone(f.state);
    f.observed.tx[field] = wrong;
    await assert.rejects(f.deployment.trackPending(f.state), /nonce was used for a different transaction/);
    assert.deepEqual(f.state, original);
  }
  for (const [field, wrong] of [['from', address(3)], ['nonce', '0x5']]) {
    const f = trackingFixture(); f.observed.tx[field] = wrong;
    assert.equal(await f.deployment.trackPending(f.state), f.state, 'another sender or nonce is not a match');
  }
});
test('setup tracking bounds historical lookup and leaves unconsumed or older requests unresolved', async () => {
  for (const mode of ['unconsumed', 'older', 'boundary']) {
    const f = trackingFixture();
    if (mode === 'unconsumed') f.lookup.consumed = false;
    else f.lookup.consumedAt = mode === 'older' ? 500n : 512n;
    assert.equal(await f.deployment.trackPending(f.state), f.state);
    assert.equal(f.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[1]).length, 0);
    assert.ok(f.calls.filter(c => c.method === 'eth_getTransactionCount').length <= 2);
  }
});
test('setup tracking retries after RPC gaps and never caches failed or malformed history', async () => {
  for (const mode of ['history', 'block', 'quantity']) {
    const f = trackingFixture();
    if (mode === 'history') f.lookup.historyAvailable = false;
    if (mode === 'block') f.lookup.blockAvailable = false;
    if (mode === 'quantity') f.lookup.count = 'invalid';
    await assert.rejects(f.deployment.trackPending(f.state), /unavailable/);
    f.lookup.historyAvailable = true; f.lookup.blockAvailable = true; f.lookup.count = undefined;
    assert.equal((await f.deployment.trackPending(f.state)).pending.hash, f.foundHash);
  }
});
test('setup tracking invalidates a cached lookup when the canonical head changes at the same height', async () => {
  const f = trackingFixture(); f.lookup.consumed = false;
  assert.equal(await f.deployment.trackPending(f.state), f.state);
  f.lookup.consumed = true;
  assert.equal(await f.deployment.trackPending(f.state), f.state);
  f.observed.head.hash = hash('reorg at the same height');
  assert.equal((await f.deployment.trackPending(f.state)).pending.hash, f.foundHash);
});
test('runtime comparison tolerates only compiler-declared immutable slots', () => {
  const a = { runtime: '0x6000000055', immutables: [{ start: 1, length: 3 }] };
  assert.equal(matchesRuntime('0x6012345655', a), true);
  assert.equal(matchesRuntime('0x6012345656', a), false);
  assert.equal(matchesRuntime('0x601234565500', a), false);
  assert.equal(matchesRuntime('0x6012345655', { ...a, immutables: [{ start: 1, length: 10 }] }), false);
});
test('the selected wallet with no test gas stops before signing, fee quotes or gas estimation', async () => {
  const deployment = create(); deployment.validate = async () => {};
  const methods = [];
  const provider = { request: async ({ method, params }) => {
    methods.push(method);
    if (method === 'eth_accounts') return [selectedWallet];
    if (method === 'eth_chainId') return '0x27d8';
    if (method === 'eth_call') {
      const [nonce] = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data }).args;
      return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, 10200n,
        stringToHex(JSON.stringify({ version: 'test', supportedNetworks: { eezL1: 10200, eezL2: 906969 }, eezContracts: { eezRegistryAddress: profile.registry, eezL2Address: profile.manager } }))] });
    }
    assert.fail(`Unexpected wallet write: ${method}`);
  } };
  deployment.rpc = async (_chain, method) => { assert.equal(method, 'eth_getBalance'); return '0x0'; };
  await assert.rejects(deployment.prepare(empty(), provider), /needs test xDAI/);
  assert.equal(methods.includes('eth_signTypedData_v4'), false); assert.equal(methods.includes('eth_sendTransaction'), false);
});
test('a changed network reference prevents wallet interaction', async () => {
  const deployment = create();
  deployment.rpc = async (_chain, method) => ({ eth_chainId: '0x27d8', eth_getBlockByNumber: { hash: hash('different chain') }, eth_getStorageAt: toHex(0, { size: 32 }), eth_getCode: '0x1234' })[method];
  await assert.rejects(deployment.prepare(empty(), { request() { assert.fail('must not open the wallet'); } }), /network or protocol deployment changed/);
});

test('new setup requires an existing L1 Safe, preserves its owners, and selects the bidirectional policy', async () => {
  const d = create(); d.validate = async () => {};
  infrastructure(d, false);
  const original = d.rpc, existing = address(123), singleton = address(124), owners = [address(42), address(43)];
  d.rpc = async (chain, method, params) => {
    if (method === 'eth_getCode' && params[0].toLowerCase() === existing) return artifacts.contracts.SafeProxy.runtime;
    if (method === 'eth_getCode' && params[0].toLowerCase() === singleton) return artifacts.contracts.Safe.runtime;
    if (method === 'eth_getStorageAt') return params[1] === '0x0' ? toHex(124n, { size: 32 }) : toHex(0n, { size: 32 });
    return original(chain, method, params);
  };
  d.read = async (_chain, _target, _artifact, name) => ({ VERSION: '1.4.1', getOwners: owners, getThreshold: 2n, nonce: 8n,
    getModulesPaginated: [[], address(1)] })[name];
  await assert.rejects(d.configure(address(42)), /existing Chiado Safe address/);
  const one = await d.configure(address(42), existing), two = await d.configure(address(43), existing);
  assert.notEqual(one.salt, two.salt);
  for (const state of [one, two]) {
    assert.equal(state.bidirectional, true); assert.deepEqual(state.reuse.l1.owners, owners);
    assert.equal(state.reuse.l1.threshold, 2); assert.equal(state.addresses.safeL1, getAddress(existing));
    assert(!d.steps(state).some(step => ['singletonL1', 'factoryL1', 'safeL1'].includes(step.id)));
    assert.equal(d.steps(state).find(step => step.id === 'policy').artifact, 'BidirectionalTreasuryPolicy');
    assert.deepEqual(readDeployment(JSON.stringify(state)), state);
  }
});
test('saved policy versions cannot be switched while a deployment is in progress', () => {
  const before = empty(), next = { ...before, bidirectional: true };
  const storage = { getItem: () => JSON.stringify(before), setItem: () => assert.fail('must not overwrite') };
  assert.throws(() => saveDeployment(storage, next), /changed in another tab/);
  assert.throws(() => readDeployment(JSON.stringify({ ...before, bidirectional: false })), /policy version/);
  assert.deepEqual(artifacts.contracts.TreasuryPolicy, JSON.parse(readFileSync(new URL('../contracts/legacy/artifacts/TreasuryPolicy.json', import.meta.url))));
});
test('reuse is independent for each chain; only an unadapted L2 Safe needs owner adoption', () => {
  const d = create();
  for (const [l1, l2, adapter, length] of [[true, false, false, 28], [false, true, false, 30], [true, true, false, 27], [true, true, true, 24]]) {
    const state = empty();
    const imported = { address: address(9), singleton: address(8), owners: [address(7)], threshold: 1 };
    if (l1) state.reuse.l1 = imported;
    if (l2) state.reuse.l2 = { ...imported, ...(adapter ? { adapter: { address: address(6) } } : {}) };
    const plan = d.steps(state);
    assert.equal(plan.length, length);
    assert.equal(plan.some(s => s.id === 'safeL1'), !l1);
    assert.equal(plan.some(s => s.id === 'safeL2'), !l2);
    assert.equal(plan.some(s => s.migration), l2 && !adapter);
    assert.equal(plan.some(s => s.id === 'adapter'), !adapter);
    assert.equal(plan.some(s => s.method === 'setGuard'), false);
  }
});
test('active legacy journals migrate without changing the deployer, salt, pending request or completed history', () => {
  const legacyIdentity = hash(JSON.stringify(profile));
  const old = { version: 1, identity: legacyIdentity, completed: ['singletonL1'], addresses: { singletonL1: address(9) }, transactions: [hash('first')],
    pending: { id: 'factoryL1', chain: 'l1', sender: profile.initialOwner, nonce: '0x4', data: '0x1234' } };
  const migrated = readDeployment(JSON.stringify(old));
  assert.equal(migrated.version, 2); assert.equal(migrated.deployer, profile.initialOwner);
  assert.equal(migrated.salt, legacyIdentity); assert.deepEqual(migrated.pending, old.pending);
  assert.deepEqual(migrated.completed, old.completed); assert.deepEqual(migrated.transactions, old.transactions);
  assert.equal(readDeployment(JSON.stringify({ ...old, completed: [], transactions: [], pending: undefined })), null);
  const storage = new Map([[legacyDeploymentKey, JSON.stringify(old)]]);
  assert.deepEqual(loadDeployment({ getItem: key => storage.get(key) ?? null }), migrated);
  storage.set(sharedDeploymentKey, JSON.stringify(empty()));
  assert.deepEqual(loadDeployment({ getItem: key => storage.get(key) ?? null }), empty());
});

test('Safe proxy matching accepts compiler metadata changes but rejects changed executable instructions', () => {
  const proxy = artifacts.contracts.SafeProxy.runtime;
  const bodyLength = proxy.length - Number.parseInt(proxy.slice(-4), 16) * 2 - 4;
  const changedMetadata = proxy.slice(0, bodyLength + 8) + (proxy[bodyLength + 8] === '0' ? '1' : '0') + proxy.slice(bodyLength + 9);
  assert(matchingSafeCode(changedMetadata, proxy));
  assert(!matchingSafeCode('0x01' + proxy.slice(4), proxy));
  assert(!matchingSafeCode('0x', proxy));
  assert(!matchingSafeCode(proxy + '00', proxy));
});

test('repeated immutable slots must agree before a reused adapter runtime is accepted', () => {
  const refs = [{ start: 1, length: 3 }, { start: 5, length: 3 }];
  const artifact = { runtime: '0x600000006000000055', immutables: refs, immutableGroups: [refs] };
  assert(matchesRuntime('0x60aabbcc60aabbcc55', artifact));
  assert(!matchesRuntime('0x60aabbcc6011223355', artifact));
});

const officialRuntime = JSON.parse(readFileSync(new URL('./fixtures/official-safe-runtime.json', import.meta.url)));
function infrastructure(d, present = true) {
  const calls = [];
  d.rpc = async (chain, method, params) => {
    calls.push({ chain, method, params });
    if (method === 'eth_getBlockByNumber') return { number: '0x42', hash: hash('infrastructure block') };
    if (method === 'eth_chainId') return toHex(profile.chains[chain].chainId);
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getCode') return chain === 'l1' && present
      ? Object.values(officialRuntime.contracts).find(item => item.address.toLowerCase() === params[0].toLowerCase())?.runtime ?? '0x' : '0x';
    assert.fail(`Unexpected RPC ${method}`);
  };
  return calls;
}
test('simplification keeps a confirmed singleton and reuses official Chiado factory and batching code', async () => {
  const d = create(); d.validate = async () => {}; infrastructure(d);
  const old = { ...empty(), completed: ['singletonL1'], transactions: [hash('confirmed')], addresses: { singletonL1: address(909) } };
  const copy = structuredClone(old), next = await d.simplify(old);
  assert.deepEqual(old, copy); assert.equal(next.version, 3);
  for (const key of ['deployer', 'salt', 'identity', 'completed', 'transactions']) assert.deepEqual(next[key], old[key]);
  assert.equal(next.addresses.singletonL1, old.addresses.singletonL1);
  assert.equal(next.addresses.factoryL1, officialRuntime.contracts.factory.address);
  assert.equal(next.addresses.multiSendL1, officialRuntime.contracts.multiSend.address);
  const plan = d.steps(next);
  assert.equal(plan.length, 23); assert.equal(plan[next.completed.length].id, 'safeL1');
  assert(!plan.some(step => ['factoryL1', 'action', 'invoiceMerchant', 'merchantPolicy', 'alias'].includes(step.id)));
  assert.deepEqual(plan.filter(step => step.batch).map(step => step.batch.map(call => call.id)),
    [['alias', 'enableL1', 'delegateL1', 'limitL1'], ['enableL2', 'delegateL2', 'limitL2']]);
  assert.deepEqual(readDeployment(JSON.stringify(next)), next);
  const values = new Map([[sharedDeploymentKey, JSON.stringify(old)]]);
  saveDeployment({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, next);
  assert.deepEqual(JSON.parse(values.get(`${previousDeploymentKey}:${old.salt}`)), old);
  assert.equal(JSON.parse(values.get(sharedDeploymentKey)).version, 3);
});
test('every old completed prefix migrates without repeating completed configuration, including partial Safe batches', async () => {
  for (let count = 0; count <= 31; count++) {
    const d = create(); d.validate = async () => {}; infrastructure(d); d.policyAlias = async () => address(777);
    const old = empty(), plan = d.steps(old);
    for (const step of plan.slice(0, count)) if (step.output) old.addresses[step.output] = address(100 + Object.keys(old.addresses).length);
    old.completed = plan.slice(0, count).map(step => step.id); old.transactions = old.completed.map(hash);
    const next = await d.simplify(old), projected = d.steps(next);
    assert.deepEqual(projected.slice(0, count).map(step => step.id), old.completed);
    assert.deepEqual(next.transactions, old.transactions);
    assert(projected.length <= 31, `extra transactions at old prefix ${count}`);
    for (const call of projected.slice(count).flatMap(step => step.batch ?? [step])) assert(!old.completed.includes(call.id), `repeated ${call.id} at ${count}`);
    if (old.addresses.invoiceMerchant) assert.equal(next.addresses.invoiceMerchant, old.addresses.invoiceMerchant);
  }
});
test('pending wallet requests and collected Safe approvals retain their exact old plan until resolved', async () => {
  for (const extra of [{ pending: { id: 'singletonL1', data: '0x1234', hash: hash('pending') } }, { review: { safeHash: hash('signed'), approvals: ['retained'] } }]) {
    const d = create(); d.validate = () => assert.fail('must not migrate an unresolved request');
    const state = { ...empty(), ...extra }; assert.equal(await d.simplify(state), state); assert.equal(d.steps(state).length, 31);
  }
});
test('official infrastructure is pinned to its address, exact code and stable canonical observation', async () => {
  const d = create(); d.validate = async () => {}; infrastructure(d);
  const next = await d.simplify(empty()); await d.validateImports(next);
  const changed = structuredClone(next); changed.addresses.factoryL1 = address(777);
  assert.throws(() => readDeployment(JSON.stringify(changed)), /official Safe deployment binding/);
  const original = d.rpc;
  d.rpc = async (chain, method, params) => method === 'eth_getCode' ? '0x6000' : original(chain, method, params);
  await assert.rejects(d.validateImports(next), /infrastructure changed/);
  await assert.rejects(d.simplify(empty()), /unexpected bytecode/);
  d.rpc = async (chain, method, params) => method === 'eth_getBlockByNumber' && params[0] !== 'latest'
    ? { hash: hash('reorg') } : original(chain, method, params);
  await assert.rejects(d.simplify(empty()), /changed during review/);
});
test('unavailable infrastructure falls back to local deployments, not a different Safe version', async () => {
  const d = create(); d.validate = async () => {}; infrastructure(d, false);
  const next = await d.simplify(empty()), plan = d.steps(next);
  assert.equal(plan.length, 25); assert.deepEqual(next.simplification.official, {});
  assert.equal(plan.find(step => step.id === 'singletonL1').artifact, 'Safe');
});

test('a pending old policy deployment confirms using its exact historical initcode identity', async () => {
  const old = JSON.parse(readFileSync(new URL('./fixtures/treasury-policy-v2.json', import.meta.url)));
  const f = receiptFixture(), plan = f.deployment.steps(f.state);
  const count = plan.findIndex(step => step.id === 'policy');
  f.state.completed = plan.slice(0, count).map(step => step.id); f.state.transactions = f.state.completed.map(hash);
  f.state.pending.id = 'policy'; f.state.pending.chain = 'l2';
  f.state.pending.data = old.bytecode + '0'.repeat(9 * 64); f.observed.tx.input = f.state.pending.data;
  f.observed.code = old.runtime;
  assert.equal((await f.deployment.reconcile(f.state)).completed.at(-1), 'policy');
  f.state.pending.data = '0xff' + f.state.pending.data.slice(4); f.observed.tx.input = f.state.pending.data;
  await assert.rejects(f.deployment.reconcile(f.state), /bytecode does not match/);
});

test('a final single configuration call does not add a helper, while already-started older batches stay resumable', async () => {
  const d = create(); d.validate = async () => {}; infrastructure(d); d.policyAlias = async () => address(777);
  const old = empty(), plan = d.steps(old);
  old.completed = plan.slice(0, 30).map(step => step.id); old.transactions = old.completed.map(hash);
  for (const step of plan.slice(0, 30)) if (step.output) old.addresses[step.output] = address(100 + Object.keys(old.addresses).length);
  const next = await d.simplify(old);
  assert.equal(d.steps(next).length, 31); assert.equal(d.steps(next)[30].id, 'limitL2');
  for (const pendingId of ['multiSendL2', 'configureL2']) {
    const current = { ...next, pending: { id: pendingId } };
    assert.deepEqual(d.steps(current).slice(30).map(step => step.id), ['multiSendL2', 'configureL2']);
  }
  const submitted = { ...next, addresses: { ...next.addresses, multiSendL2: address(999) },
    completed: [...next.completed, 'multiSendL2'], transactions: [...next.transactions, hash('helper')] };
  assert.equal(d.steps(submitted)[31].id, 'configureL2');
});

test('migration cannot overwrite confirmed progress or replace the journal when its archive cannot be saved', async () => {
  const d = create(); d.validate = async () => {}; infrastructure(d);
  const old = { ...empty(), completed: ['singletonL1'], transactions: [hash('confirmed')], addresses: { singletonL1: address(909) } };
  const next = await d.simplify(old), raw = JSON.stringify(old), writes = [];
  const full = { getItem: key => key === sharedDeploymentKey ? raw : null,
    setItem: (key, value) => { writes.push(key); throw new Error('storage quota'); } };
  assert.throws(() => saveDeployment(full, next), /storage quota/);
  assert.deepEqual(writes, [`${previousDeploymentKey}:${old.salt}`]);
  assert.equal(full.getItem(sharedDeploymentKey), raw);
  assert.throws(() => saveDeployment(full, { ...next, addresses: { ...next.addresses, singletonL1: address(555) } }), /cannot replace confirmed/);
});

test('included setup transactions advance before the safe checkpoint', async () => {
  for (const chain of ['l1', 'l2']) {
    const f = receiptFixture();
    f.observed.head.number = '0x1f';
    f.state.pending.chain = chain;
    const plan = f.deployment.steps(f.state);
    f.deployment.steps = () => [{ ...plan[0], chain }];
    const next = await f.deployment.reconcile(f.state);
    assert.deepEqual(next.completed, ['singletonL1']);
    assert.deepEqual(next.inclusions[f.state.pending.hash], { blockNumber: f.observed.receipt.blockNumber, blockHash: f.observed.receipt.blockHash });
    assert.deepEqual(readDeployment(JSON.stringify(next)), JSON.parse(JSON.stringify(next)));
  }
});

test('a reorg during deployment verification leaves the pending request intact', async () => {
  const f = receiptFixture(), original = f.deployment.rpc.bind(f.deployment);
  let blockReads = 0;
  f.deployment.rpc = async (...args) => {
    if (args[1] === 'eth_getBlockByNumber' && ++blockReads === 2) return { hash: hash('replacement block') };
    return original(...args);
  };
  assert.equal(await f.deployment.reconcile(f.state), f.state);
  assert.equal(blockReads, 2);
});

test('missing, moved, failed or uncertain prior inclusions stop later actions before wallet access', async () => {
  for (const mode of ['missing', 'moved', 'failed', 'rpc']) {
    const f = receiptFixture();
    const included = await f.deployment.reconcile(f.state);
    if (mode === 'missing') f.observed.receipt = null;
    if (mode === 'failed') f.observed.receipt.status = '0x0';
    if (mode === 'moved') { f.observed.receipt.blockHash = hash('reincluded'); f.observed.block.hash = f.observed.receipt.blockHash; }
    if (mode === 'rpc') f.deployment.rpc = async () => { throw Error('RPC unavailable'); };
    f.deployment.validate = async () => assert.fail('must stop before further network or wallet work');
    const provider = { request() { assert.fail('must not ask the wallet'); } };
    await assert.rejects(f.deployment.prepare(included, provider), /Recheck .*before continuing/);
    await assert.rejects(f.deployment.reviewStep(included), /Recheck .*before continuing/);
    const first = f.deployment.steps(included)[0]; f.deployment.steps = () => [first];
    await assert.rejects(f.deployment.manifest(included), /Recheck .*before continuing/);
  }
});

test('a reorg during missing-hash discovery neither advances nor caches the lookup', async () => {
  const f = trackingFixture(), original = f.deployment.rpc;
  f.deployment.rpc = async (...args) => args[1] === 'eth_getBlockByNumber' && args[2][0] === f.observed.head.number
    ? { ...f.observed.head, hash: hash('moved discovery head') } : original(...args);
  assert.equal(await f.deployment.trackPending(f.state), f.state);
  f.deployment.rpc = original;
  assert.equal((await f.deployment.trackPending(f.state)).pending.hash, f.foundHash);
});
