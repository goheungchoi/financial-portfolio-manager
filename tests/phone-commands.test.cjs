// Phone control P3 (artifacts/reviews/2026-11-25-phone-control): Status, Stop and Stop everything from the phone, through
// the desktop's own functions; the Phone control switch, off by default. Made-up ids and values; no network.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const C=require('../electron/phone-commands.cjs');const L=require('../electron/auto-launch.cjs');
const {PhoneService}=require('../electron/phone-service.cjs');const {PhoneCore}=require('../electron/phone-core.cjs');
const allow={application:'100000000000000004',server:'100000000000000002',channel:'100000000000000003',user:'100000000000000001'};

function fakeAutomation(over={}){const now=Date.parse('2026-11-26T01:00:00Z');return {config:{scope:'kis',conditionalOrders:true,phoneAmounts:false,...over.config},autoTradingRuns:()=>over.running??false,
  live:{getConnection:()=>({snapshot:{environment:'live'}}),orders:()=>over.orders??[]},usLive:null,lastRun:now-30*60000,nextReviewAt:()=>over.running?now+30*60000:null,
  desk:{orders:()=>over.armed??[]},watchScope:()=>'kis:x',watchingWhileStopped:()=>over.watching??false,whileStoppedState:()=>over.whileStopped,providerWaitState:()=>over.waits??[]};}

test('Status: running or stopped, the scope and account kind, the last and next review, armed orders and whether watched, approvals, lost replies, provider waits',()=>{
  const t=C.statusText(fakeAutomation({running:true,armed:[{symbol:'990001'},{symbol:'990002'}],orders:[{status:'Ready'},{status:'Uncertain'},{status:'Filled'}],waits:[{name:'Anthropic',nextTry:'11:30'}]}));
  assert.equal(t,['Auto trading: running · Korea (live account).','Last review: 09:30 KST. Next review: 10:30 KST.','2 armed orders are watched.','1 order waits for your approval on the PC.','1 order has a lost KIS reply (/orders lists them).','Anthropic: waiting, next try 11:30 KST.'].join('\n'));
  assert.match(C.statusText(fakeAutomation({armed:[{symbol:'990001'}]})),/Auto trading: stopped[\s\S]*Next review: not while stopped\.[\s\S]*1 armed order is not watched until you start auto trading\./);
  const w={sentByThemselves:1,proposedOnly:0,buys:0,covers:0,waiting:[],notStarted:[]};
  assert.match(C.statusText(fakeAutomation({armed:[{symbol:'990001'}],watching:true,whileStopped:w})),/Your 1 armed order is still watched and is sent by itself if its conditions are met\./,'the words Home and Stop use');
  assert.match(C.statusText(fakeAutomation({})),/No armed orders\./);
});

test('Status amounts follow "Show amounts in snapshots": the account value only with it on',()=>{
  assert.doesNotMatch(C.statusText(fakeAutomation({}),{equity:()=>12345678}),/₩/);
  assert.match(C.statusText(fakeAutomation({config:{phoneAmounts:true}}),{equity:()=>12345678}),/Account value: ₩12,345,678\./);
  assert.doesNotMatch(C.statusText(fakeAutomation({config:{phoneAmounts:true}}),{equity:()=>null}),/Account value/,'unknown: not shown');
});

test('Stop and Stop everything call the desktop\'s functions and answer with their own sentences',async()=>{
  const calls=[];const launch={stop:a=>{calls.push('stop');return 'Auto trading stopped. Existing broker orders remain active.';}};
  const a={...fakeAutomation({}),stopEverything:()=>{calls.push('stopall');return L.EVERYTHING_STOPPED;}};const ex=C.createExecutor({automation:a,launch});
  assert.deepEqual(await ex.run({command:'stop'}),{text:'Auto trading stopped. Existing broker orders remain active.',changed:true});assert.deepEqual(await ex.run({command:'stopall'}),{text:L.EVERYTHING_STOPPED,changed:true});assert.deepEqual(calls,['stop','stopall']);
  assert.equal(await ex.run({command:'start'}),C.NOT_YET);assert.equal(await ex.run({command:'link'}),C.NOT_YET);assert.deepEqual(await ex.summary(),{ok:false,text:C.NOT_YET});
  const failing=C.createExecutor({automation:a,launch:{stop:()=>{throw Object.assign(new Error('X'),{text:'the account is changing'});}}});assert.deepEqual(await failing.run({command:'stop'}),{text:'Not stopped: the account is changing.',changed:false});
});

