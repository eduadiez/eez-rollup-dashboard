import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { toHex } from 'viem';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { paymentState, tokenAbi } from '../../src/lib/treasury/payments.ts';

export async function bidirectionalBrowser(f, page, ui, sign, waitText, session, directory) {
  const c = session.treasury, client = new TreasuryClient(c), p = c.payments;
  const before = await paymentState(client);
  const recipientBefore = await f.read(f.network.l2.rpc, p.tokenL2, tokenAbi, 'balanceOf', [p.recipient]);
  const nonceBefore = await f.read(f.network.l1.rpc, f.safeL1, f.safeArtifact.abi, 'nonce');
  await ui.getByLabel('Payment type', { exact: true }).selectOption('fixed');
  await ui.getByLabel('Start from', { exact: true }).selectOption('l1');
  await ui.getByLabel('Amount (USDC)', { exact: true }).fill('10');
  await ui.getByLabel('Recipient chain', { exact: true }).selectOption('l2');
  await ui.getByRole('button', { name: 'Use available funds', exact: true }).click();
  await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
  await waitText('funding-preview', '10 from Ethereum + 0 from EEZ-X');
  assert.equal(await ui.getByRole('button', { name: 'Switch to L1', exact: true }).count(), 0);
  await sign('A'); await waitText('quorum', '1 of 2 approvals');
  const firstHash = await ui.getByTestId('safe-hash').textContent();
  await ui.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await ui.getByLabel('Start from', { exact: true }).selectOption('l2');
  await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
  await waitText('quorum', '0 of 2 approvals');
  assert.notEqual(await ui.getByTestId('safe-hash').textContent(), firstHash);
  await ui.getByRole('button', { name: 'Edit payment', exact: true }).click();
  await ui.getByLabel('Start from', { exact: true }).selectOption('l1');
  await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
  await sign('A'); await waitText('quorum', '1 of 2 approvals');
  await sign('B'); await waitText('quorum', '2 of 2 approvals');
  await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
  await ui.getByTestId('submitted-hash').waitFor();
  const hash = await ui.getByTestId('submitted-hash').getAttribute('data-hash');
  await page.reload();
  const intent = JSON.parse(await page.evaluate(key => localStorage.getItem(key), `eez:treasury:submission:${c.instance}`));
  const result = await f.until('browser L1 payment settles', async () => {
    const outcome = await client.outcome(intent);
    if (outcome.kind === 'rejected') {
      const receipt = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [hash]);
      const block = receipt && await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', [receipt.blockNumber, true]);
      const trace = receipt && await f.rpc(f.network.l1.rpc, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
      writeFileSync(resolve(directory, 'treasury-l1-payment-failure.json'), JSON.stringify({ outcome, receipt, block, trace }, null, 2) + '\n');
      throw new Error(`L1 payment failed: ${JSON.stringify(outcome)}`);
    }
    return outcome.kind === 'settled' ? outcome : false;
  }, 150);
  await ui.getByRole('heading', { name: 'Settled on Ethereum', exact: true }).waitFor();
  assert.equal(await ui.getByLabel('Start from', { exact: true }).inputValue(), 'l1');
  await waitText('settled-funding', 'Paid 10 from Ethereum + 0 from EEZ-X');
  assert.equal(await f.read(f.network.l1.rpc, f.safeL1, f.safeArtifact.abi, 'nonce'), nonceBefore + 1n);
  assert.equal(await f.read(f.network.l2.rpc, p.tokenL2, tokenAbi, 'balanceOf', [p.recipient]), recipientBefore + 10_000_000n);
  const after = await paymentState(client);
  assert.equal(after.spent, before.spent + 10_000_000n);
  assert.equal(result.kind, 'settled');
  await f.until('follower replays browser L1 payment', async () => {
    const tag = toHex(BigInt(result.block));
    const [a, b] = await Promise.all([f.rpc(f.network.l2.rpc, 'eth_getBlockByNumber', [tag, false]), f.rpc(f.network.follower, 'eth_getBlockByNumber', [tag, false])]);
    if (a?.hash !== b?.hash) return false;
    assert.equal(await f.read(f.network.follower, p.policy, f.paymentFixture.policyArtifact.abi, 'spent', [after.epoch], tag), after.spent);
    return true;
  });
  await ui.getByLabel('Payment history', { exact: true }).getByRole('button', { name: 'Refresh history', exact: true }).click();
  const row = ui.getByTestId('history-entry').filter({ has: page.getByText('10 USDC → EEZ-X', { exact: true }) });
  await row.waitFor();
  assert.match(await row.textContent(), /Ethereum → EEZ-X/);
  const receipt = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [hash]);
  const l1Block = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', [receipt.blockNumber, true]);
  const postIndex = l1Block.transactions.findIndex(tx => tx.to?.toLowerCase() === c.registry.toLowerCase());
  assert(postIndex >= 0 && postIndex < Number(BigInt(receipt.transactionIndex)), 'postBatch precedes the source Safe transaction');
  f.evidence.lastSuccessfulL2Block = Number(result.block);
  f.evidence.bidirectionalBrowser = { hash, block: result.block, source: 'l1', destination: 'l2', l1Block: receipt.blockNumber, sourceIndex: receipt.transactionIndex, postIndex, signaturesInvalidatedOnSourceChange: true, reloadRecovery: true, independentReplay: true };
  f.checkpoint();
  await page.screenshot({ path: resolve(directory, 'treasury-bidirectional-desktop.png'), fullPage: true });
  console.log('L1-initiated browser payment settled with genuine Safe signatures and independent replay');
}
