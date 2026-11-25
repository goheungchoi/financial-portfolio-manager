// Phone control P6 on screen (artifacts/reviews/2026-11-25-phone-control): Engine settings → Alerts → Phone control. The
// switch and its confirmation (Turn on disabled until a PIN is set), the PIN set twice (a mismatch said; the PIN never in
// the window's state), the switch saved on, each connection state the stand-in phone worker reports, the lock and
// Unlock, Home's one line only when the user is needed, and the switch off. The phone worker is a stand-in: no Discord
// connection, no token, no network. Made-up data only.
const {app}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {EventEmitter}=require('node:events');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/phone-desktop');fs.mkdirSync(output,{recursive:true});
const PIN='482913';
// The stand-in worker: what the main process posts is kept; the test speaks for the worker.
const workers=[];const electron=require('electron');const realFork=electron.utilityProcess.fork.bind(electron.utilityProcess);
electron.utilityProcess.fork=(file,...rest)=>{if(!String(file).endsWith('phone-worker.cjs'))return realFork(file,...rest);
  const w=new EventEmitter();w.posted=[];w.killed=false;w.postMessage=m=>w.posted.push(m);w.kill=()=>{w.killed=true;};workers.push(w);return w;};
const worker=()=>workers.at(-1);const say=m=>worker().emit('message',m);
const {KisService}=require('../electron/kis-service.cjs');
KisService.prototype.request=async function(operation){throw new Error('No KIS or AI request in this fixture: '+operation);};
const timer=setTimeout(()=>{console.error('Phone desktop timed out');app.exit(1);},150000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what+'. Page: '+String(await run('document.body.innerText')).slice(0,800));};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,'phone-'+name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const has=text=>`document.body.innerText.includes(${JSON.stringify(text)})`;
  const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
  const card=`document.querySelector('#eng-phone')`;
  const type=async(label,value)=>run(`(()=>{const i=document.querySelector('[aria-label="${label}"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const openCard=async()=>{await navigate('Engine settings');await run(`Array.from(document.querySelectorAll('[role="tab"]')).find(b=>b.textContent==='Alerts').click()`);await until(`Boolean(${card})`,'the Phone control card');await run(card+'.scrollIntoView({block:"start"})');};
  const homeItem=`Array.from(document.querySelectorAll('.attention-list li')).some(li=>li.innerText.includes('Phone control: '))`;
  const homeText=text=>`Array.from(document.querySelectorAll('.attention-list li')).some(li=>li.innerText.includes(${JSON.stringify('Phone control: '+text)}))`;
  // A remembered provider file, so the service starts once the switch is on (the file itself is never read here).
  {const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
    try{db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('connection-file:providers',path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-providers-not-read.json'));}finally{db.close();}}
  await openCard();
  assert.ok(await run(`${card}.innerText.includes('Off. Off by default.')`));assert.ok(await run(`${card}.innerText.includes('Not set. 6 to 12 digits')`));await capture('off');
  // The confirmation: Turn on disabled without a PIN; Cancel changes nothing.
  await run(`document.querySelector('[aria-label="Phone control"][role="switch"]').click()`);await until(`Boolean(document.querySelector('[role="dialog"][aria-label="Turn on phone control?"]'))`,'the confirmation');
  assert.equal(await run(`${button('Turn on')}.disabled`),true,'Turn on needs the PIN');assert.ok(await run(has('Set a PIN below first.')));
  await run(`document.querySelector('[role="dialog"][aria-label="Turn on phone control?"] summary').click()`);await until(has('Replies can show stock codes'),'More');await capture('confirm-no-pin');
  await run(`${button('Cancel')}.click()`);await until(`!document.querySelector('[role="dialog"][aria-label="Turn on phone control?"]')`,'closed');
  // The PIN: a mismatch is said; then set. The window's state holds "set", never the PIN.
  await type('PIN',PIN);await type('PIN again','482914');await run(`${button('Set PIN')}.click()`);await until(has('The two PINs differ.'),'the mismatch');
  assert.equal(await run(`document.querySelector('[aria-label="PIN"]').value`),'','the fields are cleared');
  await type('PIN',PIN);await type('PIN again',PIN);await run(`${button('Set PIN')}.click()`);await until(has('PIN saved.'),'saved');await until(`${card}.innerText.includes('Set. Needed for Start')`,'set');
  const state=JSON.stringify(await run('window.portfolio.getRuntime()'));assert.ok(!state.includes(PIN),'the PIN is not in the window\'s state');assert.ok(state.includes('"pin":{"set":true,"locked":false}'));
  // The switch on, saved: the stand-in worker starts.
  await run(`document.querySelector('[aria-label="Phone control"][role="switch"]').click()`);await until(`${button('Turn on')}&&!${button('Turn on')}.disabled`,'Turn on enabled');await capture('confirm');
  await run(`${button('Turn on')}.click()`);await run(`${button('Save changes')}.click()`);await until(`${workers.length>=0}&&document.body.innerText.includes('Settings saved')`,'saved');
  const started=Date.now();while(!workers.length&&Date.now()-started<10000)await new Promise(r=>setTimeout(r,100));assert.equal(workers.length,1,'the worker started');assert.equal(worker().posted[0]?.op,'start');
  // Each state the worker can report, in the card's words; Home's line only when the user is needed.
  const states=[
    [{type:'state',state:'not-set-up',missing:['discordBotToken'],invalid:['discordServerId']},'Not set up: discordBotToken missing; discordServerId not valid in the provider file.',true,'not-set-up'],
    [{type:'state',state:'keys-ok',allow:{user:'100000000000000001',server:'100000000000000002',channel:'100000000000000003',application:'100000000000000004'}},'Connecting to Discord…',false,'connecting'],
    [{type:'state',state:'waiting',waitMs:20000},'Connection to Discord lost; trying again in 20 s.',false,null],
    [{type:'state',state:'refused',code:4004},'Discord refused the bot token. Reset it in the Developer Portal and put the new one in the provider file.',true,'refused'],
    [{type:'state',state:'ready'},'Connected. No command received yet: send /status from your phone.',false,'connected'],
    [{type:'state',state:'reply-refused',status:403},'A reply was refused by Discord (HTTP 403). Check that the bot is in the server and can use the channel.',true,null],
    [{type:'state',state:'commands-registered'},'Connected. No command received yet: send /status from your phone.',false,null]];
  for(const [message,text,home,shot] of states){say(message);await until(`${card}?.innerText.includes(${JSON.stringify(text)})`,text);if(shot)await capture('state-'+shot);
    await navigate('Home');if(home){await until(homeItem,'Home\'s line');assert.ok(await run(homeText(text)),'the line says what is needed');if(shot==='refused')await capture('home-line');}else await until(`!(${homeItem})`,'no Home line: '+text);
    await openCard();}
  // The lock (five wrong PINs on the phone, written as the core writes it) and Unlock.
  {const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
    try{const row=JSON.parse(db.prepare('SELECT payload FROM phone_pin WHERE id=1').get().payload);db.prepare('UPDATE phone_pin SET payload=? WHERE id=1').run(JSON.stringify({...row,wrong:5,locked:true}));}finally{db.close();}}
  await until(`${card}.innerText.includes('Locked after 5 wrong entries')`,'locked');await until(has('Start and the lost-order fixes are locked after 5 wrong PINs.'),'the locked line');await capture('locked');
  await navigate('Home');await until(homeItem,'Home\'s line while locked');await openCard();
  await run(`${button('Unlock')}.click()`);await until(has('Unlocked.'),'unlocked');await until(`${card}.innerText.includes('Set. Needed for Start')`,'set again');
  // Off at once: the worker is stopped.
  await run(`document.querySelector('[aria-label="Phone control"][role="switch"]').click()`);await run(`${button('Save changes')}.click()`);
  const w=worker();const t0=Date.now();while(!w.killed&&Date.now()-t0<10000)await new Promise(r=>setTimeout(r,100));assert.equal(w.killed,true,'turned off: the worker stopped');assert.ok(w.posted.some(m=>m.op==='stop'));
  await until(`${card}.innerText.includes('Off. Off by default.')`,'off again');
  clearTimeout(timer);console.log('Phone desktop passed: the switch and its confirmation, the PIN, each connection state, the lock and Unlock, Home\'s line, off');app.exit(0);
}catch(error){console.error('Phone desktop:',error);try{fs.writeFileSync(path.join(output,'phone-failure.txt'),String(error?.stack??error));}catch{}clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
