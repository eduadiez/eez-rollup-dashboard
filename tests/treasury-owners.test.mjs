import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryClient, safeAbi } from '../src/lib/treasury/client.ts';
import { approveOwnerAddition, ownerAddition, ownerAdditionOutcome, prepareOwnerAddition, readOwnerSubmission } from '../src/lib/treasury/owners.ts';
import { safeExecutionAbi, safeTransactionHash } from '../src/lib/treasury/safeTransactions.ts';
const A = privateKeyToAccount(toHex(0xa11cen, { size: 32 })), B = privateKeyToAccount(toHex(0xb0bn, { size: 32 }));
const addr = n => '0x' + n.repeat(40), hash = t => keccak256(stringToHex(t));
function fixture() {
  const c = { version: 1, environment: 'dashboard-testnet', instance: hash('test'), safeL1: addr('1'), safeL2: addr('2'),
    l1: { chainId: 10200, rpc: 'l1', checkpoint: { number: '0x100', hash: hash('reference') } },
    code: [{ chain: 'l1', address: addr('1'), hash: keccak256('0x1234') }] };
  const client = new TreasuryClient(c); client.validate = async () => {};
  const state = { owners: [A.address], threshold: 1, nonce: 4n, block: '0x105', fingerprint: `1:${A.address.toLowerCase()}` };
  client.read = async (_url, _address, _abi, name) => ({ getOwners: state.owners, getThreshold: BigInt(state.threshold), nonce: state.nonce })[name];
  client.rpc = async (_url, method) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x105', hash: hash('block') };
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_estimateGas') return '0x186a0';
    throw new Error(method);
  };
  let selected = A, chain = 10200, signed = 0;
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [selected.address];
    if (method === 'eth_chainId') return toHex(chain);
    if (method === 'eth_getCode') return '0x1234';
    if (method === 'eth_getBlockByNumber') { assert.equal(params[0], '0x100'); return { hash: hash('reference') }; }
    if (method === 'eth_signTypedData_v4') { signed++; return selected.signTypedData(JSON.parse(params[1])); }
    throw new Error(method);
  } };
  return { c, client, state, provider, select: account => { selected = account; }, chain: id => { chain = id; }, signed: () => signed };
}
test('adding connected B is an ordinary L1 Safe self-call; 1-of-1 A authorizes either 1-of-2 or 2-of-2', async () => {
  for (const threshold of [1, 2]) {
    const f = fixture(), review = ownerAddition(f.client, B.address, threshold, f.state);
    assert.equal(review.transaction.domain.chainId, 10200n);
    assert.equal(review.transaction.domain.verifyingContract, f.c.safeL1);
    assert.equal(review.transaction.message.to, f.c.safeL1);
    const approval = await approveOwnerAddition(f.client, f.provider, review);
    const prepared = await prepareOwnerAddition(f.client, f.provider, review, [approval]);
    const execution = decodeFunctionData({ abi: safeExecutionAbi, data: prepared.request.data });
    assert.equal(execution.args[9].length, 132, 'one standard 65-byte EOA approval');
    const action = decodeFunctionData({ abi: parseAbi(['function addOwnerWithThreshold(address owner,uint256 threshold)']), data: execution.args[2] });
    assert.deepEqual(action.args, [B.address, BigInt(threshold)]);
    assert.equal(prepared.request.value, '0x0'); assert.equal(prepared.request.chainId, '0x27d8');
    assert.deepEqual(readOwnerSubmission(f.client, JSON.stringify(prepared.pending)), prepared.pending);
  }
});
test('B cannot approve its own addition; wrong network, stale nonce and insufficient quorum fail before submission', async () => {
  const f = fixture(), review = ownerAddition(f.client, B.address, 2, f.state);
  f.select(B);
  await assert.rejects(approveOwnerAddition(f.client, f.provider, review), /current L1 owner/); assert.equal(f.signed(), 0);
  f.select(A); f.chain(906969);
  await assert.rejects(approveOwnerAddition(f.client, f.provider, review), /Switch to the L1/); assert.equal(f.signed(), 0);
  f.chain(10200);
  await assert.rejects(prepareOwnerAddition(f.client, f.provider, review, []), /quorum/);
  f.state.nonce = 5n;
  await assert.rejects(approveOwnerAddition(f.client, f.provider, review), /nonce changed/); assert.equal(f.signed(), 0);
});
test('owner reviews reject zero, sentinel, existing owners and impossible thresholds', () => {
  const f = fixture();
  for (const candidate of [addr('0'), '0x' + '0'.repeat(39) + '1', A.address, f.c.safeL1])
    assert.throws(() => ownerAddition(f.client, candidate, 1, f.state));
  for (const threshold of [0, -1, 1.5, 3, Number.NaN]) assert.throws(() => ownerAddition(f.client, B.address, threshold, f.state));
});
test('owner completion uses verified inclusion while the safe checkpoint lags', async () => {
  const f = fixture(), review = ownerAddition(f.client, B.address, 1, f.state);
  const approval = await approveOwnerAddition(f.client, f.provider, review);
  const { pending } = await prepareOwnerAddition(f.client, f.provider, review, [approval]); pending.hash = hash('owner tx');
  let canonical = true, success = true, receipt = true; const tags = [];
  f.client.rpc = async (_url, method, params) => {
    if (method === 'eth_getTransactionReceipt') return !receipt ? null : { status: '0x1', blockNumber: '0x106', blockHash: hash('mined'), logs: success ? [{ address: f.c.safeL1,
      topics: [encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess' })[0], safeTransactionHash(review.transaction)], data: encodeAbiParameters([{ type: 'uint256' }], [0n]) }] : [] };
    if (method === 'eth_getBlockByNumber') { tags.push(params[0]); return { number: params[0] === 'safe' ? '0x100' : '0x106', hash: hash(canonical ? 'mined' : 'reorg') }; }
    if (method === 'eth_getTransactionByHash') return { from: A.address, to: f.c.safeL1, input: pending.data, nonce: pending.sourceNonce };
    throw new Error(`${method}: ${params}`);
  };
  f.state.owners = [A.address, B.address]; f.state.nonce++;
  assert.equal((await ownerAdditionOutcome(f.client, pending)).success, true);
  assert(!tags.includes('safe'), 'owner inclusion must not depend on a later safe checkpoint');
  receipt = false; assert.equal((await ownerAdditionOutcome(f.client, pending)).complete, false); receipt = true;
  canonical = false; assert.equal((await ownerAdditionOutcome(f.client, pending)).complete, false); canonical = true;
  success = false; await assert.rejects(ownerAdditionOutcome(f.client, pending), /does not establish/);
});

test('Safe 1.3.0 owner addition recovers a lost response by hash in log data and verifies resulting owners', async () => {
  const f = fixture(), review = ownerAddition(f.client, B.address, 1, f.state);
  const approval = await approveOwnerAddition(f.client, f.provider, review);
  const { pending } = await prepareOwnerAddition(f.client, f.provider, review, [approval]);
  const log = { address: f.c.safeL1, transactionHash: hash('owner130'), topics: [encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess' })[0]],
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [pending.safeHash, 0n]) };
  let matching = true;
  f.client.rpc = async (_url, method, params) => {
    if (method === 'eth_getLogs') {
      assert.equal(params[0].topics.length, 1);
      return [{ ...log, data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [hash('different Safe approval'), 0n]) }, ...(matching ? [log] : [])];
    }
    if (method === 'eth_getTransactionReceipt') { assert.equal(params[0], log.transactionHash); return { status: '0x1', blockNumber: '0x106', blockHash: hash('mined'), logs: [log] }; }
    if (method === 'eth_getBlockByNumber') return { number: '0x106', hash: hash('mined') };
    if (method === 'eth_getTransactionByHash') return { from: A.address, to: f.c.safeL1, input: pending.data, nonce: pending.sourceNonce };
    throw new Error(method);
  };
  f.state.owners = [A.address, B.address]; f.state.nonce++;
  assert.equal((await ownerAdditionOutcome(f.client, pending)).success, true);
  matching = false; assert.equal((await ownerAdditionOutcome(f.client, pending)).complete, false);
});


test('owner inclusion rechecks the receipt and canonical block after reading owners', async () => {
  for (const change of ['missing receipt', 'moved receipt', 'changed status', 'reorg', 'RPC failure']) {
    const f = fixture(), review = ownerAddition(f.client, B.address, 1, f.state);
    const approval = await approveOwnerAddition(f.client, f.provider, review);
    const { pending } = await prepareOwnerAddition(f.client, f.provider, review, [approval]); pending.hash = hash('owner tx');
    const saved = JSON.stringify(pending);
    let receiptReads = 0, blockReads = 0;
    f.client.rpc = async (_url, method, params) => {
      if (method === 'eth_getTransactionReceipt') {
        const receipt = { status: '0x1', blockNumber: '0x106', blockHash: hash('mined'), logs: [{ address: f.c.safeL1,
          topics: [encodeEventTopics({ abi: safeAbi, eventName: 'ExecutionSuccess' })[0], safeTransactionHash(review.transaction)], data: encodeAbiParameters([{ type: 'uint256' }], [0n]) }] };
        if (++receiptReads > 1) {
          if (change === 'missing receipt') return null;
          if (change === 'moved receipt') return { ...receipt, blockNumber: '0x107', blockHash: hash('moved') };
          if (change === 'changed status') return { ...receipt, status: '0x0' };
          if (change === 'RPC failure') throw new Error('Receipt observation unavailable');
        }
        return receipt;
      }
      if (method === 'eth_getBlockByNumber') {
        assert.equal(params[0], '0x106'); blockReads++;
        return { number: '0x106', hash: hash(change === 'reorg' && blockReads === 4 ? 'reorg' : 'mined') };
      }
      if (method === 'eth_getTransactionByHash') return { from: A.address, to: f.c.safeL1, input: pending.data, nonce: pending.sourceNonce };
      throw new Error(method);
    };
    f.state.owners = [A.address, B.address]; f.state.nonce++;
    if (change === 'RPC failure') await assert.rejects(ownerAdditionOutcome(f.client, pending), /Receipt observation unavailable/);
    else {
      const result = await ownerAdditionOutcome(f.client, pending);
      assert.equal(result.complete, false, change); assert.equal(result.detail, 'Checking L1 inclusion again.');
    }
    assert.equal(receiptReads, 2); assert.equal(blockReads, 4);
    assert.equal(JSON.stringify(pending), saved, 'uncertain inclusion must retain the request');
  }
});

test('a reverted owner change completes as a failure at verified inclusion', async () => {
  const f = fixture(), review = ownerAddition(f.client, B.address, 1, f.state);
  const approval = await approveOwnerAddition(f.client, f.provider, review);
  const { pending } = await prepareOwnerAddition(f.client, f.provider, review, [approval]); pending.hash = hash('reverted owner tx');
  f.client.rpc = async (_url, method, params) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x0', blockNumber: '0x106', blockHash: hash('mined'), logs: [] };
    if (method === 'eth_getBlockByNumber') { assert.equal(params[0], '0x106'); return { number: '0x106', hash: hash('mined') }; }
    if (method === 'eth_getTransactionByHash') return { from: A.address, to: f.c.safeL1, input: pending.data, nonce: pending.sourceNonce };
    throw new Error(method);
  };
  const result = await ownerAdditionOutcome(f.client, pending);
  assert.equal(result.complete, true); assert.equal(result.success, false); assert.equal(result.detail, 'The L1 owner change reverted.');
  assert.equal(result.blockNumber, '0x106'); assert(!f.state.owners.includes(B.address));
});


test('malformed owner receipt headers cannot establish inclusion', async () => {
  const f = fixture(), review = ownerAddition(f.client, B.address, 1, f.state);
  const approval = await approveOwnerAddition(f.client, f.provider, review);
  const { pending } = await prepareOwnerAddition(f.client, f.provider, review, [approval]); pending.hash = hash('malformed receipt');
  for (const invalid of [{ blockNumber: undefined }, { blockNumber: 'latest' }, { blockHash: '0x1234' }, { status: '0x2' }]) {
    f.client.rpc = async (_url, method) => {
      assert.equal(method, 'eth_getTransactionReceipt', 'reject malformed headers before following their block reference');
      return { status: '0x1', blockNumber: '0x106', blockHash: hash('mined'), logs: [], ...invalid };
    };
    await assert.rejects(ownerAdditionOutcome(f.client, pending), /Incomplete owner transaction receipt/);
  }
});
