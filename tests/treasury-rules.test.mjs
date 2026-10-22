import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import { checkedPayment, formatPercentage, fundingPreview, parsePercentage, paymentAbi, paymentAmount, paymentTransaction, settledPayment } from '../src/lib/treasury/payments.ts';
import { readIntent } from '../src/lib/treasury/client.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';

const address = byte => `0x${byte.repeat(40)}`;
const c = { instance: keccak256(stringToHex('rule-devnet')), safeL2: address('2'), l2: { chainId: 420691 },
  payments: { policy: address('3'), tokenL1: address('4'), combinedL2: true, percentageRules: true } };
const rule = { kind: 'rule', recipient: address('1'), bps: '1000', destination: 'l1', funding: 'combined', epoch: '100' };
const state = { epoch: 100n, balanceL1: 200_000_000n, balanceL2: 100_000_000n,
  allowanceL1: [100_000_000n, 0n], allowanceL2: [100_000_000n, 0n], spent: 0n, globalLimit: 150_000_000n };
const hash = (payment = rule, nonce = 5n, config = c) => safeTransactionHash(paymentTransaction(config, payment, nonce));
const log = (name, overrides = {}) => {
  const a = { token: c.payments.tokenL1, recipient: rule.recipient, onL1: true, bps: 1000, balanceL1: 200_000_000n,
    balanceL2: 100_000_000n, amount: 30_000_000n, fromL1: 30_000_000n, fromL2: 0n, epoch: 100n, ...overrides };
  const keys = name === 'Paid' ? ['onL1', 'amount', 'fromL1', 'fromL2', 'epoch'] : ['onL1', 'bps', 'balanceL1', 'balanceL2', 'amount', 'epoch'];
  return { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: name, args: { token: a.token, recipient: a.recipient } }),
    data: encodeAbiParameters(keys.map(key => ({ type: key === 'onL1' ? 'bool' : key === 'bps' ? 'uint16' : 'uint256' })), keys.map(key => a[key])) };
};

