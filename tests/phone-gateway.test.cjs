// Phone control P2 (artifacts/reviews/2026-11-25-phone-control): the gateway client, the phone worker and the main
// process's service, against a stand-in gateway, a fake fetch and manual timers. No request leaves the process; made-up
// ids and tokens only.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Gateway,NEVER_RECONNECT}=require('../electron/discord-gateway.cjs');const W=require('../electron/phone-worker.cjs');
const {PhoneService,NOT_YET}=require('../electron/phone-service.cjs');const {PhoneCore}=require('../electron/phone-core.cjs');
const TOKEN='MTAwMDAwMDAwMDAwMDAwMDA0.FAKE.made-up-bot-token-for-tests',ITOKEN='aW50ZXJhY3Rpb24tbWFkZS11cA-made-up';
const allow={application:'100000000000000004',server:'100000000000000002',channel:'100000000000000003',user:'100000000000000001'};
// Manual timers.
function timers(){let now=0,list=[];return {now:()=>now,st:(fn,ms)=>{const t={fn,at:now+ms};list.push(t);return t;},ct:t=>{list=list.filter(x=>x!==t);},
  advance(ms){const end=now+ms;for(;;){const next=list.filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!next)break;list=list.filter(x=>x!==next);now=next.at;next.fn();}now=end;},pending:()=>list.length};}
// The stand-in gateway: every socket opened, what it was sent, and a way to speak as Discord.
function standIn(){const sockets=[];class WS{constructor(url){this.url=url;this.sent=[];this.closed=null;sockets.push(this);}send(m){this.sent.push(JSON.parse(m));}close(code){this.closed=code;}
    speak(m){this.onmessage?.({data:JSON.stringify(m)});}drop(code){this.onclose?.({code});}}return {WS,sockets};}
function fakeFetch(handler){const calls=[];const f=async(url,init)=>{calls.push({url,method:init.method,auth:init.headers?.authorization,body:init.body?JSON.parse(init.body):null});
  const r=handler?.(url,init)??{status:200,body:{url:'wss://gateway.discord.gg'}};return {ok:r.status<300,status:r.status,json:async()=>r.body};};f.calls=calls;return f;}
const tick=()=>new Promise(r=>setImmediate(r));

