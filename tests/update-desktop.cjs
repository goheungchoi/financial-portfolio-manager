// In-app update flow against a local release server: detect, download with SHA-512 verification, reject a bad checksum.
// The downloaded "installer" is random bytes and is never run; this test never installs anything.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const crypto=require('node:crypto');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/ui-tests');const payload=crypto.randomBytes(256*1024);
const release={version:'9.9.9',sha512:crypto.createHash('sha512').update(payload).digest('base64')};
const manifest=()=>`version: ${release.version}\nfiles:\n  - url: Financial-Portfolio-Manager-Setup-${release.version}.exe\n    sha512: ${release.sha512}\n    size: ${payload.length}\npath: Financial-Portfolio-Manager-Setup-${release.version}.exe\nsha512: ${release.sha512}\nreleaseDate: '2026-10-16T00:00:00.000Z'\nreleaseNotes: Fixture release notes\n`;
const server=http.createServer((req,res)=>{if(req.url.startsWith('/latest.yml')){res.writeHead(200,{'content-type':'text/yaml'});res.end(manifest());return;}if(req.url.endsWith('.exe')){res.writeHead(200,{'content-type':'application/octet-stream','content-length':payload.length});res.end(payload);return;}res.writeHead(404);res.end();});
server.listen(0,'127.0.0.1',()=>{
  const config=path.join(process.env.PORTFOLIO_SMOKE_DATA,'update-test.yml');fs.writeFileSync(config,`provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: financial-portfolio-manager-update-test\n`);
  // Run as a script, Electron would report its own version; use the app's.
  app.setVersion(require('../package.json').version);process.env.PORTFOLIO_UPDATE_TEST=config;require('../electron/main.cjs');
});
// The fixture download lands in the updater cache; remove this test's cache folder on exit.
const cleanup=()=>{try{fs.rmSync(path.join(process.env.LOCALAPPDATA??'','financial-portfolio-manager-update-test'),{recursive:true,force:true});}catch{}};app.on('will-quit',cleanup);
const timer=setTimeout(()=>{console.error("Update test timed out");cleanup();app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.hide();win.webContents.once('did-finish-load',async()=>{
  const run=code=>win.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(code,message,tries=200)=>{for(let i=0;i<tries;i++){if(await run(code))return;await wait(50);}throw new Error(message);};
  const click=async text=>{await run(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing '+${JSON.stringify(text)});button.click();})()`);await wait(80);};
  const badge='document.querySelector(`[aria-label="App updates"] .badge`)?.textContent';
  try{
    await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.textContent==='Connections').click()`);await until(`Boolean(document.querySelector('[aria-label="App updates"]'))`,'Update panel missing');
    assert.ok((await run('document.querySelector(`[aria-label="App updates"]`).textContent')).includes('Version '+app.getVersion()));
    await click('Check for updates');await until(`${badge}==="VERSION 9.9.9 AVAILABLE"`,'Update not detected');
    assert.ok(await run('document.querySelector(`[aria-label="App updates"]`).textContent.includes("Fixture release notes")'));
    await click('Download 9.9.9');await until(`${badge}==="VERSION 9.9.9 READY TO INSTALL"`,'Download not verified');
    assert.equal(await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Restart and install')?.disabled`),false,'install is allowed when nothing is running');
    fs.writeFileSync(path.join(output,'update-ready.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    // A manifest whose checksum does not match the file must be rejected.
    release.version='9.9.10';release.sha512=crypto.createHash('sha512').update('tampered').digest('base64');
    await click('Check for updates');await until(`${badge}==="VERSION 9.9.10 AVAILABLE"`,'Second update not detected');
    await click('Download 9.9.10');await until('document.querySelector(`[aria-label="App updates"]`).textContent.includes("did not match its published checksum")','Checksum mismatch not reported');
    console.log('Update flow passed: detected, downloaded and verified a release, offered install, and rejected a checksum mismatch.');clearTimeout(timer);server.close();cleanup();app.exit(0);
  }catch(error){console.error(error);try{console.error('Update panel: '+await run('document.querySelector(`[aria-label="App updates"]`)?.textContent'));}catch{}try{fs.writeFileSync(path.join(output,'update-failure.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}catch{}clearTimeout(timer);cleanup();app.exit(1);}
});});
