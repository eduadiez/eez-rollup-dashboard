import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeEventLog, getAddress, toFunctionSelector, zeroAddress } from 'viem';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { paymentState, paymentTransaction, tokenAbi } from '../../src/lib/treasury/payments.ts';
import { safeTransactionHash, packOwnerApprovals, encodeSafeExecution } from '../../src/lib/treasury/safeTransactions.ts';

export async function paymentBrowser(f, page, ui, sign, waitText, directory) {
  const { treasury: config } = JSON.parse(readFileSync(resolve(directory, 'ui-session.json')));
  const client = new TreasuryClient(config), p = config.payments;
  const { token, module, policyArtifact, bridge } = f.paymentFixture;
  const read = (chain, address, abi, name, args = [], tag = 'latest') => f.read(f.network[chain].rpc, address, abi, name, args, tag);
  const balance = (chain, account) => read(chain, chain === 'l1' ? p.tokenL1 : p.tokenL2, tokenAbi, 'balanceOf', [account]);
  const state = async () => {
    const s = await paymentState(client);
    return { epoch: String(s.epoch), balanceL1: String(s.balanceL1), balanceL2: String(s.balanceL2),
      recipientL1: String(await balance('l1', p.recipient)), recipientL2: String(await balance('l2', p.recipient)),
      escrow: String(await balance('l1', p.bridgeL1)), supply: String(await read('l2', p.tokenL2, tokenAbi, 'totalSupply')),
      policyBalance: String(await balance('l2', p.policy)), aliasBalance: String(await balance('l1', p.alias)),
      allowanceL1: s.allowanceL1.map(String), allowanceL2: s.allowanceL2.map(String), spent: String(s.spent),
      aliasApproval: String(await read('l1', p.tokenL1, token.abi, 'allowance', [p.alias, p.bridgeL1])),
      depositNonce: String(await read('l2', p.bridgeL2, bridge.abi, 'nextDepositNonce')),
      safeNonce: String(await read('l2', f.safeL2, f.safeArtifact.abi, 'nonce')) };
  };
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
  // Opening this view validates the deployment and reads live balances first.
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  await waitText('global-spent', '0');
  // Leave enough natural period time for both reviewed payments and the forced
  // rejection. No clock/reset RPC mutates this private chain to manufacture state.
  await f.until('payment period with time for the sequence', async () => {
    const block = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
    return Number(BigInt(block.timestamp) % 600n) < 420;
  }, 240);
  assert(!(await ui.locator('#treasury-kind option').allTextContents()).some(text => /percentage|holdings/i.test(text)));
  assert.equal(await ui.getByLabel('Percentage (%)', { exact: true }).count(), 0);
  const initial = await state();
  assert.equal(initial.balanceL1, '300000000'); assert.equal(initial.balanceL2, '150000000');
  assert.equal(initial.escrow, '150000000'); assert.equal(initial.supply, initial.escrow);
  const events = (receipt, address, abi, name) => receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase()).flatMap(log => {
    try { const event = decodeEventLog({ abi, ...log }); return event.eventName === name ? [event.args] : []; } catch { return []; }
  });
  const approveAndSend = async (preset, expectedFunding, global, a1, a2, reload, expectedEpoch = initial.epoch, destination = 'l1', amount = preset === 'Pay 40 on EEZ-X' ? '40' : '110') => {
    const local = preset === 'Pay 40 on EEZ-X';
    await ui.getByLabel('Payment type', { exact: true }).selectOption('fixed');
    await ui.getByLabel('Recipient chain', { exact: true }).selectOption(local ? 'l2' : destination);
    await ui.getByLabel('Amount (USDC)', { exact: true }).fill(amount);
    await ui.getByRole('button', { name: 'Use available funds', exact: true }).click();
    await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
    await waitText('funding-preview', expectedFunding);
    if (amount === '30') {
      await sign('A'); await waitText('quorum', '1 of 2 approvals');
      const originalHash = await ui.getByTestId('safe-hash').textContent();
      await ui.getByRole('button', { name: 'Edit payment', exact: true }).click();
      await ui.getByLabel('Amount (USDC)', { exact: true }).fill('15');
      await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
      await waitText('quorum', '0 of 2 approvals');
      assert.notEqual(await ui.getByTestId('safe-hash').textContent(), originalHash);
      await ui.getByRole('button', { name: 'Edit payment', exact: true }).click();
      await ui.getByLabel('Amount (USDC)', { exact: true }).fill('30');
      await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
      await waitText('quorum', '0 of 2 approvals');
      assert.equal(await ui.getByTestId('safe-hash').textContent(), originalHash);
      await waitText('funding-preview', expectedFunding);
    }
    await sign('A'); await waitText('quorum', '1 of 2 approvals');
    await sign('B'); await waitText('quorum', '2 of 2 approvals');
    const safeHash = await ui.getByTestId('safe-hash').textContent();
    const fromBlock = await f.rpc(f.network.l1.rpc, 'eth_blockNumber');
    if (preset === 'Pay 40 on EEZ-X') {
      const history = ui.getByLabel('Payment history', { exact: true });
      const count = await history.getByTestId('history-entry').count();
      await page.evaluate(() => { window.treasuryTestWallet.rejectNextSend = true; });
      await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
      await ui.getByRole('alert').filter({ hasText: 'Wallet submission cancelled' }).waitFor();
      assert.equal(await history.getByTestId('history-entry').count(), count, 'wallet cancellation removes only the unsent history entry');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `eez:treasury:submission:${config.instance}`), null);
    }
    await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).click();
    await ui.getByTestId('submitted-hash').waitFor();
    const hash = await ui.getByTestId('submitted-hash').getAttribute('data-hash');
    if (reload) await page.reload();
    await ui.getByRole('heading', { name: 'Settled on Ethereum', exact: true }).waitFor({ timeout: 120_000 });
    await waitText('global-spent', global); await waitText('l1-spent', a1); await waitText('l2-spent', a2);
    await waitText('settled-funding', `Paid ${expectedFunding}`);
    if (reload) {
      assert.equal(await ui.getByLabel('Amount (USDC)', { exact: true }).inputValue(), amount);
      assert.equal(await ui.getByLabel('Recipient address', { exact: true }).inputValue(), p.recipient);
      assert.equal(await ui.getByLabel('Recipient chain', { exact: true }).inputValue(), destination);
      const slider = ui.getByRole('slider', { name: 'EEZ-X share of payment', exact: true });
      assert.equal(await slider.inputValue(), amount === '30' ? '0' : destination === 'l1' ? '909' : '9091');
      assert.match(await slider.getAttribute('aria-valuetext'), amount === '30'
        ? /Ethereum .*30 USDC; EEZ-X .*0 USDC$/ : destination === 'l1'
        ? /Ethereum .*100 USDC; EEZ-X .*10 USDC$/ : /Ethereum .*10 USDC; EEZ-X .*100 USDC$/);
    }
    const receipt = await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [hash]);
    const verification = await f.ownerVerificationOnL1({ hash: safeHash }, fromBlock);
    const snapshot = await state();
    assert.equal(snapshot.epoch, expectedEpoch, 'payment must settle in its reviewed budget period');
    f.evidence.cases.push({ label: preset, transaction: hash, safeHash, blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash,
      l1Verification: verification, snapshot });
    f.evidence.lastSuccessfulL2Block = Number(BigInt(receipt.blockNumber)); f.checkpoint();
    return { receipt, verification, snapshot };
  };
  const local = await approveAndSend('Pay 40 on EEZ-X', '0 from Ethereum + 40 from EEZ-X', '40', '0', '40', false);
  assert.equal(local.snapshot.recipientL2, '40000000'); assert.equal(local.snapshot.recipientL1, '0');
  assert.equal(local.snapshot.balanceL2, '110000000'); assert.equal(local.snapshot.balanceL1, '300000000');
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  const split = await approveAndSend('Split 110 to Ethereum', '100 from Ethereum + 10 from EEZ-X', '150', '100', '50', true);
  assert.equal(split.snapshot.balanceL1, '200000000'); assert.equal(split.snapshot.balanceL2, '100000000');
  assert.equal(split.snapshot.recipientL1, '110000000'); assert.equal(split.snapshot.recipientL2, '40000000');
  assert.equal(split.snapshot.escrow, '140000000'); assert.equal(split.snapshot.supply, split.snapshot.escrow);
  assert.equal(split.snapshot.policyBalance, '0'); assert.equal(split.snapshot.aliasBalance, '0');
  const posted = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [split.verification.transaction]);
  const transfers = posted.logs.filter(log => log.address.toLowerCase() === p.tokenL1.toLowerCase()).flatMap(log => {
    try { const event = decodeEventLog({ abi: token.abi, ...log }); return event.eventName === 'Transfer' && event.args.to.toLowerCase() === p.recipient.toLowerCase() ? [event.args] : []; } catch { return []; }
  });
  assert(transfers.some(t => t.from.toLowerCase() === f.safeL1.toLowerCase() && t.value === 100_000_000n));
  assert(transfers.some(t => t.from.toLowerCase() === p.bridgeL1.toLowerCase() && t.value === 10_000_000n));
  // Independent L2 replay must reproduce balances, its allowance and policy
  // state. The L1 allowance is checked directly in the canonical snapshot above.
  await f.until('follower replays payment balances and budget', async () => {
    const head = await f.rpc(f.network.follower, 'eth_getBlockByNumber', ['safe', false]);
    if (BigInt(head.number) < BigInt(split.receipt.blockNumber)) return false;
    const block = await f.rpc(f.network.follower, 'eth_getBlockByNumber', [split.receipt.blockNumber, false]);
    assert.equal(block.hash, split.receipt.blockHash);
    for (const [address, abi, name, args, expected] of [
      [p.tokenL2, tokenAbi, 'balanceOf', [f.safeL2], 100_000_000n], [p.tokenL2, tokenAbi, 'balanceOf', [p.recipient], 40_000_000n],
      [p.policy, policyArtifact.abi, 'spent', [BigInt(initial.epoch)], 150_000_000n],
      [f.safeL2, f.safeArtifact.abi, 'nonce', [], BigInt(initial.safeNonce) + 2n]])
      assert.equal(await f.read(f.network.follower, address, abi, name, args, split.receipt.blockNumber), expected);
    const a = await f.read(f.network.follower, p.moduleL2, module.abi, 'getTokenAllowance', [f.safeL2, p.policy, p.tokenL2], split.receipt.blockNumber);
    assert.equal(a[1], 50_000_000n);
    return true;
  });
  await page.screenshot({ path: resolve(directory, 'treasury-payments-desktop.png'), fullPage: true });
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  await ui.getByLabel('Payment type', { exact: true }).selectOption('fixed');
  await ui.getByLabel('Recipient chain', { exact: true }).selectOption('l2');
  await ui.getByLabel('Amount (USDC)', { exact: true }).fill('1');
  await ui.getByRole('button', { name: 'Use available funds', exact: true }).click();
  await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
  await ui.getByRole('alert').filter({ hasText: 'Shared budget exceeded: 0 USDC remains globally' }).waitFor();
  assert.equal(await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).count(), 0);
  // Bypass the UI preflight deliberately: the actual policy must reject it too.
  const payment = { recipient: p.recipient, amount: '1000000', destination: 'l2', fromL1: '0', epoch: initial.epoch };
  const tx = paymentTransaction(config, payment, BigInt(split.snapshot.safeNonce));
  let error;
  try { await f.rpc(f.network.l2.rpc, 'eth_call', [{ from: f.safeL2, to: p.policy, data: tx.message.data }, 'latest']); } catch (e) { error = e.rpcError; }
  assert(JSON.stringify(error).includes(toFunctionSelector('GlobalLimit()')), 'exact policy GlobalLimit error');
  const approvals = await Promise.all([f.A, f.B].map(async o => ({ owner: o.address, signature: await o.signTypedData(tx) })));
  const sig = await packOwnerApprovals(tx, f.adapter, [f.A.address, f.B.address], 2, approvals);
  const hash = await f.submit(f.network.l2, f.safeL2, encodeSafeExecution(tx, sig));
  const status = await f.until('global-budget source discarded', async () => {
    const status = await f.rpc(f.network.l2.rpc, 'eez_getCrossChainTransaction', [hash]);
    return status?.lifecycle === 'terminal' ? status : false;
  });
  assert.equal(status.ownership.reason, 'PoolDiscarded');
  assert.equal(await f.rpc(f.network.l2.rpc, 'eth_getTransactionReceipt', [hash]), null);
  const trace = await f.until('global-limit rejection reaches policy in Composer', async () => {
    for (const name of readdirSync(f.network.traceDirectory)) {
      if (!name.startsWith(`${hash}-admission_execution-`)) continue;
      let rows; try { rows = readFileSync(resolve(f.network.traceDirectory, name), 'utf8').trim().split('\n').map(JSON.parse); } catch { continue; }
      if (rows.at(-1)?.kind !== 'end') continue;
      assert.equal(rows.at(-1).truncated, false);
      assert(rows.some(r => r.kind === 'step' && r.chain_id === f.network.l2.chainId && r.address?.toLowerCase() === p.policy.toLowerCase() && r.op === 253));
      return name;
    }
  });
  assert.deepEqual(await state(), split.snapshot, 'balances, allowance counters/nonces, Safe nonce, supply and global spending unchanged');
  f.evidence.cases.push({ label: 'Extra 1 rejected by the independent global budget', transaction: hash, safeHash: safeTransactionHash(tx),
    error: 'GlobalLimit()', disposition: status.ownership.reason, compositionTrace: trace, snapshot: split.snapshot });
  f.evidence.paymentChecks = ['40 local', '110 split', 'same L1 transaction receives both legs', 'global rejection despite 50 L2 allowance remaining',
    'actual Composer policy rejection', 'unchanged state on rejection', 'bridge backing', 'no residual policy custody', 'independent follower', 'payment reload recovery'];
  f.checkpoint();
  console.log('Forward sequence passed; waiting for the next natural L1 budget period for the 30 USDC payment and reverse payment');
  const nextEpoch = await f.until('next L1 budget period', async () => {
    const head = await f.rpc(f.network.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
    const epoch = BigInt(head.timestamp) / 600n;
    return epoch > BigInt(initial.epoch) ? String(epoch) : false;
  }, 660);
  await waitText('global-spent', '0'); await waitText('l1-spent', '0'); await waitText('l2-spent', '0');
  const fixedPayment = await approveAndSend('Pay 30 on Ethereum', '30 from Ethereum + 0 from EEZ-X', '30', '30', '0', true, nextEpoch, 'l1', '30');
  assert.equal(fixedPayment.snapshot.balanceL1, '170000000'); assert.equal(fixedPayment.snapshot.balanceL2, '100000000');
  assert.equal(fixedPayment.snapshot.recipientL1, '140000000'); assert.equal(fixedPayment.snapshot.recipientL2, '40000000');
  assert.equal(fixedPayment.snapshot.escrow, '140000000'); assert.equal(fixedPayment.snapshot.supply, fixedPayment.snapshot.escrow);
  assert.equal(fixedPayment.snapshot.policyBalance, '0'); assert.equal(fixedPayment.snapshot.aliasBalance, '0');
  assert.equal(fixedPayment.snapshot.safeNonce, String(BigInt(initial.safeNonce) + 3n));
  const payments = events(fixedPayment.receipt, p.policy, policyArtifact.abi, 'Paid');
  assert.equal(payments.length, 1);
  assert.deepEqual(payments[0], { token: getAddress(p.tokenL1), recipient: getAddress(p.recipient), onL1: true,
    amount: 30_000_000n, fromL1: 30_000_000n, fromL2: 0n, epoch: BigInt(nextEpoch) });
  const fixedPosted = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [fixedPayment.verification.transaction]);
  assert.equal(events(fixedPosted, p.tokenL1, token.abi, 'Transfer').filter(t =>
    t.from.toLowerCase() === f.safeL1.toLowerCase() && t.to.toLowerCase() === p.recipient.toLowerCase() && t.value === 30_000_000n).length, 1);
  await f.until('follower independently replays the fixed payment', async () => {
    const head = await f.rpc(f.network.follower, 'eth_getBlockByNumber', ['safe', false]);
    if (BigInt(head.number) < BigInt(fixedPayment.receipt.blockNumber)) return false;
    const block = await f.rpc(f.network.follower, 'eth_getBlockByNumber', [fixedPayment.receipt.blockNumber, false]);
    assert.equal(block.hash, fixedPayment.receipt.blockHash);
    assert.equal(await f.read(f.network.follower, p.policy, policyArtifact.abi, 'spent', [BigInt(nextEpoch)], fixedPayment.receipt.blockNumber), 30_000_000n);
    assert.equal(await f.read(f.network.follower, f.safeL2, f.safeArtifact.abi, 'nonce', [], fixedPayment.receipt.blockNumber), BigInt(initial.safeNonce) + 3n);
    const receipt = await f.rpc(f.network.follower, 'eth_getTransactionReceipt', [fixedPayment.receipt.transactionHash]);
    assert(receipt); assert.deepEqual(events(receipt, p.policy, policyArtifact.abi, 'Paid'), payments);
    return true;
  });
  f.evidence.paymentChecks.push('fixed 30 USDC payment', 'amount edits invalidate approvals', 'reload recovers exact amount and split',
    'Paid event agrees with exact contributions', 'actual 30 token transfer on L1', 'fixed payment independently replayed');
  f.checkpoint();
  await page.screenshot({ path: resolve(directory, 'treasury-fixed-desktop.png'), fullPage: true });
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  const reverse = await approveAndSend('Split 110 to EEZ-X', '10 from Ethereum + 100 from EEZ-X', '140', '40', '100', true, nextEpoch, 'l2');
  assert.equal(reverse.snapshot.balanceL1, '160000000'); assert.equal(reverse.snapshot.balanceL2, '0');
  assert.equal(reverse.snapshot.recipientL1, '140000000'); assert.equal(reverse.snapshot.recipientL2, '150000000');
  assert.equal(reverse.snapshot.escrow, '150000000'); assert.equal(reverse.snapshot.supply, reverse.snapshot.escrow);
  assert.equal(reverse.snapshot.policyBalance, '0'); assert.equal(reverse.snapshot.aliasBalance, '0');
  assert.equal(reverse.snapshot.aliasApproval, '0'); assert.equal(reverse.snapshot.depositNonce, '1');
  assert.equal(await read('l1', p.bridgeL1, bridge.abi, 'lockedDeposits', [0n]), true);
  const reversePosted = await f.rpc(f.network.l1.rpc, 'eth_getTransactionReceipt', [reverse.verification.transaction]);
  const l1Transfers = events(reversePosted, p.tokenL1, token.abi, 'Transfer');
  for (const [from, to] of [[f.safeL1, p.alias], [p.alias, p.bridgeL1]])
    assert.equal(l1Transfers.filter(t => t.from.toLowerCase() === from.toLowerCase() && t.to.toLowerCase() === to.toLowerCase() && t.value === 10_000_000n).length, 1);
  const approvalsOnL1 = events(reversePosted, p.tokenL1, token.abi, 'Approval');
  assert(approvalsOnL1.some(a => a.owner.toLowerCase() === p.alias.toLowerCase() && a.spender.toLowerCase() === p.bridgeL1.toLowerCase() && a.value === 10_000_000n));
  const locks = events(reversePosted, p.bridgeL1, bridge.abi, 'DepositLocked');
  assert.equal(locks.length, 1); assert.equal(locks[0].nonce, 0n); assert.equal(locks[0].amount, 10_000_000n);
  assert.equal(locks[0].payerAlias.toLowerCase(), p.alias.toLowerCase()); assert.equal(locks[0].recipient.toLowerCase(), p.recipient.toLowerCase());
  const localTransfers = events(reverse.receipt, p.tokenL2, token.abi, 'Transfer');
  for (const [from, amount] of [[f.safeL2, 100_000_000n], [zeroAddress, 10_000_000n]])
    assert.equal(localTransfers.filter(t => t.from.toLowerCase() === from.toLowerCase() && t.to.toLowerCase() === p.recipient.toLowerCase() && t.value === amount).length, 1);
  const mints = events(reverse.receipt, p.bridgeL2, bridge.abi, 'DepositMinted');
  assert.equal(mints.length, 1); assert.equal(mints[0].nonce, 0n); assert.equal(mints[0].amount, locks[0].amount);
  assert.equal(mints[0].payer.toLowerCase(), p.policy.toLowerCase()); assert.equal(mints[0].recipient.toLowerCase(), p.recipient.toLowerCase());
  await f.until('follower replays the lock-backed mint and local contribution', async () => {
    const head = await f.rpc(f.network.follower, 'eth_getBlockByNumber', ['safe', false]);
    if (BigInt(head.number) < BigInt(reverse.receipt.blockNumber)) return false;
    const block = await f.rpc(f.network.follower, 'eth_getBlockByNumber', [reverse.receipt.blockNumber, false]);
    assert.equal(block.hash, reverse.receipt.blockHash);
    for (const [address, abi, name, args, expected] of [
      [p.tokenL2, tokenAbi, 'balanceOf', [f.safeL2], 0n], [p.tokenL2, tokenAbi, 'balanceOf', [p.recipient], 150_000_000n],
      [p.tokenL2, tokenAbi, 'totalSupply', [], 150_000_000n], [p.bridgeL2, bridge.abi, 'nextDepositNonce', [], 1n],
      [p.policy, policyArtifact.abi, 'spent', [BigInt(nextEpoch)], 140_000_000n],
      [p.policy, policyArtifact.abi, 'spent', [BigInt(initial.epoch)], 150_000_000n],
      [f.safeL2, f.safeArtifact.abi, 'nonce', [], BigInt(initial.safeNonce) + 4n]])
      assert.equal(await f.read(f.network.follower, address, abi, name, args, reverse.receipt.blockNumber), expected);
    const allowance = await f.read(f.network.follower, p.moduleL2, module.abi, 'getTokenAllowance', [f.safeL2, p.policy, p.tokenL2], reverse.receipt.blockNumber);
    assert.equal(allowance[1], 100_000_000n);
    return true;
  });
  f.evidence.paymentChecks.push('110 to EEZ-X: 100 local + 10 L1', 'terminal L1 lock in canonical batch', 'exact approval consumed',
    'nonce-bound lock and mint', 'both contributions in the same L2 receipt', 'reverse payment reload recovery', 'natural period reset with idle L2', 'reverse state independently replayed');
  f.checkpoint();
  await page.screenshot({ path: resolve(directory, 'treasury-reverse-desktop.png'), fullPage: true });
  await f.until('completed payment unlocks after live reads', () => ui.getByRole('button', { name: 'Review payment', exact: true }).isEnabled());
  await ui.getByLabel('Payment type', { exact: true }).selectOption('fixed');
  await ui.getByLabel('Recipient chain', { exact: true }).selectOption('l1');
  await ui.getByLabel('Amount (USDC)', { exact: true }).fill('16');
  await ui.getByRole('button', { name: 'Review payment', exact: true }).click();
  await ui.getByRole('alert').filter({ hasText: 'Shared budget exceeded: 10 USDC remains globally' }).waitFor();
  assert.equal(await ui.getByRole('button', { name: 'Submit Safe transaction', exact: true }).count(), 0);
  assert.deepEqual(await state(), reverse.snapshot, 'rejecting a 16-USDC fixed payment does not change treasury state');
  f.evidence.paymentChecks.push('16-USDC fixed payment rejected with only 10 global remaining'); f.checkpoint();
  console.log('Real USDC payment browser sequence passed: 40 / 110 to L1 / rejected 1 / next period fixed 30 / 110 to EEZ-X / fixed budget rejection');
}
