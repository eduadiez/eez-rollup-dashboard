import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { PaymentHistoryStore, attemptId, historyConfig, historyKey, historyStatus } from '../src/lib/treasury/history.ts';
import { paymentTransaction } from '../src/lib/treasury/payments.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const address = byte => `0x${byte.repeat(40)}`;
const hash = text => keccak256(stringToHex(text));
const config = { instance: hash('history'), l2: { chainId: 420691 }, safeL2: address('1'), payments: { version: 2, policy: address('2'), tokenL1: address('3') } };
const payment = { amount: '40000000', recipient: address('4'), fromL1: '0', destination: 'l2', epoch: '100' };
const intent = { version: 1, instance: config.instance, value: '0', payment, nonce: '5', safeHash: safeTransactionHash(paymentTransaction(config, payment, 5n)),
  data: '0x1234', sender: address('5'), sourceNonce: '0xa', startBlock: '0x12' };
function fixture() {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  return { values, storage, store: new PaymentHistoryStore(config, storage) };
}
test('a missing response and its recovered hash remain one payment across reloads and repeated polls', () => {
  const { store, storage } = fixture();
  const first = store.remember(intent)[0];
  for (let i = 0; i < 4; i++) store.remember({ ...intent, hash: hash('source') });
  store.remember(intent); // a stale tab must not erase the recovered hash
  const loaded = new PaymentHistoryStore(config, storage).read();
  assert.equal(loaded.length, 1); assert.equal(loaded[0].recordedAt, first.recordedAt);
  assert.equal(loaded[0].intent.hash, hash('source'));
  assert.equal(historyStatus(loaded[0]), 'pending', 'no persisted settlement assertion');
});
test('distinct source attempts using the same Safe hash/nonce are retained', () => {
  const { store } = fixture();
  store.remember(intent);
  for (const edit of [{ sourceNonce: '0xb' }, { sender: address('6') }, { startBlock: '0x13' }]) store.remember({ ...intent, ...edit });
  assert.equal(store.read().length, 4);
  assert.equal(new Set(store.read().map(e => e.id)).size, 4);
  assert.equal(attemptId(intent), attemptId({ ...intent, sourceNonce: '0x0a', startBlock: '0x012' }));
});
test('browser-local preparation checks are distinct from signed or submitted payments', () => {
  const { store, storage } = fixture();
  const [entry] = store.reject(payment, 'Shared budget exceeded');
  assert.equal(entry.kind, 'preparation'); assert.equal(entry.intent, undefined);
  assert.equal(historyStatus(entry), 'preparation');
  assert.deepEqual(new PaymentHistoryStore(config, storage).read(), [entry]);
  store.remember(intent);
  assert.equal(store.read().length, 2);
});
test('devnet history is isolated by deployment even when addresses repeat', () => {
  const { store, storage, values } = fixture();
  store.remember(intent);
  const other = { ...config, instance: hash('other') }, next = new PaymentHistoryStore(other, storage);
  assert.deepEqual(next.read(), []);
  storage.setItem(historyKey(other), values.get(historyKey(config)));
  assert.throws(() => next.read(), /devnet/);
});
test('corruption, tampered identities, duplicated records and unsupported schema never silently overwrite old records', () => {
  const { store, storage } = fixture();
  store.remember(intent); const good = JSON.parse(storage.getItem(historyKey(config)));
  const corrupt = ['{', JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, entries: [...good.entries, ...good.entries] }),
    JSON.stringify({ ...good, entries: [{ ...good.entries[0], intent: { ...intent, payment: { ...payment, amount: '41000000' } } }] })];
  for (const text of corrupt) {
    storage.setItem(historyKey(config), text);
    assert.throws(() => store.remember(intent));
    assert.equal(storage.getItem(historyKey(config)), text);
  }
});
test('storage exhaustion propagates before an unrecorded send and existing data stays readable', () => {
  const { store, storage } = fixture();
  store.remember(intent);
  storage.setItem = () => { throw new Error('quota exceeded'); };
  assert.throws(() => store.remember({ ...intent, startBlock: '0x13' }), /quota exceeded/);
  assert.equal(store.read().length, 1);
});
test('wallet cancellation removes only the unsent attempt; submitted hashes cannot be removed or replaced', () => {
  const { store } = fixture();
  store.remember(intent); store.cancel(intent); assert.deepEqual(store.read(), []);
  store.remember({ ...intent, hash: hash('source') });
  assert.throws(() => store.cancel(intent), /submitted/);
  assert.throws(() => store.remember({ ...intent, hash: hash('replacement') }), /Conflicting/);
  assert.equal(store.read()[0].intent.hash, hash('source'));
});
test('writes merge existing records from another mounted view and omit owner actions', () => {
  const { store, storage } = fixture(), other = new PaymentHistoryStore(config, storage);
  store.remember(intent); other.reject(payment, 'Capacity exceeded'); store.remember({ ...intent, hash: hash('source') });
  assert.equal(store.read().length, 2);
  store.remember({ ...intent, payment: undefined }); assert.equal(store.read().length, 2);
});
test('history classifications require current evidence and downgrade on reorg or unavailable reads', () => {
  const { store } = fixture(), [entry] = store.remember(intent);
  const observation = outcome => ({ outcome });
  assert.equal(historyStatus(entry, observation({ kind: 'settled' })), 'settled');
  assert.equal(historyStatus(entry, observation({ kind: 'pending', detail: 'reorg' })), 'pending');
  assert.equal(historyStatus(entry, { outcome: { kind: 'settled' }, error: 'offline' }), 'pending');
  assert.equal(historyStatus(entry, { outcome: { kind: 'settled' }, checking: true }), 'pending');
  assert.equal(historyStatus(entry, observation({ kind: 'rejected' })), 'rejected');
  assert.equal(historyStatus(entry, observation({ kind: 'rejected', rejectionStage: 'preparation' })), 'preparation');
  assert.equal(historyStatus(entry, observation({ kind: 'rejected', rollback: { postHash: hash('verified') } })), 'rollback');
  assert.equal(historyStatus(entry, observation({ kind: 'pending', rollback: {} })), 'pending', 'incomplete reconciliation is not a completed rollback');
});