test('on a real Automation: a phone Stop is the desktop Stop (auto-launch.cjs stop), and Stop everything is automation.stopEverything',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const make=()=>{const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]);const a=new Automation(db,paper,{request:async()=>({})},()=>{});a.config.enabled=true;a.sessionArmed=true;return a;};
  const desk=make(),phone=make();const want=L.stop(desk);const got=await C.createExecutor({automation:phone}).run({command:'stop'});
  assert.equal(got.text,want,'the same sentence');assert.equal(phone.config.enabled,false);assert.equal(phone.autoTradingRuns(),false);
  const e1=make(),e2=make();assert.equal((await C.createExecutor({automation:e2}).run({command:'stopall'})).text,e1.stopEverything());
});

test('the switch: Phone control is off by default, a boolean like the other settings; the app starts the service only with it on',()=>{
  const {DEFAULTS,Automation}=require('../electron/automation.cjs');assert.equal(DEFAULTS.phoneControl,false);
  const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  assert.equal(a.config.phoneControl,false);assert.throws(()=>a.configure({phoneControl:'yes'}),/INVALID_SETTINGS/);a.configure({phoneControl:true});assert.equal(a.config.phoneControl,true);
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("const on=automation.config.phoneControl===true&&Boolean(providers);"),'started only with the switch on and a provider file');
  assert.ok(src.includes("if(!on){if(phoneControl){phoneControl.stop();phoneControl=null;}return;}"),'turned off: stopped at once');
  assert.ok(src.includes("automation.configure(value);phoneSync();"),'checked after every settings save');
});

test('end to end without the network: the worker\'s ids build the core; Status and Stop answer; nothing before the ids',async()=>{
  const db=new DatabaseSync(':memory:');let now=1795600000000;const sent=[];const a={...fakeAutomation({}),stopEverything:()=>L.EVERYTHING_STOPPED};let stopped=0;
  const svc=new PhoneService({makeCore:al=>new PhoneCore(db,{allow:al,clock:()=>now}),spawn:()=>({postMessage:m=>sent.push(m),on(){},kill(){}}),clock:()=>now,
    executor:C.createExecutor({automation:a,launch:{stop:()=>{stopped++;return 'Auto trading stopped. Existing broker orders remain active.';}}})});svc.start('p','s');
  let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));const data=command=>({id:idAt(now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command});
  await svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:data('stop')});assert.equal(stopped,0,'no core yet: nothing done');assert.equal(sent.filter(m=>m.op==='reply').length,0);
  await svc.handle({type:'state',state:'keys-ok',allow:{...allow,user:['bad']}});assert.equal(svc.core,null,'malformed ids: no core');
  await svc.handle({type:'state',state:'keys-ok',allow});assert.ok(svc.core);
  await svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:data('status')});assert.match(sent.at(-1).text,/^Auto trading: stopped/);
  await svc.handle({type:'interaction',ref:'c'.repeat(24),interaction:data('stop')});assert.equal(stopped,1);assert.equal(sent.at(-1).text,'Auto trading stopped. Existing broker orders remain active.');
  await svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:data('stopall')});assert.equal(sent.at(-1).text,L.EVERYTHING_STOPPED);
});

