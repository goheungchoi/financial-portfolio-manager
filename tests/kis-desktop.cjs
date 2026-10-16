const {app,BrowserWindow,dialog}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const {KisService}=require('../electron/kis-service.cjs');
const snapshot={source:'kis',environment:'mock',timestamp:new Date().toISOString(),cash:500,reportedTotal:800,holdings:[{symbol:'005380',name:'Fixture company',quantity:2,cost:100,price:150,marketValue:300,unrealized:100}]};
let fixtureService;
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation,payload) {
  fixtureService=this;
  if(operation==='quotes')return [{symbol:'005380',price:200,retrievedAt:Date.now()}];
  if(operation==='company-chart')return {status:'available',metrics:{price:200,PER:10},candles:[{timestamp:Date.parse('2026-10-14T00:00:00+09:00'),open:100,high:210,low:90,close:200,volume:100}],data:{SMA5:null}};
  if(operation==='history')return [{timestamp:Date.parse('2026-10-14T00:00:00+09:00'),open:100,high:210,low:90,close:200,volume:100}];
  if(operation==='orders')return {source:'kis',environment:'mock',startDate:payload.startDate,endDate:payload.endDate,retrievedAt:new Date().toISOString(),orders:[
    {id:'buy',orderId:'1',originalOrderId:null,symbol:'005380',name:'Fixture buy',timestamp:Date.now(),side:'Buy',quantity:10,filled:4,remaining:6,rejected:0,executionAmount:600,averagePrice:150,orderPrice:150,status:'Partially filled'},
    {id:'sell',orderId:'2',originalOrderId:null,symbol:'005380',name:'Fixture sell',timestamp:Date.now(),side:'Sell',quantity:2,filled:2,remaining:0,rejected:0,executionAmount:400,averagePrice:200,orderPrice:200,status:'Filled'},
    {id:'rejected',orderId:'3',originalOrderId:null,symbol:'005380',name:'Fixture rejection',timestamp:Date.now(),side:'Buy',quantity:3,filled:0,remaining:0,rejected:3,executionAmount:0,averagePrice:0,orderPrice:150,status:'Rejected'}
  ]};
  if(operation==='profit')return {source:'kis',environment:'mock',startDate:payload.startDate,endDate:payload.endDate,retrievedAt:new Date().toISOString(),records:[{timestamp:Date.now(),symbol:'005380',name:'Fixture company',realized:125,fee:5,tax:2}],summary:{realized:125,fee:5,tax:2,returnPct:2.5}};
  return snapshot;
};
const timer=setTimeout(()=>{console.error('KIS desktop fixture timed out');app.exit(1);},15000);
app.once('browser-window-created',(_event,win)=>{
  win.webContents.setBackgroundThrottling(false);
  win.hide();
  win.webContents.once('did-finish-load',async()=>{
    try {
      await win.webContents.executeJavaScript('window.portfolio.importKis()');
      await new Promise(resolve=>setTimeout(resolve,300));
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state=>state.source)'),'kis');
      for(let i=0;i<40&&await win.webContents.executeJavaScript('document.querySelector(`[aria-label="Combined equity"] strong`)?.textContent')!=='₩900';i++)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await win.webContents.executeJavaScript('document.querySelector(`[aria-label="Combined equity"] strong`).textContent'),'₩900');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".home-holdings .company-link").textContent'),'Fixture company');
      fixtureService.onStatus({status:'streaming',subscribed:1});
      fixtureService.onQuote({symbol:'005380',price:220,timestamp:Date.now(),receivedAt:Date.now(),cumulativeVolume:100});
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state=>state.snapshot.holdings[0].price)'),220);
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state=>state.quotes[0].timeBasis)'),'exchange');
      await new Promise(resolve=>setTimeout(resolve,1100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(`[aria-label="Combined equity"] strong`).textContent'),'₩940');
      await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".top-chip")).find(b=>b.title==="Market feed").click()');await new Promise(resolve=>setTimeout(resolve,100));assert.ok((await win.webContents.executeJavaScript('document.querySelector(".chip-panel").textContent')).includes('Last trade'));await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".top-chip")).find(b=>b.title==="Market feed").click()');
      const waitDelta=async expected=>{for(let attempt=0;attempt<45;attempt++){const delta=await win.webContents.executeJavaScript('document.querySelector(".tick-delta").dataset.delta');if(delta===String(expected))return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Expected tick equity change '+expected);};
      fixtureService.onQuote({symbol:'005380',price:225,timestamp:Date.now(),receivedAt:Date.now(),cumulativeVolume:101});await waitDelta(10);
      assert.ok((await win.webContents.executeJavaScript('document.querySelector(".tick-delta").textContent')).includes('+₩10'));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".tick-delta").classList.contains("increase")'),true);
      fixtureService.onQuote({symbol:'005380',price:220,timestamp:Date.now(),receivedAt:Date.now(),cumulativeVolume:102});await waitDelta(-10);
      assert.ok((await win.webContents.executeJavaScript('document.querySelector(".tick-delta").textContent')).includes('−₩10'));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".tick-delta").classList.contains("decrease")'),true);await waitDelta(0);
      const saved=await win.webContents.executeJavaScript('window.portfolio.getSnapshot()');
      assert.equal(saved.environment,'synthetic');assert.notEqual(saved.cash,500);
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent==='Charts').click()");
      await new Promise(resolve=>setTimeout(resolve,200));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("[aria-label=\\"Candle interval\\"]").value'),'1d');
      assert.ok((await win.webContents.executeJavaScript('document.querySelector(".candle-summary").textContent')).includes('C 200'));
      await win.webContents.executeJavaScript("const select=document.querySelectorAll('.section-head select')[1];select.value='1m';select.dispatchEvent(new Event('change',{bubbles:true}));");
      await new Promise(resolve=>setTimeout(resolve,200));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("[aria-label=\\"Candle interval\\"]").value'),'1m');
      assert.ok((await win.webContents.executeJavaScript('document.querySelector(".candles").closest("section").querySelector("p").textContent')).includes('intraday'));
      assert.ok((await win.webContents.executeJavaScript('document.querySelector(".candle-summary").textContent')).includes('C 200'));
      fs.writeFileSync(path.join(__dirname,'../artifacts/kis-chart-fixture.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent==='Activity').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Load history').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("tbody tr").length'),3);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".metrics strong").textContent'),'₩600');
      await win.webContents.executeJavaScript("(()=>{const select=document.querySelectorAll('.report-toolbar select')[1];select.value='Rejected';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("tbody tr").length'),1);
      await win.webContents.executeJavaScript("(()=>{const select=document.querySelectorAll('.report-toolbar select')[1];select.value='All';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await new Promise(resolve=>setTimeout(resolve,100));
      fs.writeFileSync(path.join(__dirname,'../artifacts/activity-fixture.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent==='Performance').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Load performance').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".metrics strong").textContent'),'₩125');
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".realized-chart rect").length'),1);
      fs.writeFileSync(path.join(__dirname,'../artifacts/performance-fixture.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript('window.portfolio.disconnectKis()');
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("tbody tr").length'),0);
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state=>state.source)'),'synthetic');
      assert.equal(BrowserWindow.getAllWindows().length,1);
      console.log('KIS dashboard fixture passed: streamed valuation, charts, order history/filtering, realized performance, and disconnect data clearing.');
      clearTimeout(timer);app.exit(0);
    }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
  });
});
require('../electron/main.cjs');