test('an in-place policy upgrade retains old payment identities and their original receipt configuration', () => {
  const { store, storage } = fixture();
  store.remember({ ...intent, hash: hash('settled-old') });
  store.reject(payment, 'Old policy preparation rejection');
  const upgraded = { ...config, previousPayments: config.payments,
    payments: { ...config.payments, predecessor: config.payments.policy, policy: address('8'), l1Initiation: true } };
  const next = new PaymentHistoryStore(upgraded, storage);
  assert.equal(next.read().length, 2);
  const old = next.read()[0].intent;
  assert.equal(historyConfig(upgraded, old).payments.policy, config.payments.policy);
  const fresh = { ...intent, nonce: '6', safeHash: safeTransactionHash(paymentTransaction(upgraded, payment, 6n)), sourceNonce: '0xb' };
  next.remember(fresh);
  assert.equal(next.read().length, 3);
  assert.equal(historyConfig(upgraded, fresh), upgraded);
  assert.throws(() => historyConfig(upgraded, { ...old, safeHash: hash('unrelated-policy') }), /does not match/);
});

test('payments remain verifiable through a second policy handover', () => {
  const {store,storage}=fixture();store.remember(intent);
  const first={...config,payments:{...config.payments,policy:address('6'),predecessor:config.payments.policy,l1Initiation:true},previousPayments:config.payments};
  const second={...first,payments:{...first.payments,policy:address('7'),predecessor:first.payments.policy,exactSplits:true},previousPayments:first.payments,olderPayments:[config.payments]};
  const saved=new PaymentHistoryStore(second,storage).read();
  assert.equal(saved.length,1);
  assert.equal(historyConfig(second,saved[0].intent).payments.policy,config.payments.policy);
  assert.deepEqual(saved[0].intent,intent);
});
