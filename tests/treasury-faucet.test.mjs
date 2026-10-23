import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, stringToHex, encodeDeployData, encodeFunctionData, encodeEventTopics, encodeAbiParameters, getAddress, getContractAddress, keccak256, maxUint256, parseAbi, toHex, zeroAddress } from 'viem';
import { TreasuryFaucetDeployment, parseFaucetAmount } from '../src/lib/treasury/networkDeployment.ts';
import { deploymentIdentity, readDeployment } from '../src/lib/treasury/deployment.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const target = { l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2' }, fees: { l1: '1', l2: '1' } };
const fixture = () => ({ version: 2, identity: deploymentIdentity, deployer: address(100), salt: hash('faucet'), reuse: {}, addresses: { tokenL1: address(101) }, completed: [], transactions: [] });
const client = () => new TreasuryFaucetDeployment(target, artifacts);
test('new faucet requests mint to the same wallet repeatedly while retaining confirmed history', () => {
  const d = client(); let state = fixture();
  for (let i = 0; i < 3; i++) {
    state = readDeployment(JSON.stringify(state));
    const steps = d.steps(state), step = steps[state.completed.length];
    assert.equal(step.id, `faucetMint_${i}`); assert.equal(step.artifact, 'TestUSDCClaim');
    assert.equal(step.target, undefined); assert.equal(step.method, undefined);
    assert.deepEqual(step.args(), [state.addresses.tokenL1]);
    assert.deepEqual(steps.slice(0, i).map(step => step.id), state.completed);
    state = { ...state, completed: [...state.completed, step.id], transactions: [...state.transactions, hash(`claim ${i}`)] };
  }
  assert.equal(state.transactions.length, 3); assert.equal(state.deployer, fixture().deployer);
});
test('an outstanding direct claim keeps its exact calldata; its confirmation permits a new repeatable claim', () => {
  const d = client(), state = fixture();
  const data = encodeFunctionData({ abi: artifacts.contracts.SharedTestUSDC.abi, functionName: 'claim' });
  const pending = { ...state, pending: { id: 'faucetClaim', chain: 'l1', sender: state.deployer, to: state.addresses.tokenL1, nonce: '0x1', data } };
  const raw = JSON.stringify(pending), resumed = readDeployment(raw), step = d.steps(resumed)[0];
  assert.equal(step.id, 'faucetClaim'); assert.equal(step.method, 'claim'); assert.equal(step.target(), state.addresses.tokenL1);
  assert.equal(encodeFunctionData({ abi: d.abi(step.artifact), functionName: step.method, args: step.args() }), data);
  assert.equal(JSON.stringify(resumed), raw);
  const completed = { ...state, completed: ['faucetClaim'], transactions: [hash('legacy')] };
  assert.equal(d.steps(completed)[1].id, 'faucetMint_1');
});
test('faucet rejects unrelated, reordered and changed pending requests', () => {
  const d = client(), state = fixture();
  for (const completed of [['fundingBatchL1'], ['faucetMint_1'], ['faucetMint_0', 'faucetClaim']])
    assert.throws(() => d.steps({ ...state, completed }), /Invalid saved faucet request/);
  assert.throws(() => d.steps({ ...state, pending: { id: 'faucetMint_1' } }), /Pending faucet request changed/);
  assert.throws(() => d.steps({ ...state, pending: { id: 'faucetMint_0', chain: 'l1', sender: address(999) } }), /Pending faucet request changed/);
});
test('repeat claims never query a per-wallet claim flag', async () => {
  const d = client(), state = fixture(), block = { number: '0x10', hash: hash('canonical') };
  state.completed = ['faucetClaim']; state.transactions = [hash('old claim')];
  d.validate = async () => {}; d.validateImports = async () => {}; d.wallet = async () => state.deployer;
  d.read = async () => { throw Error('No token eligibility read belongs in claim preparation'); };
  d.rpc = async (_chain, method) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: block.number, blockHash: block.hash };
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return '0x2';
    if (method === 'eth_estimateGas') return '0x10000';
    throw Error(`Unexpected ${method}`);
  };
  const { pending, request } = await d.prepare(state, {});
  assert.equal(pending.id, 'faucetMint_1'); assert.equal(request.to, undefined);
  assert.equal(request.data, encodeDeployData({ abi: d.abi('TestUSDCClaim'), bytecode: artifacts.contracts.TestUSDCClaim.bytecode, args: [state.addresses.tokenL1] }));
  await assert.rejects(d.prepare({ ...state, pending }, {}), /Resolve the pending deployment/);
});
test('a receipt cannot confirm a mint for a different token or a substituted call', async () => {
  const d = client(), state = fixture();
  const data = encodeDeployData({ abi: d.abi('TestUSDCClaim'), bytecode: artifacts.contracts.TestUSDCClaim.bytecode, args: [address(999)] });
  const pending = { id: 'faucetMint_0', chain: 'l1', sender: state.deployer, nonce: '0x1', data, hash: hash('receipt') };
  d.rpc = async () => { throw Error('Wrong request must fail before receipt reads'); };
  await assert.rejects(d.reconcile({ ...state, pending }), /does not match this token/);
  const correct = encodeDeployData({ abi: d.abi('TestUSDCClaim'), bytecode: artifacts.contracts.TestUSDCClaim.bytecode, args: [state.addresses.tokenL1] });
  await assert.rejects(d.reconcile({ ...state, pending: { ...pending, data: correct, to: state.addresses.tokenL1 } }), /does not match this token/);
});

