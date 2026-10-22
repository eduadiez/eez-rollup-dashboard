import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, keccak256, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryClient, readIntent, requireDashboardTreasury, safeAbi, unchanged } from '../src/lib/treasury/client.ts';
import { paymentAbi, paymentTransaction } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash, safeExecutionAbi } from '../src/lib/treasury/safeTransactions.ts';
const address = n => toHex(n, { size: 20 }), hash = text => keccak256(stringToHex(text));
const owner = privateKeyToAccount(toHex(123n, { size: 32 }));
const c = { instance: hash('treasury'), l1: { chainId: 1337, rpc: 'l1', front: 'composer-l1' }, l2: { chainId: 1338, rpc: 'l2', front: 'composer-l2' },
  safeL1: address(1), safeL2: address(2), adapter: address(3), payments: { policy: address(4), alias: address(5), tokenL1: address(6), l1Initiation: true, combinedL2: true } };
const payment = { source: 'l1', destination: 'l2', funding: 'combined', recipient: address(7), amount: '110000000', epoch: '100' };
const tx = paymentTransaction(c, payment, 8n);
const intent = { version: 1, instance: c.instance, value: '0', nonce: '8', safeHash: safeTransactionHash(tx), data: '0x1234', sender: owner.address,
  sourceNonce: '0x2', startBlock: '0x10', l2StartBlock: '0x10', hash: hash('l1-payment'), payment };
test('source Safe determines the signing domain, target and recovery identity independently of recipient chain', () => {
  assert.equal(tx.domain.chainId, 1337n); assert.equal(tx.domain.verifyingContract, c.safeL1); assert.equal(tx.message.to, c.payments.alias);
  const l2 = paymentTransaction(c, { ...payment, source: 'l2' }, 8n);
  assert.equal(l2.domain.chainId, 1338n); assert.equal(l2.domain.verifyingContract, c.safeL2); assert.equal(l2.message.to, c.payments.policy);
  assert.equal(tx.message.data, l2.message.data); assert.notEqual(safeTransactionHash(tx), safeTransactionHash(l2));
  assert.deepEqual(readIntent(c, JSON.stringify(intent)), intent);
  for (const change of [{ l2StartBlock: undefined }, { payment: { ...payment, source: 'l2' } }])
    assert.throws(() => readIntent(c, JSON.stringify({ ...intent, ...change })));
  assert.throws(() => paymentTransaction({ ...c, payments: { ...c.payments, l1Initiation: false } }, payment, 8n), /EEZ-X only/);
  assert(!unchanged({ nonce: 8n, fingerprint: 'same', source: 'l1' }, { nonce: 8n, fingerprint: 'same', source: 'l2' }));
});
test('prepare uses normal L1 owner signatures and wraps only L2 approvals', async () => {
  for (const source of ['l1', 'l2']) {
    const client = new TreasuryClient(c), p = { ...payment, source }, transaction = paymentTransaction(c, p, 8n);
    const snapshot = { source, owners: [owner.address], threshold: 1, nonce: 8n, fingerprint: 'one-owner' };
    const signature = await owner.signTypedData(transaction);
    client.validate = async () => {}; client.snapshot = async value => { assert.equal(value, source); return snapshot; };
    client.wallet = async (_provider, _owner, value) => { assert.equal(value, source); return owner.address; };
    client.rpc = async (url, method) => {
      if (method === 'eth_getTransactionCount') { assert.equal(url, c[source].rpc); return '0x2'; }
      assert.equal(method, 'eth_getBlockByNumber'); return { number: '0x10', baseFeePerGas: '0x1' };
    };
    const prepared = await client.prepare({}, transaction, snapshot, [{ owner: owner.address, signature }], p);
    assert.equal(prepared.request.to, source === 'l1' ? c.safeL1 : c.safeL2);
    assert.equal(BigInt(prepared.request.chainId), transaction.domain.chainId);
    const execution = decodeFunctionData({ abi: safeExecutionAbi, data: prepared.request.data });
    assert.equal(execution.args[0], transaction.message.to);
    const packed = execution.args.at(-1);
    if (source === 'l1') { assert.equal(packed, signature); assert.equal(prepared.intent.l2StartBlock, '0x10'); }
    else { assert(packed.endsWith(signature.slice(2))); assert(packed.length > signature.length); }
  }
});
function fixture(options = {}) {
  const state = { marker: true, paid: true, source: true, l1Canonical: true, l2Canonical: true, status: null, ...options }, calls = [];
  const client = new TreasuryClient(c);
  const marker = { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'L1PaymentAuthorized',
    args: { safeNonce: 9n, callHash: keccak256(tx.message.data) } }), data: '0x', transactionHash: hash('l2-import'), blockHash: hash('l2-block'), blockNumber: '0x20' };
  const paid = { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'Paid', args: { token: c.payments.tokenL1, recipient: payment.recipient } }),
    data: encodeAbiParameters([{ type: 'bool' }, ...Array(4).fill({ type: 'uint256' })], [false, 110000000n, 10000000n, 100000000n, 100n]) };
  const success = { address: c.safeL1, topics: encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess', args: { txHash: intent.safeHash } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [0n]), transactionHash: intent.hash };
  if (state.legacy) { success.topics = success.topics.slice(0, 1); success.data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [intent.safeHash, 0n]); }
  const unrelated = { ...success, address: address(999), transactionHash: hash('unrelated') };
  client.rpc = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'eez_getCrossChainTransaction') { assert.equal(url, c.l1.front); return state.status; }
    if (method === 'eth_getTransactionByHash') return { from: intent.sender, to: c.safeL1, input: intent.data, nonce: intent.sourceNonce, value: '0x0', ...state.transaction };
    if (method === 'eth_getTransactionReceipt') return url === c.l1.rpc ? state.source && { status: state.failed ? '0x0' : '0x1', blockHash: hash('l1-block'), blockNumber: '0x21', logs: [success] }
      : state.missingL2 ? null : { status: '0x1', blockHash: hash('l2-block'), blockNumber: '0x20', logs: [state.receiptMarker === false ? { ...marker, topics: marker.topics.slice(0, 1) } : marker, ...(state.paid ? [paid] : [])] };
    if (method === 'eth_getBlockByNumber') return params[0] === 'safe' ? { number: state.safeHeight ?? '0x20', hash: hash('l2-block') }
      : { hash: hash(url === c.l1.rpc ? state.l1Canonical ? 'l1-block' : 'reorg' : state.l2Canonical ? 'l2-block' : 'reorg') };
    if (method === 'eth_getLogs') {
      if (url === c.l1.rpc) return state.recover ? [unrelated, success] : [];
      assert.deepEqual(params[0].topics, marker.topics); assert.equal(params[0].toBlock, state.safeHeight ?? '0x20');
      return state.marker ? Array(state.duplicates ? 2 : 1).fill(marker) : [];
    }
    assert.fail(method);
  };
  return { client, state, calls };
}
test('L1 settlement requires matching Safe success, authenticated nonce/calldata marker and Paid event on canonical L2', async () => {
  const f = fixture();
  assert.deepEqual((await f.client.outcome(intent)).contributions, { fromL1: '10000000', fromL2: '100000000' });
  assert.equal((await f.client.outcome(intent)).sourceBlock, '33');
  assert.deepEqual((await f.client.outcome(intent)).execution, { l1: intent.hash, l2: hash('l2-import') });
  for (const options of [{ marker: false }, { missingL2: true }, { l1Canonical: false }, { l2Canonical: false }, { safeHeight: '0xf' }])
    assert.equal((await fixture(options).client.outcome(intent)).kind, 'pending');
  for (const options of [{ paid: false }, { receiptMarker: false }, { duplicates: true }, { transaction: { nonce: '0x3' } }])
    await assert.rejects(fixture(options).client.outcome(intent));
});
test('lost L1 wallet responses recover by Safe hash; unresolved or status-only requests never become settled', async () => {
  const withoutHash = { ...intent, hash: undefined };
  assert.equal((await fixture({ recover: true }).client.outcome(withoutHash)).kind, 'settled');
  assert.equal((await fixture().client.outcome(withoutHash)).kind, 'unknown');
  assert.equal((await fixture({ source: false, status: { lifecycle: 'terminal', ownership: { reason: 'CanonicalConsumed' } } }).client.outcome(intent)).kind, 'pending');
  assert.equal((await fixture({ source: false, status: { lifecycle: 'terminal', ownership: { reason: 'PoolDiscarded' } } }).client.outcome(intent)).kind, 'rejected');
  assert.equal((await fixture({ failed: true }).client.outcome(intent)).rejectionStage, 'execution');
});

