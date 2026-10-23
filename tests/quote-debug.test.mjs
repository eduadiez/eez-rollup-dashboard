import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, encodeErrorResult, parseAbi } from 'viem';
import { buildDebugQuote, decodeQuoteFrame, decodeQuoteRun, fetchVerifiedQuoteAbi, quoteChain, requestDebugQuote } from '../src/lib/quoteDebug.ts';

globalThis.window = { location: { origin: 'https://dashboard.invalid' } };
const address = byte => '0x' + byte.repeat(20);
const caller = address('11'), proxy = address('22'), implementation = address('33');
const bytes = hex => ({ hex, length: (hex.length - 2) / 2, truncated: false });
const fields = { from: caller, to: proxy, value: '123', data: '0x', gas: '', nonce: '' };
const abi = parseAbi([
  'function execute((address recipient, uint256 amount)[] payments, string memo) returns (uint256 total)',
  'function transfer(address recipient, uint256 amount) returns (bool success)',
  'error BadToken(address token)',
]);
const data = encodeFunctionData({ abi, functionName: 'execute', args: [[{ recipient: caller, amount: 123456789012345678901n }], 'invoice'] });
const frame = (id = 0) => ({ id, chainId: '0x1', codeAddress: implementation, to: proxy, kind: 'DELEGATECALL',
  status: 'success', input: bytes(data), output: bytes(encodeAbiParameters([{ type: 'uint256' }], [123456789012345678901n])) });
const verified = { abi, name: 'VerifiedSettlement' };
const response = (metadata = verified) => new Response(JSON.stringify({ status: '1', result: [{ SourceCode: 'contract Verified {}',
  ContractName: metadata.name, ABI: JSON.stringify(metadata.abi) }] }), { headers: { 'Content-Type': 'application/json' } });

test('builds a single unsigned debug request with exact decimal/hex quantities', () => {
  const request = buildDebugQuote({ ...fields, gas: '16777216', nonce: '0x12bf0' }, '0x0');
  assert.equal(request.method, 'eez_debugQuoteFee');
  assert.deepEqual(request.params, [{ from: caller, to: proxy, data: '0x', value: '0x7b', gas: '0x1000000', nonce: '0x12bf0' },
    { trace: 'calls', transactionTypes: ['0x0'] }]);
  assert.equal(buildDebugQuote({ ...fields, to: '' }, 'both').params[0].to, undefined);
  assert.deepEqual(buildDebugQuote(fields, 'both').params[1], { trace: 'calls' });
  for (const bad of [{ from: 'bad' }, { to: 'bad' }, { data: '0x1' }, { value: '-1' }, { value: '1.2' },
    { gas: '0' }, { nonce: (1n << 64n).toString() }, { value: (1n << 256n).toString() }]) {
    assert.throws(() => buildDebugQuote({ ...fields, ...bad }, '0x2'));
  }
});

test('decodes verified tuples/arrays and preserves integer precision and delegate target', () => {
  const decoded = decodeQuoteFrame(frame(), verified);
  assert.equal(decoded.method, 'execute');
  assert.equal(decoded.signature, 'execute((address,uint256)[],string)');
  assert.match(decoded.arguments, /123456789012345678901/);
  assert.match(decoded.arguments, /payments/);
  assert.match(decoded.arguments, /recipient/);
  assert.match(decoded.returns, /123456789012345678901/);
  assert.match(decoded.note, /historical code match not checked/);
});

test('decodes custom reverts independently of the function selector without changing outcomes', () => {
  const call = { ...frame(), status: 'revert', input: bytes('0xdeadbeef'), output: bytes(encodeErrorResult({ abi, errorName: 'BadToken', args: [proxy] })) };
  const before = structuredClone(call);
  const decoded = decodeQuoteFrame(call, verified);
  assert.match(decoded.error, /BadToken\(address\)/);
  assert.match(decoded.error, new RegExp(proxy));
  assert.equal(decoded.returns, undefined);
  assert.deepEqual(call, before);
});

test('keeps truncated, unknown, malformed, empty-return and constructor data explicit', () => {
  const call = frame(); call.input.truncated = true; call.input.length++;
  let decoded = decodeQuoteFrame(call, verified);
  assert.equal(decoded.method, 'execute'); assert.equal(decoded.arguments, undefined);
  assert.match(decoded.note, /Input is truncated/);
  call.status = 'revert'; call.output = { ...bytes('0xdeadbeef'), truncated: true, length: 100 };
  assert.equal(decodeQuoteFrame(call, verified).error, undefined);
  const emptyReturn = { ...frame(), input: bytes(encodeFunctionData({ abi, functionName: 'transfer', args: [caller, 1n] })), output: bytes('0x') };
  decoded = decodeQuoteFrame(emptyReturn, verified);
  assert.equal(decoded.returns, undefined); assert.match(decoded.note, /returned no data despite declared return values/);
  assert.equal(decodeQuoteFrame({ ...frame(), kind: 'CREATE2' }, verified).method, undefined);
  assert.equal(decodeQuoteFrame(frame(), null).method, undefined);
  assert.equal(decodeQuoteFrame({ ...frame(), input: bytes(data.slice(0, 10)) }, verified).arguments, undefined);
});

test('overloads use the matching selector, and collisions remain ambiguous', () => {
  const overloaded = parseAbi(['function f(uint256 n) returns (uint256)', 'function f(address n) returns (address)']);
  const call = { ...frame(), input: bytes(encodeFunctionData({ abi: overloaded, functionName: 'f', args: [caller] })),
    output: bytes(encodeAbiParameters([{ type: 'address' }], [caller])) };
  assert.equal(decodeQuoteFrame(call, { abi: overloaded }).signature, 'f(address)');
  const duplicated = { abi: [overloaded[1], overloaded[1]] };
  assert.equal(decodeQuoteFrame(call, duplicated).method, undefined);
});

