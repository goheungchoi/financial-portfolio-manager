// Phone control P6 (artifacts/reviews/2026-11-25-phone-control): Engine settings → Phone control. The switch and its
// confirmation, the PIN handlers, the connection line and Home's line, the setup guide. Made-up values; no network.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const W=require('../electron/phone-words.cjs');
const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
const base={enabled:true,providerFile:true,pin:{set:true,locked:false},service:{state:'ready'},clockSuspect:false};

test('the connection line: each state of the service in plain words; "action" only when the user must do something',()=>{
  const cases=[
    [{enabled:false},'ok','Off.'],
    [{pin:{set:false,locked:false}},'action','Set a PIN: Start and the lost-order fixes need it.'],
    [{providerFile:false},'action','Not running: choose your provider file in Connections.'],
    [{service:{state:'not-set-up',missing:['discordBotToken','discordUserId'],invalid:['discordServerId','secretValue']}},'action','Not set up: discordBotToken and discordUserId missing; discordServerId not valid in the provider file.'],
    [{service:{state:'not-set-up',problems:['x']}},'action','Not set up: the provider file could not be read.'],
    [{service:{state:'connecting'}},'info','Connecting to Discord…'],[{service:{state:'keys-ok'}},'info','Connecting to Discord…'],
    [{service:{state:'waiting',waitMs:20000}},'info','Connection to Discord lost; trying again in 20 s.'],
    [{service:{state:'worker-restarting',waitMs:5000}},'info','Phone control stopped unexpectedly; restarting in 5 s.'],
    [{service:{state:'refused',code:4004}},'action','Discord refused the bot token. Reset it in the Developer Portal and put the new one in the provider file.'],
    [{service:{state:'refused',code:4014}},'action','Discord refused the connection (code 4014). Check the bot\'s setup in the Developer Portal.'],
    [{service:{state:'bad-gateway-url'}},'action','Not connecting: Discord gave an unexpected address. Check for an app update.'],
    [{service:{state:'commands-refused',httpStatus:403}},'action','Connected, but Discord refused the command list (HTTP 403). Check the server id and that the bot is in that server.'],
    [{service:{state:'reply-refused',httpStatus:403}},'action','A reply was refused by Discord (HTTP 403). Check that the bot is in the server and can use the channel.'],
    [{service:{state:'ready'}},'ok','Connected. No command received yet: send /status from your phone.'],
    [{service:{state:'commands-registered',lastCommandAt:Date.parse('2026-11-26T01:05:00Z')}},'ok','Connected. Last command at 10:05 KST.'],
    [{pin:{set:true,locked:true}},'action','Start and the lost-order fixes are locked after 5 wrong PINs. Unlock them in Engine settings.'],
    [{clockSuspect:true},'action','The PC clock may be wrong: phone commands looked too old or too new. Check the time in Windows settings.']];
  for(const [over,tone,text] of cases)assert.deepEqual(W.phoneLine({...base,...over}),{tone,text},JSON.stringify(over));
  assert.ok(!JSON.stringify(W.phoneLine({...base,service:{state:'not-set-up',invalid:['secretValue']}})).includes('secretValue'),'only the five key names are ever named');
});

test('the PIN handlers: authorize, take the PIN twice, never echo it; the window learns only "set" and "locked"',()=>{
  assert.ok(main.includes("ipcMain.handle('phone:set-pin',(event,pin,again)=>{authorize(event);if(typeof pin!=='string'||typeof again!=='string'||!/^\\d{6,12}$/.test(pin))return {ok:false,error:'PIN_FORMAT',state:runtimeState()};"));
  assert.ok(main.includes("if(pin!==again)return {ok:false,error:'PIN_DIFFERENT',state:runtimeState()};try{phonePins().setPin(pin);phonePinView.drop();}"));
  assert.ok(main.includes("ipcMain.handle('phone:unlock',event=>{authorize(event);try{phonePins().unlock();phonePinView.drop();}"));
  assert.ok(main.includes("return {enabled:view.enabled,pin,line:require('./phone-words.cjs').phoneLine(view)};"),'the view: the switch, two booleans and the line');
  assert.ok(main.includes("const runtimeState=()=>lightState({...automation.getState(),phone:phoneView(),"));
  const handler=main.slice(main.indexOf("ipcMain.handle('phone:set-pin'"),main.indexOf("ipcMain.handle('runtime:configure'"));
  assert.ok(!/log\([^)]*pin[^)]*\)/i.test(handler.replace(/'The phone control PIN was (set|unlocked) on this PC\.'/g,'')),'the PIN is never logged');
  const preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  assert.ok(preload.includes("setPhonePin: (pin, again) => ipcRenderer.invoke('phone:set-pin', pin, again),"));assert.ok(preload.includes("unlockPhonePin: () => ipcRenderer.invoke('phone:unlock'),"));
  // The PIN store is the core's own table, so the phone checks exactly what the desktop set.
  const {DatabaseSync}=require('node:sqlite');const {PhoneCore}=require('../electron/phone-core.cjs');const db=new DatabaseSync(':memory:');
  const store=new PhoneCore(db,{allow:null});store.setPin('482913');const core=new PhoneCore(db,{allow:{user:'100000000000000001',server:'100000000000000002',channel:'100000000000000003',application:'100000000000000004'}});
  assert.equal(core.checkPin('482913').ok,true);assert.equal(store.accept({}).silent,true,'the store accepts no command');
  store.writePin({...store.pinState(),wrong:5,locked:true});assert.equal(core.locked(),true);store.unlock();assert.equal(core.locked(),false);
});

