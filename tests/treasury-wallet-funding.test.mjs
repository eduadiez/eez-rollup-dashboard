import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, getAddress, keccak256, toHex, zeroAddress } from 'viem';
import { TreasuryDeployment, deploymentIdentity, readDeployment, saveDeployment, sharedDeploymentKey, previousWalletFundingKey, previousOptionalFundingKey } from '../src/lib/treasury/deployment.ts';
import { TreasuryNetworkDeployment, readNetworkDeployment, networkDeploymentKey } from '../src/lib/treasury/networkDeployment.ts';
import { verifyAssetInfrastructure } from '../src/lib/treasury/assetInfrastructure.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const target = { l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2' }, fees: { l1: '1', l2: '1' } };
const asset = { tokenL1: address(100), tokenL2: address(101), bridgeL1: address(102), bridgeL2: address(103), tokenCodeHash: hash('token code') };
async function fixture() {
  const d = new TreasuryDeployment(target, artifacts); d.validate = async () => {}; d.validateImports = async () => {};
  d.findAssetInfrastructure = async () => asset;
  const state = await d.group({ version: 2, identity: deploymentIdentity, deployer: address(99), salt: hash('current'), reuse: {}, completed: ['singletonL1'], transactions: [hash('confirmed')], addresses: { singletonL1: address(200) } });
  return { d, state };
}
test('wallet funding preserves confirmed progress and uses standard ERC20 calls without token creation or claims', async () => {
  const { d, state } = await fixture(); const next = await d.useExistingAsset(state);
  assert.equal(next.version, 6); assert.deepEqual(next.completed, state.completed); assert.deepEqual(next.transactions, state.transactions);
  assert.equal(next.salt, state.salt); assert.equal(next.addresses.singletonL1, state.addresses.singletonL1);
  assert.deepEqual(readDeployment(JSON.stringify(next)), JSON.parse(JSON.stringify(next)));
  const steps = d.steps(next), actions = steps.flatMap(step => step.group?.actions ?? [step]);
  assert(!actions.some(s => ['SharedTestUSDC', 'DevnetUSDC'].includes(s.artifact)));
  assert(!actions.some(s => ['claim', 'registerBridges', 'seal', 'setCanonicalBridgeAddress'].includes(s.method)));
  assert(!actions.some(s => ['tokenL1', 'bridgeL1', 'bridgeL2'].includes(s.output)));
  const approve = steps.find(s => s.id === 'approveFunding');
  next.addresses.bootstrapL1 = address(201);
  assert.deepEqual(approve.args(), [next.addresses.bootstrapL1, 450_000_000n]);
  const funding = steps.find(s => s.id === 'fundingBatchL1').group.actions;
  assert.equal(funding[0].method, 'transferFrom'); assert.equal(funding[1].method, 'transfer');
  assert.deepEqual(funding[0].args(), [next.deployer, next.addresses.bootstrapL1, 450_000_000n]);
  assert(steps.indexOf(approve) < steps.findIndex(s => s.id === 'fundingBatchL1'));
});
async function awaitingFunding() {
  const { d, state } = await fixture();
  const next = await d.useExistingAsset(state), plan = d.steps(next);
  const prefix = plan.slice(0, plan.findIndex(step => step.id === 'approveFunding'));
  next.completed = prefix.map(step => step.id);
  next.transactions = prefix.map((step, i) => state.transactions[i] ?? hash(`included ${step.id}`));
  Object.assign(next.addresses, { bootstrapL1: address(201), adapter: address(202), safeL1: address(203), safeL2: address(204) });
  return { d, next };
}
test('removing funding preserves confirmed setup, removes transfers and retains the owner connection', async () => {
  const { d, next } = await awaitingFunding(), before = JSON.stringify(next);
  const skipped = d.withoutFunding(next), resumed = readDeployment(JSON.stringify(skipped));
  assert.equal(JSON.stringify(next), before);
  assert.equal(resumed.version, 8);
  for (const field of ['completed', 'transactions', 'addresses', 'reuse', 'asset', 'salt', 'deployer']) assert.deepEqual(resumed[field], JSON.parse(before)[field]);
  assert.deepEqual(resumed.fundingSkipped.source, JSON.parse(before));
  const plan = d.steps(resumed), connection = plan[resumed.completed.length];
  assert(!plan.some(step => step.id === 'approveFunding'));
  assert.equal(connection.id, 'fundingBatchL1'); assert.equal(connection.quoted, false); assert.equal(connection.group.finish, true);
  assert.deepEqual(connection.group.actions.map(call => call.id), ['adapterAlias']);
  const actions = plan.flatMap(step => [...(step.group?.actions ?? [step]), ...(step.batch ?? [])]);
  assert(!actions.some(call => ['approve', 'transfer', 'transferFrom', 'bridgeTokens', 'claim'].includes(call.method)));
  assert(actions.some(call => call.id === 'limitL1')); assert(actions.some(call => call.id === 'limitL2'));
  assert.equal(await d.useExistingAsset(resumed), resumed);
});
test('funding is removed from fresh plans and from plans with a confirmed approval', async () => {
  const { d, next } = await awaitingFunding();
  const { state } = await fixture();
  const fresh = d.withoutFunding(await d.useExistingAsset(state));
  assert.equal(fresh.version, 8);
  assert(!d.steps(fresh).some(step => step.id === 'approveFunding'));
  const approved = { ...next, completed: [...next.completed, 'approveFunding'], transactions: [...next.transactions, hash('approval')] };
  const migrated = d.withoutFunding(approved), plan = d.steps(migrated);
  assert.deepEqual(migrated.completed, approved.completed);
  assert.deepEqual(migrated.transactions, approved.transactions);
  assert.equal(plan[migrated.completed.length - 1].id, 'approveFunding');
  assert.equal(plan[migrated.completed.length].id, 'fundingBatchL1');
  assert.deepEqual(plan[migrated.completed.length].group.actions.map(call => call.id), ['adapterAlias']);
  assert.equal(d.withoutFunding(migrated), migrated);
});
test('pending requests, signed reviews and already-funded plans keep their exact saved work', async () => {
  const { d, next } = await awaitingFunding();
  for (const pending of [{ id: 'approveFunding' }, { id: 'approveFunding', hash: hash('submitted') }, { id: 'fundingBatchL1', data: '0x1234' }]) {
    const state = { ...next, pending };
    assert.equal(d.withoutFunding(state), state);
  }
  const reviewed = { ...next, review: {} };
  assert.equal(d.withoutFunding(reviewed), reviewed);
  const funded = { ...next, completed: [...next.completed, 'approveFunding', 'fundingBatchL1'], transactions: [...next.transactions, hash('approval'), hash('funding')] };
  assert.equal(d.withoutFunding(funded), funded);
  const priorOptional = { ...d.withoutFunding(next), version: 7 };
  assert.deepEqual(readDeployment(JSON.stringify(priorOptional)), JSON.parse(JSON.stringify(priorOptional)));
  assert.equal(d.withoutFunding(priorOptional), priorOptional);
});
test('the no-funding migration is backed up and cannot downgrade or replace confirmed progress', async () => {
  const { d, next } = await awaitingFunding(), raw = JSON.stringify(next), skipped = d.withoutFunding(next);
  const entries = new Map([[sharedDeploymentKey, raw]]), storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  saveDeployment(storage, skipped);
  assert.equal(entries.get(`${previousOptionalFundingKey}:${next.salt}`), raw);
  assert.deepEqual(readDeployment(entries.get(sharedDeploymentKey)), JSON.parse(JSON.stringify(skipped)));
  assert.throws(() => saveDeployment(storage, next), /reinstate token transfers/);
  const corrupt = structuredClone(skipped); corrupt.addresses.bootstrapL1 = address(999);
  assert.throws(() => readDeployment(JSON.stringify(corrupt)), /Skipping funding replaced confirmed progress/);
  const pending = structuredClone(skipped); pending.fundingSkipped.source.pending = { id: 'approveFunding' };
  assert.throws(() => readDeployment(JSON.stringify(pending)), /Invalid setup without funding/);
  const oldBuildShape = { ...skipped, version: 6 };
  assert.throws(() => readDeployment(JSON.stringify(oldBuildShape)), /Unexpected skipped funding decision/);
  assert.throws(() => saveDeployment({ getItem: key => key === sharedDeploymentKey ? raw : null, setItem: () => { throw Error('storage full'); } }, skipped), /storage full/);
});
test('the connection can be prepared without querying token balance or allowance', async () => {
  const { d, next } = await awaitingFunding(), skipped = d.withoutFunding(next), block = { number: '0x20', hash: hash('canonical') };
  d.wallet = async () => next.deployer;
  d.rpc = async (_chain, method) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: block.number, blockHash: block.hash };
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getBalance') return '0x1';
    if (method === 'eth_getTransactionCount') return '0x1';
    if (method === 'eth_getCode') return artifacts.contracts.TreasuryBootstrap.runtime;
    if (method === 'eth_estimateGas') return '0x10000';
    throw Error(`Unexpected ${method}`);
  };
  d.read = async (_chain, _address, artifact, method) => {
    assert.equal(artifact, 'TreasuryBootstrap', 'skipped funding cannot query token balances or approvals');
    assert(['owner', 'closed', 'sequence'].includes(method));
    return { owner: next.deployer, closed: false, sequence: 1n }[method];
  };
  const prepared = await d.prepare(skipped, {});
  const call = decodeFunctionData({ abi: artifacts.contracts.TreasuryBootstrap.abi, data: prepared.request.data });
  assert.equal(call.functionName, 'execute'); assert.equal(call.args[2], true);
  assert.equal(call.args[1].length, 1); assert.equal(call.args[1][0].target.toLowerCase(), profile.registry.toLowerCase());
  assert.equal(decodeFunctionData({ abi: d.abi('Registry'), data: call.args[1][0].data }).functionName, 'getOrCreateCrossChainProxy');
  assert.equal(skipped.pending, undefined);
});
test('absence or uncertainty never authorizes implicit token deployment', async () => {
  const { d, state } = await fixture(), before = JSON.stringify(state);
  d.findAssetInfrastructure = async () => undefined;
  await assert.rejects(d.useExistingAsset(state), /predeployment/);
  d.findAssetInfrastructure = async () => { throw Error('RPC unavailable'); };
  await assert.rejects(d.useExistingAsset(state), /RPC unavailable/); assert.equal(JSON.stringify(state), before);
});
test('pending, reviewed or already funded legacy setups retain their exact plan', async () => {
  const { d, state } = await fixture(); d.findAssetInfrastructure = async () => { throw Error('must not query'); };
  for (const s of [{ ...state, pending: { id: 'contractsBatchL1', data: '0x1234' } }, { ...state, review: { safeHash: hash('review') } },
    { ...state, addresses: { ...state.addresses, tokenL1: address(300) } }, { ...state, addresses: { ...state.addresses, bootstrapL1: address(301) } }]) assert.equal(await d.useExistingAsset(s), s);
});
test('migration backs up old journals and refuses changed confirmed contracts', async () => {
  const { d, state } = await fixture(), next = await d.useExistingAsset(state), raw = JSON.stringify(state), storage = new Map([[sharedDeploymentKey, raw]]);
  saveDeployment({ getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }, next);
  assert.equal(storage.get(`${previousWalletFundingKey}:${state.salt}`), raw);
  assert.throws(() => saveDeployment({ getItem: () => raw, setItem: () => { throw Error('quota'); } }, next), /quota/);
  const forged = structuredClone(next); forged.addresses.singletonL1 = address(999);
  assert.throws(() => readDeployment(JSON.stringify(forged)), /confirmed progress/);
});
test('insufficient wallet balance or approval stops before preparing a transaction', async () => {
  const { d, state } = await fixture(), next = await d.useExistingAsset(state);
  next.addresses.bootstrapL1 = address(200); next.completed = []; next.transactions = []; d.wallet = async () => next.deployer;
  let balance = 449_999_999n, allowance = 450_000_000n;
  d.read = async (_chain, _address, artifact, method) => { assert.equal(artifact, 'ERC20'); return method === 'balanceOf' ? balance : allowance; };
  d.steps = () => [{ id: 'approveFunding', chain: 'l1' }];
  await assert.rejects(d.prepare(next, {}), /wallet needs 450/);
  balance++; allowance = 449_999_999n; d.steps = () => [{ id: 'fundingBatchL1', chain: 'l1' }];
  await assert.rejects(d.prepare(next, {}), /allowance is insufficient/);
});
test('operator network provisioning has a separate journal and no treasury Safe funding', async () => {
  const d = new TreasuryNetworkDeployment(target, artifacts); d.validate = async () => {}; d.findSharedInfrastructure = async () => undefined;
  const state = await d.start(address(10));
  assert.notEqual(networkDeploymentKey, sharedDeploymentKey); assert.deepEqual(readNetworkDeployment(JSON.stringify(state)), state);
  const steps = d.steps(state), actions = steps.flatMap(s => s.group.actions);
  assert.equal(steps.length, 3); assert(!actions.some(s => s.artifact === 'Safe' || s.artifact === 'TreasuryPolicy'));
  assert(actions.find(s => s.id === 'seedWrapped').special === 'wrapped');
  assert(actions.findIndex(s => s.id === 'sealL1') < actions.findIndex(s => s.id === 'registerNetwork'));
  d.findSharedInfrastructure = async () => asset;
  await assert.rejects(d.start(address(11)), /already exists/);
});
test('existing-asset verification requires ERC20 metadata, frozen peers and a bound wrapped mint authority, without faucet calls', async () => {
  const { d } = await fixture(), tokenCode = '0x60006000', binding = { ...asset, tokenCodeHash: keccak256(tokenCode) }, block = { number: '0x20', hash: hash('block') };
  d.rpc = async (_chain, method, params) => method === 'eth_getBlockByNumber' ? block : params[0] === binding.tokenL1 ? tokenCode : params[0] === binding.tokenL2 ? artifacts.contracts.WrappedToken.runtime : artifacts.contracts.SharedTreasuryBridge.runtime;
  d.read = async (chain, _address, artifact, method) => {
    assert.notEqual(artifact, 'SharedTestUSDC');
    const values = { canonicalToken: binding.tokenL1, manager: chain === 'l1' ? profile.registry : profile.manager, rollupId: chain === 'l1' ? 0n : 1n, treasuryRollupId: 1n, admin: zeroAddress,
      canonicalBridgeAddress: chain === 'l1' ? binding.bridgeL2 : binding.bridgeL1, decimals: 6, getWrappedToken: binding.tokenL2, wrappedTokenInfo: [binding.tokenL1, 0n], BRIDGE: binding.bridgeL2 };
    assert(method in values, method); return values[method];
  };
  await verifyAssetInfrastructure(d, binding);
  await assert.rejects(verifyAssetInfrastructure(d, { ...binding, tokenCodeHash: hash('wrong') }), /asset code changed/);
  const original = d.read; d.read = (...args) => args[3] === 'decimals' ? 18 : original(...args);
  await assert.rejects(verifyAssetInfrastructure(d, binding), /six-decimal/);
});

test('fresh setup gets exact splits while version 8 retains its reviewed deployment bytecode', async () => {
  const { d } = await fixture();
  const grouped = await d.group({ version: 2, bidirectional: true, identity: deploymentIdentity, deployer: address(99), salt: hash('fresh-split'), reuse: {}, completed: [], transactions: [], addresses: { singletonL1: address(200) } });
  const fresh = d.withoutFunding(await d.useExistingAsset(grouped));
  assert.equal(fresh.version, 9);
  const next = readDeployment(JSON.stringify(fresh));
  const policyStep = state => d.steps(state).find(s => s.id === 'budgetBatchL2').group.actions.find(a => a.id === 'policy');
  assert.equal(policyStep(next).artifact, 'SplitTreasuryPolicy');
  const old = { ...fresh, version: 8 };
  assert.equal(policyStep(readDeployment(JSON.stringify(old))).artifact, 'BidirectionalTreasuryPolicy');
  assert.equal(d.withoutFunding(old), old);
  assert.notEqual(artifacts.contracts.SplitTreasuryPolicy.bytecode, artifacts.contracts.BidirectionalTreasuryPolicy.bytecode);
  assert(!d.steps(next).some(s => s.id === 'approveFunding'));
});
