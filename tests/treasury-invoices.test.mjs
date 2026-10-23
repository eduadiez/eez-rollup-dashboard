import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem';
import { checkedPayment, paymentAbi, paymentTransaction, settledPayment } from '../src/lib/treasury/payments.ts';
import { invoiceAbi, invoiceTrace, verifyInvoiceRollback } from '../src/lib/treasury/invoices.ts';
import { readIntent } from '../src/lib/treasury/client.ts';
import { safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const address = n => `0x${String(n).repeat(40)}`;
const c = { instance: keccak256(stringToHex('invoices')), registry: address(9), safeL1: address(1), safeL2: address(2), l2: { chainId: 420691 },
  payments: { version: 2, policy: address(3), alias: address(4), tokenL1: address(5), bridgeL1: address(6), invoiceMerchant: address(7) } };
const p = { kind: 'invoice', invoiceId: keccak256(stringToHex('invoice-1')), recipient: address(8), amount: '110000000', destination: 'l1', epoch: '100' };
const tx = paymentTransaction(c, p, 5n), hash = safeTransactionHash(tx);
const intent = { version: 1, instance: c.instance, value: '0', payment: p, nonce: '5', safeHash: hash, data: '0x1234', sender: address(1), sourceNonce: '0x1', startBlock: '0x1' };
test('invoice signs identity, terms, period and acceptance through a distinct typed entry point', () => {
  const call = decodeFunctionData({ abi: paymentAbi, data: tx.message.data });
  assert.equal(call.functionName, 'payInvoice');
  assert.deepEqual(call.args, [c.payments.tokenL1, p.recipient, 110000000n, p.invoiceId, 100n]);
  for (const update of [{ invoiceId: keccak256(stringToHex('other')) }, { amount: '109000000' }, { recipient: address('a') }, { epoch: '101' }, { kind: 'fixed', invoiceId: undefined, fromL1: '100000000' }]) {
    const next = { ...p, ...update }; if (next.kind === 'fixed') delete next.invoiceId;
    assert.notEqual(safeTransactionHash(paymentTransaction(c, next, 5n)), hash);
  }
  assert.equal(tx.message.safeTxGas, 0n); assert.equal(tx.message.gasPrice, 0n);
  for (const update of [{ invoiceId: '0x' }, { invoiceId: `0x${'0'.repeat(64)}` }, { funding: 'local' }, { destination: 'l2' }, { bps: '1000' }]) assert.throws(() => checkedPayment({ ...p, ...update }));
  assert.throws(() => paymentTransaction({ ...c, payments: { ...c.payments, invoiceMerchant: undefined } }, p, 5n));
  assert.deepEqual(readIntent(c, JSON.stringify(intent)), intent);
  assert.throws(() => readIntent(c, JSON.stringify({ ...intent, payment: { ...p, invoiceId: keccak256(stringToHex('changed')) } })));
});
const trace = () => ({ to: c.registry, error: 'execution reverted', calls: [
  ...[[c.payments.bridgeL1, 10000000n], [c.safeL1, 100000000n]].map(([from, amount]) => ({ from, to: c.payments.tokenL1,
    input: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [p.recipient, amount] }),
    output: encodeAbiParameters([{ type: 'bool' }], [true]) })),
  { from: c.payments.alias, to: c.payments.invoiceMerchant, input: encodeFunctionData({ abi: invoiceAbi, functionName: 'accept', args: [p.invoiceId, c.payments.tokenL1, p.recipient, BigInt(p.amount)] }),
    error: 'execution reverted', output: `0xa1c43db2${p.invoiceId.slice(2)}` },
] });
test('rollback requires successful earlier transfers and the exact later invoice error within a reverted frame', () => {
  invoiceTrace(trace(), c, intent);
  for (const mutate of [t => t.calls.reverse(), t => t.calls.shift(), t => delete t.error, t => t.calls[0].error = 'reverted',
    t => t.calls[1].output = '0x00', t => t.calls[2].output = '0x', t => t.calls[2].from = address(1), t => t.calls[0].from = address(1)]) {
    const t = trace(); mutate(t); assert.throws(() => invoiceTrace(t, c, intent));
  }
});
test('receipt settlement requires InvoicePaid as well as Paid, with the signed invoice ID', () => {
  const paid = { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'Paid', args: { token: c.payments.tokenL1, recipient: p.recipient } }),
    data: encodeAbiParameters([{ type: 'bool' }, ...Array(4).fill({ type: 'uint256' })], [true, 110000000n, 100000000n, 10000000n, 100n]) };
  const accepted = { address: c.payments.policy, topics: encodeEventTopics({ abi: paymentAbi, eventName: 'InvoicePaid', args: { invoiceId: p.invoiceId } }), data: '0x' };
  assert.deepEqual(settledPayment(c, p, [paid, accepted]), { fromL1: '100000000', fromL2: '10000000' });
  assert.equal(settledPayment(c, p, [paid]), undefined);
  assert.equal(settledPayment(c, p, [paid, accepted, accepted]), undefined);
  assert.equal(settledPayment(c, { ...p, invoiceId: keccak256(stringToHex('different')) }, [paid, accepted]), undefined);
});
test('an unverified or unrelated fixture report cannot unlock a rollback result', async () => {
  for (const report of [{ phase: 'unverified' }, { phase: 'verified', intent: { ...intent, safeHash: '0x' } }, { phase: 'verified', intent }])
    await assert.rejects(verifyInvoiceRollback({ config: c }, intent, report), /Incomplete invoice/);
});

