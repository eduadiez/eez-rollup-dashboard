import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, toHex, keccak256, decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryClient, readIntent, safeAbi } from '../src/lib/treasury/client.ts';
import { paymentTransaction, paymentAbi } from '../src/lib/treasury/payments.ts';
import { safeExecutionAbi, safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
import { transferAbi, transferRollup } from '../src/lib/treasury/transfers.ts';
import { treasuryTransactions } from '../src/lib/treasury/settlement.ts';
const a=n=>toHex(n,{size:20}),h=s=>keccak256(toHex(s)),owner=privateKeyToAccount(toHex(123n,{size:32}));
const c={instance:h('standard'),safeL1:a(1),safeL2:a(2),adapter:a(3),registry:a(4),manager:a(5),
 l1:{chainId:1,rpc:'l1',front:'front1'},l2:{chainId:696990,rpc:'l2',front:'front2'},
 payments:{bridgeKind:'standard',bridgeExecutorL1:a(14),safeL2Alias:a(6),policy:a(7),alias:a(8),tokenL1:a(9),tokenL2:a(10),bridgeL1:a(11),bridgeL2:a(12),l1Initiation:true,combinedL2:true,exactSplits:true}};
const payment={source:'l2',destination:'l2',recipient:a(13),amount:'10000000',funding:'split',fromL1:'5000000',epoch:'100'};
const tx=paymentTransaction(c,payment,2n),intent={version:1,submissionChain:'l1',instance:c.instance,value:'0',nonce:'2',safeHash:safeTransactionHash(tx),data:'0x1234',sender:owner.address,sourceNonce:'0x3',startBlock:'0x10',l2StartBlock:'0x10',hash:h('relay'),payment};
test('mirror approval keeps EEZ-X domain; preparation submits to its Ethereum alias and persists the network',async()=>{
 const client=new TreasuryClient(c),snapshot={source:'l2',owners:[owner.address],threshold:1,nonce:2n,fingerprint:'owners'};
 client.validate=async()=>{};client.snapshot=async source=>{assert.equal(source,'l2');return snapshot;};
 client.wallet=async(_provider,_owner,source)=>{assert.equal(source,'l1');return owner.address;};
 client.rpc=async(url,method)=>{
  if(method==='eth_getTransactionCount'){assert.equal(url,'l1');return '0x3';}
  assert.equal(method,'eth_getBlockByNumber');return {number:'0x10',baseFeePerGas:'0x1'};
 };
 const approval={owner:owner.address,signature:await owner.signTypedData(tx)};
 const prepared=await client.prepare({},tx,snapshot,[approval],payment);
 assert.equal(client.transactionSource(tx),'l2');assert.equal(client.submissionSource(tx),'l1');
 assert.equal(prepared.request.to,c.payments.safeL2Alias);assert.equal(prepared.request.chainId,'0x1');
 const execution=decodeFunctionData({abi:safeExecutionAbi,data:prepared.request.data});
 assert.equal(execution.args[0],c.payments.policy);assert(execution.args.at(-1).endsWith(approval.signature.slice(2)));
 assert.deepEqual(readIntent(c,JSON.stringify(prepared.intent)),prepared.intent);
 for(const submissionChain of ['l2',undefined])assert.throws(()=>readIntent(c,JSON.stringify({...prepared.intent,submissionChain})));
 assert.deepEqual(treasuryTransactions({...prepared.intent,hash:intent.hash}),[{chain:'l1',hash:intent.hash,block:undefined,role:'execution'}]);
});
function fixture(patch={}){
 const state={...patch},client=new TreasuryClient(c),l1=h('l1block'),l2=h('l2block'),callHash=h('call');
 const log=(address,event,args,data,chain)=>({address,topics:encodeEventTopics({abi:[...transferAbi,...safeAbi,...paymentAbi],eventName:event,args}),data,
  transactionHash:chain==='l1'?intent.hash:h('execution'),blockNumber:'0x20',blockHash:chain==='l1'?l1:l2});
 const outbound=log(c.registry,'CrossChainCallExecuted',{crossChainCallHash:callHash,proxy:c.payments.safeL2Alias},encodeAbiParameters([{type:'address'},{type:'bytes'},{type:'uint256'}],[owner.address,intent.data,0n]),'l1');
 const incoming=log(c.manager,'IncomingCrossChainCallExecuted',{crossChainCallHash:callHash},encodeAbiParameters([{type:'bool'},{type:'address'},{type:'uint64'},{type:'address'},{type:'uint256'},{type:'uint64'},{type:'bytes'}],[false,owner.address,0n,c.safeL2,0n,8000000n,state.wrongData?'0x5678':intent.data]),'l2');
 const success=log(c.safeL2,'ExecutionSuccess',{txHash:intent.safeHash},encodeAbiParameters([{type:'uint256'}],[0n]),'l2');
 const paid=log(c.payments.policy,'Paid',{token:c.payments.tokenL1,recipient:payment.recipient},encodeAbiParameters([{type:'bool'},...Array(4).fill({type:'uint256'})],[false,10000000n,5000000n,5000000n,100n]),'l2');
 client.rpc=async(url,method,params)=>{
  if(method==='eez_getCrossChainTransaction')return state.terminal?{lifecycle:'terminal',ownership:{reason:'PoolDiscarded'}}:null;
  if(method==='eth_getTransactionReceipt')return url==='l1'?state.noReceipt?null:{status:state.failed?'0x0':'0x1',blockHash:l1,blockNumber:'0x20',logs:[outbound]}:{status:'0x1',blockHash:l2,blockNumber:'0x20',logs:[incoming,success,...(state.noPaid?[]:[paid])]};
  if(method==='eth_getTransactionByHash')return {from:intent.sender,to:state.wrongTarget?a(99):c.payments.safeL2Alias,input:intent.data,nonce:intent.sourceNonce,value:'0x0'};
  if(method==='eth_getBlockByNumber')return {number:state.unsafe&&params[0]==='safe'?'0x19':'0x20',hash:url==='l1'?state.reorg?h('reorg'):l1:l2};
  if(method==='eth_getLogs')return url==='l1'?Array(state.duplicate?2:1).fill(outbound):[success];
  if(method==='eez_getSettlementByL2Block')return {canonicalL2:!state.noncanonical,l1BlockHash:state.wrongSettlement?h('other-source'):l1,l1BlockNumber:'0x20',l2Blocks:[{number:'0x20',hash:l2}]};
  assert.fail(method);
 };
 return client;
}
test('relay settlement binds exact source, incoming call, Safe hash, split and canonical settlement; lost hash recovers',async()=>{
 const result=await fixture().outcome(intent);assert.equal(result.kind,'settled');assert.deepEqual(result.contributions,{fromL1:'5000000',fromL2:'5000000'});
 assert.equal((await fixture().outcome({...intent,hash:undefined})).hash,intent.hash);
 for(const state of [{wrongData:true},{wrongSettlement:true},{noncanonical:true},{reorg:true},{unsafe:true},{noReceipt:true}])assert.equal((await fixture(state).outcome(intent)).kind,'pending',JSON.stringify(state));
 for(const state of [{noPaid:true},{wrongTarget:true},{duplicate:true}])await assert.rejects(fixture(state).outcome(intent));
 assert.equal((await fixture({failed:true}).outcome(intent)).rejectionStage,'execution');
 assert.equal((await fixture({noReceipt:true,terminal:true}).outcome(intent)).rejectionStage,'preparation');
});
test('standard bridge internal transfer reads the destination rollup from EEZ-X without the test extension',async()=>{
 const client=new TreasuryClient(c);client.rpc=async(url,method,params)=>{
  assert.equal(url,'l2');assert.equal(method,'eth_call');assert.equal(params[0].to,c.payments.bridgeL2);
  assert.equal(decodeFunctionData({abi:transferAbi,data:params[0].data}).functionName,'rollupId');return toHex(1n,{size:32});
 };
 assert.equal(await transferRollup(client),'1');
});