const asset = { tokenL1: address(101), tokenL2: address(102), bridgeL1: address(103), bridgeL2: address(104), tokenCodeHash: hash('token') };
const choice = { amount: '1000123456', recipient: address(105), destination: 'l2' };
test('amount accepts exact decimals and values above the old claim amount, without a balance cap', () => {
  for (const [text, expected] of [['0.000001', 1n], ['.1', 100000n], ['1000.123456', 1000123456n], ['450', 450000000n], ['0450.0', 450000000n]])
    assert.equal(parseFaucetAmount(text), expected);
  for (const text of ['', '0', '-1', '1e6', 'Infinity', '0.0000001', '1,000', '.', '1.0000001', String(maxUint256)])
    assert.throws(() => parseFaucetAmount(text), /amount/);
});
test('first request deploys only the dispenser, then preserves recipient, amount and destination for delivery', async () => {
  const d = client(), state = d.selectRequest(fixture(), asset, choice), nonce = '0x1';
  const step = d.steps(state)[0];
  assert.equal(step.id, 'faucetPrepare_0'); assert.equal(step.quoted, undefined);
  assert.deepEqual(step.args(), [asset.tokenL1, asset.bridgeL1]);
  const faucet = getContractAddress({ from: state.deployer, nonce: 1n });
  const data = encodeDeployData({ abi: d.abi(step.artifact), bytecode: artifacts.contracts[step.artifact].bytecode, args: step.args() });
  const pending = { id: step.id, chain: 'l1', sender: state.deployer, nonce, data, hash: hash('prepare') };
  d.read = async (_c, _a, _art, method) => ({ token: asset.tokenL1, bridge: asset.bridgeL1, destinationRollup: 1n })[method];
  d.rpc = async (_c, method) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x10', blockHash: hash('block'), contractAddress: faucet, logs: [] };
    if (method === 'eth_getTransactionByHash') return { from: state.deployer, to: null, input: data, nonce, value: '0x0' };
    if (method === 'eth_getBlockByNumber') return { hash: hash('block') };
    if (method === 'eth_getCode') return artifacts.contracts.TestUSDCFaucet.runtime;
    throw Error(method);
  };
  const confirmed = await d.reconcile(readDeployment(JSON.stringify({ ...state, pending })));
  assert.deepEqual(confirmed.faucetRequests[1], { ...choice, faucet });
  assert.equal(confirmed.pending, undefined);
  const delivery = d.steps(confirmed)[1];
  assert.equal(delivery.id, 'faucetRequest_1'); assert.equal(delivery.quoted, true);
  assert.equal(delivery.target(), faucet); assert.deepEqual(delivery.args(), [choice.recipient, 1000123456n, true]);
  const changed = d.selectRequest(confirmed, asset, { ...choice, destination: 'l1', recipient: address(106), amount: '1' });
  assert.equal(d.steps(changed)[1].quoted, false);
  assert.deepEqual(d.steps(changed)[1].args(), [address(106), 1n, false]);
  assert.deepEqual(changed.transactions, confirmed.transactions);
});
test('the connected sender pays gas when requesting tokens for an unfunded recipient', async () => {
  const d = client(), sender = fixture().deployer;
  const state = d.selectRequest({ ...fixture(), addresses: { tokenL1: asset.tokenL1, faucet: address(110) } }, asset, { ...choice, destination: 'l1' });
  d.validate = async () => {}; d.validateImports = async () => {};
  let senderBalance = '0x100000'; const balanceReads = [];
  const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x27d8';
    if (method === 'eth_accounts') return [sender];
    if (method === 'eth_call') {
      const [nonce] = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data }).args;
      return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, 10200n,
        stringToHex(JSON.stringify({ version: 'test', supportedNetworks: { eezL1: 10200, eezL2: 906969 }, eezContracts: { eezRegistryAddress: profile.registry, eezL2Address: profile.manager } }))] });
    }
    throw Error(`Unexpected wallet call ${method}`);
  } };
  d.rpc = async (chain, method, params) => {
    assert.equal(chain, 'l1');
    if (method === 'eth_getBalance') { balanceReads.push(params[0]); return params[0].toLowerCase() === sender.toLowerCase() ? senderBalance : '0x0'; }
    if (method === 'eth_getTransactionCount') return '0x3';
    if (method === 'eth_estimateGas') { assert.equal(params[0].from, sender); return '0x10000'; }
    throw Error(`Unexpected RPC ${method}`);
  };
  const prepared = await d.prepare(state, provider);
  assert.deepEqual(balanceReads, [sender]);
  assert.equal(prepared.pending.sender, sender); assert.equal(prepared.request.from, sender);
  assert.equal(prepared.request.data, encodeFunctionData({ abi: d.abi('TestUSDCFaucet'), functionName: 'request', args: [choice.recipient, BigInt(choice.amount), false] }));
  senderBalance = '0x0';
  await assert.rejects(d.prepare(state, provider), /The submitting wallet needs test xDAI on Chiado/);
  assert(balanceReads.every(value => value === sender), 'receiving tokens never requires a recipient gas balance');
});
test('invalid request fields and inconsistent history cannot become wallet transactions', () => {
  const d = client();
  for (const change of [{ amount: '0' }, { amount: '-1' }, { amount: String(maxUint256 + 1n) }, { recipient: zeroAddress }, { recipient: '0x1234' }, { destination: 'mainnet' }, { faucet: address(9) }])
    assert.throws(() => d.selectRequest(fixture(), asset, { ...choice, ...change }));
  const state = d.selectRequest(fixture(), asset, choice);
  assert.throws(() => d.selectRequest({ ...state, pending: {} }, asset, choice), /pending/);
  assert.throws(() => d.selectRequest(state, { ...asset, bridgeL1: address(999) }, choice), /bindings changed/);
  assert.throws(() => d.steps({ ...state, completed: ['faucetRequest_0'] }), /type changed/);
  assert.throws(() => d.steps({ ...state, faucetRequests: { 2: choice } }), /request index/);
  assert.throws(() => d.steps({ ...state, faucetRequests: { 0: { ...choice, faucet: address(9) } } }), /address changed/);
});
test('delivery requires the exact canonical request event and matching transfer or bridge lock', async () => {
  for (const destination of ['l1', 'l2']) {
    const d = client(), faucet = address(110);
    const base = { ...fixture(), addresses: { ...asset, faucet } }; delete base.addresses.tokenCodeHash;
    const state = d.selectRequest(base, asset, { ...choice, destination });
    const step = d.steps(state)[0], data = encodeFunctionData({ abi: d.abi(step.artifact), functionName: step.method, args: step.args() });
    const pending = { id: step.id, chain: 'l1', sender: state.deployer, to: faucet, nonce: '0x1', data, hash: hash('delivery') };
    const requestEvent = { address: faucet,
      topics: encodeEventTopics({ abi: d.abi('TestUSDCFaucet'), eventName: 'TokensRequested', args: { requester: state.deployer, recipient: choice.recipient } }),
      data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [destination === 'l2', BigInt(choice.amount)]) };
    const transfer = { address: asset.tokenL1,
      topics: encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']), eventName: 'Transfer', args: { from: faucet, to: destination === 'l2' ? asset.bridgeL1 : choice.recipient } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(choice.amount)]) };
    let logs = [requestEvent, transfer], blockHash = hash('block'), tx = { from: state.deployer, to: faucet, input: data, nonce: '0x1', value: '0x0' };
    d.read = async (_c, _a, _art, method) => ({ token: asset.tokenL1, bridge: asset.bridgeL1, destinationRollup: 1n })[method];
    d.rpc = async (_c, method) => {
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x10', blockHash, logs };
      if (method === 'eth_getTransactionByHash') return tx;
      if (method === 'eth_getBlockByNumber') return { hash: hash('block') };
      if (method === 'eth_getCode') return artifacts.contracts.TestUSDCFaucet.runtime;
      throw Error(method);
    };
    const saved = readDeployment(JSON.stringify({ ...state, pending }));
    const settled = await d.reconcile(saved); assert.equal(settled.pending, undefined); assert.equal(settled.completed.length, 1);
    assert.equal(d.steps(d.selectRequest(settled, asset, { ...choice, destination }))[1].target(), faucet, 'reuse on repeat');
    logs = [transfer]; await assert.rejects(d.reconcile(saved), /matching faucet delivery/);
    logs = [requestEvent]; await assert.rejects(d.reconcile(saved), /exact token delivery/);
    logs = [requestEvent, { ...transfer, data: encodeAbiParameters([{ type: 'uint256' }], [1n]) }];
    await assert.rejects(d.reconcile(saved), /exact token delivery/);
    logs = [requestEvent, transfer]; tx = { ...tx, from: address(999) };
    await assert.rejects(d.reconcile(saved), /does not match the saved/);
    tx = { ...tx, from: state.deployer }; blockHash = hash('orphan'); assert.equal(await d.reconcile(saved), saved);
    await assert.rejects(d.reconcile({ ...saved, pending: { ...pending, data: '0x1234' } }), /does not match/);
  }
});