test('L1 review pins owner membership, threshold and Safe nonce to the same canonical block', async () => {
  const client = new TreasuryClient(c), reads = [];
  client.rpc = async () => ({ number: '0x20', hash: hash('owners') });
  client.read = async (url, target, _abi, name, tag) => {
    reads.push({ url, target, name, tag });
    return { getOwners: [owner.address], getThreshold: 1n, nonce: 8n }[name];
  };
  const snapshot = await client.snapshot('l1');
  assert.equal(snapshot.source, 'l1');
  assert.deepEqual(reads.map(r => r.tag), ['0x20', '0x20', '0x20']);
  assert(reads.every(r => r.url === c.l1.rpc && r.target === c.safeL1));
});
test('bidirectional shared manifests require the selected L1 Composer and its fee limit', () => {
  const shared = { ...c, environment: 'dashboard-testnet', l1: { ...c.l1, rpc: 'https://example.com/l1', front: 'https://example.com/composer/l1' },
    l2: { ...c.l2, rpc: 'https://example.com/l2', front: 'https://example.com/composer/l2' }, registry: address(8), manager: address(9),
    fees: { maxTotalWei: '100', l1MaxTotalWei: '200' } };
  const dashboard = { l1ChainId: '1337', l2ChainId: '1338', l1Rpc: shared.l1.rpc, l2Rpc: shared.l2.rpc, l1Front: shared.l1.front,
    l2Front: shared.l2.front, registry: shared.registry, manager: shared.manager, feesEnabled: true, maxTotalWei: '100', l1FeesEnabled: true, l1MaxTotalWei: '200' };
  requireDashboardTreasury(shared, dashboard);
  for (const change of [{ l1FeesEnabled: false }, { l1MaxTotalWei: '201' }, { l1Front: 'https://example.com/wrong' }])
    assert.throws(() => requireDashboardTreasury(shared, { ...dashboard, ...change }));
});

test('Safe 1.3.0 L1 payments decode and recover the source result without weakening L2 evidence', async () => {
  assert.equal((await fixture({ legacy: true }).client.outcome(intent)).kind, 'settled');
  const f = fixture({ legacy: true, recover: true });
  assert.equal((await f.client.outcome({ ...intent, hash: undefined })).kind, 'settled');
  const query = f.calls.find(call => call.url === c.l1.rpc && call.method === 'eth_getLogs').params[0];
  assert.equal(query.topics.length, 1, 'legacy txHash is in data, never topic 1');
  assert.equal((await fixture({ legacy: true, marker: false }).client.outcome(intent)).kind, 'pending');
  await assert.rejects(fixture({ legacy: true, paid: false }).client.outcome(intent), /payment event/);
  assert.equal((await fixture({ legacy: true, failed: true }).client.outcome(intent)).kind, 'rejected');
});
