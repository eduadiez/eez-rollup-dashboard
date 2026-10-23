// Isolated fixture controller. Uses only the testkit relay's existing barrier;
// the proof, posting transaction and blob sidecars remain byte-for-byte intact.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeFunctionData, encodeFunctionData, keccak256, parseTransaction, fromRlp, toRlp, concatHex, stringToHex } from 'viem';
import { TreasuryClient, readIntent } from '../src/lib/treasury/client.ts';
import { invoiceAbi, invoiceSnapshot, invoiceTrace, verifyInvoiceRollback } from '../src/lib/treasury/invoices.ts';

// Viem parses canonical 4844 payloads and the older four-field network wrapper.
// Osaka's native relay carries [payload, 0x01, blobs, commitments, cell proofs].
// Decode its signed payload for inspection/hash only; never reconstruct the
// network envelope or replace any sidecar submitted to the pinned node.
export function postedTransaction(raw) {
  assert(typeof raw === 'string' && raw.startsWith('0x03') && raw.length < 8 * 1024 * 1024, 'Expected bounded blob posting');
  const wrapped = fromRlp(`0x${raw.slice(4)}`, 'hex');
  assert(Array.isArray(wrapped) && [4, 5].includes(wrapped.length) && Array.isArray(wrapped[0]) && wrapped[0].length === 14, 'Expected signed blob network envelope');
  if (wrapped.length === 5) assert.equal(wrapped[1], '0x01', 'Unsupported blob sidecar version');
  const payload = concatHex(['0x03', toRlp(wrapped[0])]);
  const transaction = parseTransaction(payload);
  // Viem omits zero-valued fee properties. A canonical RLP zero tip is valid;
  // normalize only that encoding for the separately signed closure's fee.
  if (wrapped[0][2] === '0x') transaction.maxPriorityFeePerGas = 0n;
  assert.equal(typeof transaction.maxPriorityFeePerGas, 'bigint', 'Expected an encoded posting priority fee');
  return { transaction, hash: keccak256(payload) };
}

