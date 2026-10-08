// All wallet submissions and RPC responses are mocked. Never broadcast a real transaction.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = (process.env.EEZ_UI_URL || 'http://127.0.0.1:8083/dashboard').replace(/\/$/, '');
const addr = b => '0x'+b.repeat(20), hash = '0x'+'44'.repeat(32);
const account=addr('22'), target=addr('77'), eoa=addr('88'), fresh=addr('99'), registry=addr('11'), manager=addr('33');
const forward={ [target]:addr('55'), [eoa]:addr('aa') }, reverse={ [target]:addr('66'), [eoa]:addr('cc') };
const proxyFor=(address,l1)=>address===target?(l1?addr('55'):addr('66')):address===eoa?(l1?addr('aa'):addr('cc')):(l1?addr('bb'):addr('dd'));
async function fixture(browser,options={}){
 const context=await browser.newContext(), page=await context.newPage();
 const requests=[],errors=[],receipt={value:null},estimation={error:null,delay:false,pending:[]};
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(({account,hash,forward,reverse})=>{
  localStorage.setItem('crossChainProxies',JSON.stringify(forward));localStorage.setItem('crossChainProxiesL2',JSON.stringify(reverse));
  window.walletRequests=[];window.switches=[];window.currentChain='0x27d8';window.rejectSwitch=false;
  window.ethereum={isRabby:true,on(){},removeListener(){},async request({method,params}){
   if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
   if(method==='eth_chainId')return window.currentChain;
   if(method==='wallet_addEthereumChain')return null;
   if(method==='wallet_switchEthereumChain'){if(window.rejectSwitch)throw new Error('User rejected switch');window.currentChain=params[0].chainId;window.switches.push(window.currentChain);return null;}
   if(method==='eth_sendTransaction'){window.walletRequests.push({...params[0],walletChain:window.currentChain});return hash;}
   throw new Error('Unexpected wallet method '+method);
  }};
 },{account,hash,forward,reverse});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(path.endsWith('/config.json'))return route.fulfill({json:{networkName:'EEZ-X Devnet',l1RpcUrl:'/rpc/l1',l2RpcUrl:'/rpc/l2',l1FrontUrl:'/composer/l1',l2FrontUrl:'/composer/l2',l1ContractAddress:registry,l2ContractAddress:manager,rollupId:'1',l1ExplorerApiUrl:'/explorer/l1',l2ExplorerApiUrl:'/explorer/l2',l1ExplorerUrl:'https://l1.invalid',l2ExplorerUrl:'https://l2.invalid'}});
  if(path.startsWith('/explorer/')){
   requests.push({path,action:url.searchParams.get('action'),address:url.searchParams.get('address')});
   const contract=url.searchParams.get('address')===target, l1=path.startsWith('/explorer/l1');
   if(!contract)return route.fulfill({json:{status:'0',result:'Contract is not verified'}});
   if(url.searchParams.get('action')==='getsourcecode')return route.fulfill({json:{status:'1',result:[{ContractName:l1?'L1 Vault':'L2 Counter'}]}});
   return route.fulfill({json:{status:'1',result:JSON.stringify([{type:'function',name:l1?'setValue':'increment',inputs:l1?[{name:'value',type:'uint256'}]:[],outputs:[],stateMutability:'nonpayable'}])}});
  }
  if(req.method()!=='POST')return route.continue();
  const {method,params=[],id}=req.postDataJSON();assert(!/send|sign/i.test(method),'RPC broadcast forbidden');requests.push({path,method,params});
  const l1=path.endsWith('l1'), reply=result=>route.fulfill({json:{jsonrpc:'2.0',id,result}});let result=null;
  if(method==='eth_chainId')result=l1?'0x27d8':'0x1892';
  if(method==='eth_getBalance')result='0x3635c9adc5dea00000';
  if(method==='eth_getBlockByNumber')result={number:'0x10',timestamp:'0x65000000',gasUsed:'0x0',gasLimit:'0x1c9c380',baseFeePerGas:'0x7',transactions:[]};
  if(method==='eth_call'&&params[0].data.startsWith('0xeb20c0aa')){
   assert.equal(params[0].to,l1?registry:manager);assert.equal(BigInt('0x'+params[0].data.slice(-64)),l1?1n:0n);
   const destination='0x'+params[0].data.slice(34,74);result='0x'+proxyFor(destination,l1).slice(2).padStart(64,'0');
  }
  if(method==='eth_getCode'){
   if(options.codeError)return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32000,message:'Read RPC temporarily unavailable'}}});
   result=[...Object.values(forward),...Object.values(reverse)].includes(params[0])?'0x6000':'0x';
  }
  if(method==='eth_estimateGas'){
   if(path.startsWith('/rpc/'))assert.equal(params[0].to,l1?registry:manager,'proxy calls must estimate through Composer');
   if(path.startsWith('/composer/')){
    if(estimation.delay)await new Promise(resolve=>estimation.pending.push(resolve));
    if(estimation.error)return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:3,message:estimation.error}}});
   }
   return reply('0x671af');
  }
  if(method==='eth_getTransactionReceipt')result=receipt.value;
  if(method==='eth_gasPrice'||method==='eth_maxPriorityFeePerGas')result='0x3b9aca00';
  if(method==='eth_getLogs'||method==='eez_getSettledL2RangesByL1Block')result=[];
  return reply(result);
 });
 await page.goto(origin+'/#/bridge');await page.getByRole('button',{name:'Connect Wallet',exact:true}).click();await page.getByRole('button',{name:'Rabby',exact:true}).click();
 const panel=page.getByRole('region',{name:'Cross-chain contracts'});
 await panel.getByText('L2 Counter',{exact:false}).first().waitFor();await panel.getByText('L1 Vault',{exact:false}).first().waitFor();
 const select=async(address,back)=>panel.getByRole('button',{name:`Select proxy for ${address} on ${back?'L2':'L1'}`,exact:true}).click();
 const send=panel.getByRole('button',{name:'Send Cross-Chain Transaction',exact:true});
 return {page,context,panel,select,send,requests,errors,receipt,estimation};
}
async function until(condition, message) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error(message);
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});let scenarios=0;
 try {
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(target,back);await f.send.waitFor({state:'visible'});await assert.doesNotReject(()=>f.send.click({trial:true}));
   const builder=f.panel.locator('[data-call-builder]');
   await builder.getByText(back?'L1 Vault':'L2 Counter',{exact:false}).first().waitFor();
   assert.equal(await f.panel.getByRole('columnheader',{name:'Status',exact:true}).count(),0);
   assert.equal(await f.page.evaluate(()=>window.currentChain),back?'0x1892':'0x27d8');
   const gas=f.panel.getByLabel('Gas limit',{exact:true});await gas.fill('500000');
   await f.page.clock.install();await f.send.click();
   await f.panel.getByText('Waiting for confirmation on '+(back?'EEZ-X Devnet':'Chiado')+'…',{exact:true}).waitFor();
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);
   assert.equal(tx.to,back?reverse[target]:forward[target]);assert.equal(tx.walletChain,back?'0x1892':'0x27d8');assert.equal(tx.gas,'0x7a120');assert.equal(tx.gasLimit,tx.gas);
   assert.ok(tx.data.startsWith(back?'0x55241077':'0xd09de08a'));assert.equal(tx.value,'0x0');
   const estimates=f.requests.filter(r=>r.method==='eth_estimateGas'&&r.path.startsWith('/composer/'));assert(estimates.length);assert(estimates.every(r=>r.path===(back?'/composer/l2':'/composer/l1')));
   assert(estimates.every(r=>Object.keys(r.params[0]).sort().join(',')==='data,from,to,value'));assert.equal(estimates.at(-1).params[0].from,account);
   f.receipt.value={status:'0x1',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
   await builder.getByText('Cross-chain call confirmed on '+(back?'EEZ-X Devnet':'Chiado'),{exact:true}).waitFor();
   const history=await f.page.evaluate(()=>JSON.parse(localStorage.getItem('txHistory'))[0]);assert.equal(history.direction,back?'l2-to-l1':'l1-to-l2');assert.equal(history.status,'confirmed');
   assert(f.requests.some(r=>r.method==='eth_getTransactionReceipt'&&r.path===(back?'/rpc/l2':'/rpc/l1')));
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  for(const back of [false,true]){
   const f=await fixture(browser);await f.select(eoa,back);await f.panel.getByLabel('Calldata',{exact:true}).waitFor();await f.panel.getByLabel('Value (xDAI)',{exact:true}).fill('0.01');
   await f.send.click({trial:true});await f.send.click();await f.panel.getByText('Waiting for confirmation on '+(back?'EEZ-X Devnet':'Chiado')+'…',{exact:true}).waitFor();
   const tx=await f.page.evaluate(()=>window.walletRequests[0]);assert.equal(tx.data,'0x');assert.equal(tx.value,'0x2386f26fc10000');assert.equal(tx.gas,'0x671af');assert.equal(tx.gasLimit,tx.gas);
   assert.equal(await f.panel.getByText('Enter calldata above to enable sending',{exact:true}).count(),0);
   assert.equal(await f.panel.getByLabel('ABI JSON',{exact:true}).evaluate(e=>getComputedStyle(e).resize),'none');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(target,false);await f.send.click({trial:true});await f.page.evaluate(()=>window.rejectSwitch=true);await f.select(target,true);
   await f.panel.getByRole('alert').getByText('Wallet network switch was cancelled.',{exact:false}).waitFor();
   assert.equal(await f.panel.getByRole('button',{name:`Selected proxy for ${target} on L1`,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.panel.getByRole('button',{name:'Add address',exact:true}).click();
   for(const back of [false,true]){
    if(back)await f.panel.getByRole('button',{name:'Call L2 to L1',exact:true}).click();
    await f.panel.getByLabel('Destination address',{exact:false}).fill(fresh);
    const create=f.panel.getByRole('button',{name:'Create proxy',exact:true});await create.waitFor();if(!back)await f.page.clock.install();f.receipt.value=null;await create.click();
    await f.panel.getByText('Waiting for confirmation on '+(back?'EEZ-X Devnet':'Chiado')+'…',{exact:true}).waitFor();
    const tx=await f.page.evaluate(()=>window.walletRequests.at(-1));assert.equal(tx.to,back?manager:registry);assert.equal(tx.data.slice(0,10),'0xa7587c62');assert.equal(BigInt('0x'+tx.data.slice(-64)),back?0n:1n);
    f.receipt.value={status:'0x1',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
    await f.panel.getByRole('button',{name:`Selected proxy for ${fresh} on ${back?'L2':'L1'}`,exact:true}).waitFor();
    assert.equal(await f.page.evaluate(({key,fresh})=>JSON.parse(localStorage.getItem(key))[fresh],{key:back?'crossChainProxiesL2':'crossChainProxies',fresh}),proxyFor(fresh,!back));
    const row=f.page.getByRole('region',{name:'Transaction history'}).locator('li').first();
    assert.equal(await row.getByRole('group',{name:back?'L2':'L1',exact:true}).count(),1);
    if(!back)assert.equal(await row.getByText('L2 transaction not indexed yet',{exact:true}).count(),0);
   }
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),2);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser,{codeError:true});
   assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('crossChainProxies'))),forward);
   assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('crossChainProxiesL2'))),reverse);
   assert(f.requests.some(r=>r.method==='eth_getCode'&&r.path==='/rpc/l1'));
   assert(f.requests.some(r=>r.method==='eth_getCode'&&r.path==='/rpc/l2'));
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,true);await f.send.click({trial:true});await f.page.clock.install();await f.send.click();
   await f.panel.getByText('Waiting for confirmation on EEZ-X Devnet…',{exact:true}).waitFor();
   f.receipt.value={status:'0x0',blockNumber:'0x10',logs:[]};await f.page.clock.runFor(1100);
   await f.panel.getByText('Transaction reverted on L2',{exact:false}).waitFor();
   assert.equal(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('txHistory'))[0].status),'failed');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);f.estimation.error='execution reverted: refused';await f.select(eoa,true);await f.panel.getByText('Transaction will revert:',{exact:false}).waitFor();
   assert.equal(await f.panel.getByRole('button',{name:'Transaction Will Revert',exact:true}).isDisabled(),true);
   await f.panel.getByLabel('Gas limit',{exact:true}).fill('500000');assert.equal(await f.panel.getByRole('button',{name:'Transaction Will Revert',exact:true}).isDisabled(),true);
   assert.equal(await f.page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,false);await f.send.click({trial:true});
   f.estimation.delay=true;await f.panel.getByLabel('Calldata',{exact:true}).fill('0x1234');
   assert.equal(await f.send.isDisabled(),true,'changed calldata invalidates the previous estimate immediately');
   await until(()=>f.estimation.pending.length===1,'first delayed estimate missing');
   await f.panel.getByLabel('Calldata',{exact:true}).fill('0x5678');await until(()=>f.estimation.pending.length===2,'second delayed estimate missing');
   f.estimation.delay=false;for(const release of f.estimation.pending.splice(0).reverse())release();
   await f.send.click({trial:true});await f.send.click();await f.panel.getByText('Waiting for confirmation on Chiado…',{exact:true}).waitFor();
   assert.equal(await f.page.evaluate(()=>window.walletRequests[0].data),'0x5678','old estimates must not restore stale calldata');
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  {
   const f=await fixture(browser);await f.select(eoa,false);await f.send.click({trial:true});
   for(const width of [1920,1440,1280,1024,800,640,390,320]){await f.page.setViewportSize({width,height:1080});assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);}
   await f.page.setViewportSize({width:1440,height:1080});await f.panel.hover();await f.panel.screenshot({path:'/tmp/eez-bidirectional-calls.png'});
   assert.deepEqual(f.errors,[]);await f.context.close();scenarios++;
  }
  console.log(JSON.stringify({passed:true,scenarios,bothDirections:true,sourceComposerEstimates:true,manualGas:true,eoasAndEmptyCalldata:true,proxyCreationBothChains:true,separateCaches:true,chainScopedNamesAndAbi:true,rejectedSwitchPreservesSelection:true,sourceReceiptPolling:true,historyDirections:true,responsiveWidths:8,transactionsBroadcast:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
