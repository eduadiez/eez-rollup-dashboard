// EEZ_UI_URL=http://127.0.0.1:18777 NODE_PATH=/work/node_modules node tests/bridge-gas-fees.cjs
// Mocked Rabby and RPCs: records the wallet request and never broadcasts it.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:18777').replace(/\/$/, '');
const RAW_GAS = 422319n;
const token = '0x' + '77'.repeat(20);
const recipient = '0x' + '88'.repeat(20);
const bridge = '0x' + '11'.repeat(20);
const account = '0x' + '22'.repeat(20);
const manager = '0x' + '33'.repeat(20);
const encodeString = value => '0x' + (32n).toString(16).padStart(64, '0') + BigInt(Buffer.byteLength(value)).toString(16).padStart(64, '0') + Buffer.from(value).toString('hex').padEnd(Math.ceil(Buffer.byteLength(value) / 32) * 64, '0');
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
  const errors = [], rpcRequests = [];
  const estimation = { unsupported: options.unsupported ?? false, error: options.estimateError ?? null, result: options.estimateResult ?? "0x671af" };
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
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
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
    rpcRequests.push({ path, method, params });
    if (method === 'eth_estimateGas') {
      if (!path.startsWith('/composer/')) return reject('Read RPC must not estimate bridge transactions');
      if (estimation.unsupported) return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:3,message:'execution reverted',data:'0x096aa08200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004f9d330ad00000000000000000000000000000000000000000000000000000000'}}});
      if (estimation.error) return reject(estimation.error);
      return reply(estimation.result);
    }
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === bridge && params[0]?.data.startsWith('0x3e38ac74')) {
      if (options.tokenInfoError) return reject('Token information unavailable');
      return reply('0x' + (options.wrapped ? '6b175474e89094c44da98b954eedeac495271d0f' : '').padStart(64, '0') + '0'.repeat(64));
    }
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === token) {
      if (params[0].data === '0x313ce567') return reply('0x' + '0'.repeat(62) + '12');
      if (params[0].data === '0x95d89b41' && options.symbol) return reply(encodeString(options.symbol));
      if (params[0].data.startsWith('0x70a08231')) return reply('0x' + BigInt(options.balance ?? '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').toString(16).padStart(64, '0'));
      if (params[0].data.startsWith('0xdd62ed3e')) return reply('0x' + BigInt(options.allowance ?? '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').toString(16).padStart(64, '0'));
      return reply('0x');
    }
    if (method === 'eth_call') return reject('execution reverted');
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
  if (options.reverse) await page.getByTitle('Swap direction').click();
  if (options.erc20) {
    await page.getByRole('button', { name: 'ERC20', exact: true }).click();
    await page.getByPlaceholder('0x... (ERC20 token address)', { exact: true }).fill(token);
    await until(async () => (await page.getByPlaceholder('0.0 ' + (options.symbol || '???')).count()) === 1, 'token metadata did not load');
  }
  if (options.destination) {
    await page.getByRole('button', { name: 'Change recipient', exact: true }).click();
    await page.getByLabel('Recipient address', { exact: true }).fill(options.destination);
  }
  await page.getByPlaceholder(options.erc20 ? '0.0 ' + (options.symbol || '???') : '0.0 ETH', { exact: true }).fill(options.amount || '0.001');
  const button = page.getByRole('button', { name: options.erc20 ? 'Teleport ' + (options.symbol || '???') : 'Teleport ETH', exact: true });
  if (options.tokenInfoError) await page.getByText('Unable to check the token:', {exact:false}).waitFor();
  else if (options.approvalRequired) await page.getByRole('button', {name:'Approve ' + (options.symbol || '???'),exact:true}).waitFor();
  else if (options.unsupported) await page.getByText('This Composer cannot estimate cross-chain gas yet.', {exact:false}).waitFor();
  else if (options.estimateError || options.estimateResult) await page.getByRole('alert').filter({ hasText: 'Gas estimation failed:' }).waitFor();
  else await until(async () => !(await button.isDisabled()), 'Composer estimate or bridge readiness did not finish');
  return { context, page, button, errors, rpcRequests, estimation };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    let scenarios = 0;
    for (const reverse of [false, true]) for (const erc20 of [false, true]) for (const custom of [null, 500000]) {
      const f = await fixture(browser, { reverse, erc20, destination: recipient });
      const row = f.page.getByText('Estimated gas', { exact: true }).locator('..');
      const displayed = (await row.locator('span').last().textContent()).replace(/,/g, '');
      assert.equal(displayed, String(RAW_GAS), 'Composer gas must be displayed without a 1.3x buffer');
      assert.equal(await f.page.getByText('Requested gas limit (1.3x estimate)', { exact: true }).count(), 0);
      if (custom) await f.page.getByPlaceholder('422,319', { exact: true }).fill(String(custom));
      const estimates = f.rpcRequests.filter(r => r.method === 'eth_estimateGas');
      assert.ok(estimates.length > 0);
      assert.ok(estimates.every(r => r.path === (reverse ? '/composer/l2' : '/composer/l1')));
      assert.ok(estimates.every(r => Object.keys(r.params[0]).sort().join(',') === 'data,from,to,value'), 'no gas cap or fee fields on estimates');
      await f.button.click();
      await until(async () => (await f.page.evaluate(() => window.walletRequests.length)) === 1, 'wallet did not receive bridge');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      const record = await f.page.evaluate(() => JSON.parse(localStorage.getItem('txHistory'))[0]);
      assert.equal(record.type, 'bridge');
      assert.equal(record.direction, reverse ? 'l2-to-l1' : 'l1-to-l2');
      assert.equal(BigInt(tx.gas), custom ? BigInt(custom) : RAW_GAS);
      assert.equal(tx.gasLimit, tx.gas);
      assert.equal(tx.type, '0x2');
      assert.equal(BigInt(tx.maxPriorityFeePerGas), 1_000_000_000n);
      assert.equal(BigInt(tx.maxFeePerGas), 1_000_000_014n);
      assert.equal(tx.gasPrice, undefined);
      assert.equal(tx.to.toLowerCase(), bridge);
      const request = estimates.at(-1).params[0];
      for (const field of ['from', 'to', 'data', 'value']) assert.equal(tx[field], request[field], field + ' must match estimation');
      assert.equal(tx.from, account);
      assert.equal(tx.data.slice(-64), recipient.slice(2).padStart(64, '0'));
      const destinationRollup = (reverse ? '0' : '1').padStart(64, '0');
      assert.equal(tx.data.slice(erc20 ? 138 : 10, erc20 ? 202 : 74), destinationRollup);
      assert.equal(tx.value, erc20 ? '0x0' : '0x38d7ea4c68000');
      assert.deepEqual(f.errors, []);
      await f.context.close(); scenarios++;
    }
    // Failure cannot be bypassed by a manual override. Changing inputs retries
    // without reusing the old gas cap, and a valid new estimate unblocks sending.
    for (const reverse of [false, true]) {
      const f = await fixture(browser, { reverse, estimateError: 'Composer simulation failed' });
      assert.equal(await f.button.isDisabled(), true);
      await f.page.getByPlaceholder('Enter gas limit', { exact: true }).fill('500000');
      assert.equal(await f.button.isDisabled(), true, 'override must not bypass failed estimation');
      await f.button.evaluate(button => { button.click(); });
      await f.page.getByText('Composer simulation failed', { exact: false }).first().waitFor();
      assert.deepEqual(await f.page.evaluate(() => window.walletRequests), []);
      const amount = f.page.getByPlaceholder('0.0 ETH', { exact: true });
      f.estimation.error = null;
      await amount.fill('0.002');
      await until(() => f.button.isEnabled(), 'valid Composer estimate did not unblock retry');
      assert.ok(f.rpcRequests.filter(r => r.method === 'eth_estimateGas').every(r => !r.params[0].gas && !r.params[0].gasLimit));
      await f.button.click();
      await until(async () => (await f.page.evaluate(() => window.walletRequests.length)) === 1, 'retry was not submitted');
      assert.equal((await f.page.evaluate(() => window.walletRequests[0])).gas, '0x7a120', 'manual override must survive retry');
      assert.deepEqual(f.errors, []);await f.context.close(); scenarios++;
    }
    for (const estimateResult of ['0x0', 'not-a-quantity']) {
      const f = await fixture(browser, { estimateResult });
      assert.equal(await f.button.isDisabled(), true);
      assert.deepEqual(await f.page.evaluate(() => window.walletRequests), []);
      assert.deepEqual(f.errors, []);await f.context.close();scenarios++;
    }
    // A prior successful estimate is invalid as soon as the inputs change.
    for (const reverse of [false, true]) {
      const f = await fixture(browser, { reverse });
      f.estimation.error = 'Updated bridge transaction cannot be estimated';
      await f.page.getByPlaceholder('0.0 ETH', { exact: true }).fill('0.003');
      await until(() => f.button.isDisabled(), 'changed transaction should disable the bridge');
      await f.page.getByRole('alert').waitFor();
      await f.button.evaluate(button => { button.click(); });
      assert.deepEqual(await f.page.evaluate(() => window.walletRequests), [], 'old successful estimate must not be submitted');
      assert.deepEqual(f.errors, []);await f.context.close();scenarios++;
    }
    // Wrapped DAI is burned by the bridge: zero ERC20 allowance must not block withdrawal.
    for (const unsupported of [false, true]) {
      const f = await fixture(browser, {reverse:true, erc20:true, wrapped:true, symbol:'DAI', amount:'1', balance:10n ** 18n, allowance:0n, unsupported});
      assert.equal(await f.page.getByRole('button',{name:'Approve DAI',exact:true}).count(),0);
      assert.equal(f.rpcRequests.filter(r=>r.method==='eth_call' && r.params[0]?.data.startsWith('0xdd62ed3e')).length,0,'wrapped withdrawals must not query allowance');
      if (unsupported) {
        assert.equal(await f.button.isDisabled(),true,'no automatic gas fallback when Composer lacks execution context');
        await f.page.getByPlaceholder('Enter gas limit',{exact:true}).fill('500000');
        await until(()=>f.button.isEnabled(),'explicit manual gas did not unblock unsupported Composer');
      }
      await f.button.click();
      await until(async()=> (await f.page.evaluate(()=>window.walletRequests.length))===1,'DAI withdrawal was not passed to the mock wallet');
      const tx = await f.page.evaluate(()=>window.walletRequests[0]);
      assert.equal(tx.gas,unsupported?'0x7a120':'0x671af');assert.equal(tx.gasLimit,tx.gas);
      assert.equal(BigInt('0x'+tx.data.slice(74,138)),10n ** 18n);
      assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
    }
    const native = await fixture(browser,{reverse:true,erc20:true,symbol:'DAI',allowance:0n,approvalRequired:true});
    assert.equal(await native.button.isDisabled(),true,'native token still requires approval');
    assert.equal(await native.page.getByRole('button',{name:'Approve DAI',exact:true}).count(),1);
    assert.deepEqual(await native.page.evaluate(()=>window.walletRequests),[]);await native.context.close();scenarios++;
    const tokenError = await fixture(browser,{reverse:true,erc20:true,tokenInfoError:true});
    assert.equal(await tokenError.button.isDisabled(),true,'unknown token origin must never be guessed');
    assert.deepEqual(await tokenError.page.evaluate(()=>window.walletRequests),[]);await tokenError.context.close();scenarios++;
    const metamask = await fixture(browser, { multipleWallets: true });
    await metamask.button.click();
    await until(async () => (await metamask.page.evaluate(() => window.walletSenders.length)) === 1,
      'MetaMask did not receive the bridge request');
    const metamaskTx = await metamask.page.evaluate(() => window.walletRequests[0]);
    assert.equal(BigInt(metamaskTx.gas), RAW_GAS);
    assert.equal(metamaskTx.gasLimit, metamaskTx.gas);
    assert.equal(metamaskTx.type, '0x2');
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
    console.log(JSON.stringify({ passed: true, scenarios: scenarios + 2, composerOnly: true, rawGas: String(RAW_GAS), bothDirectionsAndAssets: true, manualOverrides: true, failedEstimatesBlockSubmission: true, staleEstimatesBlocked: true, selectedMetaMask: true, type2FeesUnchanged: true, realTransactionsBroadcast: 0 }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
