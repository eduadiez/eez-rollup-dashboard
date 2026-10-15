// Browser integration with mocked RPC and selected wallets. No real broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until, RAW_GAS } = require('./bridge-gas-fees.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let scenarios = 0;
  try {
    for (const multipleWallets of [false, true]) for (const erc20 of [false, true]) for (const walletNonce of ['0x0', '0x00', 0]) {
      const f = await fixture(browser, { reverse: true, feesEnabled: true, multipleWallets, erc20, walletNonce });
      await f.page.getByRole('status').filter({ hasText: 'App fee cap:' }).waitFor();
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'quoted transaction never reached selected wallet');
      const sent = await f.page.evaluate(() => ({ tx: window.walletRequests[0], wallets: window.walletSenders }));
      assert.deepEqual(sent.wallets, [multipleWallets ? 'MetaMask' : 'Rabby']);
      assert.equal(sent.tx.gas, '0x' + RAW_GAS.toString(16));
      if (multipleWallets) {
        assert.equal(BigInt(sent.tx.maxPriorityFeePerGas), 9_000_000_000n);
        assert.equal(BigInt(sent.tx.maxFeePerGas), 9_000_000_007n);
        assert.equal(sent.tx.gasPrice, undefined);
      } else {
        assert.equal(BigInt(sent.tx.gasPrice), 9_000_000_007n);
        assert.equal(sent.tx.maxFeePerGas, undefined);
        assert.equal(sent.tx.maxPriorityFeePerGas, undefined);
      }
      assert.equal(sent.tx.nonce, '0x0');
      assert.equal(sent.tx.type, multipleWallets ? '0x2' : '0x0');
      const quotes = f.rpcRequests.filter(r => r.transaction);
      assert.equal(quotes.length, 1);
      for (const [field, value] of Object.entries(quotes[0].transaction)) assert.equal(sent.tx[field], value);
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
    for (const walletNonce of [1, '0x01']) {
      const f = await fixture(browser, { reverse: true, feesEnabled: true, multipleWallets: true, walletNonce });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Wallet nonce changed' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({ passed: true, scenarios, realTransactionsBroadcast: 0, selectedWallets: ['Rabby', 'MetaMask'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