test('one Activity line per command, in fixed words or the desktop\'s sentence; refusals with no answer at most once a minute; no PIN, token or id',async()=>{
  const db=new DatabaseSync(':memory:');let now=1795600000000;const lines=[];const sent=[];const a={...fakeAutomation({}),stopEverything:()=>L.EVERYTHING_STOPPED};
  const svc=new PhoneService({makeCore:al=>new PhoneCore(db,{allow:al,clock:()=>now}),spawn:()=>({postMessage:m=>sent.push(m),on(){},kill(){}}),clock:()=>now,log:(t,b)=>lines.push([t,b]),
    executor:C.createExecutor({automation:a,launch:{stop:()=>'Auto trading stopped. Existing broker orders remain active.'}})});svc.start('p','s');await svc.handle({type:'state',state:'keys-ok',allow});
  let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));const data=(command,extra={})=>({id:idAt(now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command,...extra});
  await svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:data('status')});await svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:data('stop')});
  for(let i=0;i<5;i++)await svc.handle({type:'interaction',ref:String(i).repeat(24).slice(0,24).replace(/\d/g,'c'),interaction:data('stop',{userId:'100000000000000099'})});
  svc.core.setPin('482913');await svc.handle({type:'interaction',ref:'e'.repeat(24),interaction:data('nottaken',{options:[{name:'order',value:'A1'}]})});
  assert.deepEqual(lines,[['Phone command · status','Status sent.'],['Phone command · stop','Auto trading stopped. Existing broker orders remain active.'],['Phone command refused','A command was not answered (not-user). Refusals like this are noted at most once a minute.'],['Phone command · nottaken',C.NOT_YET]]);
  const all=JSON.stringify(lines);for(const secret of ['482913',...Object.values(allow),'100000000000000099'])assert.ok(!all.includes(secret),secret.slice(0,4));
});

test('the Phone control switch is not part of the start token: turning it on or off never refuses a Start held with an earlier token',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const before=L.launchState(a).token;a.configure({phoneControl:true});assert.equal(L.launchState(a).token,before);a.configure({intervalMinutes:15});assert.notEqual(L.launchState(a).token,before,'any other setting still changes it');
});

// Review of P3: seven changes.
function serviceRig({opts={}}={}){const db=new DatabaseSync(':memory:');let now=1795600000000;const sent=[],lines=[],alerts=[];let handlers={};
  const a={...fakeAutomation({}),stopEverything:()=>L.EVERYTHING_STOPPED};
  const svc=new PhoneService({makeCore:al=>new PhoneCore(db,{allow:al,clock:()=>now}),spawn:()=>({postMessage:m=>sent.push(m),on:(e,fn)=>{handlers[e]=fn;},kill(){}}),clock:()=>now,
    log:(t,b)=>lines.push([t,b]),notify:t=>alerts.push(t),executor:C.createExecutor({automation:a,launch:{stop:()=>'Auto trading stopped. Existing broker orders remain active.'}}),...opts});svc.start('p','s');
  let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));
  const data=(command,extra={})=>({id:idAt(now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command,...extra});
  return {svc,db,sent,lines,alerts,data,emit:m=>handlers.message(m),tick:()=>new Promise(r=>setImmediate(r))};}

test('review 1: through the worker listener, an interaction and a state message in their raw shapes',async()=>{
  const r=serviceRig();r.emit({type:'state',state:'keys-ok',allow});await r.tick();assert.ok(r.svc.core,'the state message as posted');
  r.emit({type:'interaction',ref:'a'.repeat(24),interaction:r.data('status')});await r.tick();await r.tick();
  assert.match(r.sent.find(m=>m.op==='reply')?.text??'',/^Auto trading: stopped/,'answered through the listener');
});

test('review 2: a second keys-ok, whatever its ids, changes no one\'s rights; said once',async()=>{
  const r=serviceRig();await r.svc.handle({type:'state',state:'keys-ok',allow});const core=r.svc.core;
  for(let i=0;i<3;i++)await r.svc.handle({type:'state',state:'keys-ok',allow:{...allow,user:'100000000000000099'}});
  assert.equal(r.svc.core,core,'the same core');await r.svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:r.data('stop',{userId:'100000000000000099'})});
  assert.equal(r.sent.filter(m=>m.kind==='message').length,0,'the other user\'s Stop is not acted on');
  assert.equal(r.lines.filter(l=>l[1]==='Phone control: the worker reported other ids; ignored.').length,1);
});

