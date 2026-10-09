import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
globalThis.window = { location: { search: "", origin: "https://test.invalid" } };
const { setConfig } = await import('../src/config.ts');
const { fetchCallSettlement } = await import('../src/lib/callSettlement.ts');
setConfig({ l1Rpc: 'https://l1.invalid', l2Rpc: 'https://l2.invalid', l2ProxyRpc: 'https://composer-l2.invalid' });
const hash = byte => '0x' + byte.repeat(32);
const l1Hash = hash('11'), l2Hash = hash('22'), tx = hash('33'), post = hash('44');
const record = { l1BlockNumber: '0x64', l1BlockHash: l1Hash, l1TransactionHash: post,
  l2Blocks: [{ number: '0x7', hash: l2Hash }], canonicalL2: true, l2Finalized: false };
function fixture(options = {}) {
  const calls = [];
  const rpc = async (url, method, params) => {
    calls.push({ url, method, params });
    const l1 = url.includes('l1');
    assert.equal(url, method.startsWith('eez_') ? 'https://composer-l2.invalid' : l1 ? 'https://l1.invalid' : 'https://l2.invalid', 'settlement index queries use Composer; canonical evidence uses read RPCs');
    if (method === 'eth_getTransactionReceipt') return options.pending ? null : {
      status: options.reverted ? '0x0' : '0x1', blockNumber: l1 ? '0x64' : '0x7', blockHash: l1 ? l1Hash : l2Hash, logs: [],
    };
    if (method === 'eez_getSettlementByL2Block') {
      if (options.indexError) throw new Error('Settlement index unavailable');
      return options.awaiting ? null : options.record ?? record;
    }
    if (method === 'eez_getSettledL2RangesByL1Block') return [options.record ?? { ...record, l1TransactionHash: tx }];
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'safe' || params[0] === 'finalized') {
        if (options.unsupportedTags) throw new Error('Unsupported block tag');
        const reached = params[0] === 'safe' ? options.safe : options.finalized;
        return { number: reached ? l1 ? '0x64' : '0x7' : '0x0', hash: l1 ? l1Hash : l2Hash };
      }
      if (l1 && options.missingL1) return null;
      if (!l1 && options.missingL2) return null;
      return { number: params[0], hash: l1 ? options.changedL1 ? hash('aa') : l1Hash : options.changedL2 ? hash('bb') : l2Hash };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  return { rpc, calls };
}
test('pending source inclusion does not claim settlement', async () => {
  const { rpc, calls } = fixture({ pending: true });
  assert.equal((await fetchCallSettlement(tx, 'l2', true, rpc)).state, 'pending');
  assert.equal(calls.length, 1);
});
test('confirmed execution remains awaiting when settlement is not indexed', async () => {
  const { rpc } = fixture({ awaiting: true });
  const result = await fetchCallSettlement(tx, 'l2', true, rpc);
  assert.equal(result.state, 'awaiting'); assert.equal(result.execution, 'confirmed');
});
for (const [state, options] of [['posted', {}], ['safe', { safe: true }], ['finalized', { finalized: true }]]) {
  test(`canonical L2 call reaches ${state} only with corresponding node evidence`, async () => {
    const { rpc, calls } = fixture(options);
    const result = await fetchCallSettlement(tx, 'l2', true, rpc);
    assert.equal(result.state, state); assert.deepEqual(result.settlement, record);
    assert(calls.every(call => !/send|sign/.test(call.method)));
  });
}
test('index finality flag alone cannot establish finality', async () => {
  const { rpc } = fixture({ record: { ...record, l2Finalized: true } });
  assert.equal((await fetchCallSettlement(tx, 'l2', true, rpc)).state, 'posted');
});
test('both L1 and L2 safety must be reached', async () => {
  const { rpc } = fixture({ safe: true });
  const uneven = (url, method, params) => method === 'eth_getBlockByNumber' && params[0] === 'safe' && url.includes('l2')
    ? Promise.resolve({ number: '0x6', hash: hash('dd') }) : rpc(url, method, params);
  assert.equal((await fetchCallSettlement(tx, 'l2', true, uneven)).state, 'posted');
});
test('unsupported finality tags retain posted status', async () => {
  const { rpc } = fixture({ unsupportedTags: true });
  assert.equal((await fetchCallSettlement(tx, 'l2', true, rpc)).state, 'posted');
});
for (const options of [{ changedL1: true }, { changedL2: true }, { record: { ...record, canonicalL2: false } }]) {
  test(`reorganizations clear positive settlement stages: ${JSON.stringify(options)}`, async () => {
    const { rpc } = fixture({ ...options, finalized: true });
    assert.equal((await fetchCallSettlement(tx, 'l2', true, rpc)).state, 'reorg');
  });
}
for (const options of [{ missingL1: true }, { missingL2: true }, { record: { ...record, canonicalL2: undefined } },
  { record: { ...record, l2Blocks: [] } }, { record: { ...record, l2Blocks: [{ number: '0x8', hash: hash('ff') }] } }]) {
  test(`missing or inconsistent evidence stays unverified: ${JSON.stringify(options)}`, async () => {
    const { rpc } = fixture({ ...options, finalized: true });
    assert.equal((await fetchCallSettlement(tx, 'l2', true, rpc)).state, 'unavailable');
  });
}
test('a reverted L2 transaction can still settle without being called successful', async () => {
  const { rpc } = fixture({ reverted: true, finalized: true });
  const result = await fetchCallSettlement(tx, 'l2', true, rpc);
  assert.equal(result.state, 'finalized'); assert.equal(result.execution, 'reverted');
});
test('settlement lookup failures are surfaced instead of reporting finalized', async () => {
  const { rpc } = fixture({ indexError: true, finalized: true });
  await assert.rejects(fetchCallSettlement(tx, 'l2', true, rpc), /Settlement index unavailable/);
});
test('counterpart lookup failures do not masquerade as awaiting settlement', async () => {
  const base = fixture({ record });
  let queries = 0;
  const rpc = (url, method, params) => method === 'eez_getSettledL2RangesByL1Block' && ++queries > 1
    ? Promise.reject(new Error('Counterpart index offline')) : base.rpc(url, method, params);
  await assert.rejects(fetchCallSettlement(tx, 'l1', true, rpc), /Counterpart index offline/);
});
test('L1 posting transactions follow their exact settlement record', async () => {
  const { rpc } = fixture({ safe: true });
  const result = await fetchCallSettlement(tx, 'l1', true, rpc);
  assert.equal(result.state, 'safe'); assert.equal(result.settlement.l1TransactionHash, tx);
});
test('local L1 counter operations do not wait for an unrelated L2 settlement', async () => {
  const { rpc, calls } = fixture({ finalized: true });
  const result = await fetchCallSettlement(tx, 'l1', false, rpc);
  assert.equal(result.state, 'finalized'); assert.equal(result.localL1, true);
  assert.equal(result.settlement, undefined);
  assert(calls.every(call => call.url.includes('l1')));
});
