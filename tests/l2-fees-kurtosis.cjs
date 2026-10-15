// Real browser-to-settlement exercise on disposable Kurtosis chains only.
// The injected EIP-1193 adapter signs a fixture key; it is not a wallet extension.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { chromium } = require('playwright');

const required = name => { assert(process.env[name], `${name} is required`); return process.env[name]; };
const base = required('EEZ_UI_URL').replace(/\/$/, '');
const l1 = required('EEZ_DEVNET_L1_RPC');
const l2 = required('EEZ_DEVNET_L2_RPC');
const front = required('EEZ_DEVNET_L2_FRONT');
const key = required('EEZ_TEST_FEE_KEY');
const output = required('EEZ_UI_FEE_EVIDENCE_FILE');
const fixture = JSON.parse(readFileSync(required('EEZ_FEE_EVIDENCE_FILE'), 'utf8')).sources[0];
let id = 0;
function cast(...args) {
  try { return execFileSync('cast', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`cast ${args[0]} failed`); }
}
async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}
async function until(label, check) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  assert.equal(BigInt(await rpc(l1, 'eth_chainId')), 7331n, 'private Kurtosis L1 only');
  assert.equal(BigInt(await rpc(l2, 'eth_chainId')), 696990n, 'private Kurtosis L2 only');
  const account = cast('wallet', 'address', '--private-key', key);
  assert(BigInt(await rpc(l2, 'eth_getBalance', [account, 'latest'])) > 10n ** 17n, 'fixture must be funded');
  const data = cast('calldata', 'setValue(uint256)', '991');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const quotes = [], sends = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && request.postDataJSON()?.method === 'eez_quoteL2ToL1Fee') {
      quotes.push(response.json().then(value => value.result));
    }
  });
  let chain = '0xaa29e';
  assert.equal(BigInt(chain), 696990n);
  await page.exposeBinding('fixtureWalletRequest', async (_source, { method, params = [] }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_addEthereumChain') return null;
    if (method === 'wallet_switchEthereumChain') {
      assert.equal(BigInt(params[0].chainId), 696990n);
      chain = params[0].chainId;
      return null;
    }
    if (method === 'eth_sendTransaction') {
      assert.equal(sends.length, 0, 'one wallet signing request');
      const tx = params[0];
      assert.equal(tx.from.toLowerCase(), account.toLowerCase());
      assert.equal(tx.to.toLowerCase(), fixture.proxy.toLowerCase());
      assert.equal(tx.data, data);
      assert.equal(BigInt(tx.chainId), 696990n);
      assert.equal(BigInt(tx.type), 2n);
      assert.equal(BigInt(tx.value), 0n);
      assert(BigInt(tx.maxPriorityFeePerGas) > 0n);
      const raw = cast('mktx', '--private-key', key, '--chain', '696990',
        '--nonce', String(BigInt(tx.nonce)), '--gas-limit', String(BigInt(tx.gas)),
        '--gas-price', String(BigInt(tx.maxFeePerGas)), '--priority-gas-price', String(BigInt(tx.maxPriorityFeePerGas)),
        '--value', '0', tx.to, tx.data);
      sends.push({ transaction: tx });
      const hash = await rpc(front, 'eth_sendRawTransaction', [raw]);
      sends[0].hash = hash;
      return hash;
    }
    assert(/^eth_(get|call|estimate|maxPriority|gasPrice)/.test(method), `unexpected wallet method ${method}`);
    return rpc(front, method, params);
  });
  await page.addInitScript(({ account, fixture }) => {
    localStorage.setItem('crossChainProxiesL2', JSON.stringify({ [fixture.target.toLowerCase()]: fixture.proxy }));
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
      request: request => window.fixtureWalletRequest(request), selectedAddress: account };
  }, { account, fixture });
  try {
    await page.goto(`${base}/#/bridge`);
    await page.getByRole('status').filter({ hasText: 'App fee cap:' }).waitFor();
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('button', { name: 'MetaMask', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Cross-chain contracts', exact: true });
    await panel.getByRole('button', { name: `Select proxy for ${fixture.target.toLowerCase()} on L2`, exact: true }).click();
    await panel.getByLabel('Calldata', { exact: true }).fill(data);
    await panel.getByRole('button', { name: 'Send Cross-Chain Transaction', exact: true }).click();
    await until('signed transaction', async () => {
      const failure = await page.getByRole('dialog').getByRole('alert').allTextContents();
      assert(!failure.length, failure.join('\n'));
      return sends[0]?.hash;
    });
    assert.equal(quotes.length, 1);
    const quote = await quotes[0];
    for (const [field, value] of Object.entries(quote.transaction)) assert.equal(sends[0].transaction[field], value, field);
    const hash = sends[0].hash;
    const { receipt, settlement, block } = await until('canonical receipt and correlation', async () => {
      const receipt = await rpc(l2, 'eth_getTransactionReceipt', [hash]);
      if (!receipt) return null;
      const block = await rpc(l2, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (block?.hash !== receipt.blockHash) return null;
      const result = await rpc(front, 'eez_getSettlementByL2Block', [receipt.blockHash]);
      return result?.canonicalL2 ? { receipt, block, settlement: result } : null;
    });
    assert.equal(receipt.status, '0x1');
    await until('L1 target update', async () => BigInt(await rpc(l1, 'eth_call', [{ to: fixture.target, data: cast('calldata', 'value()') }, 'latest'])) === 991n);
    const tip = BigInt(receipt.gasUsed) * (BigInt(receipt.effectiveGasPrice) - BigInt(block.baseFeePerGas));
    assert(tip >= BigInt(quote.estimate.requiredL2Tip));
    assert.equal(block.miner.toLowerCase(), quote.policy.assumptions.beneficiary.toLowerCase());
    assert.equal((await rpc(l2, 'eth_getBlockByNumber', [receipt.blockNumber, false])).hash, receipt.blockHash);
    const post = await rpc(l1, 'eth_getTransactionReceipt', [settlement.l1TransactionHash]);
    assert.equal(post.status, '0x1'); assert.equal(post.type, '0x3'); assert(BigInt(post.blobGasUsed) > 0n);
    assert.equal((await rpc(l1, 'eth_getBlockByNumber', [post.blockNumber, false])).hash, post.blockHash);
    assert.deepEqual(errors, []);
    await page.getByRole('dialog').getByRole('heading', { name: 'Cross-chain call confirmed', exact: true }).waitFor();
    await page.screenshot({ path: `${output}.png`, fullPage: true });
    writeFileSync(output, JSON.stringify({ verified: true, wallet: 'injected fixture adapter', realTransactions: 1,
      hash, quote, transaction: sends[0].transaction, receipt, settlement, post, grossL2Tip: String(tip), target: fixture.target, expected: 991 }, null, 2) + '\n');
    console.log(JSON.stringify({ verified: true, hash, l1Posting: settlement.l1TransactionHash, grossL2Tip: String(tip) }));
  } catch (error) {
    await page.screenshot({ path: `${output}.failure.png`, fullPage: true });
    writeFileSync(`${output}.failure.json`, JSON.stringify({ error: error.message, sends, quotes: await Promise.all(quotes), errors }, null, 2) + '\n');
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
