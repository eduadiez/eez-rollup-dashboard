// Real owner-signed Safe transactions on both source chains, proved and replayed
// by the dashboard's existing native fixture. No privileged treasury calls.
import assert from 'node:assert/strict';
import { decodeErrorResult, keccak256, parseAbi, toHex } from 'viem';
import { startComposerAdapter } from '../../scripts/treasury-composer.mjs';
import { setupPayments } from './treasury-payments.mjs';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { paymentState, paymentTransaction, tokenAbi } from '../../src/lib/treasury/payments.ts';
import { packEOAApprovals, packOwnerApprovals, encodeSafeExecution, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';

export async function runBidirectionalPayments(f) {
  const setup = await setupPayments(f, { legacy: true }), n = f.network;
  let p = setup.payments;
  const code = [...setup.code];
  for (const [chain, address] of [['l1', f.safeL1], ['l2', f.safeL2], ['l2', f.adapter]])
    code.push({ chain, address, hash: keccak256(await f.rpc(n[chain].rpc, 'eth_getCode', [address, 'latest'])) });
  const c = { version: 1, environment: 'isolated-devnet', instance: keccak256(toHex(f.safeL2)),
    l1: { ...n.l1, genesis: (await f.rpc(n.l1.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash },
    l2: { ...n.l2, genesis: (await f.rpc(n.l2.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash },
    registry: n.registry, manager: f.manager, safeL1: f.safeL1, safeL2: f.safeL2, adapter: f.adapter,
    code, payments: p, ownerLabels: {} };
  const adapters = [];
  try {
  for (const chain of ["l1", "l2"]) {
    const adapter = await startComposerAdapter(n[chain].front, { chainId: n[chain].chainId, genesis: c[chain].genesis,
      l1ChainId: n.l1.chainId, l2ChainId: n.l2.chainId, registry: n.registry, manager: f.manager, statusRpc: n.l2.rpc });
    adapters.push(adapter); c[chain].front = adapter.url;
  }
  let client = new TreasuryClient(c);
  await client.validate();
  await f.until('bidirectional period has time remaining', async () => {
    const b = await f.rpc(n.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
    return BigInt(b.timestamp) % 600n < 400n;
  }, 250);
  const { runPolicyUpgrade } = await import('./treasury-upgrade.mjs');
  Object.assign(c, await runPolicyUpgrade(f, c, setup)); p = c.payments;
  client = new TreasuryClient(c); await client.validate();
  const epoch = String((await paymentState(client)).epoch);
  const cases = f.evidence.bidirectional = [];
  let first;
  async function build(source, destination, amount, fromL1 = String(amount)) {
    const payment = { source, destination, recipient: p.recipient, amount: String(amount), funding: 'split', fromL1, epoch };
    const snapshot = await client.snapshot(source);
    const tx = paymentTransaction(c, payment, snapshot.nonce);
    const approvals = await Promise.all([f.A, f.B].map(async owner => ({ owner: owner.address, signature: await owner.signTypedData(tx) })));
    const signatures = source === 'l1' ? await packEOAApprovals(tx, snapshot.owners, snapshot.threshold, approvals)
      : await packOwnerApprovals(tx, c.adapter, snapshot.owners, snapshot.threshold, approvals);
    const intent = { version: 1, instance: c.instance, value: '0', nonce: String(snapshot.nonce), safeHash: safeTransactionHash(tx),
      data: encodeSafeExecution(tx, signatures), sender: f.submitter.address,
      sourceNonce: await f.rpc(n[source].rpc, 'eth_getTransactionCount', [f.submitter.address, 'pending']),
      startBlock: await f.rpc(n[source].rpc, 'eth_blockNumber'), l2StartBlock: (await f.rpc(n.l2.rpc, 'eth_getBlockByNumber', ['safe', false])).number, payment };
    return intent;
  }
  for (const [source, destination, amount, fromL1, fromL2, spent] of [
    ['l1', 'l2', 70_000_000n, '35000000', '35000000', 110_000_000n],
    ['l1', 'l1', 10_000_000n, '0', '10000000', 120_000_000n],
    ['l2', 'l1', 10_000_000n, '10000000', '0', 130_000_000n],
    ['l2', 'l2', 20_000_000n, '5000000', '15000000', 150_000_000n],
  ]) {
    const before = await paymentState(client), safe = source === 'l1' ? f.safeL1 : f.safeL2;
    const recipientToken = destination === 'l1' ? p.tokenL1 : p.tokenL2;
    const beforeRecipient = await f.read(n[destination].rpc, recipientToken, tokenAbi, 'balanceOf', [p.recipient]);
    const intent = await build(source, destination, amount, fromL1);
    intent.hash = await f.submit(n[source], safe, intent.data);
    if (!first) first = intent;
    const result = await f.until(`${source} to ${destination} canonical payment`, async () => {
      const outcome = await client.outcome(intent);
      if (outcome.kind === 'rejected') throw new Error(JSON.stringify(outcome));
      return outcome.kind === 'settled' ? outcome : false;
    }, 180);
    assert.deepEqual(result.contributions, { fromL1, fromL2 });
    const after = await paymentState(client);
    assert.equal(after.spent, spent);
    assert.equal(after.balanceL1, before.balanceL1 - BigInt(fromL1));
    assert.equal(after.balanceL2, before.balanceL2 - BigInt(fromL2));
    assert.equal(await f.read(n[destination].rpc, recipientToken, tokenAbi, 'balanceOf', [p.recipient]), beforeRecipient + amount);
    const l2Block = await f.rpc(n.l2.rpc, 'eth_getBlockByNumber', [toHex(BigInt(result.block)), false]);
    await f.until('independent follower payment replay', async () => {
      const block = await f.rpc(n.follower, 'eth_getBlockByNumber', [l2Block.number, false]);
      return block?.hash === l2Block.hash;
    });
    assert.equal(await f.read(n.follower, p.policy, setup.policyArtifact.abi, 'spent', [BigInt(epoch)], l2Block.number), spent);
    assert.equal(await f.read(n.follower, p.tokenL2, tokenAbi, 'balanceOf', [f.safeL2], l2Block.number), after.balanceL2);
    cases.push({ source, destination, amount: String(amount), hash: intent.hash, safeHash: intent.safeHash, block: result.block, contributions: result.contributions, spent: String(spent), independentReplay: true });
    f.evidence.lastSuccessfulL2Block = Number(result.block); f.checkpoint();
    console.log(`Bidirectional ${source} → ${destination}: ${amount}, settled and independently replayed`);
  }
  async function rejected(label, to, data, ordinary = false) {
    const nonce = await f.read(n.l1.rpc, f.safeL1, f.safeArtifact.abi, 'nonce');
    const hash = await f.submit(n.l1, to, data);
    if (ordinary) {
      const receipt = await f.until(label, () => f.rpc(n.l1.rpc, 'eth_getTransactionReceipt', [hash]));
      assert.equal(receipt.status, '0x0');
      const block = await f.rpc(n.l1.rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      assert.equal(block.hash, receipt.blockHash);
      const trace = await f.rpc(n.l1.rpc, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
      assert.equal(decodeErrorResult({ abi: parseAbi(['error Error(string)']), data: trace.output }).args[0], 'GS026');
    } else {
    const status = await f.until(label, async () => {
      const s = await f.rpc(n.l2.rpc, 'eez_getCrossChainTransaction', [hash]);
      return s?.lifecycle === 'terminal' ? s : false;
    });
    assert.equal(status.ownership.reason, 'PoolDiscarded');
    assert.equal(await f.rpc(n.l1.rpc, 'eth_getTransactionReceipt', [hash]), null);
    }
    assert.equal(await f.read(n.l1.rpc, f.safeL1, f.safeArtifact.abi, 'nonce'), nonce);
    assert.equal((await paymentState(client)).spent, 150_000_000n);
    cases.push({ label, hash, stage: ordinary ? 'ordinary L1 signature rejection' : 'preparation rejected', unchanged: true }); f.checkpoint();
  }
  const exhausted = await build('l1', 'l1', 1_000_000n);
  await rejected('L1 shared budget rejects despite remaining L1 allowance', f.safeL1, exhausted.data);
  await rejected('L1 Safe signature replay rejected', f.safeL1, first.data, true);
  const direct = paymentTransaction(c, exhausted.payment, BigInt(exhausted.nonce));
  await rejected('EOA cannot impersonate the L1 Safe through its policy proxy', p.alias, direct.message.data);
  const { runFaucetDeliveries } = await import('./treasury-faucet.mjs');
  await runFaucetDeliveries(f, c, client, epoch);
  } finally { await Promise.all(adapters.map(adapter => adapter.close())); }
}
