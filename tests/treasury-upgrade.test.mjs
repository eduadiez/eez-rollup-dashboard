import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroAddress } from 'viem';
import { readUpgrade, upgradeTransactions } from '../src/lib/treasury/upgrade.ts';
import { deploymentIdentity, sharedManifestKey } from '../src/lib/treasury/deployment.ts';
import { policyUpgradeKey, policyUpgradePending, setupSnapshot, withActiveTreasury } from '../src/lib/treasury/setupState.ts';
import { parseTreasuryConfig } from '../src/lib/treasury/client.ts';
import { paymentState, paymentAbi, allowanceAbi, tokenAbi } from '../src/lib/treasury/payments.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const address = n => toHex(n, { size: 20 }), hash = text => keccak256(toHex(text));
const target = { l1: { rpc: 'http://127.0.0.1:8001', front: 'http://127.0.0.1:8002' }, l2: { rpc: 'http://127.0.0.1:8003', front: 'http://127.0.0.1:8004' }, fees: { l1: '1000000000000000000', l2: '1000000000000000000' } };
function fixture() {
  const keys = ['policy', 'alias', 'tokenL1', 'tokenL2', 'moduleL1', 'moduleL2', 'bridgeL1', 'bridgeL2', 'recipient', 'aliasReaderL1'];
  const payments = { ...Object.fromEntries(keys.map((key, i) => [key, address(100 + i)])), combinedL2: true, decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Devnet USDC' };
  const c = { version: 1, environment: 'isolated-devnet', instance: hash('existing'), l1: { ...target.l1, chainId: 31337, genesis: hash('l1') }, l2: { ...target.l2, chainId: 31338, genesis: hash('l2') },
    registry: address(1), manager: address(2), safeL1: address(3), safeL2: address(4), adapter: address(5), ownerLabels: {}, payments, code: [] };
  c.code = [['l1', c.safeL1], ['l2', c.safeL2], ['l2', c.adapter], ...keys.filter(k => k !== 'recipient').map(k => [k === 'policy' || k.endsWith('L2') ? 'l2' : 'l1', payments[k]])].map(([chain, a]) => ({ chain, address: a, hash: hash(a) }));
  parseTreasuryConfig(c);
  const record = { version: 1, previous: c, helpers: [], state: { version: 2, identity: deploymentIdentity, salt: hash('upgrade'), deployer: address(6), reuse: {}, completed: [], transactions: [],
    addresses: { safeL1: c.safeL1, safeL2: c.safeL2, adapter: c.adapter, ...Object.fromEntries(['moduleL1','moduleL2','tokenL1','tokenL2','bridgeL1','bridgeL2','aliasReaderL1'].map(k => [k,payments[k]])), multiSendL1: address(7), multiSendL2: address(8), policy: address(200), alias: address(201) } } };
  return { c, record };
}
test('upgrade journal survives reload, preserves old infrastructure and rejects conflicting manifests', () => {
  const { c, record } = fixture();
  assert.deepEqual(readUpgrade(JSON.stringify(record),c),record);
  for (const key of ['safeL1','safeL2','moduleL1','tokenL2','bridgeL1']) {
    const corrupt = structuredClone(record); corrupt.state.addresses[key] = address(999);
    assert.throws(() => readUpgrade(JSON.stringify(corrupt),c), /bindings|replaced/);
  }
  assert.throws(() => readUpgrade(JSON.stringify(record), {...c,payments:{...c.payments,policy:address(998)}}),/policy changed/);
});
test('upgrade and stale-policy tabs cannot sign, submit or restart the selected treasury', async () => {
  const { c, record } = fixture(), values = new Map([[sharedManifestKey, JSON.stringify(c)]]);
  const storage = { getItem:k=>values.get(k)??null }, locks={ request:async (_k,_o,fn)=>fn({}) };
  values.set(policyUpgradeKey(c.instance), JSON.stringify(record));
  assert.equal(policyUpgradePending(storage,c),true);
  assert.match(setupSnapshot(storage).blocked,/policy upgrade/);
  await assert.rejects(withActiveTreasury(storage,locks,c.instance,async()=>assert.fail('no wallet calls'),c.payments.policy),/policy upgrade/);
  const p={...c.payments,policy:record.state.addresses.policy,alias:record.state.addresses.alias,predecessor:c.payments.policy,l1Initiation:true};
  const next=parseTreasuryConfig({...c,payments:p,previousPayments:c.payments,code:[...c.code,{chain:'l1',address:p.alias,hash:hash('a')},{chain:'l2',address:p.policy,hash:hash('p')}]});
  values.set(sharedManifestKey,JSON.stringify(next));
  assert.equal(policyUpgradePending(storage,next),false);
  await assert.rejects(withActiveTreasury(storage,locks,c.instance,async()=>assert.fail('stale wallet call'),c.payments.policy),/policy changed/);
  let called=false; await withActiveTreasury(storage,locks,c.instance,async()=>{called=true;},next.payments.policy); assert(called);
});
test('carried counters reduce the displayed Safe capacity only for the activation period', async () => {
  const { c }=fixture(); c.payments.predecessor=address(250);
  let epoch=100n;
  const client={config:c,rpc:async(url,method,args)=>{
    if(method==='eth_getBlockByNumber')return {number:'0x1',hash:hash(url),timestamp:toHex(epoch*600n)};
    assert.equal(method,'eth_call'); const call=args[0];
    const abi=[...paymentAbi,...allowanceAbi,...tokenAbi]; const {functionName}=decodeFunctionData({abi,data:call.data});
    const result={balanceOf:300_000_000n,getTokenAllowance:[100_000_000n,10_000_000n,10n,epoch*10n,2n],spent:60_000_000n,carriedSpending:epoch===100n?[0n,40_000_000n]:[0n,0n]}[functionName];
    assert.notEqual(result,undefined);return encodeFunctionResult({abi,functionName,result});
  }};
  const first=await paymentState(client); assert.equal(first.allowanceL1[1],10_000_000n); assert.equal(first.allowanceL2[1],50_000_000n);
  epoch++; const later=await paymentState(client); assert.equal(later.allowanceL2[1],10_000_000n);
});
test('old outstanding deployment bytecode stays frozen while the upgrade gets its own artifact',()=>{
  for(const name of ['TreasuryPolicy','BidirectionalTreasuryPolicy']) assert.deepEqual(artifacts.contracts[name],JSON.parse(readFileSync(`contracts/legacy/artifacts/${name}.json`)));
  assert(artifacts.contracts.TreasuryPolicyUpgrade.bytecode.length>100);
});

test('retained handover history is readable without an executable migration client', () => {
  const { record } = fixture();
  const state = { ...record.state, completed: ['upgradePolicy', 'upgradeL1'],
    transactions: [hash('policy'), hash('l1')],
    pending: { id: 'upgradeL2', chain: 'l2', hash: hash('l2') } };
  const rows = upgradeTransactions({ ...record, state });
  assert.deepEqual(rows.map(({ id, chain, hash: tx, completed }) => ({ id, chain, tx, completed })), [
    { id: 'upgradePolicy', chain: 'l2', tx: hash('policy'), completed: true },
    { id: 'upgradeL1', chain: 'l1', tx: hash('l1'), completed: true },
    { id: 'upgradeL2', chain: 'l2', tx: hash('l2'), completed: false },
  ]);
  assert.throws(() => upgradeTransactions({ ...record, state: { ...state, completed: ['upgradeL1', 'upgradePolicy'] } }), /order changed/);
  assert.throws(() => upgradeTransactions({ ...record, state: { ...state, pending: { ...state.pending, chain: 'l1' } } }), /transaction changed/);
});
