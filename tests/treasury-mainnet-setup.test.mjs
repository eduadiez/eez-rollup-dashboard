import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, getAddress, getContractAddress, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { MainnetSetup, mainnetSetupKey, mainnetManifestKey, mainnetSetupSteps, readMainnetSetup, isMainnetSetupTarget, loadMainnetManifest } from '../src/lib/treasury/mainnetSetup.ts';
import { sharedDeploymentKey, sharedManifestKey } from '../src/lib/treasury/deployment.ts';
const json=path=>JSON.parse(readFileSync(path));
const base=json('src/lib/treasury/deployment-artifacts.json'),current=json('src/lib/treasury/mainnet-artifacts.json'),network=json('src/lib/treasury/mainnet-network.json');
const artifacts={...base,contracts:{...base.contracts,...current.contracts}},addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const target={l1:{rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1',explorer:'https://etherscan.io'},l2:{rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2',explorer:'https://explorer.eez.dev'},fees:{l1:'1',l2:'1'}};
function fixture(){
 const engine=new MainnetSetup(target,artifacts),safe=addr(100),singleton=addr(101),deployer=addr(200),block={number:'0xa',hash:zeroHash};
 engine.validate=async()=>{};
 engine.io.rpc=async(chain,method,params)=>{
  if(method==='eth_getBlockByNumber')return block;
  if(method==='eth_getStorageAt')return params[1]==='0x0'?toHex(BigInt(singleton),{size:32}):zeroHash;
  if(method==='eth_getCode')return params[0]===safe?artifacts.contracts.SafeProxy.runtime:params[0]===singleton?artifacts.contracts.Safe.runtime:'0x';
  if(method==='eth_getTransactionCount')return '0x4';
  throw Error(method);
 };
 engine.io.read=async(chain,address,name,method)=>({VERSION:'1.4.1',getOwners:[deployer],getThreshold:1n,nonce:0n,getModulesPaginated:[[],addr(1)],sequence:1n,owner:deployer,closed:false}[method]);
 return {engine,safe,singleton,deployer};
}
test('mainnet eligibility uses the selected network, not a treasury Safe or wallet',()=>{
 assert.equal(isMainnetSetupTarget('0x1','0xaa29e',network.registry,network.manager,network.contracts.bridgeL1.address,network.contracts.bridgeL2.address),true);
 assert.equal(isMainnetSetupTarget('0x27d8','0xdd6d9',network.registry,network.manager,network.contracts.bridgeL1.address,network.contracts.bridgeL2.address),false);
 assert.equal(isMainnetSetupTarget('0x1','0xaa29e',network.registry,network.manager,addr(9),network.contracts.bridgeL2.address),false);
 assert.notEqual(mainnetSetupKey,sharedDeploymentKey);assert.notEqual(mainnetManifestKey,sharedManifestKey);
});
test('selection preserves the entered Safe, its owner threshold and a different deployer',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(addr(201),safe);
 assert.equal(s.addresses.safeL1,safe);assert.equal(s.deployer,addr(201));assert.notEqual(s.deployer,deployer);
 assert.equal(s.completed.length,0);assert.equal(s.addresses.safeL2,undefined);assert.equal(s.code.length,2);
 assert.deepEqual(readMainnetSetup(JSON.stringify(s)),s);
 assert.throws(()=>readMainnetSetup(JSON.stringify({...s,identity:zeroHash})),/Invalid Ethereum setup/);
});
test('Ethereum preparation deploys bounded authority without creating, funding or minting a Safe',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe),batch=await engine.batch(s,'0x4');
 const artifact=artifacts.contracts.TreasuryBootstrap;
 const [owner,actions]=decodeAbiParameters(artifact.abi.find(x=>x.type==='constructor').inputs,`0x${batch.data.slice(artifact.bytecode.length)}`);
 assert.equal(owner.toLowerCase(),deployer.toLowerCase());assert.equal(actions.length,4);assert(actions.every(x=>x.create));
 assert.deepEqual(batch.outputs.map(x=>x.key),['bootstrapL1','aliasReaderL1','moduleL1','multiSendL1','bridgeExecutorL1']);
 const funding=actions.at(-1),a=artifacts.contracts.StandardBridgeDelegate;
 const args=decodeAbiParameters(a.abi.find(x=>x.type==='constructor').inputs,`0x${funding.data.slice(a.bytecode.length)}`);
 assert.equal(args[0].toLowerCase(),safe.toLowerCase());assert.equal(args[2].toLowerCase(),network.contracts.usdcProxy.address.toLowerCase());
 assert.equal(args[3].toLowerCase(),network.contracts.bridgeL1.address.toLowerCase());assert.equal(args[4],1n);
 assert.equal(batch.executor,getContractAddress({from:deployer,nonce:4n}));assert((batch.data.length-2)/2<49152);
});
test('new mirror creation and policy deployment fit separate EVM batches without replacing the bridge',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 const prep=await engine.batch(s,'0x4');for(const o of prep.outputs)s.addresses[o.key]=o.address;s.completed=[{hash:zeroHash,chain:'l1',number:'0xa',blockHash:zeroHash}];
 const mirror=await engine.batch(s,'0x4');assert((mirror.data.length-2)/2<49152);
 assert(mirror.outputs.some(x=>x.key==='safeL2'));assert(!mirror.outputs.some(x=>/bridge|token/i.test(x.key)));
 for(const o of mirror.outputs)s.addresses[o.key]=o.address;s.completed.push({hash:zeroHash,chain:'l2',number:'0xa',blockHash:zeroHash});
 const budget=await engine.batch(s,'0x5');assert.equal(budget.to,s.addresses.bootstrapL2);assert.equal(budget.closed,true);
 const decoded=decodeFunctionData({abi:artifacts.contracts.TreasuryBootstrap.abi,data:budget.data});
 assert.equal(decoded.functionName,'execute');assert.equal(decoded.args[1].length,2);
 assert.deepEqual(budget.outputs.map(x=>x.key),['moduleL2','policy']);
 const policy=decoded.args[1][1],a=artifacts.contracts.StandardBridgeTreasuryPolicy;
 const args=decodeAbiParameters(a.abi.find(x=>x.type==='constructor').inputs,`0x${policy.data.slice(a.bytecode.length)}`);
 assert.equal(args[0].toLowerCase(),safe.toLowerCase());assert.equal(args[7].toLowerCase(),network.contracts.bridgeL2.address.toLowerCase());assert.equal(args[8],zeroAddress);
});
test('pending and incomplete mainnet setup cannot select the Chiado manifest',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 const entries=new Map([[sharedManifestKey,'must never be parsed'],[mainnetSetupKey,JSON.stringify(s)]]);
 assert.equal(loadMainnetManifest({getItem:k=>entries.get(k)??null}),null);
 assert.equal(mainnetSetupSteps.length,6);assert.equal(mainnetSetupSteps[5].chain,'l1');
});
test('setup confirmation rejects a different replacement transaction',async()=>{
 const {engine,safe,deployer}=fixture(),s=await engine.configure(deployer,safe);
 s.pending={id:'0',chain:'l1',sender:deployer,nonce:'0x1',data:'0x1234',hash:zeroHash,outputs:[]};
 engine.io.trackPending=async s=>s;
 engine.io.rpc=async(chain,method)=>method==='eth_getTransactionReceipt'?{status:'0x1',blockNumber:'0xa',blockHash:zeroHash,logs:[]}:
   method==='eth_getTransactionByHash'?{from:deployer,to:null,input:'0x5678',nonce:'0x1',value:'0x0'}:{hash:zeroHash};
 await assert.rejects(engine.reconcile(s),/replaced with different work/);
 assert.equal(s.completed.length,0);
});
