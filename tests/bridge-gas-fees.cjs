// EEZ_UI_URL=http://127.0.0.1:18777 NODE_PATH=/work/node_modules node tests/bridge-gas-fees.cjs
// Mocked Rabby and RPCs: records the wallet request and never broadcasts it.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const origin = process.env.EEZ_UI_URL || 'http://127.0.0.1:18777';
const bridge = '0x' + '11'.repeat(20);
const account = '0x' + '22'.repeat(20);
const manager = '0x' + '33'.repeat(20);
const receiptHash = '0x' + '44'.repeat(32);

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ account, receiptHash, multipleWallets }) => {
    window.walletRequests = [];
    window.walletSenders = [];
    const provider = name => ({
      isRabby: name === 'Rabby', isMetaMask: name === 'MetaMask',
      on() {}, removeListener() {},
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0x27d8';
        if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_sendTransaction') {
          window.walletSenders.push(name);
          window.walletRequests.push(params[0]);
          return receiptHash;
        }
        throw new Error('Unexpected wallet method: ' + method);
      },
    });
    window.ethereum = provider('Rabby');
    if (multipleWallets) {
      const metamask = provider('MetaMask');
      const announce = (name, uuid, rdns, selected) => window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: { info: { name, uuid, rdns }, provider: selected },
        }),
      );
      window.addEventListener('eip6963:requestProvider', () => {
        announce('Rabby', 'rabby-provider', 'io.rabby', window.ethereum);
        announce('MetaMask', 'metamask-provider', 'io.metamask', metamask);
      });
    }
  }, { account, receiptHash, multipleWallets: options.multipleWallets });
  await page.route('**/*', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/config.json') return route.fulfill({ json: {
      l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
      demoBridgeAddress: bridge, rollupId: '1',
    } });
    if (path === '/shared/rollup.env' || path === '/shared/faucet.key') {
      return route.fulfill({ status: 404, body: '' });
    }
    if (request.method() !== 'POST') return route.continue();
    const { method, params = [], id } = request.postDataJSON();
    const reply = result => route.fulfill({ json: { jsonrpc: '2.0', id, result } });
    const reject = message => route.fulfill({ json: {
      jsonrpc: '2.0', id, error: { code: 3, message },
    } });
    if (/send|sign/i.test(method)) throw new Error('Unexpected broadcast RPC: ' + method);
    if (method === 'eth_chainId') return reply(path.endsWith('l2') ? '0x1892' : '0x27d8');
    if (method === 'eth_getCode') return reply(params[0]?.toLowerCase() === bridge ? '0x6000' : '0x');
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === bridge
        && params[0]?.data === '0x481c6a75') {
      return reply('0x' + '0'.repeat(24) + manager.slice(2));
    }
    if (method === 'eth_estimateGas' || method === 'eth_call') return reject('execution reverted');
    if (method === 'eth_getBalance') return reply('0x3635c9adc5dea00000');
    if (method === 'eth_getBlockByNumber') return reply({
      number: '0x10', hash: '0x' + '55'.repeat(32),
      parentHash: '0x' + '66'.repeat(32), timestamp: '0x65000000',
      gasUsed: '0x0', gasLimit: '0x1c9c380',
      ...(options.noBaseFee ? {} : { baseFeePerGas: '0x7' }), transactions: [],
    });
    if (method === 'eth_gasPrice') return reply('0x3b9aca00');
    if (method === 'eth_maxPriorityFeePerGas') return reply('0x3b9aca00');
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return reply(null);
    if (method === 'eth_getLogs') return reply([]);
    return reply('0x0');
  });
  await page.goto(origin + '/#/bridge');
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', {
    name: options.multipleWallets ? 'MetaMask' : 'Rabby', exact: true,
  }).first().click();
  await page.getByPlaceholder('0.0 ETH', { exact: true }).fill('0.001');
  const button = page.getByRole('button', { name: 'Bridge ETH', exact: true });
  await until(async () => !(await button.isDisabled()), 'gas suggestion or bridge readiness did not finish');
  await page.getByRole('button', { name: 'Advanced Gas Settings' }).click();
  return { context, page, button, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const custom of [null, 400000]) {
      const f = await fixture(browser);
      const row = f.page.getByText('Requested gas limit (1.3x estimate)').locator('..');
      const displayed = (await row.locator('span').last().textContent()).replace(/,/g, '');
      assert.equal(displayed, '369943', '263K overhead must request about 370K after its 1.3x buffer');
      if (custom) {
        await f.page.getByPlaceholder('369,943').fill(String(custom));
      }
      await f.button.click();
      await until(async () => (await f.page.evaluate(() => window.walletRequests.length)) === 1,
        'Rabby did not receive the bridge request');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      assert.equal(BigInt(tx.gas), BigInt(custom || displayed));
      assert.equal(tx.gasLimit, tx.gas);
      assert.equal(tx.type, '0x2');
      assert.equal(BigInt(tx.maxPriorityFeePerGas), 1_000_000_000n);
      assert.equal(BigInt(tx.maxFeePerGas), 1_000_000_014n);
      assert.equal(tx.gasPrice, undefined);
      assert.equal(tx.to.toLowerCase(), bridge);
      assert.deepEqual(f.errors, []);
      await f.context.close();
    }
    const metamask = await fixture(browser, { multipleWallets: true });
    await metamask.button.click();
    await until(async () => (await metamask.page.evaluate(() => window.walletSenders.length)) === 1,
      'MetaMask did not receive the bridge request');
    assert.deepEqual(await metamask.page.evaluate(() => window.walletSenders), ['MetaMask'],
      'the selected MetaMask provider must handle the transaction, not window.ethereum');
    await metamask.page.getByRole('button', { name: /MetaMask ·/ }).click();
    await metamask.page.getByRole('button', { name: 'Switch to Rabby' }).click();
    await metamask.page.getByRole('button', { name: /Rabby ·/ }).waitFor();
    assert.deepEqual(metamask.errors, []);
    await metamask.context.close();
    const unsupported = await fixture(browser, { noBaseFee: true });
    await unsupported.button.click();
    await unsupported.page.getByText('Source chain did not provide an EIP-1559 base fee',
      { exact: false }).waitFor();
    assert.deepEqual(await unsupported.page.evaluate(() => window.walletRequests), [],
      'unsupported fee market must not submit a legacy transaction');
    assert.deepEqual(unsupported.errors, []);
    await unsupported.context.close();
    console.log('Pass: gas and type-2 fields reach the selected wallet, including MetaMask with Rabby installed; no broadcast');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