test('a new faucet request uses current dispenser validation, not availability of every historical receipt', async () => {
  const { assertSetupProgress } = await import('../src/lib/treasury/setupTransactions.ts');
  const d = client(), initial = d.selectRequest(fixture(), asset, choice), faucet = address(110);
  const completed = { ...initial, addresses: { ...initial.addresses, faucet }, completed: ['faucetPrepare_0'], transactions: [hash('pruned preparation')] };
  const state = d.selectRequest(completed, asset, { ...choice, destination: 'l1' }), saved = JSON.stringify(state);
  let validated = 0, receiptReads = 0;
  d.validate = async () => {};
  d.validateImports = async current => { validated++; assert.equal(current.addresses.faucet, faucet); };
  d.wallet = async () => state.deployer;
  d.rpc = async (_chain, method) => {
    if (method === 'eth_getTransactionReceipt') { receiptReads++; return null; }
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return '0x2';
    if (method === 'eth_estimateGas') return '0x10000';
    throw Error(`Unexpected ${method}`);
  };
  // This is the exact pre-fix prerequisite which caused the reported UI error.
  await assert.rejects(assertSetupProgress(d, state), /Recheck Prepare the test-token faucet before continuing. Waiting for a canonical receipt/);
  receiptReads = 0;
  const result = await d.prepare(state, {});
  assert.equal(result.pending.id, 'faucetRequest_1'); assert.equal(result.request.to, faucet);
  assert.equal(validated, 1); assert.equal(receiptReads, 0); assert.equal(JSON.stringify(state), saved);
  d.validateImports = async () => { throw Error('Faucet dispenser code changed'); };
  await assert.rejects(d.prepare(state, {}), /dispenser code changed/);
  await assert.rejects(d.prepare({ ...state, pending: result.pending }, {}), /Resolve the pending deployment/);
});
