// Run against a production preview. All RPCs are mocked; never signs or broadcasts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const visibilityKey = 'eez:treasury-demo:visible';
const shortcut = 'Control+Alt+Shift+KeyT';

async function fixture(browser, blockedStorage = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const errors = [], methods = [], chunks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/TreasuryDemo-[^/]+\.js$/.test(request.url())) chunks.push(request.url()); });
  await page.clock.install();
  if (blockedStorage) await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  });
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/config.json')) return route.fulfill({ json: {
      networkName: 'EEZ-X Devnet', l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2',
      l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
    } });
    if (request.method() !== 'POST') return route.continue();
    const { id, method } = request.postDataJSON();
    methods.push(method);
    const result = method === 'eth_chainId' ? (path.endsWith('l1') ? '0x27d8' : '0x1892')
      : method === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x65000000', gasUsed: '0x0', gasLimit: '0x1036640', transactions: [] }
      : method === 'eth_getLogs' ? [] : method === 'eth_getBalance' ? '0x0' : null;
    return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
  });
  const treasury = page.getByRole('region', { name: 'Treasury demo preview', exact: true });
  const tab = page.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: 'Treasury Demo', exact: true });
  const budget = treasury.getByRole('region', { name: 'Shared budget', exact: true });
  const holdings = treasury.getByRole('region', { name: 'Combined holdings', exact: true });
  const toggle = async (keys = shortcut) => { await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press(keys); };
  const hidden = async () => {
    assert.equal(await tab.count(), 0);
    assert.equal(await treasury.count(), 0);
  };
  const close = async () => {
    assert.deepEqual(errors, []);
    assert.ok(methods.every(method => !/send|sign/i.test(method)), 'preview never sends or signs a transaction');
    await context.close();
  };
  return { page, context, treasury, tab, budget, holdings, toggle, hidden, close, chunks };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const f = await fixture(browser);
    await f.page.goto(origin + '/#/treasury-demo');
    await f.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await f.hidden();
    assert.equal(f.chunks.length, 0, 'hidden example is not loaded by a direct link');
    await f.page.evaluate(() => { location.hash = '#/counter-demo'; });
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.page.evaluate(() => { location.hash = '#/treasury-demo'; });
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    await f.toggle();
    await f.treasury.waitFor();
    assert.equal(await f.tab.getAttribute('aria-current'), 'page');
    assert.ok(f.chunks.length > 0);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), visibilityKey), '1');
    assert.equal(await f.page.evaluate(key => localStorage.getItem(key), visibilityKey), null);
    assert.equal(await f.page.getByRole('region', { name: 'Transaction history', exact: true }).count(), 0);
    await f.holdings.getByText('450 USDC', { exact: true }).waitFor();
    await f.budget.getByText('150 USDC', { exact: true }).waitFor();

    // Reload keeps visibility, but not fabricated balances or approvals.
    await f.page.reload();
    await f.treasury.waitFor();
    await f.page.getByLabel('Amount (USDC)', { exact: true }).focus();
    await f.page.keyboard.press(shortcut);
    assert.ok(await f.treasury.isVisible(), 'shortcut does not fire in editable fields');
    await f.page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', ctrlKey: true, altKey: true, shiftKey: true, repeat: true, bubbles: true })));
    assert.ok(await f.treasury.isVisible(), 'held shortcut does not toggle repeatedly');
    await f.page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', ctrlKey: true, altKey: true, shiftKey: true, isComposing: true, bubbles: true })));
    assert.ok(await f.treasury.isVisible(), 'IME composition does not toggle visibility');

    // Editing a reviewed payment cannot retain its approvals.
    await f.treasury.getByRole('button', { name: 'Review payment', exact: true }).click();
    const settle = f.treasury.getByRole('button', { name: 'Simulate settlement', exact: true });
    assert.ok(await settle.isDisabled());
    await f.treasury.getByRole('button', { name: 'Simulate B approval', exact: true }).click();
    assert.ok(await settle.isDisabled());
    assert.ok(await f.page.getByLabel('Amount (USDC)', { exact: true }).isDisabled());
    await f.treasury.getByRole('button', { name: 'Edit payment', exact: true }).click();
    await f.treasury.getByText('0 of 2 simulated approvals', { exact: true }).waitFor();
    for (const invalid of ['0', '-1', '1e2', '0.0000001']) {
      await f.page.getByLabel('Amount (USDC)', { exact: true }).fill(invalid);
      assert.ok(await f.treasury.getByRole('button', { name: 'Review payment', exact: true }).isDisabled());
    }

    const simulate = async (preset, before, after) => {
      if (preset) await f.treasury.getByRole('button', { name: preset, exact: true }).click();
      await f.treasury.getByRole('button', { name: 'Review payment', exact: true }).click();
      await f.treasury.getByRole('button', { name: 'Simulate B approval', exact: true }).click();
      await f.treasury.getByRole('button', { name: 'Simulate C approval', exact: true }).click();
      await settle.click();
      await f.treasury.getByText('Simulating settlement… Balances and budgets have not changed yet.', { exact: true }).waitFor();
      await f.holdings.getByText(before + ' USDC', { exact: true }).waitFor();
      await f.page.clock.fastForward(700);
      await f.holdings.getByText(after + ' USDC', { exact: true }).waitFor();
    };
    await simulate('Pay 40 on EEZ-X', 450, 410);
    await f.budget.getByText('110 USDC', { exact: true }).waitFor();
    await f.treasury.getByRole('button', { name: 'Split 110 to Ethereum', exact: true }).click();
    const route = f.treasury.locator('[aria-label="Funding preview"]');
    assert.match(await route.innerText(), /100 USDC from Ethereum · local/);
    assert.match(await route.innerText(), /10 USDC from EEZ-X · bridged/);
    await simulate('Split 110 to Ethereum', 410, 300);
    await f.budget.getByText('0 USDC', { exact: true }).waitFor();
    assert.equal(await f.treasury.getByRole('region', { name: 'Simulated payment history' }).getByRole('listitem').count(), 2);
    await f.treasury.getByRole('button', { name: 'Try another 1', exact: true }).click();
    await f.treasury.getByRole('alert').getByText('Shared budget exhausted. EEZ-X still has 50 USDC of allowance remaining.', { exact: true }).waitFor();
    assert.ok(await f.treasury.getByRole('button', { name: 'Review payment', exact: true }).isDisabled());
    await f.holdings.getByText('300 USDC', { exact: true }).waitFor();

    // Reversing the recipient chain reverses the local/bridged contributions.
    await f.treasury.getByRole('button', { name: 'Reset simulation', exact: true }).click();
    await f.page.getByLabel('Amount (USDC)', { exact: true }).fill('110');
    assert.match(await route.innerText(), /100 USDC from EEZ-X · local/);
    assert.match(await route.innerText(), /10 USDC from Ethereum · bridged/);
    for (const width of [1440, 800, 390, 320]) {
      await f.page.setViewportSize({ width, height: 1100 });
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
      if (process.env.EEZ_UI_SCREENSHOT_DIR && [1440, 390].includes(width)) {
        await f.page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
        await f.page.screenshot({ path: `${process.env.EEZ_UI_SCREENSHOT_DIR}/treasury-${width}.png`, fullPage: true });
      }
    }
    await simulate(null, 450, 340);
    await f.budget.getByText('40 USDC', { exact: true }).waitFor();
    await f.treasury.getByRole('region', { name: 'Ethereum Safe', exact: true }).getByText('290 USDC', { exact: true }).waitFor();
    await f.treasury.getByRole('region', { name: 'EEZ-X Safe', exact: true }).getByText('50 USDC', { exact: true }).waitFor();
    await f.toggle();
    await f.page.getByRole('region', { name: 'Counter demo', exact: true }).waitFor();
    await f.hidden();
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), visibilityKey), null);
    await f.page.goBack();
    await f.page.getByRole('region', { name: 'Bridge transfers' }).waitFor();
    await f.hidden();
    await f.toggle('Meta+Alt+Shift+KeyT');
    await f.treasury.waitFor();

    const fresh = await fixture(browser);
    await fresh.page.goto(origin + '/#/treasury-demo');
    await fresh.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await fresh.hidden();
    assert.equal(fresh.chunks.length, 0, 'another browser session stays hidden');
    await fresh.close();
    await f.close();

    const blocked = await fixture(browser, true);
    await blocked.page.goto(origin + '/#/treasury-demo');
    await blocked.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await blocked.hidden();
    await blocked.toggle();
    await blocked.treasury.waitFor();
    await blocked.page.reload();
    await blocked.page.getByRole('navigation', { name: 'Dashboard sections' }).waitFor();
    await blocked.hidden();
    await blocked.close();
    console.log(JSON.stringify({ passed: true, hiddenByDefault: true, guardedDeepLinks: true, sessionVisibility: true,
      shortcutFiltering: true, blockedStorage: true, simulatedQuorum: true, exactBudgetSequence: true,
      bothDestinations: true, noOptimisticDebit: true, responsiveWidths: 4, transactionsSent: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