test('the fixture inspects both native blob envelopes without changing signed payload or DA bytes', async () => {
  const { postedTransaction } = await import('../scripts/treasury-invoices.mjs');
  const { fromRlp, toRlp, concatHex, toHex } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(toHex(1n, { size: 32 }));
  const raw = await account.signTransaction({ type: 'eip4844', chainId: 1337, nonce: 0, to: c.registry, gas: 100000n,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n, blobVersionedHashes: [`0x01${'0'.repeat(62)}`], sidecars: false, data: '0x1234' });
  const payload = fromRlp(`0x${raw.slice(4)}`, 'hex');
  for (const wrapper of [[payload, ['0x00'], ['0x01'], ['0x02']], [payload, '0x01', ['0x00'], ['0x01'], ['0x02']]]) {
    const envelope = concatHex(['0x03', toRlp(wrapper)]), before = envelope;
    const result = postedTransaction(envelope);
    assert.equal(result.hash, keccak256(raw)); assert.equal(result.transaction.data, '0x1234'); assert.equal(envelope, before);
  }
  assert.throws(() => postedTransaction(concatHex(['0x03', toRlp([payload, '0x02', [], [], []])])), /sidecar version/);
  assert.throws(() => postedTransaction(raw), /network envelope/);
});


test('a canonical zero-tip blob post remains inspectable without rewriting the native envelope', async () => {
  const { postedTransaction } = await import('../scripts/treasury-invoices.mjs');
  const { fromRlp, toRlp, concatHex, toHex } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(toHex(1n, { size: 32 }));
  const raw = await account.signTransaction({ type: 'eip4844', chainId: 1337, nonce: 17, to: c.registry, gas: 100000n,
    maxFeePerGas: 970426n, maxPriorityFeePerGas: 0n, maxFeePerBlobGas: 2n,
    blobVersionedHashes: [`0x01${'0'.repeat(62)}`], sidecars: false, data: '0x1234' });
  const payload = fromRlp(`0x${raw.slice(4)}`, 'hex');
  assert.equal(payload[2], '0x');
  for (const sidecar of [[payload, [], [], []], [payload, '0x01', [], [], []]]) {
    const envelope = concatHex(['0x03', toRlp(sidecar)]);
    const parsed = postedTransaction(envelope);
    assert.equal(parsed.transaction.maxPriorityFeePerGas, 0n);
    assert.equal(parsed.transaction.maxPriorityFeePerGas + 1n, 1n);
    assert.equal(parsed.hash, keccak256(raw));
    assert.deepEqual(fromRlp(`0x${envelope.slice(4)}`, 'hex'), sidecar);
  }
});
