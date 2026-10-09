import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
globalThis.window = { location: { search: '', origin: 'http://test.invalid' } };
const { setConfig } = await import('../src/config.ts');
const { fetchHistoryTransactions } = await import('../src/lib/historyTransactions.ts');
const hash = b => '0x' + b.repeat(32), address = b => '0x' + b.repeat(20);
const registry = address('11'), manager = address('22'), caller = address('33');
const l1Block = hash('a1'), l2Block = hash('a2'), l1Tx = hash('b1'), l2Tx = hash('b2'), callHash = hash('cc');
setConfig({ l1Rpc: 'http://l1.invalid', l2Rpc: 'http://l2.invalid', l2ProxyRpc: 'http://composer-l2.invalid', rollupsAddress: registry, ccmL2Address: manager });
const data = (types, values) => encodeAbiParameters(types.map(type => ({ type })), values);
const outgoing = { address: registry, topics: [keccak256(stringToHex('CrossChainCallExecuted(bytes32,address,address,bytes,uint256)')), callHash, '0x'+manager.slice(2).padStart(64,'0')],
  data: data(['address','bytes','uint256'],[caller,'0x1234',1n]), blockHash: l1Block, blockNumber: '0x64', transactionHash: l1Tx };
const incoming = { address: manager, topics: [keccak256(stringToHex('IncomingCrossChainCallExecuted(bytes32,bool,address,uint64,address,uint256,uint64,bytes)')),callHash],
  data: data(['bool','address','uint64','address','uint256','uint64','bytes'],[false,caller,0n,manager,1n,90000n,'0x1234']), blockHash: l2Block, blockNumber: '0x7', transactionHash: l2Tx };
