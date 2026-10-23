import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toHex } from 'viem';
import { setupTransactions, observeSetupTransaction, assertSetupProgress } from '../src/lib/treasury/setupTransactions.ts';
const hash = value => keccak256(toHex(value));
const first = hash('first'), second = hash('second');
const state = { completed: ['one', 'two'], transactions: [first, second], pending: { id: 'three', chain: 'l2' } };
const steps = () => [{ id: 'one', label: 'Create Chiado Safe', chain: 'l1' }, { id: 'two', label: 'Create EEZ-X Safe', chain: 'l2' }, { id: 'three', label: 'Configure spending', chain: 'l2' }];
function fixture() {
  const observed = { receipt: { status: '0x1', blockNumber: '0x20', blockHash: hash('block') }, block: { number: '0x20', hash: hash('block'), timestamp: '0x64' } };
  const reader = { steps, async rpc(_chain, method) {
    if (method === 'eth_getTransactionReceipt') return observed.receipt;
    assert.equal(method, 'eth_getBlockByNumber'); return observed.block;
  } };
  return { observed, reader };
}
test('history keeps setup order, both chains and the unresolved last request without inventing a hash', () => {
  const rows = setupTransactions({ steps }, state);
  assert.deepEqual(rows.map(row => [row.id, row.chain, row.hash, row.completed]), [['one', 'l1', first, true], ['two', 'l2', second, true], ['three', 'l2', undefined, false]]);
});
test('history observes included and failed receipts without treating inclusion as finality', async () => {
  const { observed, reader } = fixture(), row = setupTransactions({ steps }, state)[0];
  assert.deepEqual(await observeSetupTransaction(reader, row), { status: 'included', blockNumber: '0x20', blockHash: hash('block'), timestamp: 100000 });
  observed.receipt.status = '0x0';
  assert.equal((await observeSetupTransaction(reader, row)).status, 'failed');
});
test('missing receipts, reorganized blocks and RPC failures cannot retain success in history', async () => {
  const row = setupTransactions({ steps }, state)[0];
  for (const mode of ['missing', 'reorg', 'moved', 'rpc']) {
    const { observed, reader } = fixture();
    if (mode === 'missing') observed.receipt = null;
    if (mode === 'reorg') observed.block.hash = hash('replacement');
    if (mode === 'rpc') reader.rpc = async () => { throw Error('offline'); };
    const tx = mode === 'moved' ? { ...row, inclusion: { blockNumber: '0x20', blockHash: hash('previous inclusion') } } : row;
    assert.equal((await observeSetupTransaction(reader, tx)).status, mode === 'rpc' ? 'unavailable' : 'rechecking');
  }
});
test('legacy completed entries remain usable after current canonical receipts are verified', async () => {
  const { reader } = fixture();
  await assertSetupProgress(reader, state);
  assert.equal((await observeSetupTransaction(reader, setupTransactions({ steps }, state)[2])).status, 'pending');
});
test('progress verification bounds concurrent observations', async () => {
  let active=0, maximum=0;
  const { reader }=fixture(), rpc=reader.rpc;
  reader.rpc=async (...args)=>{
    maximum=Math.max(maximum,++active);
    await new Promise(resolve=>setTimeout(resolve,1));
    try { return await rpc(...args); } finally { active--; }
  };
  const plan=Array.from({length:12},(_,i)=>({id:String(i),label:String(i),chain:'l1'}));
  reader.steps=()=>plan;
  await assertSetupProgress(reader,{completed:plan.map(s=>s.id),transactions:plan.map(s=>hash(s.id))});
  assert.equal(maximum,4);
});