test('connect: GET /gateway/bot, then Hello → Identify with intents 0; heartbeats after a random first delay',async()=>{
  const g0=standIn(),t=timers(),f=fakeFetch(),states=[];const g=new Gateway({token:TOKEN,fetch:f,WebSocket:g0.WS,setTimeout:t.st,clearTimeout:t.ct,random:()=>0.25,onState:s=>states.push(s.state)});
  g.start();await tick();await tick();assert.equal(f.calls[0].url,'https://discord.com/api/v10/gateway/bot');assert.equal(f.calls[0].auth,'Bot '+TOKEN);
  const ws=g0.sockets[0];assert.equal(ws.url,'wss://gateway.discord.gg?v=10&encoding=json');
  ws.speak({op:10,d:{heartbeat_interval:40000}});assert.deepEqual(ws.sent[0],{op:2,d:{token:TOKEN,intents:0,properties:{os:'windows',browser:'financial-portfolio-manager',device:'financial-portfolio-manager'}}});
  t.advance(9999);assert.equal(ws.sent.length,1);t.advance(1);assert.deepEqual(ws.sent[1],{op:1,d:null},'first beat at interval × random');
  ws.speak({op:0,t:'READY',s:1,d:{session_id:'S1',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'}});assert.ok(states.includes('ready'));
  ws.speak({op:11});t.advance(40000);assert.deepEqual(ws.sent[2],{op:1,d:1},'the last seq');
  ws.speak({op:1});assert.deepEqual(ws.sent.at(-1),{op:1,d:1},'a beat Discord asks for is sent at once');
});

test('a zombie connection (no ACK) is closed with 4000 and resumed on the resume URL with the session and seq',async()=>{
  const g0=standIn(),t=timers(),f=fakeFetch();const g=new Gateway({token:TOKEN,fetch:f,WebSocket:g0.WS,setTimeout:t.st,clearTimeout:t.ct,random:()=>0});
  g.start();await tick();await tick();const ws=g0.sockets[0];ws.speak({op:10,d:{heartbeat_interval:1000}});ws.speak({op:0,t:'READY',s:5,d:{session_id:'S1',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'}});
  t.advance(0);t.advance(1000);assert.equal(ws.closed,4000,'no ACK after the first beat');
  t.advance(5000);await tick();const ws2=g0.sockets[1];assert.equal(ws2.url,'wss://gateway-us-east1-b.discord.gg?v=10&encoding=json');assert.equal(f.calls.length,1,'no new /gateway/bot for a resume');
  ws2.speak({op:10,d:{heartbeat_interval:1000}});assert.deepEqual(ws2.sent[0],{op:6,d:{token:TOKEN,session_id:'S1',seq:5}});
});

test('op 7 resumes; op 9 false identifies anew; close codes 4004 and 4010-4014 are never retried; others back off 5 s doubling to 5 minutes',async()=>{
  const g0=standIn(),t=timers(),f=fakeFetch(),states=[];const g=new Gateway({token:TOKEN,fetch:f,WebSocket:g0.WS,setTimeout:t.st,clearTimeout:t.ct,random:()=>0,onState:s=>states.push(s)});
  g.start();await tick();await tick();let ws=g0.sockets[0];ws.speak({op:10,d:{heartbeat_interval:1000}});ws.speak({op:0,t:'READY',s:2,d:{session_id:'S1',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'}});
  ws.speak({op:7});assert.equal(ws.closed,4000);t.advance(5000);await tick();ws=g0.sockets.at(-1);ws.speak({op:10,d:{heartbeat_interval:1000}});assert.equal(ws.sent[0].op,6,'op 7: resume');
  ws.speak({op:9,d:false});t.advance(10000);await tick();await tick();ws=g0.sockets.at(-1);ws.speak({op:10,d:{heartbeat_interval:1000}});assert.equal(ws.sent[0].op,2,'op 9 false: a new Identify');
  const waits=[];for(let i=0;i<8;i++){ws=g0.sockets.at(-1);ws.drop(4000);const w=states.filter(s=>s.state==='waiting').at(-1).waitMs;waits.push(w);t.advance(w);await tick();await tick();}
  assert.deepEqual(waits,[20000,40000,80000,160000,300000,300000,300000,300000].map((x,i)=>i===0?x:x),'doubling to 5 minutes (two waits were used before)');
  for(const code of NEVER_RECONNECT){const g1=standIn(),t1=timers(),st1=[];const gg=new Gateway({token:TOKEN,fetch:fakeFetch(),WebSocket:g1.WS,setTimeout:t1.st,clearTimeout:t1.ct,onState:s=>st1.push(s)});
    gg.start();await tick();await tick();g1.sockets[0].drop(code);t1.advance(600000);await tick();assert.equal(g1.sockets.length,1,String(code));assert.deepEqual(st1.at(-1),{state:'refused',code});}
  const g2=standIn(),t2=timers(),st2=[];const bad=new Gateway({token:TOKEN,fetch:fakeFetch(()=>({status:401,body:{}})),WebSocket:g2.WS,setTimeout:t2.st,clearTimeout:t2.ct,onState:s=>st2.push(s)});
  bad.start();await tick();await tick();assert.deepEqual(st2.at(-1),{state:'refused',code:401},'a refused token at /gateway/bot is not retried');
});

test('a 429 waits for retry_after once; the token is in no state the client hands out',async()=>{
  let n=0;const t=timers();const f=fakeFetch(()=>n++===0?{status:429,body:{retry_after:2}}:{status:200,body:{ok:true}});
  const states=[];const g=new Gateway({token:TOKEN,fetch:f,WebSocket:standIn().WS,setTimeout:t.st,clearTimeout:t.ct,onState:s=>states.push(s)});
  const p=g.api('POST','/x',{a:1});await tick();t.advance(2000);assert.deepEqual(await p,{ok:true});assert.equal(f.calls.length,2);
  assert.ok(!JSON.stringify(states).includes(TOKEN));
});

test('the worker reads the five keys itself: missing or invalid ones are named, never their values; the provider file is otherwise not its business',()=>{
  const good={discordBotToken:TOKEN,discordApplicationId:allow.application,discordServerId:allow.server,discordChannelId:allow.channel,discordUserId:allow.user,openaiApiKey:'sk-other'};
  assert.deepEqual(W.readKeys(JSON.stringify(good)).keys,{token:TOKEN,allow});
  const r=W.readKeys(JSON.stringify({...good,discordServerId:'12',discordUserId:undefined,discordBotToken:'bad token!'}));
  assert.deepEqual([r.missing,r.invalid],[['discordUserId'],['discordBotToken','discordServerId']]);assert.ok(!JSON.stringify(r).includes('bad token'));
  const posted=[];const w=new W.PhoneWorker({readFile:()=>JSON.stringify({openaiApiKey:'sk-other'}),post:m=>posted.push(m)});w.start('p');
  assert.deepEqual(posted[0],{type:'state',state:'not-set-up',missing:[...W.KEYS],invalid:[]});
});

// The worker with a stand-in gateway object (the Gateway class is replaced, so no socket is opened).
function worker({state=null}={}){const posted=[],api=[],t=timers();let dispatch,onState;
  class G{constructor(o){dispatch=o.onDispatch;onState=o.onState;}start(){}stop(){}async api(method,path,body){api.push({method,path,body});return null;}}
  const w=new W.PhoneWorker({readFile:()=>JSON.stringify({discordBotToken:TOKEN,discordApplicationId:allow.application,discordServerId:allow.server,discordChannelId:allow.channel,discordUserId:allow.user}),
    readState:()=>state,writeState:v=>{state=v;},post:m=>posted.push(m),setTimeout:t.st,clearTimeout:t.ct,clock:t.now,Gateway:G});w.start('p');
  return {w,posted,api,t,dispatch:d=>dispatch('INTERACTION_CREATE',d),ready:()=>onState({state:'ready'}),get state(){return state;}};}
const ix=(extra={})=>({id:'1400000000000000000',token:ITOKEN,type:2,application_id:allow.application,guild_id:allow.server,channel_id:allow.channel,member:{user:{id:allow.user}},data:{name:'status'},...extra});

test('the worker registers the seven commands for the one server once, admins only; again only when they change',async()=>{
  const k=worker();k.ready();await tick();assert.equal(k.api[0].method,'PUT');assert.equal(k.api[0].path,`/applications/${allow.application}/guilds/${allow.server}/commands`);
  assert.deepEqual(k.api[0].body.map(c=>c.name),['status','stop','stopall','start','orders','link','nottaken']);assert.ok(k.api[0].body.every(c=>c.default_member_permissions==='0'&&c.type===1));
  k.ready();await tick();assert.equal(k.api.length,1,'unchanged: not registered again');
});

test('the worker answers within 3 s itself, hands over only checked fields (no token), and ignores anyone else',async()=>{
  const k=worker();await k.dispatch(ix());assert.deepEqual(k.api[0].body,{type:5,data:{flags:64}},'an ephemeral defer at once');
  const m=k.posted.find(p=>p.type==='interaction');assert.match(m.ref,/^[a-f0-9]{24}$/);assert.ok(!JSON.stringify(k.posted).includes(ITOKEN)&&!JSON.stringify(k.posted).includes(TOKEN),'no token reaches the main process');
  assert.deepEqual(m.interaction,{id:'1400000000000000000',type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command:'status'});
  for(const other of [{member:{user:{id:'100000000000000099'}}},{guild_id:'100000000000000099'},{channel_id:'100000000000000099'},{application_id:'100000000000000099'},{member:undefined,user:{id:allow.user}}]){
    const before=k.api.length;await k.dispatch(ix({...other,id:'1400000000000000001'}));assert.equal(k.api.length,before,'no answer at all');}
  await k.w.reply({ref:m.ref,kind:'message',text:'Running.'});assert.deepEqual(k.api.at(-1),{method:'PATCH',path:`/webhooks/${allow.application}/${ITOKEN}/messages/@original`,body:{content:'Running.',allowed_mentions:{parse:[]},components:[]}});
  await k.w.reply({ref:m.ref,kind:'message',text:'again'});assert.equal(k.api.at(-1).body.content,'Running.','one answer per interaction');
});

test('the PIN form: link answers with the form once the main process gives the nonce; the form submit carries the PIN to the main process only',async()=>{
  const k=worker();await k.dispatch(ix({data:{name:'link',options:[{name:'order',value:'A1'},{name:'number',value:'99'}]}}));assert.equal(k.api.length,0,'no defer: the form must be the first answer');
  const m=k.posted.find(p=>p.type==='interaction');const nonce='a'.repeat(32);await k.w.reply({ref:m.ref,kind:'modal',nonce});
  const form=k.api[0].body;assert.equal(form.type,9);assert.equal(form.data.custom_id,'pin:'+nonce);assert.deepEqual(form.data.components[0].component,{type:4,custom_id:'pin',style:1,min_length:6,max_length:12,required:true});
  await k.dispatch(ix({id:'1400000000000000002',type:5,data:{custom_id:'pin:'+nonce,components:[{type:18,component:{type:4,custom_id:'pin',value:'482913'}}]}}));
  const sub=k.posted.filter(p=>p.type==='interaction').at(-1);assert.equal(sub.interaction.pin,'482913');assert.equal(sub.interaction.customId,'pin:'+nonce);
  // The main process does not answer in time: the worker says so itself before Discord's 3 seconds.
  const j=worker();await j.dispatch(ix({data:{name:'nottaken',options:[{name:'order',value:'A1'}]}}));j.t.advance(2500);await tick();
  assert.deepEqual(j.api[0].body,{type:4,data:{content:'The app did not answer in time. Try again.',flags:64,allowed_mentions:{parse:[]}}});
});

test('the main process: messages checked (type, size, ref, rate); the PIN goes to the core only; a crashing worker restarts after 5 s doubling to 5 minutes',async()=>{
  const db=new DatabaseSync(':memory:');let now=1795600000000;const core=new PhoneCore(db,{allow,clock:()=>now});const t=timers();
  const workers=[];const spawn=()=>{const h={};const w={sent:[],postMessage:m=>w.sent.push(m),on:(e,fn)=>{h[e]=fn;},kill(){},emit:(e,v)=>h[e]?.(v)};workers.push(w);return w;};
  const states=[];const svc=new PhoneService({core,spawn,onState:s=>states.push(s),clock:()=>now,setTimeout:t.st,clearTimeout:t.ct});svc.start('provider.json','state.json');
  assert.deepEqual(workers[0].sent[0],{op:'start',providerPath:'provider.json',statePath:'state.json'});
  const idAt=ms=>String((BigInt(ms)-1420070400000n)<<22n);const data=extra=>({id:idAt(now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command:'status',...extra});
  await svc.handle({type:'interaction',ref:'b'.repeat(24),interaction:data()});assert.deepEqual(workers[0].sent.at(-1),{op:'reply',ref:'b'.repeat(24),kind:'message',text:NOT_YET},'not active yet in P2');
  for(const bad of [null,[],'x',{type:'interaction',ref:'short',interaction:data()},{type:'interaction',ref:'c'.repeat(24),interaction:[]},{type:'nope'},{type:'state',state:'made-up'},{type:'interaction',ref:'d'.repeat(24),interaction:{...data(),pad:'x'.repeat(9000)}}]){
    const before=workers[0].sent.length;await svc.handle(bad);assert.equal(workers[0].sent.length,before,JSON.stringify(bad)?.slice(0,40));}
  await svc.handle({type:'state',state:'not-set-up',missing:['discordUserId','made-up-key'],invalid:[]});assert.deepEqual(states.at(-1).missing,['discordUserId'],'only known key names');
  core.setPin('482913');const sub={id:idAt(now),type:5,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,customId:'pin:'+'e'.repeat(32),pin:'482913'};
  await svc.handle({type:'interaction',ref:'f'.repeat(24),interaction:sub});assert.equal(sub.pin,undefined,'dropped after the core');assert.ok(!JSON.stringify([states,workers[0].sent,core.records()]).includes('482913'));
  // At most 30 messages a minute.
  for(let i=0;i<70;i++)await svc.handle({type:'state',state:'ready'});assert.ok(svc.status.dropped>0);
  // Crash loop.
  const waits=[];for(let i=0;i<8;i++){workers.at(-1).emit('exit',1);waits.push(svc.status.waitMs);t.advance(svc.status.waitMs);}
  assert.deepEqual(waits,[5000,10000,20000,40000,80000,160000,300000,300000]);assert.equal(workers.length,9);
  now+=600000;workers.at(-1).emit('exit',1);assert.equal(svc.status.waitMs,5000,'a run of 10 minutes resets the wait');
  svc.stop();const n=workers.length;workers.at(-1).emit('exit',0);t.advance(600000);assert.equal(workers.length,n,'no restart after stop');
});

test('the provider worker accepts the five Discord names and drops their values; a malformed one never stops the AI keys',()=>{
  const R=require('../electron/ai-router.cjs');const v=R.parseProviderFile(JSON.stringify({openaiApiKey:'sk-'+'a'.repeat(40),discordBotToken:'not a valid token!',discordApplicationId:'12',discordServerId:allow.server,discordChannelId:allow.channel,discordUserId:allow.user}));
  assert.equal(v.openaiApiKey,'sk-'+'a'.repeat(40));for(const k of W.KEYS)assert.ok(!(k in v),k+' dropped');
  assert.throws(()=>R.parseProviderFile(JSON.stringify({discordBotTokn:'x'})),/INVALID_PROVIDER_FILE/,'a misspelt name is still an unknown key');
});

// Review of P2: three hardenings.
test('review 1: the token goes only to Discord\'s gateway host; look-alikes, credentials and ports are a failed connect, said once',async()=>{
  const {gatewayUrlOk}=require('../electron/discord-gateway.cjs');
  for(const ok of ['wss://gateway.discord.gg','wss://gateway-us-east1-b.discord.gg/?x=1','wss://discord.gg'])assert.equal(gatewayUrlOk(ok),true,ok);
  for(const bad of ['wss://discord.gg.example','wss://example.com/discord.gg','wss://user:pass@gateway.discord.gg','wss://gateway.discord.gg:8443','ws://gateway.discord.gg','https://gateway.discord.gg','wss://evildiscord.gg','not a url',''])assert.equal(gatewayUrlOk(bad),false,bad);
  const g0=standIn(),t=timers(),states=[];const g=new Gateway({token:TOKEN,fetch:fakeFetch(()=>({status:200,body:{url:'wss://discord.gg.example'}})),WebSocket:g0.WS,setTimeout:t.st,clearTimeout:t.ct,onState:s=>states.push(s.state)});
  g.start();await tick();await tick();assert.equal(g0.sockets.length,0,'no socket, no token sent');t.advance(5000);await tick();await tick();
  assert.equal(states.filter(s=>s==='bad-gateway-url').length,1,'said once');
  const g1=standIn(),t1=timers(),st1=[];const h=new Gateway({token:TOKEN,fetch:fakeFetch(),WebSocket:g1.WS,setTimeout:t1.st,clearTimeout:t1.ct,random:()=>0,onState:s=>st1.push(s.state)});
  h.start();await tick();await tick();const ws=g1.sockets[0];ws.speak({op:10,d:{heartbeat_interval:1000}});ws.speak({op:0,t:'READY',s:1,d:{session_id:'S',resume_gateway_url:'wss://user:pass@gateway.discord.gg'}});
  assert.equal(h.resumeUrl,null,'a bad resume URL is not kept');assert.ok(st1.includes('bad-gateway-url'));
});

test('review 2: every message the bot posts or edits mentions no one',async()=>{
  const k=worker();await k.dispatch(ix({data:{name:'start'}}));const m=k.posted.find(p=>p.type==='interaction');
  await k.w.reply({ref:m.ref,kind:'summary',text:'@everyone Start Fixture',nonce:'a'.repeat(32)});assert.deepEqual(k.api.at(-1).body.allowed_mentions,{parse:[]});
  const j=worker();await j.dispatch(ix());const n=j.posted.find(p=>p.type==='interaction');await j.w.reply({ref:n.ref,kind:'message',text:'<@100000000000000001>'});assert.deepEqual(j.api.at(-1).body.allowed_mentions,{parse:[]});
});

test('review 3: an interaction over the limit gets the busy sentence; state messages are counted apart and cannot starve commands',async()=>{
  const db=new DatabaseSync(':memory:');let now=1795600000000;const core=new PhoneCore(db,{allow,clock:()=>now});const sent=[];
  const svc=new PhoneService({core,spawn:()=>({postMessage:m=>sent.push(m),on(){},kill(){}}),clock:()=>now});svc.start('p','s');
  const idAt=ms=>String((BigInt(ms)-1420070400000n)<<22n|BigInt(sent.length));const data=()=>({id:idAt(now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command:'status'});
  for(let i=0;i<100;i++)await svc.handle({type:'state',state:'ready'});
  await svc.handle({type:'interaction',ref:'a'.repeat(24),interaction:data()});assert.equal(sent.at(-1).kind,'message','a command still gets through after 100 state messages');
  for(let i=0;i<40;i++)await svc.handle({type:'interaction',ref:(i.toString(16).padStart(2,'0')).repeat(12),interaction:data()});
  const {SENTENCES}=require('../electron/phone-core.cjs');assert.ok(sent.some(m=>m.op==='reply'&&m.text===SENTENCES.busy),'the busy sentence, not left thinking');
});