test('the switch: turned on only with a PIN set (the window and the main process); off at once; off by default',()=>{
  assert.ok(main.includes("if(value?.phoneControl===true&&automation.config.phoneControl!==true&&!phonePins().hasPin())return {ok:false,error:'PHONE_PIN_REQUIRED',state:runtimeState()};"));
  assert.equal(require('../electron/automation.cjs').DEFAULTS.phoneControl,false);
  const ui=fs.readFileSync(path.join(__dirname,'../src/PhoneControl.tsx'),'utf8');
  assert.ok(ui.includes("onChange={v=>v?setAsking(true):edit('phoneControl',false)}"),'on through the confirmation, off at once');
  assert.ok(ui.includes("disabled={busy||!pinSet} onClick={()=>{edit('phoneControl',true);setAsking(false);}}"),'Turn on needs the PIN');
  assert.ok(ui.includes('type="password"')&&!ui.includes('value={state'),'the PIN fields are password fields filled only by typing');
});

test('Home: one line, only when phone control needs the user',()=>{
  assert.ok(main.includes("try{const p=phoneView();if(p.enabled&&p.line.tone==='action')items.push({id:'phone-control',tone:'action',title:'Phone control: '+p.line.text,detail:p.line.text,tab:'Engine settings',action:'Open'});}catch{}"));
});

test('the confirmation and the setup guide say what the release notes say',async()=>{
  const {PHONE_CONFIRM,PHONE_GUIDE}=await import('../src/phone-guide.mjs');const all=[PHONE_CONFIRM.body,...PHONE_CONFIRM.more].join(' ');
  for(const must of ['cannot place, change or cancel orders','change settings','need your PIN','stock codes','quantities and prices','five Discord keys','trading goes on'])assert.ok(all.includes(must),must);
  assert.equal(PHONE_GUIDE.length,10);assert.ok(PHONE_GUIDE.some(s=>s.includes('scope=bot+applications.commands&permissions=0')));
  assert.ok(PHONE_GUIDE.some(s=>s.includes('Reset Token')&&s.includes('new PIN')),'the leaked-token step');
  for(const key of W.KEY_NAMES)assert.ok(PHONE_GUIDE.join(' ').includes(key),key);
});

test('P6 review A: the PIN view is kept 5 s; a second runtime state reads nothing; set, unlock and a PIN entry drop it',async()=>{
  let now=0,reads=0;const store={set:true,locked:false};const c=W.pinCache(()=>{reads++;return {...store};},{clock:()=>now});
  assert.deepEqual(c.get(),{set:true,locked:false});c.get();now=4999;c.get();assert.equal(reads,1,'kept for 5 s');now=5000;c.get();assert.equal(reads,2,'read again after 5 s');
  store.locked=true;c.drop();assert.deepEqual(c.get(),{set:true,locked:true},'dropped: read at once');
  const bad=W.pinCache(()=>{throw new Error('disk');});assert.deepEqual(bad.get(),{set:false,locked:false});
  // main.cjs: the view comes from the cache, dropped on set-pin, unlock and the service's onPinChange.
  assert.ok(main.includes("function phoneView(){const pin=phonePinView.get();"));assert.ok(main.includes("try{phonePins().setPin(pin);phonePinView.drop();}"));
  assert.ok(main.includes("try{phonePins().unlock();phonePinView.drop();}"));assert.ok(main.includes("onPinChange:()=>phonePinView.drop(),"));
  // Five wrong PINs through the real core and service: onPinChange after each, so the lock shows at the next state.
  const {DatabaseSync}=require('node:sqlite');const {PhoneCore}=require('../electron/phone-core.cjs');const {PhoneService}=require('../electron/phone-service.cjs');
  const db=new DatabaseSync(':memory:');let t=1795600000000;const allow={user:'100000000000000001',server:'100000000000000002',channel:'100000000000000003',application:'100000000000000004'};
  const core=new PhoneCore(db,{allow,clock:()=>t});core.setPin('482913');let drops=0;const view=W.pinCache(()=>({set:core.hasPin(),locked:core.locked()}),{clock:()=>t});
  const svc=new PhoneService({core,spawn:()=>({postMessage(){},on(){},kill(){}}),clock:()=>t,onPinChange:()=>{drops++;view.drop();},executor:{summary:async()=>({ok:true,text:'x',held:{shown:'x'}}),run:async()=>'x'}});svc.start('p','s');
  assert.equal(view.get().locked,false);let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));
  const ix=extra=>({id:idAt(t),applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,...extra});
  for(let i=0;i<5;i++){t+=25000;const s=core.accept(ix({type:2,command:'nottaken',options:[{name:'order',value:'A1'}]}));core.attach(s.act.nonce,{shown:'x'});core.accept(ix({type:3,customId:'start-confirm:'+s.act.nonce}));
    await svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:ix({type:5,customId:'pin:'+s.act.nonce,pin:'000000'})});}
  assert.equal(drops,5);assert.equal(view.get().locked,true,'the lock shows at once, within the 5 s');
});
