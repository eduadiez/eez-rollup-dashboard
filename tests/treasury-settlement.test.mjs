import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toHex } from 'viem';
import { treasurySettlement } from '../src/lib/treasury/settlement.ts';
const hash = s => keccak256(toHex(s));
const l2Hash = hash('l2'), l1Hash = hash('l1'), tx = hash('post');
const outcome = { kind: 'settled', block: '5', execution: { l2: hash('execution') } };
function fixture(change = {}) {
  const calls = [];
  const record = { canonicalL2: true, l1TransactionHash: tx, l1BlockHash: l1Hash, l1BlockNumber: '0xa', l2Blocks: [{ number: '0x5', hash: l2Hash }], ...change.record };
  return { calls, client: { config: { l1: { rpc: 'l1' }, l2: { rpc: 'l2', front: 'composer' } }, async rpc(url, method, args) {
    calls.push({ url, method, args });
    if (method === 'eez_getSettlementByL2Block') { assert.equal(url, 'composer'); assert.deepEqual(args, [l2Hash]); if (change.offline) throw new Error('index offline'); return change.missing ? null : record; }
    if (method === 'eth_getTransactionReceipt') {
      if (url === 'l2') { assert.deepEqual(args, [outcome.execution.l2]); return { status: '0x1', blockNumber: '0x5', blockHash: l2Hash, ...change.l2Receipt }; }
      assert.deepEqual(args, [tx]); return { status: '0x1', blockNumber: '0xa', blockHash: l1Hash, transactionHash: tx, ...change.post };
    }
    assert.equal(method, 'eth_getBlockByNumber');
    return url === 'l1' ? { number: '0xa', hash: change.l1Reorg ? hash('replacement') : l1Hash }
      : { number: '0x5', hash: change.l2Reorg || change.lateReorg && calls.filter(c => c.url === 'l2' && c.method === method).length > 1 ? hash('replacement') : l2Hash };
  } } };
}
test('payment links bind the L2 execution receipt to a canonical index and successful L1 posting receipt', async () => {
  const f = fixture();
  assert.deepEqual(await treasurySettlement(f.client, outcome), { l1Transaction: tx, l1Block: '10', l2Block: '5' });
  assert(f.calls.every(c => !/send|sign/i.test(c.method)));
});
test('unsettled, stale, mismatched or failed evidence never becomes a settlement link', async () => {
  for (const change of [
    { missing: true }, { record: { canonicalL2: false } }, { record: { canonicalL2: undefined } },
    { record: { l2Blocks: [{ number: '0x5', hash: hash('unrelated') }] } }, { record: { l2Blocks: [{ number: '0x6', hash: l2Hash }] } },
    { post: { transactionHash: hash('wrong') } }, { post: { status: '0x0' } }, { post: { blockNumber: '0xb' } },
    { l2Receipt: { status: '0x0' } }, { l2Receipt: { blockNumber: '0x6' } }, { l1Reorg: true }, { l2Reorg: true }, { lateReorg: true },
  ]) assert.equal(await treasurySettlement(fixture(change).client, outcome), null, JSON.stringify(change));
  for (const kind of ['pending', 'unknown', 'rejected']) {
    const f = fixture(); assert.equal(await treasurySettlement(f.client, { ...outcome, kind }), null); assert.equal(f.calls.length, 0);
  }
});
test('index unavailability is explicit and cannot rewrite the payment outcome', async () => {
  const before = JSON.stringify(outcome);
  await assert.rejects(treasurySettlement(fixture({ offline: true }).client, outcome), /index offline/);
  assert.equal(JSON.stringify(outcome), before);
});

test('history links both chains and keeps Chiado initiation distinct from its later settlement', async () => {
  const { treasuryTransactions } = await import('../src/lib/treasury/settlement.ts');
  const intent = { hash: hash('source'), payment: { source: 'l1' } };
  const o = { ...outcome, hash: intent.hash, sourceBlock: '9', execution: { l1: intent.hash, l2: hash('execution') } };
  const settlement = { l1Transaction: tx, l1Block: '10', l2Block: '5' };
  assert.deepEqual(treasuryTransactions(intent, o, settlement), [
    { chain: 'l1', hash: intent.hash, block: '9', role: 'execution' },
    { chain: 'l1', hash: tx, block: '10', role: 'settlement' },
    { chain: 'l2', hash: o.execution.l2, block: '5', role: 'execution' },
  ]);
  assert.deepEqual(treasuryTransactions({ payment: { source: 'l2' }, hash: o.execution.l2 }, outcome, settlement), [
    { chain: 'l1', hash: tx, block: '10', role: 'settlement' },
    { chain: 'l2', hash: o.execution.l2, block: '5', role: 'execution' },
  ]);
});
test('history cannot invent a transaction from a Safe signing hash or unavailable settlement evidence', async () => {
  const { treasuryTransactions, settlementIdentity } = await import('../src/lib/treasury/settlement.ts');
  const intent = { safeHash: hash('signed intent'), payment: { source: 'l2' } };
  assert.deepEqual(treasuryTransactions(intent), []);
  assert.deepEqual(treasuryTransactions(intent, outcome, null), [{ chain: 'l2', hash: outcome.execution.l2, block: '5', role: 'execution' }]);
  assert.equal(settlementIdentity({ ...outcome, kind: 'pending' }), undefined);
  assert.notEqual(settlementIdentity(outcome), settlementIdentity({ ...outcome, block: '6' }));
  assert.deepEqual(treasuryTransactions({ ...intent, hash: tx, payment: { source: 'l1' } }, { sourceBlock: '10' }, { l1Transaction: tx, l1Block: '10', l2Block: '5' }), [
    { chain: 'l1', hash: tx, block: '10', role: 'execution' },
  ]);
});