const settlement = { l1BlockNumber: '0x64', l1BlockHash: l1Block, l1TransactionHash: l1Tx, l2Blocks: [{number:'0x7',hash:l2Block}], canonicalL2:true };
function node(options={}) {
  const requests=[];
  return {requests, rpc:async(url,method,params)=>{
    requests.push({url,method,params});
    const l1=url.includes('l1');
    assert.equal(url, method.startsWith('eez_') ? 'http://composer-l2.invalid' : l1 ? 'http://l1.invalid' : 'http://l2.invalid', 'only settlement queries use Composer');
    if(method==='eth_getTransactionReceipt') return params[0]===(l1?l1Tx:l2Tx) ? {blockNumber:l1?'0x64':'0x7',blockHash:l1?l1Block:l2Block,logs:l1?[outgoing]:[incoming]}:null;
    if(method.startsWith('eez_')) {
      if(options.error) throw new Error('Index unavailable');
      if(options.empty) return method==='eez_getSettlementByL2Block' ? null : [];
      const result={...settlement,canonicalL2:!options.noncanonical,...options.settlement};
      return method==='eez_getSettlementByL2Block' ? result : [result];
    }
    if(method==='eth_getLogs') return l1 ? [outgoing,...(options.originDuplicate?[{...outgoing,transactionHash:hash('b3')}]:[])] : options.logs??[incoming];
    throw new Error('Unexpected RPC '+method);
  }};
}
test('L1 history resolves the actual incoming L2 transaction and bounded canonical blocks',async()=>{
  const n=node();const info=await fetchHistoryTransactions(l1Tx,'l1',n.rpc);
  assert.equal(info.l1Hash,l1Tx);assert.deepEqual(info.l2Hashes,[l2Tx]);assert.equal(info.l2,7);
  const filter=n.requests.find(r=>r.url.includes('l2')&&r.method==='eth_getLogs').params[0];
  assert.equal(filter.fromBlock,'0x7');assert.equal(filter.toBlock,'0x7');assert.equal(filter.address,manager);
});
test('L2 history shows the exact L1 settlement transaction with its settlement label',async()=>{
  const info=await fetchHistoryTransactions(l2Tx,'l2',node().rpc);
  assert.equal(info.l1Hash,l1Tx);assert.deepEqual(info.l2Hashes,[l2Tx]);assert.equal(info.settlement,true);
});
test('repeated hashes across destination transactions stay unresolved',async()=>{
  const info=await fetchHistoryTransactions(l1Tx,'l1',node({logs:[incoming,{...incoming,transactionHash:hash('b3')}]}).rpc);
  assert.deepEqual(info.l2Hashes,[]);
});
test('repeated hashes from different L1 origins stay unresolved',async()=>{
  assert.deepEqual((await fetchHistoryTransactions(l1Tx,'l1',node({originDuplicate:true}).rpc)).l2Hashes,[]);
});
test('foreign managers and noncanonical blocks cannot become counterpart links',async()=>{
  for(const log of [{...incoming,address:address('ff')},{...incoming,blockHash:hash('ff')}])
    assert.deepEqual((await fetchHistoryTransactions(l1Tx,'l1',node({logs:[log]}).rpc)).l2Hashes,[]);
  assert.deepEqual((await fetchHistoryTransactions(l1Tx,'l1',node({noncanonical:true}).rpc)).l2Hashes,[]);
  assert.equal((await fetchHistoryTransactions(l2Tx,'l2',node({noncanonical:true}).rpc)).l1Hash,undefined);
});
test('settlement must contain the actual canonical L2 source block',async()=>{
  const info=await fetchHistoryTransactions(l2Tx,'l2',node({settlement:{l2Blocks:[{number:'0x8',hash:hash('ff')}]}}).rpc);
  assert.equal(info.l1Hash,undefined);
});
test('index errors preserve the source link and permit a later successful retry',async()=>{
  const info=await fetchHistoryTransactions(l1Tx,'l1',node({error:true}).rpc);
  assert.equal(info.l1Hash,l1Tx);assert.deepEqual(info.l2Hashes,[]);
  assert.equal(info.lookupError,'Index unavailable');
  const recovered=await fetchHistoryTransactions(l1Tx,'l1',node().rpc);
  assert.deepEqual(recovered.l2Hashes,[l2Tx]);assert.equal(recovered.lookupError,undefined);
});
test('valid empty settlement responses are pending evidence, not lookup errors',async()=>{
  for(const [tx,chain] of [[l1Tx,'l1'],[l2Tx,'l2']]) {
    const info=await fetchHistoryTransactions(tx,chain,node({empty:true}).rpc);
    assert.equal(info.lookupError,undefined);
    assert.equal(info.chain,chain);
  }
});
test('L2 lookup failures keep its receipt and transaction link',async()=>{
  const info=await fetchHistoryTransactions(l2Tx,'l2',node({error:true}).rpc);
  assert.deepEqual(info.l2Hashes,[l2Tx]);assert.equal(info.l2,7);
  assert.equal(info.l1Hash,undefined);assert.equal(info.lookupError,'Index unavailable');
});
test('failed receipt RPCs retain the preferred source link and expose bounded errors',async()=>{
  for(const [tx,chain] of [[l1Tx,'l1'],[l2Tx,'l2']]) {
    const requests=[];
    const info=await fetchHistoryTransactions(tx,chain,async(url,method)=>{
      requests.push({url,method});throw new Error('Receipt RPC offline');
    });
    assert.equal(requests.length,2);
    assert.ok(requests.every(r=>r.method==='eth_getTransactionReceipt'));
    assert.equal(info.chain,chain);
    assert.equal(info.l1Hash,chain==='l1'?tx:undefined);
    assert.deepEqual(info.l2Hashes,chain==='l2'?[tx]:[]);
    assert.equal(info.l1,undefined);assert.equal(info.l2,undefined);
    assert.match(info.lookupError,/L1 receipt: Receipt RPC offline/);
    assert.match(info.lookupError,/L2 receipt: Receipt RPC offline/);
  }
  const info=await fetchHistoryTransactions(l1Tx,'l1',async()=>{throw new Error('x'.repeat(500));});
  assert.equal(info.lookupError.length,240);
});
test('null receipts remain pending, while one failed receipt still surfaces its error',async()=>{
  assert.equal(await fetchHistoryTransactions(l1Tx,'l1',async()=>null),null);
  const info=await fetchHistoryTransactions(l1Tx,'l1',async(url)=>{
    if(url==='http://l1.invalid')throw new Error('L1 unavailable');
    return null;
  });
  assert.equal(info.lookupError,'L1 receipt: L1 unavailable');
});
test('a valid receipt on the other chain resolves despite a preferred-chain RPC failure',async()=>{
  const n=node();
  const info=await fetchHistoryTransactions(l2Tx,'l1',async(url,method,params)=>{
    if(url==='http://l1.invalid'&&method==='eth_getTransactionReceipt')throw new Error('L1 unavailable');
    return n.rpc(url,method,params);
  });
  assert.equal(info.chain,'l2');assert.equal(info.l2,7);
  assert.equal(info.lookupError,undefined);assert.equal(info.l1Hash,l1Tx);
});
