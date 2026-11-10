// Lag fix L2 (artifacts/reviews/2026-11-10-lag): a light 2-second runtime state with the history on its own request,
// and one shared runtime poller in the window.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const RS=require('../electron/runtime-state.cjs');
const review=(i,extra={})=>({id:'r'+i,timestamp:1794318000000-i*60000,trigger:'Scheduled review',provider:'openai',vendor:'openai',account:{key:'k'},contextEvidence:{big:'x'.repeat(14000)},instructions:{version:'v'},decision:{action:i%3?'Hold':'Buy',symbol:i%3?'':'005930',quantity:i%3?0:1,explanation:'Because '+i,plan:{thesis:'t'.repeat(2000)},...(i===1?{withheld:{kind:'plan',reason:'no horizon'}}:{})},...extra});
const state=()=>({config:{scope:'kis'},lessons:[{id:'l'}],reviews:Array.from({length:50},(_,i)=>review(i)),allReviews:Array.from({length:50},(_,i)=>review(i)),outcomes:Array.from({length:11},(_,i)=>({id:'o'+i,detail:'y'.repeat(7000)})),newsEvents:Array.from({length:100},(_,i)=>({id:'n'+i,title:'z'.repeat(300)})),usage:{calls:1}});

test('L2: the 2-second state drops the history lists, keeps three brief decisions and the counts, and stays under 100 KB',()=>{
  const full=state();const light=RS.lightState(full);
  for(const k of ['allReviews','outcomes','newsEvents'])assert.ok(!(k in light),k);
  assert.equal(light.reviews.length,3);assert.deepEqual(light.reviews[0],{id:'r0',timestamp:full.reviews[0].timestamp,trigger:'Scheduled review',provider:'openai',vendor:'openai',decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Because 0'}});
  assert.deepEqual(light.reviews[1].decision.withheld,{kind:'plan',reason:'no horizon'},'Home shows "Buy withheld"');
  assert.deepEqual(light.historyCounts,{reviews:50,allReviews:50,outcomes:11,newsEvents:100});
  assert.equal(light.config,full.config);assert.equal(light.lessons,full.lessons);assert.equal(light.usage,full.usage,'everything else unchanged');
  assert.ok(JSON.stringify(full).length>1500*1024,'the fixture is as large as the live state');assert.ok(JSON.stringify(light).length<100*1024,`light ${(JSON.stringify(light).length/1024).toFixed(0)} KB`);
  assert.equal(full.reviews.length,50,'the input is not changed');
  // An empty or older state.
  assert.deepEqual(RS.lightState({}).reviews,[]);assert.deepEqual(RS.lightState({}).historyCounts,{reviews:0,allReviews:0,outcomes:0,newsEvents:0});
  assert.equal(RS.lightState({reviews:[{id:'x',timestamp:1}]}).reviews[0].decision,null);
});
test('L2: the history request returns exactly the moved lists, in full',()=>{
  const full=state();const h=RS.historyOf(full);assert.deepEqual(Object.keys(h),['reviews','allReviews','outcomes','newsEvents']);
  assert.equal(h.reviews,full.reviews);assert.equal(h.allReviews.length,50);assert.deepEqual(RS.historyOf({}),{reviews:[],allReviews:[],outcomes:[],newsEvents:[]});
  assert.ok(Object.isFrozen(RS.HISTORY_KEYS));
});
test('L2: main serves the light state on runtime:get and every reply, the history on runtime:history; preload exposes it',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  assert.ok(main.includes("const runtimeState=()=>lightState({...automation.getState(),"),'every state the window receives is light');
  assert.ok(main.includes("ipcMain.handle('runtime:history',event=>{authorize(event);return historyOf(automation.getState());});"));
  assert.ok(preload.includes("getRuntimeHistory: () => ipcRenderer.invoke('runtime:history'),"));
});
test('L2: Journal and News get the history; the header, Home, the dashboard and the shell share one poller',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'../src',f),'utf8');
  const settings=read('RuntimeSettings.tsx');assert.match(settings,/const wantsHistory=mode==='journal'\|\|mode==='news';/);assert.match(settings,/getRuntimeHistory/);
  for(const f of ['WorkspaceUX.tsx','Home.tsx','Dashboard.tsx','Shell.tsx']){const src=read(f);assert.match(src,/subscribeRuntime\(/,f);}
  for(const f of ['WorkspaceUX.tsx','Dashboard.tsx','Shell.tsx'])assert.doesNotMatch(read(f),/getRuntime\(\)/,f+' no longer polls on its own');
});
test('L2: the shared poller makes one request per tick for all subscribers, keeps going while any subscribes, and stops after the last',async()=>{
  let calls=0,fail=false;const timers=new Map();let nextId=1;
  global.window={portfolio:{getRuntime:async()=>{calls++;if(fail)throw new Error('down');return {n:calls};}},setInterval:(fn,ms)=>{const id=nextId++;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id)};
  const feed=await import(require('node:url').pathToFileURL(path.join(__dirname,'../src/runtimeFeed.ts')).href);const flush=()=>new Promise(r=>setImmediate(r));
  const a=[],b=[];const stopA=feed.subscribeRuntime((s,failed)=>a.push([s?.n,failed]));await flush();
  const stopB=feed.subscribeRuntime((s,failed)=>b.push([s?.n,failed]));await flush();
  assert.equal(calls,1,'the second subscriber gets the last state without a new request');assert.deepEqual(b,[[1,false]]);assert.equal(timers.size,1,'one timer');
  [...timers.values()][0]();await flush();assert.equal(calls,2);assert.deepEqual(a.at(-1),[2,false]);assert.deepEqual(b.at(-1),[2,false]);
  fail=true;[...timers.values()][0]();await flush();assert.deepEqual(a.at(-1),[2,true],'a failure passes the last good state with failed');fail=false;
  stopA();assert.equal(timers.size,1,'still one subscriber');stopB();assert.equal(timers.size,0,'stopped after the last');
  feed.refreshRuntime();await flush();assert.equal(calls,4,'refresh asks once now');delete global.window;
});
// L2b: Journal and News fetch the history only when it can have changed.
test('L2b: the light state carries the history version; unknown is null',()=>{
  assert.equal(RS.lightState(state(),{version:'12|3|kis:a|29898'}).historyVersion,'12|3|kis:a|29898');assert.equal(RS.lightState(state()).historyVersion,null);
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.ok(main.includes('notifications:notifier.status()},{version:automation.historyVersion()});'),'read after getState, so its own writes are included');
});
test('L2b: historyVersion stays the same without writes and changes with a review, an outcome, a news event or the minute',()=>{
  const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');
  const realNow=Date.now;let now=Date.parse('2026-11-10T05:00:00Z');Date.now=()=>now;
  try{const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{throw new Error('NO_NETWORK');}},()=>{});
    a.getState();const v0=a.historyVersion();a.getState();a.getState();assert.equal(a.historyVersion(),v0,'no writes, no new version');
    const changes=[()=>db.prepare('INSERT INTO reviews VALUES(?,?)').run('x',JSON.stringify({id:'x',timestamp:now})),()=>db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run('o',JSON.stringify({id:'o'})),()=>db.prepare('UPDATE trade_outcomes SET payload=? WHERE id=?').run(JSON.stringify({id:'o',status:'closed'}),'o'),()=>db.prepare('INSERT INTO news_events(id,firstSeenAt,payload) VALUES(?,?,?)').run('n',now,JSON.stringify({id:'n'})),()=>{now+=60000;}];
    let last=a.historyVersion();for(const change of changes){change();const v=a.historyVersion();assert.notEqual(v,last);last=v;}
  }finally{Date.now=realNow;}
});
test('L2b: a page with the history does not ask again while the version is unchanged',async()=>{
  const {needsHistory}=await import(require('node:url').pathToFileURL(path.join(__dirname,'../src/runtimeFeed.ts')).href);
  assert.equal(needsHistory(undefined,'a',false),true,'page opened');assert.equal(needsHistory('a','a',true),false);assert.equal(needsHistory('a','b',true),true,'changed');assert.equal(needsHistory('a',null,true),true,'unknown: always');assert.equal(needsHistory('a','a',false),true,'no history yet');
  // The refresh loop as RuntimeSettings runs it: 2-second states with these versions; history requests counted.
  let seen,has=false,requests=0;for(const v of ['v1','v1','v1','v1','v2','v2','v3',null,'v3']){if(needsHistory(seen,v,has)){requests++;has=true;seen=v;}}
  assert.equal(requests,5,'open, v2, v3, the unknown one, then v3 again after it');
  const settings=fs.readFileSync(path.join(__dirname,'../src/RuntimeSettings.tsx'),'utf8');assert.match(settings,/needsHistory\(historySeen\.current,value\.historyVersion,Boolean\(history\.current\)\)/);assert.match(settings,/historySeen\.current=undefined;history\.current=null;void refresh\(\)/,'opening the page fetches');
});
