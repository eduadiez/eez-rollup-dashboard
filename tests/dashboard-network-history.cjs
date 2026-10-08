// Run against a local production preview. All RPC responses are mocked; no wallet is injected.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encodeAbiParameters, keccak256, stringToHex } = require('viem');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const hash = b => '0x' + b.repeat(32), address = b => '0x' + b.repeat(20);
const registry = address('11'), manager = address('22'), caller = address('33');
const l1Block = hash('a1'), l2Block = hash('a2'), l1Tx = hash('b1'), l2Tx = hash('b2'), callHash = hash('cc');
const data = (types, values) => encodeAbiParameters(types.map(type => ({ type })), values);
const outgoing = { address: registry, topics: [keccak256(stringToHex('CrossChainCallExecuted(bytes32,address,address,bytes,uint256)')), callHash, '0x'+manager.slice(2).padStart(64,'0')],
  data: data(['address','bytes','uint256'],[caller,'0x1234',1n]), blockHash: l1Block, blockNumber: '0x64', transactionHash: l1Tx };
const incoming = { address: manager, topics: [keccak256(stringToHex('IncomingCrossChainCallExecuted(bytes32,bool,address,uint64,address,uint256,uint64,bytes)')),callHash],
  data: data(['bool','address','uint64','address','uint256','uint64','bytes'],[false,caller,0n,manager,1n,90000n,'0x1234']), blockHash: l2Block, blockNumber: '0x7', transactionHash: l2Tx };
const settlement = { l1BlockNumber:'0x64',l1BlockHash:l1Block,l1TransactionHash:l1Tx,l2Blocks:[{number:'0x7',hash:l2Block}],canonicalL2:true };
(async()=>{
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    const errors=[];let indexed=false;
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.clock.install();
    await page.addInitScript(({l1Tx,l2Tx})=>localStorage.setItem('txHistory',JSON.stringify([
      {id:'out',type:'bridge',direction:'l1-to-l2',hash:l1Tx,status:'confirmed',label:'Bridge 1 xDAI L1→L2',timestamp:Date.now()},
      {id:'back',type:'bridge',direction:'l2-to-l1',hash:l2Tx,status:'confirmed',label:'Bridge 2 xDAI L2→L1',timestamp:Date.now()},
    ])),{l1Tx,l2Tx});
    await page.route('**/*',route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path.endsWith('/config.json'))return route.fulfill({json:{networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',l1ContractAddress:registry,l2ContractAddress:manager,
        l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
      if(req.method()!=='POST')return route.continue();
      const {method,params=[],id}=req.postDataJSON();assert.ok(!/send|sign/i.test(method));const l1=path.endsWith('l1');let result=null;
      if(method==='eth_chainId')result=l1?'0x27d8':'0x1892';
      if(method==='eth_getBlockByNumber')result={number:l1?'0x64':'0x7',timestamp:'0x65000000',gasUsed:'0x0',gasLimit:'0x1c9c380',transactions:[]};
      if(method==='eth_getBalance')result='0x0';
      if(method==='eth_getTransactionReceipt')result=params[0]===(l1?l1Tx:l2Tx)?{blockNumber:l1?'0x64':'0x7',blockHash:l1?l1Block:l2Block,logs:l1?[outgoing]:[incoming]}:null;
      if(method==='eez_getSettlementByL2Block')result=indexed?settlement:null;
      if(method==='eez_getSettledL2RangesByL1Block')result=indexed?[settlement]:[];
      if(method==='eth_getLogs')result=params[0]?.topics ? l1?[outgoing]:[incoming]:[];
      return route.fulfill({json:{jsonrpc:'2.0',id,result}});
    });
    await page.goto(origin+'/#/bridge');
    const header=page.getByRole('banner'),history=page.getByRole('region',{name:'Transaction history'});
    const forward=history.locator('li').filter({hasText:'1 xDAI'}),reverse=history.locator('li').filter({hasText:'2 xDAI'});
    await forward.getByText('L2 transaction not indexed yet').waitFor();
    assert.equal(await forward.locator(`a[href="https://l1.invalid/tx/${l1Tx}"]`).count(),1);
    assert.equal(await reverse.locator(`a[href="https://l2.invalid/tx/${l2Tx}"]`).count(),1);
    await forward.locator('a[href="https://l1.invalid/block/100"]').waitFor();
    await reverse.locator('a[href="https://l2.invalid/block/7"]').waitFor();
    indexed=true;await page.clock.fastForward(16000);
    await forward.locator(`a[href="https://l2.invalid/tx/${l2Tx}"]`).waitFor();
    await reverse.locator(`a[href="https://l1.invalid/tx/${l1Tx}"]`).waitFor();
    assert.equal(await reverse.getByText('Settlement',{exact:true}).count(),1);
    assert.equal(await forward.getByRole('group',{name:'L1 → L2',exact:true}).locator('img').count(),2);
    assert.equal(await reverse.getByRole('group',{name:'L2 → L1',exact:true}).locator('img').count(),2);
    assert.equal(await forward.locator('a[href="https://l1.invalid/block/100"]').count(),1);
    assert.equal(await forward.locator('a[href="https://l2.invalid/block/7"]').count(),1);
    for(const width of [1920,1440,1280,1201,1200,1024,800,640,390,320]) {
      await page.setViewportSize({width,height:1080});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
      const blocks=header.locator('[data-chain]');assert.equal(await blocks.locator('img').count(),0);
      const a=await blocks.nth(0).boundingBox(),b=await blocks.nth(1).boundingBox();assert.ok(b.y>=a.y+a.height);
      const balances=header.getByRole('group',{name:'Network balances'}).getByRole('button');
      const left=await balances.nth(0).boundingBox(),right=await balances.nth(1).boundingBox();
      assert.ok(Math.abs(left.y-right.y)<1);assert.ok(right.x>=left.x+left.width);
      assert.equal(await balances.getByText('xDAI',{exact:true}).count(),2);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,canonicalTransactionLinks:true,settlementLabel:true,indexRetry:true,historyNetworkLogos:true,blockLinks:true,responsiveWidths:10,horizontalBalances:true,consoleErrors:0,transactionsSent:0}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
