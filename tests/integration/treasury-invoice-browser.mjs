import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { invoiceAbi, invoiceControl, invoiceSnapshot, verifyInvoiceRollback } from '../../src/lib/treasury/invoices.ts';
import { paymentState, paymentTransaction } from '../../src/lib/treasury/payments.ts';
import { encodeSafeExecution, packOwnerApprovals, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';

export async function invoiceBrowser(f, page, ui, waitText, directory) {
  const { treasury: c } = JSON.parse(readFileSync(resolve(directory, 'ui-session.json'))), client = new TreasuryClient(c);
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
  // Opening this view validates the deployment and reads live balances first.
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  await f.until('invoice has time in its natural budget period', async () => {
    const block = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
    return BigInt(block.timestamp) % 600n < 470n;
  }, 180);
  // Invoice creation is an isolated fixture operation. The regular payment
  // form no longer contains rehearsal shortcuts; verify its restored outcome.
  // Use the later browser submitter for this rollback attempt so successful
  // payments advance both nonces before history omits its queue diagnostic.
  const opened = await f.invoices.open(false), openState = await paymentState(client), openSnapshot = await client.snapshot();
  const openPayment = { kind: 'invoice', invoiceId: opened.invoiceId, recipient: opened.recipient, amount: opened.amount,
    destination: 'l1', epoch: String(openState.epoch) };
  const openTx = paymentTransaction(c, openPayment, openSnapshot.nonce);
  const openApprovals = await Promise.all([f.A, f.B].map(async owner => ({ owner: owner.address, signature: await owner.signTypedData(openTx) })));
  const openData = encodeSafeExecution(openTx, await packOwnerApprovals(openTx, c.adapter, openSnapshot.owners, openSnapshot.threshold, openApprovals));
  const intent = { version: 1, instance: c.instance, payment: openPayment, value: '0', nonce: String(openSnapshot.nonce), safeHash: safeTransactionHash(openTx),
    data: openData, sender: f.B.address, sourceNonce: await f.rpc(f.network.l2.rpc, 'eth_getTransactionCount', [f.B.address, 'pending']),
    startBlock: await f.rpc(f.network.l2.rpc, 'eth_blockNumber') };
  await invoiceControl(c, 'arm', intent);
  const hash = intent.hash = await f.submit(f.network.l2, c.safeL2, openData, 0n, f.B);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`eez:treasury:submission:${c.instance}`, JSON.stringify(intent)]);
  await page.reload();
  await ui.getByRole('heading', { name: 'Rollback verified', exact: true }).waitFor({ timeout: 150_000 });
  assert.equal(await ui.getByLabel('Payment type', { exact: true }).inputValue(), 'invoice');
  await waitText('global-spent', '0'); await waitText('l1-spent', '0'); await waitText('l2-spent', '0');
  const report = f.invoices.records.get(intent.payment.invoiceId);
  assert.equal(report.phase, 'verified');
  const rollback = await verifyInvoiceRollback(client, intent, report);
  assert.equal(await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [hash]), null, 'rolled-back source is absent from canonical L2');
  const disposition = await f.rpc(f.network.l2.rpc, 'eez_getCrossChainTransaction', [hash]);
  assert.equal(disposition.lifecycle, 'terminal'); assert.equal(disposition.ownership.reason, 'PoolDiscarded');
  // Independently replay the canonical prefix after the failed post. A receipt
  // or unchanged latest state in Composer is not enough.
  await f.until('follower observes invoice rollback', async () => {
    const head = await f.rpc(f.network.follower, 'eth_getBlockByNumber', ['safe', false]);
    if (BigInt(head.number) < BigInt(report.after.l2.number)) return false;
    const follower = new TreasuryClient({ ...c, l2: { ...c.l2, rpc: f.network.follower } });
    const snapshot = await invoiceSnapshot(follower, intent, report.after);
    assert.deepEqual(snapshot.values, rollback.after);
    assert.equal(await f.rpc(f.network.follower, 'eth_getTransactionReceipt', [hash]), null);
    return true;
  });
  f.evidence.cases.push({ label: 'Invoice rejected after two L1 transfers; rollback verified', transaction: hash, safeHash: intent.safeHash,
    invoiceId: intent.payment.invoiceId, disposition: disposition.ownership.reason, ...rollback, independentReplay: true,
    trace: `invoice-${intent.payment.invoiceId}-trace.json`, postStatus: report.postStatus }); f.checkpoint();
  await page.screenshot({ path: resolve(directory, 'treasury-invoice-rollback-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `invoice table fits at ${width}`);
  }
  await page.screenshot({ path: resolve(directory, 'treasury-invoice-rollback-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Known failure: real signed source reaches Composer while the invoice is
  // already closed. It must not be presented as the settlement demonstration.
  // Keep the source account selected by the native admission-trace filter.
  const closed = await f.invoices.open(true), s = await paymentState(client), snapshot = await client.snapshot();
  const payment = { kind: 'invoice', invoiceId: closed.invoiceId, recipient: closed.recipient, amount: closed.amount,
    destination: 'l1', epoch: String(s.epoch) };
  const tx = paymentTransaction(c, payment, snapshot.nonce);
  const approvals = await Promise.all([f.A, f.B].map(async owner => ({ owner: owner.address, signature: await owner.signTypedData(tx) })));
  const packed = await packOwnerApprovals(tx, c.adapter, snapshot.owners, snapshot.threshold, approvals);
  const data = encodeSafeExecution(tx, packed);
  const closedIntent = { version: 1, instance: c.instance, payment, value: '0', nonce: String(snapshot.nonce), safeHash: safeTransactionHash(tx),
    data, sender: f.submitter.address, sourceNonce: await f.rpc(f.network.l2.rpc, 'eth_getTransactionCount', [f.submitter.address, 'pending']),
    startBlock: await f.rpc(f.network.l2.rpc, 'eth_blockNumber') };
  const before = await invoiceSnapshot(client, closedIntent);
  closedIntent.hash = await f.submit(f.network.l2, c.safeL2, data);
  const rejected = await f.until('closed invoice preparation rejection', async () => {
    const result = await client.outcome(closedIntent); return result.kind === 'rejected' ? result : false;
  });
  assert.match(rejected.detail, /Rejected during preparation/); assert.equal(rejected.rollback, undefined);
  assert.equal(await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [closedIntent.hash]), null);
  assert.deepEqual((await invoiceSnapshot(client, closedIntent)).values, before.values);
  const preparationTrace = await f.until('Composer reaches the closed merchant invoice', async () => {
    for (const name of readdirSync(f.network.traceDirectory)) {
      if (!name.startsWith(`${closedIntent.hash}-admission_execution-`)) continue;
      let rows; try { rows = readFileSync(resolve(f.network.traceDirectory, name), 'utf8').trim().split('\n').map(JSON.parse); } catch { continue; }
      if (rows.at(-1)?.kind !== 'end') continue;
      assert.equal(rows.at(-1).truncated, false);
      assert(rows.some(row => row.kind === 'step' && row.chain_id === f.network.l1.chainId && row.address?.toLowerCase() === c.payments.invoiceMerchant.toLowerCase() && row.op === 253), 'specific merchant REVERT reached during composition');
      return name;
    }
  });
  // Verify the specific merchant error at the exact canonical parent as well
  // as the real Composer's terminal disposition, not an unrelated early error.
  await assert.rejects(f.rpc(f.network.l1.rpc, 'eth_call', [{ from: c.payments.alias, to: c.payments.invoiceMerchant,
    data: (await import('viem')).encodeFunctionData({ abi: invoiceAbi, functionName: 'accept', args: [payment.invoiceId, c.payments.tokenL1, payment.recipient, BigInt(payment.amount)] }) }, 'latest']), /a1c43db2/);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`eez:treasury:submission:${c.instance}`, JSON.stringify(closedIntent)]);
  await page.reload();
  await ui.getByRole('status').filter({ hasText: 'Rejected during preparation' }).waitFor();
  assert.equal(await ui.getByRole('heading', { name: 'Rollback verified', exact: true }).count(), 0);
  f.evidence.cases.push({ label: 'Closed invoice rejected during preparation', transaction: closedIntent.hash, safeHash: closedIntent.safeHash,
    invoiceId: payment.invoiceId, outcome: rejected.detail, compositionTrace: preparationTrace, snapshot: before.values }); f.checkpoint();
  console.log('Invoice browser scenario passed: real settlement rollback and distinct preparation rejection');
}
