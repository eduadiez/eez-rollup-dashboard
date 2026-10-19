// Exercise the generic proxy/counter call path through the mounted application.
// RPC responses and wallet sends are mocked; no transactions are broadcast.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {fixture,until,target,eoa} = require('./cross-chain-calls.cjs');

(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  let scenarios = 0;
  try {
    for (const reverse of [false,true]) for (const walletName of ['Rabby','MetaMask']) for (const destination of [target,eoa]) {
      const f = await fixture(browser,{feesEnabled:true,walletName});
      await f.select(destination,reverse);
      if (destination === eoa) await f.panel.getByLabel('Calldata',{exact:true}).fill('0x1234');
      await until(() => f.send.isEnabled(),'cross-chain call was not ready');
      await f.send.click();
      await until(() => f.page.evaluate(() => window.walletRequests.length === 1),'quoted call did not reach wallet');
      const quotes = f.requests.filter(request => request.method === 'eez_quoteFee');
      assert.equal(quotes.length,1);
      assert.equal(quotes[0].path,reverse ? '/composer/l2' : '/composer/l1');
      const tx = await f.page.evaluate(() => window.walletRequests[0]);
      for (const [key,value] of Object.entries(quotes[0].params[0])) assert.equal(tx[key],value,key);
      assert.equal(tx.type,walletName === 'Rabby' ? '0x0' : '0x2');
      assert.equal(tx.walletChain,reverse ? '0x1892' : '0x27d8');
      if (destination === eoa) assert.equal(tx.data,'0x1234');
      else assert(tx.data.startsWith(reverse ? '0x55241077' : '0xd09de08a'));
      assert.equal(tx.gasPrice,walletName === 'Rabby' ? '0xf' : undefined);
      assert.equal(tx.maxPriorityFeePerGas,walletName === 'MetaMask' ? '0x5' : undefined);
      assert.deepEqual(f.errors,[]);
      await f.context.close(); scenarios++;
    }
    console.log(JSON.stringify({passed:true,scenarios,realTransactionsBroadcast:0}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
