import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { decodeFunctionData, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSafeTransaction, safeTransactionHash, safeTypedDataJSON, packOwnerApprovals, encodeSafeExecution, safeExecutionAbi } from '../src/lib/treasury/safeTransactions.ts';

const a = privateKeyToAccount(toHex(0xa11cen, {size:32}));
const b = privateKeyToAccount(toHex(0xb0bn, {size:32}));
const c = privateKeyToAccount(toHex(0xc0cn, {size:32}));
const input = {chainId:6114n, safe:'0x1111111111111111111111111111111111111111', to:'0x2222222222222222222222222222222222222222', data:'0x1234', nonce:7n};
const adapter = '0x3333333333333333333333333333333333333333';
const tx = buildSafeTransaction(input);
let approvals;
before(async () => {
  approvals = await Promise.all([a,b].map(async account => ({owner:account.address,signature:await account.signTypedData(tx)})));
});

test('typed data and contract signature match the vector also verified by real Safe Solidity tests', async () => {
  const vector=JSON.parse(readFileSync(new URL('../contracts/test/fixtures/safe-signature.json', import.meta.url)));
  const packed=await packOwnerApprovals(tx,adapter,[a.address,b.address],2,approvals);
  assert.equal(safeTransactionHash(tx),vector.hash);
  assert.equal(packed,vector.signatures);
  assert.equal(await packOwnerApprovals(tx,adapter,[b.address,a.address],2,[...approvals].reverse()),packed);
  const {functionName,args}=decodeFunctionData({abi:safeExecutionAbi,data:encodeSafeExecution(tx,packed)});
  assert.equal(functionName,'execTransaction');
  assert.deepEqual(args,[input.to,0n,input.data,0,0n,0n,0n,'0x'+'00'.repeat(20),'0x'+'00'.repeat(20),packed]);
});

test('reviewed data is immutable and uses exact L2-domain integers', () => {
  assert.throws(()=>{tx.message.nonce=9n},TypeError);
  assert.throws(()=>{tx.domain.chainId=1n},TypeError);
  assert.throws(()=>{tx.types.SafeTx[0].name='changed'},TypeError);
  const large=buildSafeTransaction({...input,nonce:2n**200n});
  assert.equal(JSON.parse(safeTypedDataJSON(large)).message.nonce,(2n**200n).toString());
  assert.equal(JSON.parse(safeTypedDataJSON(large)).domain.chainId,'6114');
});

test('changing signed fields or reusing another Safe/chain/nonce rejects approvals', async () => {
  for (const change of [{operation:1},{to:adapter},{data:'0x1235'},{nonce:8n},{chainId:1n},{safe:adapter}]) {
    const changed=buildSafeTransaction({...input,...change});
    assert.notEqual(safeTransactionHash(changed),safeTransactionHash(tx));
    await assert.rejects(packOwnerApprovals(changed,adapter,[a.address,b.address],2,approvals),/does not approve/);
  }
});

test('invalid, insufficient, duplicate, unknown and removed owners cannot form a quorum', async () => {
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,b.address],2,approvals.slice(0,1)),/quorum/);
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,b.address],2,[approvals[0],approvals[0]]),/duplicate/);
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,c.address],2,approvals),/Unknown/);
  for (const threshold of [0,3,1.5,Number.NaN])
    await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,b.address],threshold,approvals),/threshold/);
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,a.address],2,approvals),/owner set/);
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,b.address],2,[{...approvals[0],signature:'0x'},approvals[1]]),/65-byte/);
  await assert.rejects(packOwnerApprovals(tx,adapter,[a.address,b.address],2,[{...approvals[0],signature:approvals[0].signature.slice(0,-2)+'1f'},approvals[1]]),/65-byte/);
});

test('invalid transaction inputs are rejected before a wallet is asked to sign', () => {
  for (const change of [{operation:2},{operation:-1},{operation:"1"},{chainId:0n},{chainId:-1n},{nonce:-1n},{nonce:2n**256n},{nonce:7},{data:'0x1'},
    {safe:'0x'+'00'.repeat(20)},{to:'invalid'}]) assert.throws(()=>buildSafeTransaction({...input,...change}),/Invalid/);
});
