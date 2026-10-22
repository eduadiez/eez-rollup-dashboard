import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { encodeFunctionData, toHex } from 'viem';
import { startComposerAdapter } from '../scripts/treasury-composer.mjs';
import { COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_ABI, probeComposer } from '../src/lib/composerDiscovery.ts';

const expected = { chainId: 420691, l1ChainId: 1337, l2ChainId: 420691,
  genesis: `0x${'11'.repeat(32)}`, registry: `0x${'22'.repeat(20)}`, manager: `0x${'33'.repeat(20)}` };
const expectation = { l1ChainId: toHex(expected.l1ChainId), l2ChainId: toHex(expected.l2ChainId), registryAddress: expected.registry, l2Address: expected.manager };
async function fixture(t) {
  const calls = [], info = { version: 'test', supportedNetworks: { eezL1: 1337, eezL2: 420691 },
    eezContracts: { eezRegistryAddress: expected.registry, eezL2Address: expected.manager } };
  const state = { genesis: expected.genesis, info, missingMetadata: false };
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    let result;
    if (body.method === 'eez_composerInfo' && state.missingMetadata) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })); return;
    }
    if (body.method === 'eez_composerInfo') result = info;
    else if (body.method === 'eth_chainId') result = toHex(expected.chainId);
    else if (body.method === 'eth_getBlockByNumber') result = { hash: state.genesis };
    else result = body.params;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const adapter = await startComposerAdapter(`http://127.0.0.1:${upstream.address().port}`, expected);
  t.after(adapter.close);
  const request = async ({ method, params = [] }) => {
    const body = await (await fetch(adapter.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) })).json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  return { state, calls, request };
}
test('adapter probes actual upstream metadata and forwards signed submissions unchanged', async t => {
  const { calls, request } = await fixture(t);
  assert.equal((await probeComposer({ request }, expectation)).status, 'detected');
  assert(calls.some(c => c.method === 'eez_composerInfo'));
  assert(calls.some(c => c.method === 'eth_getBlockByNumber' && c.params[0] === '0x0'));
  assert.deepEqual(await request({ method: 'eth_sendRawTransaction', params: ['0x1234'] }), ['0x1234']);
  assert.deepEqual(calls.at(-1), { jsonrpc: '2.0', id: 7, method: 'eth_sendRawTransaction', params: ['0x1234'] });
});
test('discovery refuses an ordinary node and an upstream with changed bindings or genesis', async t => {
  const { state, request } = await fixture(t);
  state.missingMetadata = true;
  assert.equal((await probeComposer({ request }, expectation)).status, 'unavailable');
  state.missingMetadata = false;
  state.genesis = `0x${'44'.repeat(32)}`;
  assert.match((await probeComposer({ request }, expectation)).detail, /does not match/);
  state.genesis = expected.genesis;
  state.info.eezContracts.eezL2Address = expected.registry;
  assert.match((await probeComposer({ request }, expectation)).detail, /does not match/);
});
test('discovery rejects malformed calldata and never forwards it as a contract call', async t => {
  const { calls, request } = await fixture(t);
  const data = encodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', args: [`0x${'55'.repeat(32)}`] });
  await assert.rejects(request({ method: 'eth_call', params: [{ to: COMPOSER_DISCOVERY_ADDRESS, data: `${data}00` }, 'latest'] }), /Invalid Composer discovery calldata/);
  assert.equal(calls.length, 0);
});

test('pinned-devnet status routes only the diagnostic method to its explicit loopback node', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ path: req.url, method: body.method });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.params }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = await startComposerAdapter(origin + '/front', { ...expected, statusRpc: origin + '/node' });
  t.after(adapter.close);
  for (const method of ['eth_sendRawTransaction', 'eez_getCrossChainTransaction', 'eez_getSettlementByL2Block', 'eez_composerInfo'])
    await fetch(adapter.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
  assert.deepEqual(requests, [{ path: '/front', method: 'eth_sendRawTransaction' }, { path: '/node', method: 'eez_getCrossChainTransaction' }, { path: '/node', method: 'eez_getSettlementByL2Block' }, { path: '/front', method: 'eez_composerInfo' }]);
  await assert.rejects(startComposerAdapter(origin, { ...expected, statusRpc: 'https://example.com' }), /loopback/);
});
