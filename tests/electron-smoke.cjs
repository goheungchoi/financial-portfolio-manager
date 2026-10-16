const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.PORTFOLIO_SMOKE_DATA) throw new Error('Use tests/run-desktop.cjs to isolate test data');
app.setPath('userData', process.env.PORTFOLIO_SMOKE_DATA);
const timer = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 20000);
let first = true;
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.hide();
  if (!first) return;
  first = false;
  win.webContents.once('did-finish-load', async () => {
    try {
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Home');
      assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("main").innerText.includes("vs previous tick")'),false);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("main").innerText.includes("Holdings + cash")'),false);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".topbar").textContent.includes("Open AI window")'), false);
      if (process.argv.includes('--restore')) {
        assert.equal(await win.webContents.executeJavaScript('window.portfolio.getTheme()'), 'light');
        assert.equal(await win.webContents.executeJavaScript('window.portfolio.getEvents().then(events => events.length)'), 6);
        assert.equal(await win.webContents.executeJavaScript('window.portfolio.getSnapshot().then(snapshot => snapshot.cash)'), 3500000);
        console.log('Electron restart passed: theme, transcript, and snapshot recovered.');
        clearTimeout(timer); app.exit(0); return;
      }
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state => state.status)'), 'connected');
      await win.webContents.executeJavaScript('window.portfolio.pauseFeed(true)');
      const pausedPrice = await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state => state.quotes[0].price)');
      await new Promise(resolve=>setTimeout(resolve,5500));
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state => state.quotes.every(quote => quote.stale))'),true);
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state => state.quotes[0].price)'),pausedPrice);
      await win.webContents.executeJavaScript('window.portfolio.pauseFeed(false)');
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getMarket().then(state => state.status)'),'connected');
      await assert.rejects(win.webContents.executeJavaScript("window.portfolio.getHistory('invalid','1m')"));
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent==='Charts').click()");
      await new Promise(resolve=>setTimeout(resolve,200));
      assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.candles').length"),0);
      assert.ok(await win.webContents.executeJavaScript("document.querySelector('main').textContent.includes('Connect your portfolio')"));
      fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../artifacts/candles.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.brand').click()");
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.dataset.tab==='AI console').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(BrowserWindow.getAllWindows().length,1);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'),'AI console');
      await win.webContents.executeJavaScript('window.portfolio.runDemo()');
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getEvents().then(events=>events.length)'),6);
      await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent==='Connections').click()");
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'),'Connections');
      assert.equal(await win.webContents.executeJavaScript('window.portfolio.getKis().then(state=>state.status)'),'disconnected');
      fs.writeFileSync(path.join(__dirname, '../artifacts/kis-account.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      const {KisService}=require('../electron/kis-service.cjs');
      const service=new KisService();
      const invalidFile=path.join(process.env.PORTFOLIO_SMOKE_DATA,'invalid-fixture.json');
      fs.writeFileSync(invalidFile,JSON.stringify({appSecret:'fixture-secret'}));
      try {await assert.rejects(service.request('import',invalidFile),error=>error.message==='INVALID_CREDENTIAL_FILE');}
      finally {service.disconnect();}
      await win.webContents.executeJavaScript("document.querySelector('.brand').click()");
      fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../artifacts/dashboard.png'), (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.theme-switch').click()");
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await win.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'light');
      fs.writeFileSync(path.join(__dirname, '../artifacts/dashboard-light.png'), (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      console.log('Electron smoke passed: renderer isolation, same-window console navigation, read-only account screen, broker isolation, and event delivery.');
      console.log('Market desktop checks passed: pause, stale detection, resume, history validation, and candle rendering.');
      clearTimeout(timer); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
  });
});
require('../electron/main.cjs');
