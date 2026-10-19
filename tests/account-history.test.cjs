const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Scoreboard}=require('../electron/scoreboard.cjs');const {buildDigest}=require('../electron/daily-digest.cjs');const {PortfolioStore:Storage}=require('../electron/storage.cjs');
const rows=db=>{const add=(id,account,action='Hold')=>db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify({id,timestamp:Date.now(),decision:{action,symbol:'005930',quantity:1},contextEvidence:{environment:'kis'},...(account?{account:{key:account,label:account}}:{})}));
  add('m1','mock');add('m2','mock','Buy');add('l1','live');add('old',null);};
test('the scoreboard reads only the connected account, or everything when none is connected',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');rows(db);let key='live';
  const board=new Scoreboard(db,Date.now,()=>key);assert.deepEqual(board.reviews().map(r=>r.id),['l1']);key='mock';assert.deepEqual(board.reviews().map(r=>r.id),['m1','m2']);key=null;assert.equal(board.reviews().length,4);
});
test('the daily digest counts the connected account’s reviews only',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');rows(db);
  const a={db,config:{scope:'kis'},paper:{orders:()=>[]},live:{getState:()=>({loss:null}),orders:()=>[]},usLive:null,guardrails:{eventsOn:()=>[],failuresOn:()=>0},accountValues:()=>[],accountTag:()=>({key:'mock',label:'KIS mock'})};
  const d=buildDigest(a);assert.equal(d.reviews,2);assert.match(d.text,/2 reviews \(1 Buy, 0 Sell, 1 Hold\)/);
  assert.equal(buildDigest({...a,accountTag:()=>null}).reviews,4,'no account connected: everything');
});
test('the review list and console entries carry the account; the list filters by it',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],async()=>50000);
  const a=new Automation(db,paper,{request:async()=>({})},()=>{});rows(db);
  a.config.scope='kis';a.live={identity:()=>'live',getConnection:()=>({snapshot:{environment:'live'}})};
  assert.deepEqual(a.accountTag(),{key:'live',label:'KIS live'});assert.deepEqual(a.reviewHistory(50).map(r=>r.id),['l1']);assert.equal(a.reviewHistory(50,true).length,4);
  a.config.scope='paper';assert.deepEqual(a.accountTag(),{key:'paper',label:'Paper'});assert.deepEqual(a.reviewHistory(50).map(r=>r.id),[]);
  const store=new Storage(':memory:');store.appendEvent({id:'e1',runId:'r',timestamp:'t',kind:'Agent',title:'x',body:'y',account:'live',accountLabel:'KIS live'});store.appendEvent({id:'e2',runId:'r',timestamp:'t',kind:'Agent',title:'x',body:'y'});
  assert.deepEqual(store.getEvents().map(e=>e.account??null),['live',null]);
});
test('risk per trade accepts up to 20% and refuses more',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:1,stale:false}]),{request:async()=>({})},()=>{});
  a.configure({sizingRiskPct:10});assert.equal(a.config.sizingRiskPct,10);assert.throws(()=>a.configure({sizingRiskPct:25}));
});
test('a refused market-data request names the symbol and points to the tools that work',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const logs=[];let round=0;
  const request=async({continuation})=>{round++;if(round===1)return {toolCalls:[{name:'get_market_evidence',callId:'c1',args:{symbol:'000270',dataset:'daily_technicals'}}],continuation:[]};return {decision:{action:'Hold'},seen:continuation};};
  const result=await researchReview({context:{universe:[{symbol:'005930'}]},evidence:{get:async()=>({})},request,log:(kind,title,body)=>logs.push({title,body})});
  const refused=logs.find(l=>l.title==='Request refused · get_market_evidence');assert.ok(refused);const value=JSON.parse(refused.body);
  assert.deepEqual(value.request,{symbol:'000270',dataset:'daily_technicals'});assert.match(value.reason,/000270 is not in this review's universe.*get_company_research.*update_watchlist/);
  assert.match(result.seen[0].output,/000270/,'the agent receives the same explanation');
});
