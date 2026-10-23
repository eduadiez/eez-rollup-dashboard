import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TreasuryClient, canonicalRequestRetired } from '../../src/lib/treasury/client.ts';

export async function historyBrowser(f, page, ui, directory) {
  const { treasury: config } = JSON.parse(readFileSync(resolve(directory, 'ui-session.json')));
  const key = `eez:treasury:history:${config.instance}`;
  const panel = ui.getByLabel('Payment history', { exact: true });
  const rows = panel.getByTestId('history-entry');
  const expected = { settled: 4, preparation: 3, rollback: 1, pending: 0, rejected: 0 };
  const counts = async () => Object.fromEntries(await Promise.all(Object.keys(expected).map(async status =>
    [status, await panel.locator(`[data-testid="history-entry"][data-status="${status}"]`).count()])));
  const complete = async () => f.until('all history outcomes reconciled', async () => JSON.stringify(await counts()) === JSON.stringify(expected));
  await complete();
  const invoice = f.evidence.cases.find(c => c.label.startsWith('Invoice rejected after'));
  const client = new TreasuryClient(config), invoiceReport = f.invoices.records.get(invoice.invoiceId);
  const queueObservation = await client.rpc(config.l2.front, 'eez_getCrossChainTransaction', [invoice.transaction]);
  assert.equal(await canonicalRequestRetired(client, invoiceReport.intent), true, 'both canonical nonces prevent replay of the old attempt');
  // Diagnostic retention has no fixed expiry deadline. Omit only this old
  // lookup on reload; all receipts, nonces, traces and state remain real RPCs.
  let omittedDiagnostics = 0;
  await page.route(config.l2.front, async route => {
    const body = route.request().postDataJSON();
    if (body.method === 'eez_getCrossChainTransaction' && body.params?.[0] === invoice.transaction) {
      omittedDiagnostics++;
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: null } });
    }
    return route.fallback();
  });
  const saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), key));
  assert.equal(saved.entries.length, 8);
  assert.equal(saved.entries.filter(e => e.kind === 'submitted').length, 6);
  assert.equal(saved.entries.filter(e => e.kind === 'preparation').length, 2);
  assert.equal(new Set(saved.entries.map(e => e.id)).size, 8);
  assert(saved.entries.every(e => !('outcome' in e)), 'cached storage cannot assert settlement');
  assert.equal(saved.entries.filter(e => e.intent?.payment?.kind === 'invoice').length, 2, 'failed invoices share a Safe nonce but keep separate identities');
  await page.reload();
  await complete();
  assert(omittedDiagnostics > 0, 'reconciliation queried the omitted Composer diagnostic');
  assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), key)), saved, 'reload reconciles without appending or modifying attempts');
  const filter = panel.getByLabel('Filter history', { exact: true });
  await filter.selectOption('settled'); assert.equal(await rows.count(), 4);
  const fixed = rows.filter({ hasText: '30 USDC → Ethereum' });
  await fixed.getByRole('button', { name: 'Show payment details', exact: true }).click();
  assert.match(await fixed.getByTestId('history-settled-funding').textContent(), /Paid 30 from Ethereum \+ 0 from EEZ-X/);
  const l1 = rows.filter({ hasText: '110 USDC → Ethereum' });
  await l1.getByRole('button', { name: 'Show payment details', exact: true }).click();
  assert.match(await l1.getByTestId('history-settled-funding').textContent(), /Paid 100 from Ethereum \+ 10 from EEZ-X/);
  const l2 = rows.filter({ hasText: '110 USDC → EEZ-X' });
  await l2.getByRole('button', { name: 'Show payment details', exact: true }).click();
  assert.match(await l2.getByTestId('history-settled-funding').textContent(), /Paid 10 from Ethereum \+ 100 from EEZ-X/);
  await filter.selectOption('preparation'); assert.equal(await rows.count(), 3);
  const local = rows.filter({ hasText: '1 USDC → EEZ-X' });
  await local.getByRole('button', { name: 'Show payment details', exact: true }).click();
  assert.match(await local.textContent(), /Not signed or submitted; no transaction hash/);
  const closed = rows.filter({ hasText: 'Invoice' });
  await closed.getByRole('button', { name: 'Show payment details', exact: true }).click();
  assert.match(await closed.textContent(), /closed this invoice before submission/);
  assert.match(await closed.textContent(), /Submitted transaction/);
  await filter.selectOption('rollback'); assert.equal(await rows.count(), 1);
  await rows.getByRole('button', { name: 'Show payment details', exact: true }).click();
  const evidence = rows.getByLabel('Historical Invoice rollback evidence', { exact: true });
  await evidence.waitFor();
  assert.match(await evidence.textContent(), /both transfers reverted/);
  assert.equal(await evidence.locator('tbody tr').count(), 10);
  await evidence.getByText('Settlement evidence', { exact: true }).click();
  const failure = f.evidence.cases.find(c => c.label.startsWith('Invoice rejected after'));
  assert((await evidence.textContent()).includes(failure.postHash));
  assert((await evidence.textContent()).includes(failure.closeHash));
  await page.screenshot({ path: resolve(directory, 'treasury-history-rollback-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `history fits at ${width}px`);
  }
  await page.screenshot({ path: resolve(directory, 'treasury-history-rollback-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await filter.selectOption('all');
  // RPC unavailability must remove current verified labels, not leave a saved
  // success/rollback badge looking freshly verified. No blockchain mutation.
  await page.route(config.l2.rpc, route => route.abort());
  await panel.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.locator('[data-outcome="settled"]').count(), 0);
  assert.equal(await panel.locator('[data-outcome="rollback"]').count(), 0);
  assert.equal(await panel.locator('[data-outcome="pending"]').count(), 6);
  await page.unroute(config.l2.rpc);
  await panel.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await complete();
  await page.screenshot({ path: resolve(directory, 'treasury-history-desktop.png'), fullPage: true });
  const report = { counts: expected, retainedAcrossReload: true, ownerActionsExcluded: true,
    verifiedFunding: ['40 local EEZ-X', '110 split L1', '30 fixed payment', '110 split EEZ-X'],
    preparation: ['closed invoice at Composer', '1 USDC local budget check', '16 USDC fixed local budget check'],
    rollbackTraceAndStateDetails: true, expiredQueueDiagnosticsHandled: true, queueExpiredNaturally: queueObservation === null, missingDiagnosticInjectedOnReload: true, omittedDiagnostics, unavailableReadsDowngrade: true, responsiveWidths: [390, 320], automaticResubmissions: 0 };
  writeFileSync(resolve(directory, 'history-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
  f.evidence.historyChecks = report; f.checkpoint();
  console.log('Payment history passed: four settlements, three preparation rejections, one verified rollback, reload and unavailable-read recovery');
}