test('review 3: the service follows the provider file (choose, reconnect, forget)',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("const phoneRestart=()=>{try{phoneControl?.stop();}catch{}phoneControl=null;try{phoneSync();}catch{}};"));
  assert.ok(src.includes("remembered.remember('providers',file);remembered.progress.providers='connected';phoneRestart();"),'a file chosen or reconnected: restarted with its keys');
  assert.ok(src.includes("if(kind==='providers'){providerService.disconnect();phoneRestart();"),'forgotten: stopped (no file, so phoneSync does not start it)');
});

test('review 4: link and nottaken answer "not active yet" at once: no PIN form, no PIN counted, nothing held',async()=>{
  const r=serviceRig();await r.svc.handle({type:'state',state:'keys-ok',allow});r.svc.core.setPin('482913');
  for(const [cmd,options] of [['link',[{name:'order',value:'A1'},{name:'number',value:'1'}]],['nottaken',[{name:'order',value:'A1'}]],['start',[]]]){
    await r.svc.handle({type:'interaction',ref:'c'.repeat(24),interaction:r.data(cmd,{options})});assert.deepEqual(r.sent.at(-1),{op:'reply',ref:'c'.repeat(24),kind:'message',text:C.NOT_YET},cmd);}
  assert.equal(r.sent.some(m=>m.kind==='modal'),false);assert.equal(r.svc.core.pending.size,0);assert.equal(r.svc.core.pinState().wrong,0);
});

test('review 5: one alert for each command that changes state; none for Status or a refusal',async()=>{
  const r=serviceRig();await r.svc.handle({type:'state',state:'keys-ok',allow});
  await r.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:r.data('status')});await r.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:r.data('stop',{userId:'100000000000000099'})});assert.deepEqual(r.alerts,[]);
  await r.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:r.data('stop')});await r.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:r.data('stopall')});
  assert.deepEqual(r.alerts,['Auto trading stopped from the phone.','Everything stopped from the phone.']);
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');assert.ok(src.includes("notify:(text,command)=>{try{automation.notify?.('phone-'+String(command)+'-'+Date.now()+'-'+(++phoneAlertSeq),text);}catch{}},"),'the app\'s own alert path');
});

test('review 6: Status never fails (each line on its own); an Activity title takes only the seven names',async()=>{
  const bad={config:{scope:'kis',conditionalOrders:true},autoTradingRuns:()=>{throw new Error('x');},live:{getConnection:()=>{throw new Error('x');},orders:()=>[null,7,{status:'Uncertain'}]},
    nextReviewAt:()=>{throw new Error('x');},desk:{orders:()=>{throw new Error('x');}},watchScope:()=>'s',providerWaitState:()=>[null,{name:5},{name:'OpenAI',nextTry:'12:00'}],lastRun:'odd'};
  const t=C.statusText(bad);assert.match(t,/^Auto trading: not known\./);assert.match(t,/Armed orders: not known\./);assert.match(t,/1 order has a lost KIS reply/);assert.match(t,/OpenAI: waiting, next try 12:00 KST\./);
  assert.equal(C.statusText({config:{conditionalOrders:true},live:{orders:()=>{throw 1;}},desk:{orders:()=>{throw 1;}}}),'Status could not be read.');
  const w={...fakeAutomation({armed:[{symbol:'990001'}],watching:true,whileStopped:'odd shape'})};assert.match(C.statusText(w),/1 armed order is not watched until you start auto trading\./);
  const r=serviceRig();await r.svc.handle({type:'state',state:'keys-ok',allow});await r.svc.handle({type:'interaction',ref:'e'.repeat(24),interaction:r.data('<@x>sell')});
  assert.deepEqual(r.lines.at(-1)[0],'Phone command · unknown');
});

test('review 7: the Phone control switch does not change the keep-alive\'s stamp',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const before=a.prefixStamp();a.configure({phoneControl:true});assert.equal(a.prefixStamp(),before);a.configure({intervalMinutes:15});assert.notEqual(a.prefixStamp(),before);
});

