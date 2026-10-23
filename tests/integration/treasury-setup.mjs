// Real Safe contracts on two owned Anvils. Only protocol discovery/checkpoints
// are fixture substitutes: this does not claim EEZ settlement or signer coverage.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { concatHex, decodeEventLog, decodeFunctionData, encodeDeployData, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, size, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryDeployment, readDeployment, deploymentIdentity } from '../../src/lib/treasury/deployment.ts';
import { adoptL1Owners, inspectSafe, SAFE_GUARD_SLOT } from '../../src/lib/treasury/safeSetup.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../../src/lib/composerDiscovery.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const officialRuntime = JSON.parse(readFileSync('tests/fixtures/official-safe-runtime.json'));
const safeVersion = process.env.EEZ_TEST_SAFE_VERSION || '1.4.1';
assert(['1.3.0', '1.4.1'].includes(safeVersion));
const safe130 = JSON.parse(readFileSync('tests/fixtures/safe-130-runtime.json'));
for (const contract of Object.values(safe130.contracts)) assert.equal(keccak256(contract.runtime), contract.codeHash);
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const [A, B, C] = [0xa11cen, 0xb0bn, 0xc0cn].map(key => privateKeyToAccount(toHex(key, { size: 32 })));
const sentinel = getAddress(toHex(1, { size: 20 }));
const handlerSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const names = ['l1', 'l2'], processes = [], chains = {}, calls = [];
mkdirSync('.runtime/treasury-flexible-setup', { recursive: true });
const directory = mkdtempSync('.runtime/treasury-flexible-setup/anvil-');
const evidence = { verified: false, safeVersion, scope: 'real Safe contracts; mocked protocol discovery, no EEZ execution', anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(), cases: [], transactions: [] };
const record = name => { evidence.cases.push(name); console.log(`PASS ${name}`); };
let d;
async function rpc(chain, method, params = []) {
  const response = await fetch(chains[chain].rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`); if (['anvil_setStorageAt', 'anvil_setCode'].includes(method)) await rpc(chain, 'anvil_mine', ['0x40']);
  return result.result;
}
async function start(chain) {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const log = openSync(`${directory}/${chain}.log`, 'w');
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(profile.chains[chain].chainId), '--silent'], { stdio: ['ignore', log, log] });
  closeSync(log); processes.push(child); chains[chain] = { rpc: `http://127.0.0.1:${port}`, front: `http://127.0.0.1:${port}` };
  for (let i = 0; i < 100; i++) {
    try { assert.equal(Number(BigInt(await rpc(chain, 'eth_chainId'))), profile.chains[chain].chainId); return; } catch (error) { if (child.exitCode !== null) throw error; }
    await sleep(50);
  }
  throw new Error(`Anvil ${chain} did not start`);
}
function provider(chain, account) {
  return { request: async ({ method, params = [] }) => {
    calls.push(method);
    if (method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return toHex(profile.chains[chain].chainId);
    if (method === 'eth_signTypedData_v4') { assert.equal(params[0], account.address); return account.signTypedData(JSON.parse(params[1])); }
    if (method === 'eth_call') {
      const [nonce] = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data }).args;
      return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, BigInt(profile.chains[chain].chainId), toHex(JSON.stringify({ version: 'owned-anvil-setup-fixture', supportedNetworks: { eezL1: 10200, eezL2: 906969 }, eezContracts: { eezRegistryAddress: profile.registry, eezL2Address: profile.manager } }))] });
    }
    throw new Error(`Unexpected wallet method ${method}`);
  } };
}
async function send(chain, account, to, data, value = 0n, success = true) {
  const nonce = Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [account.address, 'pending'])));
  const raw = await account.signTransaction({ chainId: profile.chains[chain].chainId, nonce, ...(to ? { to } : {}), data, value, gas: 15_000_000n, gasPrice: 2_000_000_000n });
  const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
  let receipt;
  for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc(chain, 'eth_getTransactionReceipt', [hash]); if (!receipt) await sleep(50); }
  assert(receipt, 'Anvil transaction receipt');
  assert.equal(receipt.status, success ? '0x1' : '0x0');
  await rpc(chain, 'anvil_mine', ['0x40']);
  evidence.transactions.push({ chain, hash, success }); return receipt;
}
async function deploy(chain, name, args = [], fixture = false) {
  const contract = fixture ? JSON.parse(readFileSync(`contracts/out/OwnerFixture.sol/${name}.json`))
    : safeVersion === '1.3.0' && ['Safe', 'SafeL2'].includes(name)
      ? { ...artifacts.contracts[name], ...safe130.contracts[name === 'Safe' ? 'Safe130' : 'Safe130L2'] } : artifacts.contracts[name];
  return (await send(chain, A, undefined, encodeDeployData({ abi: contract.abi, bytecode: fixture ? contract.bytecode.object : contract.bytecode, args }))).contractAddress;
}
// The focused adoption/configuration fixtures install their prerequisites directly.
// These real no-op receipts cover inclusion checks, not full deployment coverage;
// the native integration separately executes the complete application setup.
async function prerequisiteReceipts(plan) {
  const hashes = [];
  for (const step of plan) hashes.push((await send(step.chain, A, A.address, '0x')).transactionHash);
  return hashes;
}
const read = (chain, safe, name, args = []) => d.read(chain, safe, 'Safe', name, args);
async function newSafe(chain, singleton, factory, owners, threshold, salt) {
  const initializer = encodeFunctionData({ abi: d.abi('Safe'), functionName: 'setup', args: [owners, BigInt(threshold), zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
  const receipt = await send(chain, A, factory, encodeFunctionData({ abi: d.abi('SafeProxyFactory'), functionName: 'createProxyWithNonce', args: [singleton, initializer, BigInt(salt)] }));
  return receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()).map(log => decodeEventLog({ abi: factory.toLowerCase() === officialRuntime.contracts.factory.address.toLowerCase() ? parseAbi(['event ProxyCreation(address proxy,address singleton)']) : d.abi('SafeProxyFactory'), ...log, strict: false })).find(log => log.eventName === 'ProxyCreation').args.proxy;
}
async function execution(chain, safe, to, data, signers = [A, B], operation = 0) {
  const tx = buildSafeTransaction({ chainId: BigInt(profile.chains[chain].chainId), safe, to, data, operation, nonce: await read(chain, safe, 'nonce') });
  const owners = await read(chain, safe, 'getOwners'), threshold = Number(await read(chain, safe, 'getThreshold'));
  const approvals = await Promise.all(signers.map(async a => ({ owner: a.address, signature: await a.signTypedData(tx) })));
  return encodeSafeExecution(tx, await packEOAApprovals(tx, owners, threshold, approvals));
}
async function admin(chain, safe, method, args, signers) {
  return send(chain, C, safe, await execution(chain, safe, safe, encodeFunctionData({ abi: d.abi('Safe'), functionName: method, args }), signers));
}
try {
  for (const chain of names) await start(chain);
  d = new TreasuryDeployment({ ...chains, fees: { l1: '100000000000000000', l2: '100000000000000000' } }, artifacts);
  // This replaces only shared-chain checkpoint/protocol identity checks. All
  // Safe bytecode, owner, signature, transaction and receipt checks are production.
  d.validate = async () => { for (const chain of names) assert.equal(Number(BigInt(await rpc(chain, 'eth_chainId'))), profile.chains[chain].chainId); };
  for (const chain of names) for (const owner of [A, B, C]) await rpc(chain, 'anvil_setBalance', [owner.address, toHex(100n * 10n ** 18n)]);
  for (const fixture of Object.values(officialRuntime.contracts)) {
    assert.equal(keccak256(fixture.runtime), fixture.codeHash);
    await rpc('l1', 'anvil_setCode', [fixture.address, fixture.runtime]);
  }
  let fresh = { version: 2, identity: deploymentIdentity, deployer: C.address, salt: toHex(912, { size: 32 }), reuse: {}, addresses: {}, completed: [], transactions: [] };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(d.prepare(fresh, provider('l1', A)), /Reconnect the deployment wallet/);
    const prepared = await d.prepare(fresh, provider('l1', C));
    let receipt, originalHash;
    if (i === 0) receipt = await send('l1', C, prepared.pending.to, prepared.pending.data);
    else {
      const tx = { chainId: profile.chains.l1.chainId, nonce: Number(BigInt(prepared.pending.nonce)),
        to: prepared.pending.to, data: prepared.pending.data, value: 0n, gas: 15_000_000n };
      await rpc('l1', 'anvil_setAutomine', [false]);
      try {
        originalHash = await rpc('l1', 'eth_sendRawTransaction', [await C.signTransaction({ ...tx, gasPrice: 2_000_000_000n })]);
        const replacementHash = await rpc('l1', 'eth_sendRawTransaction', [await C.signTransaction({ ...tx, gasPrice: 3_000_000_000n })]);
        await rpc('l1', 'anvil_mine', ['0x1']);
        receipt = await rpc('l1', 'eth_getTransactionReceipt', [replacementHash]);
        assert.equal(receipt.status, '0x1');
        assert.equal(await rpc('l1', 'eth_getTransactionReceipt', [originalHash]), null);
        evidence.replacement = { originalHash, replacementHash };
        evidence.transactions.push({ chain: 'l1', hash: replacementHash, success: true });
      } finally { await rpc('l1', 'anvil_setAutomine', [true]); }
      await rpc('l1', 'anvil_mine', ['0x40']);
    }
    const pending = readDeployment(JSON.stringify({ ...fresh, pending: { ...prepared.pending, ...(originalHash ? { hash: originalHash } : {}) } }));
    const tracked = await d.trackPending(pending);
    assert.equal(tracked.pending.hash, receipt.transactionHash);
    assert.equal(pending.pending.hash, originalHash);
    assert.deepEqual(tracked.completed, fresh.completed, 'discovery does not count as confirmation');
    fresh = await d.reconcile(readDeployment(JSON.stringify(tracked)));
    record(i === 0 ? 'missing wallet response recovered from real account history, then exact canonical deployment validated'
      : 'actual fee replacement discovered by sender/nonce and confirmed without resubmission');

  }
  assert.deepEqual(await read('l1', fresh.addresses.safeL1, 'getOwners'), [C.address]);
  assert.equal(await read('l1', fresh.addresses.safeL1, 'getThreshold'), 1n);
  record('confirmed 1.4.1 singleton and transaction retained; official 1.3.0 factory creates its 1-of-1 Safe after reload, with 23 total steps');
  const singletonL1 = safeVersion === '1.3.0' ? await deploy('l1', 'SafeL2') : fresh.addresses.singletonL1, factoryL1 = fresh.addresses.factoryL1;
  const singletonL2 = await deploy('l2', 'SafeL2'), factoryL2 = await deploy('l2', 'SafeProxyFactory');
  const safeL1 = await newSafe('l1', singletonL1, factoryL1, [A.address, B.address, C.address], 2, 10);
  const safeL2 = await newSafe('l2', singletonL2, factoryL2, [A.address, B.address, C.address], 2, 11);
  const module = await deploy('l2', 'AllowanceModule'), handler = await deploy('l2', 'OwnerTestTarget', [], true), token = await deploy('l2', 'DevnetUSDC');
  await admin('l2', safeL2, 'enableModule', [module]); await admin('l2', safeL2, 'setFallbackHandler', [handler]);
  await send('l2', A, safeL2, '0x', 12345n);
  await send('l2', A, token, encodeFunctionData({ abi: d.abi('DevnetUSDC'), functionName: 'transfer', args: [safeL2, 87_000_000n] }));
  let state = await d.configure(C.address, safeL1, safeL2);
  assert.equal(state.reuse.l1.threshold, 2); assert.equal(state.reuse.l2.threshold, 2);
  assert.deepEqual(state.reuse.l2.modules, [getAddress(module)]);
  assert.equal(d.steps(state).length, 19); record(`existing Safe / SafeL2 ${safeVersion} recognized with 2-of-3 owners and retained modules`);
  if (safeVersion === '1.3.0') {
    const standard = await newSafe('l1', await deploy('l1', 'Safe'), factoryL1, [A.address], 1, 13);
    assert.equal((await inspectSafe(d, 'l1', standard)).threshold, 1);
    record('official standard Safe 1.3.0 also passes bytecode and owner verification');
  }
  await assert.rejects(d.configure(C.address, A.address), /not a supported Safe proxy/);
  await rpc('l2', 'anvil_setStorageAt', [safeL2, SAFE_GUARD_SLOT, toHex(BigInt(handler), { size: 32 })]);
  await assert.rejects(d.configure(C.address, safeL1, safeL2), /transaction Guard/);
  await rpc('l2', 'anvil_setStorageAt', [safeL2, SAFE_GUARD_SLOT, toHex(0n, { size: 32 })]);
  await rpc('l2', 'anvil_setStorageAt', [safeL2, toHex(0, { size: 32 }), toHex(BigInt(handler), { size: 32 })]);
  await assert.rejects(d.validateImports(state), /implementation changed/);
  await assert.rejects(inspectSafe(d, 'l2', safeL2), /Unsupported Safe implementation/);
  await rpc('l2', 'anvil_setStorageAt', [safeL2, toHex(0, { size: 32 }), toHex(BigInt(singletonL2), { size: 32 })]);
  const contractOwned = await newSafe('l2', singletonL2, factoryL2, [handler], 1, 12);
  await assert.rejects(inspectSafe(d, 'l2', contractOwned), /contract-owner signatures/);
  await rpc('l1', 'anvil_setCode', [A.address, concatHex(['0xef0100', handler])]);
  assert.equal((await inspectSafe(d, 'l1', safeL1)).signableOwners.length, 3);
  await rpc('l1', 'anvil_setCode', [A.address, '0x']);
  record('Non-Safe addresses, implementation tampering, Guards and unsupported contract-owner quorums rejected; EIP-7702 wallet recognized');
  const manager = await deploy('l2', 'ReadThroughManager', [1n], true);
  const managerCode = await rpc('l2', 'eth_getCode', [manager, 'latest']);
  await rpc('l2', 'anvil_setCode', [profile.manager, managerCode]);
  await send('l2', A, profile.manager, encodeFunctionData({ abi: d.abi('Registry'), functionName: 'getOrCreateCrossChainProxy', args: [safeL1, 0n] }));
  const adapter = getAddress(await deploy('l2', 'L1Owners', [profile.manager, safeL1]));
  const batch = await deploy('l2', 'MultiSendCallOnly');
  state.addresses = { ...state.addresses, adapter, multiSendL2: getAddress(batch) };
  const plan = d.steps(state), index = plan.findIndex(step => step.id === 'adoptL2');
  // Other application deployments are outside this focused test. Start at the
  // real adoption step, using the helper and adapter actually deployed above.
  state.completed = plan.slice(0, index).map(step => step.id); state.transactions = await prerequisiteReceipts(plan.slice(0, index));
  const snapshot = async () => ({ owners: await read('l2', safeL2, 'getOwners'), threshold: await read('l2', safeL2, 'getThreshold'), nonce: await read('l2', safeL2, 'nonce'),
    native: await rpc('l2', 'eth_getBalance', [safeL2, 'latest']), tokens: await d.read('l2', token, 'DevnetUSDC', 'balanceOf', [safeL2]),
    module: await read('l2', safeL2, 'isModuleEnabled', [module]), handler: await rpc('l2', 'eth_getStorageAt', [safeL2, handlerSlot, 'latest']) });
  const before = await snapshot();
  const migration = adoptL1Owners(safeL2, before.owners, adapter);
  const fail = encodeFunctionData({ abi: [{ type: 'function', name: 'fail', inputs: [], outputs: [], stateMutability: 'pure' }], functionName: 'fail' });
  const failingBatch = concatHex([migration, '0x00', handler, toHex(0n, { size: 32 }), toHex(size(fail), { size: 32 }), fail]);
  const failedData = await execution('l2', safeL2, batch, encodeFunctionData({ abi: d.abi('MultiSendCallOnly'), functionName: 'multiSend', args: [failingBatch] }), [A, B], 1);
  const failed = await send('l2', C, safeL2, failedData, 0n, false);
  assert.deepEqual(await snapshot(), before);
  const trace = await rpc('l2', 'debug_traceTransaction', [failed.transactionHash, { tracer: 'callTracer' }]);
  const flattened = []; const walk = node => { flattened.push(node); for (const child of node.calls ?? []) walk(child); }; walk(trace);
  assert(flattened.some(call => call.input === encodeFunctionData({ abi: d.abi('Safe'), functionName: 'swapOwner', args: [sentinel, before.owners.at(-1), adapter] }) && !call.error));
  assert(flattened.some(call => call.input === fail && call.error));
  record('later batch failure executes the owner swap then rolls back every owner, threshold, nonce, balance, module and handler change');
  state.review = await d.reviewStep(state);
  assert.equal(state.review.operation, 1); assert.equal(state.review.threshold, 2);
  state.review.approvals.push(await d.approve(state, provider('l2', A)));
  await assert.rejects(d.approve(state, provider('l2', A)), /already approved/);
  await assert.rejects(d.prepare(state, provider('l2', C)), /Incomplete or invalid owner quorum/);
  await admin('l2', safeL2, 'changeThreshold', [1n]);
  await assert.rejects(d.currentReview(state), /changed/);
  await admin('l2', safeL2, 'changeThreshold', [2n], [A]);
  await assert.rejects(d.currentReview(state), /changed/);
  state.review = await d.reviewStep(state);
  for (const owner of [A, B]) state.review.approvals.push(await d.approve(state, provider('l2', owner)));
  state = readDeployment(JSON.stringify(state));
  const prepared = await d.prepare(state, provider('l2', C));
  assert.equal(prepared.pending.sender, C.address);
  const receipt = await send('l2', C, prepared.pending.to, prepared.pending.data);
  const ready = { ...state, pending: { ...prepared.pending, hash: receipt.transactionHash } };
  const originalRpc = d.rpc.bind(d);
  d.rpc = async (...args) => args[1] === 'eth_getTransactionReceipt' ? { ...receipt, logs: [] } : originalRpc(...args);
  await assert.rejects(d.reconcile(ready), /Missing matching successful Safe execution/);
  d.rpc = originalRpc;
  const final = await d.reconcile(ready), after = await snapshot();
  assert.equal(final.review, undefined); assert.equal(final.pending, undefined);
  assert.deepEqual(after.owners, [adapter]); assert.equal(after.threshold, 1n);
  for (const key of ['native', 'tokens', 'module', 'handler']) assert.equal(after[key], before[key]);
  assert.deepEqual(await read('l1', safeL1, 'getOwners'), state.reuse.l1.owners); assert.equal(await read('l1', safeL1, 'getThreshold'), 2n);
  record('quorum, duplicate approval, stale nonce/threshold and missing success event rejected; reloaded approvals execute adoption with a separate submitter');
  const reused = await d.configure(C.address, safeL1, safeL2);
  assert.equal(reused.addresses.adapter, adapter); assert.equal(d.steps(reused).length, 17);
  await assert.rejects(d.configure(C.address, fresh.addresses.safeL1, safeL2), /matching L1 Safe/);
  record('an already-adapted Safe reuses the verified owner adapter and rejects a different L1 treasury');
  const observed = await inspectSafe(d, 'l2', safeL2);
  assert.equal(observed.adapter.address, adapter);
  const originalAdapterCode = await rpc('l2', 'eth_getCode', [adapter, 'latest']);
  const groups = artifacts.contracts.L1Owners.immutableGroups;
  const proxyRefs = groups.find(refs => refs.length > 1);
  assert(proxyRefs, 'the compiled adapter repeats its Safe proxy immutable');
  for (const refs of [[proxyRefs[0]], proxyRefs]) {
    let changed = originalAdapterCode;
    for (const ref of refs) {
      const position = 2 + ref.start * 2;
      changed = changed.slice(0, position) + toHex(BigInt(A.address), { size: ref.length }).slice(2) + changed.slice(position + ref.length * 2);
    }
    await rpc('l2', 'anvil_setCode', [adapter, changed]);
    await assert.rejects(d.configure(C.address, safeL1, safeL2), /contract-owner|proxy binding/i);
    await rpc('l2', 'anvil_setCode', [adapter, originalAdapterCode]);
  }
  record('reused adapter rejects inconsistent immutable copies and a consistently wrong L1 Safe proxy');

  const l1Module = getAddress(await deploy('l1', 'AllowanceModule'));
  let l1State = await d.configure(C.address, safeL1, safeL2);
  const registry = await deploy('l1', 'ReadThroughManager', [0n], true);
  await rpc('l1', 'anvil_setCode', [profile.registry, await rpc('l1', 'eth_getCode', [registry, 'latest'])]);
  l1State.addresses.moduleL1 = l1Module;
  l1State.addresses.tokenL1 = getAddress(await deploy('l1', 'DevnetUSDC'));
  l1State.addresses.policy = B.address;
  l1State.addresses.alias = await d.policyAlias(B.address);
  const l1Plan = d.steps(l1State), l1Index = l1Plan.findIndex(step => step.id === 'configureL1');
  l1State.completed = l1Plan.slice(0, l1Index).map(step => step.id);
  l1State.transactions = await prerequisiteReceipts(l1Plan.slice(0, l1Index));
  const l1Before = { nonce: await read('l1', safeL1, 'nonce'), enabled: await read('l1', safeL1, 'isModuleEnabled', [l1Module]),
    allowance: await d.read('l1', l1Module, 'AllowanceModule', 'getTokenAllowance', [safeL1, l1State.addresses.alias, l1State.addresses.tokenL1]),
    aliasCode: await rpc('l1', 'eth_getCode', [l1State.addresses.alias, 'latest']) };
  const l1Failure = await deploy('l1', 'OwnerTestTarget', [], true);
  const l1Step = d.steps(l1State)[l1State.completed.length];
  const configuredThenFail = concatHex([l1Step.args()[0], '0x00', l1Failure, toHex(0n, { size: 32 }), toHex(size(fail), { size: 32 }), fail]);
  const failedConfiguration = await send('l1', C, safeL1, await execution('l1', safeL1, l1State.addresses.multiSendL1,
    encodeFunctionData({ abi: d.abi('MultiSendCallOnly'), functionName: 'multiSend', args: [configuredThenFail] }), [A, B], 1), 0n, false);
  assert.deepEqual({ nonce: await read('l1', safeL1, 'nonce'), enabled: await read('l1', safeL1, 'isModuleEnabled', [l1Module]),
    allowance: await d.read('l1', l1Module, 'AllowanceModule', 'getTokenAllowance', [safeL1, l1State.addresses.alias, l1State.addresses.tokenL1]),
    aliasCode: await rpc('l1', 'eth_getCode', [l1State.addresses.alias, 'latest']) }, l1Before);
  const configurationTrace = await rpc('l1', 'debug_traceTransaction', [failedConfiguration.transactionHash, { tracer: 'callTracer' }]);
  const configurationCalls = []; const visit = call => { configurationCalls.push(call); for (const child of call.calls ?? []) visit(child); }; visit(configurationTrace);
  const limitCall = l1Step.batch.find(call => call.id === 'limitL1');
  assert(configurationCalls.some(call => call.input === encodeFunctionData({ abi: d.abi(limitCall.artifact), functionName: limitCall.method, args: limitCall.args() }) && !call.error));
  assert(configurationCalls.some(call => call.input === fail && call.error));
  record('late configuration failure follows successful allowance setup then rolls back module, delegate allowance, alias deployment and Safe nonce');
  l1State.review = await d.reviewStep(l1State);
  assert.equal(l1State.review.threshold, 2); assert.equal(l1State.review.operation, 1);
  for (const owner of [A, B]) l1State.review.approvals.push(await d.approve(l1State, provider('l1', owner)));
  const l1Prepared = await d.prepare(l1State, provider('l1', C));
  const l1Receipt = await send('l1', C, l1Prepared.pending.to, l1Prepared.pending.data);
  const l1Done = await d.reconcile({ ...l1State, pending: { ...l1Prepared.pending, hash: l1Receipt.transactionHash } });
  assert.equal(l1Done.completed.at(-1), 'configureL1'); assert.equal(await read('l1', safeL1, 'isModuleEnabled', [l1Module]), true);
  assert.deepEqual(await read('l1', safeL1, 'getOwners'), state.reuse.l1.owners); assert.equal(await read('l1', safeL1, 'getThreshold'), 2n);
  assert.deepEqual((await d.read('l1', l1Module, 'AllowanceModule', 'getTokenAllowance', [safeL1, l1State.addresses.alias, l1State.addresses.tokenL1])).slice(0, 3), [100_000_000n, 0n, 10n]);
  record('official call-only helper batches alias provisioning, module, delegate and 100-token allowance with the existing quorum');
  evidence.verified = true; evidence.calls = [...new Set(calls)]; evidence.chains = names.map(chain => profile.chains[chain].chainId);
  evidence.contracts = { safeL1, safeL2, adapter, batch, singletonL1, singletonL2 }; evidence.artifactsHash = keccak256(toHex(readFileSync('src/lib/treasury/deployment-artifacts.json', 'utf8')));
} catch (error) { evidence.failure = String(error.stack ?? error); throw error; }
finally {
  for (const child of processes) { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  writeFileSync(`${directory}/summary.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(`Evidence: ${directory}`);
}