test('percentages preserve basis-point precision and reject rounding or invalid bounds', () => {
  for (const [text, bps] of [['0.01', 1n], ['1.25', 125n], ['10', 1000n], ['99.99', 9999n], ['100', 10000n]]) {
    assert.equal(parsePercentage(text), bps); assert.equal(formatPercentage(bps), text);
  }
  for (const text of ['0', '0.001', '100.01', '-1', '1e1', '10.', '.1', ' 10', '10%']) assert.throws(() => parsePercentage(text));
});
test('rule amounts use both Safe holdings, round down and never clip to available capacity', () => {
  assert.equal(paymentAmount(state, rule), 30_000_000n);
  assert.equal(paymentAmount({ ...state, balanceL2: 99_999_999n }, rule), 29_999_999n);
  assert.equal(paymentAmount({ ...state, allowanceL1: [0n, 0n], allowanceL2: [0n, 0n], spent: 150_000_000n }, rule), 30_000_000n);
  assert.throws(() => paymentAmount({ balanceL1: 9n, balanceL2: 0n }, rule), /rounds down to zero/);
  assert.equal(paymentAmount({ balanceL1: 9n, balanceL2: 0n }, { ...rule, bps: '10000' }), 9n);
  assert.throws(() => paymentAmount(state, { ...rule, bps: '10000' }), /exceeding the 150/);
  assert.throws(() => fundingPreview({ ...state, allowanceL1: [1_000_000n, 0n], allowanceL2: [1_000_000n, 0n] }, rule), /Insufficient/);
  assert.throws(() => fundingPreview({ ...state, spent: 140_000_000n }, rule), /Shared budget/);
  assert.throws(() => fundingPreview({ ...state, epoch: 101n }, rule), /period changed/);
});
test('rules route to either chain through the same destination-first capacities', () => {
  assert.deepEqual(fundingPreview(state, rule), { fromL1: 30_000_000n, fromL2: 0n });
  assert.deepEqual(fundingPreview({ ...state, allowanceL1: [100_000_000n, 90_000_000n] }, rule), { fromL1: 10_000_000n, fromL2: 20_000_000n });
  assert.deepEqual(fundingPreview({ ...state, allowanceL2: [100_000_000n, 90_000_000n] }, { ...rule, destination: 'l2' }), { fromL1: 20_000_000n, fromL2: 10_000_000n });
});
test('a rule signs its fraction, destination, recipient, asset, period and Safe nonce, without an estimated amount', () => {
  const tx = paymentTransaction(c, rule, 5n), call = decodeFunctionData({ abi: paymentAbi, data: tx.message.data });
  assert.equal(call.functionName, 'payRule'); assert.deepEqual(call.args, [c.payments.tokenL1, rule.recipient, 1000, true, 100n]);
  assert.equal(tx.domain.chainId, 420691n); assert.equal(tx.domain.verifyingContract, c.safeL2);
  for (const update of [{ bps: '500' }, { recipient: address('6') }, { destination: 'l2' }, { epoch: '101' }]) assert.notEqual(hash({ ...rule, ...update }), hash());
  assert.notEqual(hash(rule, 6n), hash());
  assert.notEqual(hash(rule, 5n, { ...c, payments: { ...c.payments, tokenL1: address('7') } }), hash());
  assert.notEqual(hash({ recipient: rule.recipient, amount: '30000000', destination: 'l1', funding: 'combined', epoch: rule.epoch }), hash());
  assert.equal(paymentAmount(state, rule), 30_000_000n);
  assert.equal(paymentAmount({ ...state, balanceL1: 250_000_000n }, rule), 35_000_000n);
  assert.equal(safeTransactionHash(tx), hash(), 'changed holdings do not change the signed fraction');
});
test('rule validation rejects ambiguous payment shapes and old deployment capabilities', () => {
  for (const update of [{ bps: '0' }, { bps: '10001' }, { bps: '1.5' }, { amount: '30000000' }, { funding: 'local' }, { kind: 'fixed' }])
    assert.throws(() => checkedPayment({ ...rule, ...update }));
  for (const flag of [false, undefined]) assert.throws(() => paymentTransaction({ ...c, payments: { ...c.payments, percentageRules: flag } }, rule, 5n), /does not support percentage/);
  assert.throws(() => paymentTransaction({ ...c, payments: { ...c.payments, combinedL2: false } }, { ...rule, destination: 'l2' }, 5n), /does not support combined/);
});
test('reload recovery preserves a signed rule and rejects changes to its parameters', () => {
  const saved = { version: 1, instance: c.instance, value: '0', payment: rule, nonce: '5', safeHash: hash(), data: '0x1234', sender: address('5'), sourceNonce: '0x1', startBlock: '0x1' };
  assert.deepEqual(readIntent(c, JSON.stringify(saved)), saved);
  for (const update of [{ bps: '500' }, { destination: 'l2' }, { epoch: '101' }, { amount: '30000000' }])
    assert.throws(() => readIntent(c, JSON.stringify({ ...saved, payment: { ...rule, ...update } })));
  assert.throws(() => readIntent(c, JSON.stringify({ ...saved, nonce: '6' })));
});
test('settlement requires both matching events and recomputes the executed fraction', () => {
  assert.deepEqual(settledPayment(c, rule, [log('Paid'), log('RulePaid')]), { fromL1: '30000000', fromL2: '0',
    rule: { bps: '1000', balanceL1: '200000000', balanceL2: '100000000', amount: '30000000' } });
  // A preview of 30 may validly settle as 35 when the Safe holdings change.
  const changed = { amount: 35_000_000n, fromL1: 35_000_000n, balanceL1: 250_000_000n };
  assert.equal(settledPayment(c, rule, [log('Paid', changed), log('RulePaid', changed)]).rule.amount, '35000000');
  const reverse = { onL1: false, fromL1: 10_000_000n, fromL2: 20_000_000n };
  assert.equal(settledPayment(c, { ...rule, destination: 'l2' }, [log('Paid', reverse), log('RulePaid', reverse)]).fromL2, '20000000');
  for (const logs of [[], [log('Paid')], [log('RulePaid')], [log('Paid'), log('Paid'), log('RulePaid')], [log('Paid'), log('RulePaid'), log('RulePaid')],
    [log('Paid'), { ...log('RulePaid'), address: address('9') }]]) assert.equal(settledPayment(c, rule, logs), undefined);
  for (const update of [{ bps: 999 }, { bps: 0 }, { balanceL1: 199_999_999n }, { amount: 29_999_999n }, { epoch: 101n }, { onL1: false }, { recipient: address('6') }, { token: address('7') }])
    assert.equal(settledPayment(c, rule, [log('Paid'), log('RulePaid', update)]), undefined);
  for (const update of [{ fromL1: 29_999_999n }, { amount: 29_999_999n }, { onL1: false }, { epoch: 101n }, { recipient: address('6') }])
    assert.equal(settledPayment(c, rule, [log('Paid', update), log('RulePaid')]), undefined);
  assert.equal(settledPayment(c, rule, [log('Paid'), log('RulePaid', { balanceL1: (1n << 256n) - 1n })]), undefined);
  assert.equal(settledPayment(c, rule, [log('Paid'), log('RulePaid', { balanceL1: 0n, balanceL2: 300_000_000n })]), undefined, 'funding cannot exceed observed Safe balance');
});
test('fixed settlement cannot masquerade as a percentage payment', () => {
  const fixed = { recipient: rule.recipient, amount: '30000000', destination: 'l1', funding: 'combined', epoch: rule.epoch };
  assert.deepEqual(settledPayment(c, fixed, [log('Paid')]), { fromL1: '30000000', fromL2: '0' });
  assert.equal(settledPayment(c, fixed, [log('Paid'), log('RulePaid')]), undefined);
});
