import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';
import { checkedPayment, paymentTransaction } from '../src/lib/treasury/payments.ts';
import { readPaymentDeployment, recordedPaymentTransaction } from '../src/lib/treasury/savedPayments.ts';
import { readIntent } from '../src/lib/treasury/client.ts';
import { buildSafeTransaction, safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const a=n=>toHex(n,{size:20}),h=s=>keccak256(toHex(s));
const c={instance:h('unchanged treasury'),safeL1:a(1),safeL2:a(2),l1:{chainId:10200,front:'l1'},l2:{chainId:906969},payments:{policy:a(3),alias:a(4),tokenL1:a(5),exactSplits:true,l1Initiation:true,combinedL2:true}};
const oldAbi=parseAbi(['function pay(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch)','function payRouted(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch)','function paySplit(address token,address recipient,uint256 amount,bool onL1,uint256 expectedEpoch,uint256 fromL1)']);
test('old local, routed and split submissions preserve the original signing identity on both Safes after reload',()=>{
 for(const source of ['l1','l2'])for(const destination of ['l1','l2'])for(const funding of ['local','combined','split']){
  const payment={source,destination,funding,recipient:a(6),amount:'40000000',epoch:'123',...(funding==='split'?{fromL1:'12345678'}:{})};
  const args=[c.payments.tokenL1,payment.recipient,40_000_000n,destination==='l1',123n,...(funding==='split'?[12345678n]:[])];
  const original=buildSafeTransaction({chainId:BigInt(c[source].chainId),safe:source==='l1'?c.safeL1:c.safeL2,to:source==='l1'?c.payments.alias:c.payments.policy,nonce:7n,
   data:encodeFunctionData({abi:oldAbi,functionName:funding==='local'?'pay':funding==='combined'?'payRouted':'paySplit',args})});
  const intent={version:1,instance:c.instance,value:'40',payment,nonce:'7',safeHash:safeTransactionHash(original),data:'0x1234',sender:a(7),sourceNonce:'0x8',startBlock:'0x10',l2StartBlock:'0x11'};
  const raw=JSON.stringify(intent),loaded=readIntent(c,raw);
  assert.equal(JSON.stringify(loaded),raw);assert.deepEqual(recordedPaymentTransaction(c,loaded.payment,7n),original);
  assert.throws(()=>checkedPayment(payment));assert.throws(()=>paymentTransaction(c,payment,7n));
  for(const edit of [{amount:'40000001'},{epoch:'124'},{source:source==='l1'?'l2':'l1'},{recipient:a(9)}])
   assert.throws(()=>readIntent(c,JSON.stringify({...intent,payment:{...payment,...edit}})),/does not match/);
  assert.equal(readIntent(c,JSON.stringify({...intent,hash:h('replacement')})).hash,h('replacement'));
 }
});
test('current payment manifests use one interface identity and reject ambiguous or malformed versions',()=>{
 const current={...c.payments,version:2};
 for(const key of ['exactSplits','l1Initiation','combinedL2'])delete current[key];
 assert.equal(readPaymentDeployment(current),current);
 assert.equal(readPaymentDeployment(c.payments),c.payments,'old records are not rewritten');
 for(const version of [-1,3,'2',null,NaN])assert.throws(()=>readPaymentDeployment({...current,version}));
 for(const key of ['exactSplits','l1Initiation','combinedL2','abiVersion'])assert.throws(()=>readPaymentDeployment({...current,[key]:key==='abiVersion'?2:true}));
});

test('saved one-way policies cannot initiate a payment from the original Safe',()=>{
 const payment={source:'l1',destination:'l2',recipient:a(6),amount:'10',fromL1:'5',epoch:'123'};
 const legacy={...c,payments:{...c.payments,l1Initiation:false}};
 assert.throws(()=>paymentTransaction(legacy,payment,0n),/EEZ-X only/);
 assert.equal(paymentTransaction(legacy,{...payment,source:'l2'},0n).domain.verifyingContract,c.safeL2);
 assert.equal(paymentTransaction(c,payment,0n).domain.verifyingContract,c.safeL1);
 const current={...c.payments,version:2};
 for(const key of ['exactSplits','l1Initiation','combinedL2'])delete current[key];
 for(const source of ['l1','l2'])assert.equal(paymentTransaction({...c,payments:current},{...payment,source},0n).domain.verifyingContract,source==='l1'?c.safeL1:c.safeL2);
});