test('uses the actual chain and code address, deduplicates and bounds concurrent metadata work', async t => {
  const urls = []; let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(new URL(url)); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return response();
  });
  const frames = Array.from({ length: 10 }, (_, id) => ({ ...frame(id), codeAddress: address((40 + id).toString(16)) }));
  frames.push({ ...frames[0], id: 10 }, { ...frame(11), chainId: '0x2' });
  const annotations = [];
  const status = await decodeQuoteRun({ id: 0, frames }, { l1: '0x1', l2: '0x2' },
    { l1: 'https://l1.invalid', l2: 'https://l2.invalid/explorer' }, new AbortController().signal, items => annotations.push(...items));
  assert.equal(urls.length, 11); assert.equal(peak, 4);
  assert(urls.every(url => url.searchParams.get('address') !== proxy));
  assert(urls.some(url => url.hostname === 'l2.invalid' && url.pathname === '/explorer/api'));
  assert.equal(annotations.length, 12); assert.match(status, /11 verified contract ABIs/);
  assert.equal(quoteChain('0x01', { l1: '0x1', l2: '0x2' }), 'l1');
  assert.equal(quoteChain('0x3', { l1: '0x1', l2: '0x2' }), null);
  assert.equal(quoteChain('0x1', { l1: '0x1', l2: '0x1' }), null);
  assert.equal(quoteChain('0x1', { l1: '0x1', l2: null }), 'l1');
  assert.equal(quoteChain('0x539', { l1: null, l2: '0x2' }), null, 'development defaults must not select an explorer after discovery fails');
});

test('does not fetch foreign-chain contracts or follow current proxy implementations', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ status: '1', result: [{ SourceCode: 'proxy', ContractName: 'HistoricalImplementation', ABI: JSON.stringify(abi),
      ImplementationAddress: address('ff'), IsProxy: 'true' }] }));
  });
  const annotations = [];
  await decodeQuoteRun({ id: 0, frames: [frame(), { ...frame(1), chainId: '0x99' }] }, { l1: '0x1', l2: '0x2' },
    { l1: 'https://l1.invalid', l2: '' }, new AbortController().signal, value => annotations.push(...value));
  assert.equal(urls.length, 1); assert(urls[0].includes(implementation)); assert(!urls[0].includes(address('ff')));
  assert.equal(annotations.length, 1);
});

test('cancellation stops new lookups and suppresses superseded annotations', async t => {
  const controller = new AbortController(); let calls = 0, annotations = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); return response(); });
  await decodeQuoteRun({ id: 0, frames: Array.from({ length: 20 }, (_, i) => ({ ...frame(i), codeAddress: address((60 + i).toString(16)) })) },
    { l1: '0x1', l2: '0x2' }, { l1: 'https://l1.invalid', l2: '' }, controller.signal, () => annotations++);
  assert(calls <= 4); assert.equal(annotations, 0);
});

test('limits distinct contract lookups to 128 per selected run', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{"status":"0","result":[]}'); });
  const frames = Array.from({ length: 130 }, (_, id) => ({ ...frame(id), codeAddress: '0x' + (id + 1000).toString(16).padStart(40, '0') }));
  const result = await decodeQuoteRun({ id: 0, frames }, { l1: '0x1', l2: '0x2' },
    { l1: 'https://l1.invalid', l2: '' }, new AbortController().signal, () => {});
  assert.equal(requests, 128);
  assert.match(result, /130 calls without a verified ABI/);
  assert.match(result, /2 calls exceed the 128-contract lookup limit/);
});

test('requires a verified source and rejects oversized or unsafe ABI metadata', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: '1', result: [{ ABI: JSON.stringify(abi) }] })));
  const get = () => fetchVerifiedQuoteAbi('/explorer', implementation, new AbortController().signal);
  assert.equal(await get(), null);
  mock.mock.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(get(), /Response exceeds/);
  mock.mock.mockImplementation(async () => response({ abi: [{ type: 'function', name: 'f', inputs: [{ name: 'x', type: 'tuple[]', components: [] }], outputs: [] }] }));
  assert.equal(await get(), null);
});

test('keeps verified contract names for fallback-only proxies without inventing a function', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ abi: [{ type: 'fallback', stateMutability: 'payable' }], name: 'CrossChainProxy' }));
  const contract = await fetchVerifiedQuoteAbi('/explorer', implementation, new AbortController().signal);
  assert.equal(contract.name, 'CrossChainProxy');
  const decoded = decodeQuoteFrame(frame(), contract);
  assert.equal(decoded.name, 'CrossChainProxy'); assert.equal(decoded.method, undefined);
  assert.match(decoded.note, /unknown or ambiguous/);
});

test('direct quoting preserves diagnostic error envelopes and rejects unrelated/oversized replies', async t => {
  const request = buildDebugQuote(fields, '0x2'); const seen = [];
  const envelope = { id: request.id, jsonrpc: '2.0', error: { code: -32004, message: 'Funding error', data: { trace: { partial: true } } } };
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => { seen.push({ url, ...options }); return new Response(JSON.stringify(envelope)); });
  const result = await requestDebugQuote('/composer/l2', request, new AbortController().signal);
  assert.deepEqual(JSON.parse(result), envelope); assert.equal(seen[0].method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].body), request);
  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ ...envelope, id: 999 })));
  await assert.rejects(requestDebugQuote('/composer/l2', request, new AbortController().signal), /unrelated/);
  mock.mock.mockImplementation(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)));
  await assert.rejects(requestDebugQuote('/composer/l2', request, new AbortController().signal), /Response exceeds/);
});
