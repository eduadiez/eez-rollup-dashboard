// Live policy handover on the owned native devnet. This retained test fixture
// exercises the retired handover plan; signatures use the fixture's actual Safe domains and live nonces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeDeployData, encodeFunctionData, keccak256, toHex } from 'viem';
import { TreasuryUpgrade } from '../fixtures/treasury-policy-upgrade.ts';
import { TreasuryClient, parseTreasuryConfig } from '../../src/lib/treasury/client.ts';
import { deploymentIdentity } from '../../src/lib/treasury/deployment.ts';
import { paymentState, paymentTransaction } from '../../src/lib/treasury/payments.ts';
import { PaymentHistoryStore, historyConfig } from '../../src/lib/treasury/history.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, packOwnerApprovals, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';

export async function runPolicyUpgrade(f, c, setup) {
  const n=f.network, p=c.payments, oldClient=new TreasuryClient(c);
  const artifacts=JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
  const epoch=(await paymentState(oldClient)).epoch;
  async function sign(chain,to,data,operation=0) {
    const safe=chain==='l1'?c.safeL1:c.safeL2;
    const nonce=await f.read(n[chain].rpc,safe,f.safeArtifact.abi,'nonce');
    const tx=buildSafeTransaction({chainId:BigInt(n[chain].chainId),safe,to,data,operation,nonce});
    const approvals=await Promise.all([f.A,f.B].map(async owner=>({owner:owner.address,signature:await owner.signTypedData(tx)})));
    const owners=[f.A.address,f.B.address];
    const signatures=chain==='l1'?await packEOAApprovals(tx,owners,2,approvals):await packOwnerApprovals(tx,c.adapter,owners,2,approvals);
    return {tx,data:encodeSafeExecution(tx,signatures)};
  }
  const payment={recipient:p.recipient,amount:'40000000',destination:'l2',funding:'local',epoch:String(epoch)};
  const oldTx=paymentTransaction(c,payment,(await oldClient.snapshot()).nonce);
  const oldSigned=await sign('l2',p.policy,oldTx.message.data);
  const intent={version:1,instance:c.instance,value:'0',nonce:String(oldSigned.tx.message.nonce),safeHash:safeTransactionHash(oldSigned.tx),data:oldSigned.data,sender:f.submitter.address,
    sourceNonce:await f.rpc(n.l2.rpc,'eth_getTransactionCount',[f.submitter.address,'pending']),startBlock:await f.rpc(n.l2.rpc,'eth_blockNumber'),payment};
  intent.hash=await f.submit(n.l2,c.safeL2,intent.data);
  await f.until('legacy payment before upgrade',async()=>{const outcome=await oldClient.outcome(intent);return outcome.kind==='settled'&&outcome;});
  const before=await paymentState(oldClient); assert.equal(before.spent,40_000_000n);
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  new PaymentHistoryStore(c,storage).remember(intent);
  const target={l1:{rpc:n.l1.rpc,front:c.l1.front},l2:{rpc:n.l2.rpc,front:c.l2.front},fees:{l1:'1000000000000000000',l2:'1000000000000000000'}};
  const upgrade=new TreasuryUpgrade(target,artifacts,c,[],2);
  const helpers=f.evidence.configurationBatches.slice(-2);
  const state={version:2,identity:deploymentIdentity,deployer:f.submitter.address,salt:keccak256(toHex('native-upgrade')),reuse:{},completed:[],transactions:[],addresses:{
    safeL1:c.safeL1,safeL2:c.safeL2,adapter:c.adapter,...Object.fromEntries(['moduleL1','moduleL2','tokenL1','tokenL2','bridgeL1','bridgeL2','aliasReaderL1'].map(k=>[k,p[k]])),
    multiSendL1:helpers.find(h=>h.chain==='l1').helper,multiSendL2:helpers.find(h=>h.chain==='l2').helper}};
  const hashes=[];
  const deployment=upgrade.steps(state)[0];
  const deployed=await f.send(n.l2,undefined,encodeDeployData({abi:artifacts.contracts.SplitTreasuryPolicyUpgrade.abi,bytecode:artifacts.contracts.SplitTreasuryPolicyUpgrade.bytecode,args:deployment.args()}));
  state.addresses.policy=deployed.contractAddress;
  state.addresses.alias=await f.read(n.l1.rpc,n.registry,f.eeZAbi,'computeCrossChainProxyAddress',[state.addresses.policy,BigInt(n.rollupId)]);
  hashes.push(deployed.transactionHash); state.completed.push(deployment.id);state.transactions.push(deployed.transactionHash);
  const abi=artifacts.contracts.SplitTreasuryPolicyUpgrade.abi;
  assert.equal(await f.read(n.l2.rpc,state.addresses.policy,abi,'active'),false);
  for(const chain of ['l1','l2']) {
    const step=upgrade.steps(state)[state.completed.length]; assert.equal(step.chain,chain);
    const signed=await sign(chain,step.target(),encodeFunctionData({abi:upgrade.abi(step.artifact),functionName:step.method,args:step.args()}),step.operation);
    const receipt=await f.send(n[chain],step.safe(),signed.data); hashes.push(receipt.transactionHash);
    state.completed.push(step.id);state.transactions.push(receipt.transactionHash);
    const old=await f.read(n[chain].rpc,chain==='l1'?p.moduleL1:p.moduleL2,setup.module.abi,'getTokenAllowance',[step.safe(),chain==='l1'?p.alias:p.policy,chain==='l1'?p.tokenL1:p.tokenL2]);
    assert.equal(old[0],0n); assert.equal(old[1],chain==='l1'?0n:40_000_000n);
    if(chain==='l1')assert.equal(await f.read(n.l2.rpc,state.addresses.policy,abi,'active'),false);
    else {
      await f.until('canonical activation',async()=>BigInt((await f.rpc(n.l2.rpc,'eth_getBlockByNumber',['safe',false])).number)>=BigInt(receipt.blockNumber));
      f.evidence.lastSuccessfulL2Block=Number(BigInt(receipt.blockNumber));
    }
  }
  assert.equal(hashes.length,3);
  assert.equal(await f.read(n.l2.rpc,state.addresses.policy,abi,'active'),true);
  assert.deepEqual(await f.read(n.l2.rpc,state.addresses.policy,abi,'carriedSpending',[epoch]),[0n,40_000_000n]);
  const code=[...c.code];for(const [chain,address] of [['l1',state.addresses.alias],['l2',state.addresses.policy]])code.push({chain,address,hash:keccak256(await f.rpc(n[chain].rpc,'eth_getCode',[address,'latest']))});
  const {invoiceMerchant:_merchant,invoiceControl:_control,...capabilities}=p;
  const next=parseTreasuryConfig({...c,code,previousPayments:p,payments:{...capabilities,policy:state.addresses.policy,alias:state.addresses.alias,l1Initiation:true,exactSplits:true,predecessor:p.policy}});
  const after=await paymentState(new TreasuryClient(next));
  assert.equal(after.balanceL1,before.balanceL1);assert.equal(after.balanceL2,before.balanceL2);
  assert.equal(after.spent,before.spent);assert.equal(after.allowanceL2[1],40_000_000n);assert.equal(after.allowanceL1[1],0n);
  const entry=new PaymentHistoryStore(next,storage).read()[0];
  assert.equal((await new TreasuryClient(historyConfig(next,entry.intent)).outcome(entry.intent)).kind,'settled');
  const head=await f.rpc(n.l2.rpc,'eth_getBlockByNumber',['safe',false]);
  await f.until('independent follower activation replay',async()=>(await f.rpc(n.follower,'eth_getBlockByNumber',[head.number,false]))?.hash===head.hash);
  assert.deepEqual(await f.read(n.follower,state.addresses.policy,abi,'carriedSpending',[epoch],head.number),[0n,40_000_000n]);
  f.evidence.policyUpgrade={previousPolicy:p.policy,policy:state.addresses.policy,safeL1:c.safeL1,safeL2:c.safeL2,transactions:hashes,balancesUnchanged:true,carriedGlobal:'40000000',carriedL2:'40000000',oldAllowancesRevoked:true,oldHistoryVerified:true,independentReplay:true};f.checkpoint();
  console.log('Policy upgraded in three transactions; same Safes, balances, live budget and history verified');
  return next;
}