// P3 follow-ups A-D (planner, 2026-11-26).
test('follow-up A: a provider file whose import fails restarts (or stops) the phone service too',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("catch{if(closing)return;providerService.disconnect();phoneRestart();automation.providerStatus="),'the failure path follows the remembered file as the success path does');
});

test('follow-up B: what could not be read says so; nothing read gives the last-resort sentence',()=>{
  assert.equal(C.statusText(null),'Status could not be read.');assert.equal(C.statusText(undefined),'Status could not be read.');assert.equal(C.statusText({}),'Status could not be read.');
  const t=C.statusText({...fakeAutomation({armed:[{symbol:'990001'}]}),autoTradingRuns:()=>{throw new Error('x');}});
  assert.match(t,/^Auto trading: not known\./);assert.doesNotMatch(t,/stopped|Next review/,'no guessed state');assert.match(t,/1 armed order; whether watched is not known\./);
  const u=C.statusText({...fakeAutomation({}),desk:{orders:()=>{throw new Error('x');}}});assert.match(u,/Armed orders: not known\./);assert.doesNotMatch(u,/No armed orders/);
});

test('follow-up C: no alert after "Not stopped"; two alerts in one millisecond keep apart ids',async()=>{
  const r=serviceRig({opts:{executor:C.createExecutor({automation:{...fakeAutomation({}),stopEverything:()=>{throw Object.assign(new Error('X'),{text:'the account is changing'});}},launch:{stop:()=>{throw new Error('busy');}}})}});
  await r.svc.handle({type:'state',state:'keys-ok',allow});
  await r.svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:r.data('stop')});await r.svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:r.data('stopall')});
  assert.match(r.sent.at(-1).text,/^Not stopped: the account is changing\./);assert.deepEqual(r.alerts,[],'nothing stopped: no alert');
  // The id main.cjs builds: command, time and a counter, so the outbox keeps both.
  let seq=0;const ids=[];const notify=(text,command)=>ids.push('phone-'+String(command)+'-'+1795600000000+'-'+(++seq));notify('a','stop');notify('b','stop');assert.notEqual(ids[0],ids[1]);
  const q=serviceRig();const got=[];q.svc.notify=(t,c)=>got.push(c);await q.svc.handle({type:'state',state:'keys-ok',allow});
  await q.svc.handle({type:'interaction',ref:'c'.repeat(24),interaction:q.data('stop')});await q.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:q.data('stopall')});assert.deepEqual(got,['stop','stopall'],'the command goes with the alert');
});

test('follow-up D: each launch starts with no core; start, link and nottaken say "not active yet" with no PIN or a locked PIN',async()=>{
  const r=serviceRig();await r.svc.handle({type:'state',state:'keys-ok',allow});assert.ok(r.svc.core);
  r.svc.launch();assert.equal(r.svc.core,null,'a new launch: no core until its own keys-ok');
  await r.svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:r.data('stop')});assert.equal(r.sent.filter(m=>m.op==='reply').length,0,'a command in the gap is ignored');
  await r.svc.handle({type:'state',state:'keys-ok',allow});assert.ok(r.svc.core,'the new launch\'s keys-ok is accepted');
  for(const cmd of ['start','link','nottaken']){await r.svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:r.data(cmd,{options:cmd==='start'?[]:cmd==='link'?[{name:'order',value:'A1'},{name:'number',value:'1'}]:[{name:'order',value:'A1'}]})});assert.equal(r.sent.at(-1).text,C.NOT_YET,cmd+', no PIN set');}
  r.svc.core.setPin('482913');const s=r.svc.core.pinState();r.svc.core.writePin({...s,wrong:5,locked:true});
  for(const cmd of ['start','nottaken']){await r.svc.handle({type:'interaction',ref:'c'.repeat(24),interaction:r.data(cmd,{options:cmd==='start'?[]:[{name:'order',value:'A1'}]})});assert.equal(r.sent.at(-1).text,C.NOT_YET,cmd+', PIN locked');}
  await r.svc.handle({type:'interaction',ref:'d'.repeat(24),interaction:r.data('status')});assert.match(r.sent.at(-1).text,/^Auto trading:/,'Status still works');
});
