// Browser integration with mocked RPC and selected wallets. No real broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until, RAW_GAS } = require('./bridge-gas-fees.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let scenarios = 0;
  try {
    for (const multipleWallets of [false, true]) for (const erc20 of [false, true]) {
      const f = await fixture(browser, { reverse: true, feesEnabled: true, multipleWallets, erc20 });
      await f.page.getByRole('status').filter({ hasText: 'App fee cap:' }).waitFor();
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'quoted transaction never reached selected wallet');
      const sent = await f.page.evaluate(() => ({ tx: window.walletRequests[0], wallets: window.walletSenders }));
      assert.deepEqual(sent.wallets, [multipleWallets ? 'MetaMask' : 'Rabby']);
      assert.equal(sent.tx.gas, '0x' + RAW_GAS.toString(16));
      assert.equal(BigInt(sent.tx.maxPriorityFeePerGas), 9_000_000_000n);
      assert.equal(BigInt(sent.tx.maxFeePerGas), 9_000_000_007n);
      assert.equal(sent.tx.nonce, '0x0');
      assert.equal(sent.tx.type, '0x2');
      const quotes = f.rpcRequests.filter(r => r.intent);
      assert.equal(quotes.length, 1);
      for (const [field, value] of Object.entries(quotes[0].intent)) assert.equal(sent.tx[field], value);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const options of [{ quoteFailure: true }, { feeCeiling: '1' }]) {
      const f = await fixture(browser, { reverse: true, feesEnabled: true, ...options });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: options.quoteFailure ? 'quote_unavailable' : 'app limit' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({ passed: true, scenarios, realTransactionsBroadcast: 0, selectedWallets: ['Rabby', 'MetaMask'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
