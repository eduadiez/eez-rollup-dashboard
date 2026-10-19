// Pure mocked JSON-RPC checks; no wallet signing or network access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { estimateBridgeGas } = await import('../src/lib/gasEstimation.ts');
const calls = [];
const request = { rpcUrl: 'https://composer.invalid/l1', from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x12345678', value: '0x7' };
let response;
globalThis.fetch = async (url, init) => {
  calls.push({ url, ...JSON.parse(init.body) });
  return { json: async () => typeof response === 'function' ? response() : response };
};
response = { result: '0x671af' };
assert.deepEqual(await estimateBridgeGas(request), { gasLimit: 422319n, rawEstimate: 422319n, method: 'direct' });
assert.equal(calls.length, 1);
assert.equal(calls[0].url, request.rpcUrl);
assert.equal(calls[0].method, 'eth_estimateGas');
const { rpcUrl, ...tx } = request;
assert.deepEqual(calls[0].params, [tx]);
for (const result of ['0x0', 'malformed', null, undefined, 422319, '0x20000000000000']) {
  calls.length = 0; response = { result };
  await assert.rejects(estimateBridgeGas(request), /invalid bridge gas estimate/);
  assert.equal(calls.length, 1, 'invalid estimate must never trigger a simulation or fixed/calldata fallback');
}
for (const message of ['execution reverted: NotReady', 'Composer unavailable']) {
  calls.length = 0; response = { error: { message } };
  await assert.rejects(estimateBridgeGas(request), error => error.message === message);
  assert.equal(calls.length, 1, 'Composer errors must surface without retries against another RPC');
}
for (const error of [{ code: -32601, message: 'Method not found' }, { code: 3, message: 'execution reverted', data: '0xf9d330ad' },
  { code: 3, message: 'execution reverted', data: '0x096aa08200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004f9d330ad00000000000000000000000000000000000000000000000000000000' }]) {
  calls.length = 0; response = { error };
  await assert.rejects(estimateBridgeGas(request), e => e.type === 'unsupported');
  assert.equal(calls.length, 1, 'unsupported estimation must not invent a gas limit');
}
response = { error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } };
await assert.rejects(estimateBridgeGas(request), e => e.type !== 'unsupported', 'unrecognized contract failure must not enable manual bypass');
console.log('Pass: raw bridge Composer gas, exact transaction fields, invalid/error estimates rejected without fallbacks');

const transient = code => ({ error: { code: -32000, message: 'context not ready', data: { code, retryable: true } } });
const flush = () => new Promise(setImmediate);

test('known transient contexts retry the exact estimate on the same Composer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of ['settlement_reconciliation_pending', 'estimation_context_changed']) {
    calls.length = 0;
    const replies = [transient(code), { result: '0x671af' }];
    response = () => replies.shift();
    const pending = estimateBridgeGas(request).then(value => ({ value }), error => ({ error }));
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1000);
    assert.deepEqual((await pending).value, { gasLimit: 422319n, rawEstimate: 422319n, method: 'direct' });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, request.rpcUrl);
      assert.equal(call.method, 'eth_estimateGas');
      assert.deepEqual(call.params, [tx]);
    }
  }
});

test('a persistent reconciliation wait stops after four attempts without a gas fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  response = transient('settlement_reconciliation_pending');
  const pending = estimateBridgeGas(request).then(value => ({ value }), error => ({ error }));
  for (const delay of [1000, 2000, 4000]) {
    await flush();
    t.mock.timers.tick(delay);
  }
  const { error, value } = await pending;
  assert.equal(value, undefined);
  assert.equal(error.type, 'unavailable');
  assert.match(error.message, /settlement.*retry/i);
  assert.equal(calls.length, 4);
});

test('unknown errors and misleading text never trigger automatic retries', async () => {
  for (const error of [
    { code: -32000, message: 'cross-chain estimation unavailable: settlement reconciliation pending' },
    { code: -32000, message: 'context not ready', data: { code: 'other', retryable: true } },
    { code: 3, message: 'execution reverted', data: { code: 'settlement_reconciliation_pending', retryable: true } },
    { code: -32000, message: 'context not ready', data: { code: 'settlement_reconciliation_pending', retryable: false } },
  ]) {
    calls.length = 0;
    response = { error };
    await assert.rejects(estimateBridgeGas(request), e => e.message === error.message);
    assert.equal(calls.length, 1);
  }
});

test('cancelling an obsolete estimate stops its backoff and further RPC calls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  calls.length = 0;
  response = transient('settlement_reconciliation_pending');
  const controller = new AbortController();
  const pending = estimateBridgeGas({ ...request, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  await flush();
  controller.abort();
  t.mock.timers.tick(7000);
  assert.equal((await pending).error.name, 'AbortError');
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(estimateBridgeGas({ ...request, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