export function invoiceFixture(f, config, directory) {
  const p = config.payments, client = new TreasuryClient(config);
  const controls = JSON.parse(readFileSync(resolve(directory, 'relay-control.json'))).directory;
  const coreAbi = JSON.parse(readFileSync(resolve(directory, 'fixture/contracts/out/EEZ.sol/EEZ.json'))).abi;
  const records = new Map();
  let active;
  const file = name => resolve(controls, `${name}.json`);
  const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
  const atomic = (name, value) => { writeFileSync(`${file(name)}.new`, json(value)); renameSync(`${file(name)}.new`, file(name)); };
  const save = record => writeFileSync(resolve(directory, `invoice-${record.id}.json`), json(record));
  const closeData = id => encodeFunctionData({ abi: invoiceAbi, functionName: 'close', args: [id] });
  const merchantRead = id => f.read(f.network.l1.rpc, p.invoiceMerchant, invoiceAbi, 'invoices', [id]);
  async function open(closed = false) {
    assert(!active, 'An invoice demonstration is already active');
    const id = keccak256(stringToHex(randomUUID()));
    await f.send(f.network.l1, p.invoiceMerchant, encodeFunctionData({ abi: invoiceAbi, functionName: 'open', args: [id, p.recipient, 110_000_000n] }));
    if (closed) await f.send(f.network.l1, p.invoiceMerchant, closeData(id));
    const record = { id, phase: 'open', mode: closed ? 'preparation' : 'settlement', recipient: p.recipient, amount: '110000000' };
    records.set(id, record); save(record);
    return { invoiceId: id, recipient: p.recipient, amount: '110000000' };
  }
  async function run(record) {
    let held, released = false;
    try {
      const deadline = Date.now() + 55_000;
      while (!existsSync(file('held-bundle'))) {
        assert(!record.cancelled, 'Wallet submission cancelled');
        assert(Date.now() < deadline, 'Timed out waiting for a proved invoice bundle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      held = JSON.parse(readFileSync(file('held-bundle')));
      const raws = held.params[0].txs;
      assert.equal(raws.length, 1, 'Invoice fixture requires a single original posting transaction');
      const raw = raws[0], posted = postedTransaction(raw), tx = posted.transaction;
      assert.equal(tx.to.toLowerCase(), config.registry.toLowerCase());
      const decoded = decodeFunctionData({ abi: coreAbi, data: tx.data });
      assert.equal(decoded.functionName, 'postAndVerifyBatch');
      const batch = decoded.args[0], payment = record.intent.payment;
      const accept = encodeFunctionData({ abi: invoiceAbi, functionName: 'accept', args: [record.id, p.tokenL1, payment.recipient, BigInt(payment.amount)] });
      const entries = batch.entries.filter(entry => entry.l2ToL1Calls.some(call => call.data === accept
        && call.targetAddress.toLowerCase() === p.invoiceMerchant.toLowerCase() && call.sourceAddress.toLowerCase() === p.policy.toLowerCase()));
      assert.equal(entries.length, 1, 'Held proof must include exactly this signed invoice condition');
      assert(tx.data.toLowerCase().includes(record.intent.safeHash.slice(2).toLowerCase()), 'Proof must include this Safe authorization');
      const parent = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
      assert.equal(BigInt(held.params[0].blockNumber), BigInt(parent.number) + 1n, 'Hold must preserve the intended next L1 target');
      const nonce = Number(BigInt(await f.rpc(f.network.l1.rpc, 'eth_getTransactionCount', [f.submitter.address, 'pending'])));
      const close = await f.submitter.signTransaction({ chainId: f.network.l1.chainId, nonce, type: 'eip1559', to: p.invoiceMerchant,
        data: closeData(record.id), gas: 150_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas + 1n });
      record.closeHash = keccak256(close);
      record.postHash = posted.hash;
      record.phase = 'executing'; record.detail = 'Original proved payment released after the invoice closure';
      record.targetBlock = held.params[0].blockNumber; record.parentHash = parent.hash;
      record.originalPostSha = keccak256(raw); save(record);
      writeFileSync(resolve(directory, `invoice-${record.id}-original-bundle.json`), json(held));
      held.params[0].txs = [close, raw];
      atomic('released-bundle', held); released = true;
      const post = await f.until('canonical invoice posting receipt', () => f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [record.postHash]));
      const closing = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [record.closeHash]);
      assert(closing && closing.status === '0x1');
      assert.equal(post.blockHash, closing.blockHash); assert.equal(post.blockNumber, record.targetBlock);
      assert(BigInt(closing.transactionIndex) < BigInt(post.transactionIndex));
      const block = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', [post.blockNumber, false]);
      assert.equal(block.parentHash, record.parentHash);
      const onchain = await f.rpc(f.network.l1.rpc, 'eth_getTransactionByHash', [record.postHash]);
      assert.equal(onchain.input, tx.data, 'Exact proved calldata is unchanged');
      assert.deepEqual(onchain.blobVersionedHashes, tx.blobVersionedHashes, 'Exact DA commitments are unchanged');
      const trace = await f.rpc(f.network.l1.rpc, 'debug_traceTransaction', [record.postHash, { tracer: 'callTracer' }]);
      invoiceTrace(trace, config, record.intent);
      writeFileSync(resolve(directory, `invoice-${record.id}-trace.json`), json(trace));
      record.l1Block = post.blockNumber; record.l1BlockHash = post.blockHash; record.postStatus = post.status;
      // Wait until canonical L2 storage reflects the skipped entry, not a
      // speculative receipt from its successful composition while still open.
      const before = await invoiceSnapshot(client, record.intent, { l1: parent, l2: record.before.l2 });
      const after = await f.until('invoice treasury rollback on canonical L2', async () => {
        const l2 = await f.rpc(f.network.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
        const snapshot = await invoiceSnapshot(client, record.intent, { l1: block, l2 });
        return JSON.stringify(snapshot.values) === JSON.stringify(before.values) ? snapshot : false;
      });
      record.before = { l1: before.l1, l2: before.l2 }; record.after = { l1: after.l1, l2: after.l2 };
      record.phase = 'verified'; record.detail = 'Both transfers reached before the closed invoice reverted their shared frame';
      record.rollback = await verifyInvoiceRollback(client, record.intent, record);
      record.closedInvoice = after.invoice; save(record);
    } catch (error) {
      record.phase = record.cancelled ? 'cancelled' : 'unverified';
      record.detail = String(error.shortMessage || error.message).slice(0, 500); save(record);
      console.error('Invoice scenario unverified:', record.detail);
      // If the fixture cannot establish its intended ordering, close the
      // invoice normally before releasing. A fixture error must not silently
      // turn the requested failure demonstration into a successful payment.
      try {
        if ((await merchantRead(record.id))[2] === 1) await f.send(f.network.l1, p.invoiceMerchant, closeData(record.id));
      } catch (closingError) { console.error('Invoice closure unresolved:', String(closingError.shortMessage || closingError.message).slice(0, 300)); }
      // Never leave a held relay waiting on a controller error. This is the exact
      // original request; failure to inject is not reported as rollback evidence.
      if (held && !released) atomic('released-bundle', held);
    } finally {
      rmSync(file('hold-next'), { force: true });
      active = undefined;
    }
  }
  async function arm(input) {
    assert(!active, 'An invoice demonstration is already active');
    const intent = readIntent(config, JSON.stringify(input));
    assert(intent?.payment?.kind === 'invoice');
    const record = records.get(intent.payment.invoiceId);
    assert(record && record.phase === 'open' && record.mode === 'settlement', 'Create a fresh invoice first');
    assert.equal(intent.payment.amount, record.amount); assert.equal(intent.payment.recipient.toLowerCase(), record.recipient.toLowerCase());
    const before = await invoiceSnapshot(client, intent);
    assert.equal(before.invoice[2], 1); assert.equal(before.values.safeNonce, intent.nonce);
    assert.equal(before.values.spent, '0', 'Use a fresh shared-budget period for this scenario');
    for (const key of ['allowanceL1', 'allowanceL2']) { assert.equal(before.values[key][0], '100000000'); assert.equal(before.values[key][1], '0'); }
    assert(BigInt(before.values.balanceL1) >= 100_000_000n && BigInt(before.values.balanceL2) >= 10_000_000n, 'Safes need 100 L1 + 10 L2');
    assert(BigInt(before.l1.timestamp) % 600n < 540n, 'Wait for the next period to leave time for settlement');
    for (const name of ['held-bundle', 'released-bundle', 'hold-next']) rmSync(file(name), { force: true });
    Object.assign(record, { intent, phase: 'armed', before: { l1: before.l1, l2: before.l2 }, detail: 'Waiting for a proved invoice payment at the relay' });
    active = record; save(record); atomic('hold-next', { skip: 0 });
    void run(record);
    return { armed: true };
  }
  const plugin = { name: 'isolated-treasury-invoices', configureServer(server) {
    server.middlewares.use('/treasury-fixture/invoices', async (req, res) => {
      const origin = `http://${req.headers.host}`;
      const respond = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(json(body)); };
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || (req.headers.origin && req.headers.origin !== origin)
          || req.headers['x-treasury-instance'] !== config.instance) return respond(403, { error: 'This control belongs to the local treasury fixture' });
      try {
        const action = req.url.split('?')[0].slice(1);
        if (req.method === 'GET') {
          const record = records.get(action); return record ? respond(200, record) : respond(404, { error: 'No invoice evidence' });
        }
        assert.equal(req.method, 'POST');
        let bytes = ''; for await (const chunk of req) { bytes += chunk; assert(bytes.length <= 32_768, 'Invoice request too large'); }
        const body = JSON.parse(bytes);
        if (action === 'open') return respond(200, await open(body.closed === true));
        if (action === 'arm') return respond(200, await arm(body));
        if (action === 'cancel') {
          const record = records.get(body.invoiceId);
          assert(record && (!active || active === record));
          record.cancelled = true;
          if (active !== record && (await merchantRead(record.id))[2] === 1) await f.send(f.network.l1, p.invoiceMerchant, closeData(record.id));
          return respond(200, { cancelled: true });
        }
        respond(404, { error: 'Unknown invoice action' });
      } catch (error) { respond(409, { error: String(error.message) }); }
    });
  } };
  return { plugin, open, records };
}
