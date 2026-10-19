// Browser integration with mocked RPC and selected wallets. No real broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until, RAW_GAS, token } = require('./bridge-gas-fees.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let scenarios = 0;
  try {
    for (const reverse of [false, true]) for (const multipleWallets of [false, true]) for (const erc20 of [false, true]) for (const walletNonce of ['0x0', '0x00', 0]) {
      const f = await fixture(browser, { reverse, feesEnabled: true, multipleWallets, erc20, walletNonce });
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
      assert.equal(quotes[0].path, reverse ? '/composer/l2' : '/composer/l1');
      assert.equal(sent.tx.chainId, reverse ? '0x1892' : '0x27d8');
      for (const [field, value] of Object.entries(quotes[0].transaction)) assert.equal(sent.tx[field], value);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const erc20 of [false, true]) {
      const f = await fixture(browser, { chain: '0x1', l2Chain: '0xaa29e', reverse, erc20, feesEnabled: true });
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'mainnet Rabby bridge did not reach wallet');
      const sent = await f.page.evaluate(() => ({ tx: window.walletRequests[0], wallets: window.walletSenders }));
      assert.deepEqual(sent.wallets, ['Rabby']);
      assert.equal(sent.tx.chainId, reverse ? '0xaa29e' : '0x1');
      assert.equal(sent.tx.type, reverse ? '0x0' : '0x2');
      assert.equal(sent.tx.gas, '0x' + RAW_GAS.toString(16));
      if (reverse) {
        assert.equal(BigInt(sent.tx.gasPrice), 9_000_000_007n);
        assert.equal(sent.tx.maxFeePerGas, undefined);
        assert.equal(sent.tx.maxPriorityFeePerGas, undefined);
      } else {
        assert.equal(BigInt(sent.tx.maxPriorityFeePerGas), 9_000_000_000n);
        assert.equal(BigInt(sent.tx.maxFeePerGas), 9_000_000_007n);
        assert.equal(sent.tx.gasPrice, undefined);
      }
      const quotes = f.rpcRequests.filter(r => r.transaction);
      assert.equal(quotes.length, 1);
      assert.equal(quotes[0].path, reverse ? '/composer/l2' : '/composer/l1');
      for (const [field, value] of Object.entries(quotes[0].transaction)) assert.equal(sent.tx[field], value);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const options of [{ quoteFailure: true }, { feeCeiling: '1' }]) {
      const f = await fixture(browser, { reverse, feesEnabled: true, ...options });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: options.quoteFailure ? 'quote_unavailable' : 'app limit' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) for (const walletNonce of [1, '0x01']) {
      const f = await fixture(browser, { reverse, feesEnabled: true, multipleWallets: true, walletNonce });
      await f.button.click();
      await f.page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Wallet nonce changed' }).waitFor();
      assert.equal(await f.page.evaluate(() => window.walletRequests.length), 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      // Enabling one direction must not enable fees on the other chain.
      const f = await fixture(browser, { reverse, l1FeesEnabled: reverse, l2FeesEnabled: !reverse });
      assert.equal(await f.page.getByRole('status').filter({ hasText: 'App fee cap:' }).count(), 0);
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'disabled direction did not submit');
      assert.equal(f.rpcRequests.filter(r => r.transaction).length, 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      const caps = reverse ? {l1FeeCeiling:'1'} : {l2FeeCeiling:'1'};
      const f = await fixture(browser, { reverse, l1FeesEnabled:true, l2FeesEnabled:true, ...caps });
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'other chain fee cap incorrectly blocked signing');
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      const f = await fixture(browser, { reverse, feesEnabled:true, nativeBalance:'1000000000000000000' });
      await f.page.getByRole('button', {name:'MAX',exact:true}).click();
      await until(async () => await f.page.getByLabel('Bridge amount',{exact:true}).inputValue() === '0.9', 'MAX must reserve source fee cap');
      await until(() => f.button.isEnabled(), 'MAX amount did not get a fresh estimate');
      await f.button.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'MAX did not submit');
      assert.equal(BigInt((await f.page.evaluate(() => window.walletRequests[0])).value), 900000000000000000n);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    for (const reverse of [false, true]) {
      // An ERC-20 approval remains an ordinary source-chain transaction.
      const f = await fixture(browser, { reverse, feesEnabled:true, erc20:true, allowance:'0', approvalRequired:true });
      await f.page.getByRole('button', {name:'Approve ???',exact:true}).click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1), 'token approval did not submit');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(tx.to, token);
      assert.ok(tx.data.startsWith('0x095ea7b3'));
      assert.equal(f.rpcRequests.filter(r => r.transaction).length, 0);
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({ passed: true, scenarios, realTransactionsBroadcast: 0, selectedWallets: ['Rabby', 'MetaMask'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
