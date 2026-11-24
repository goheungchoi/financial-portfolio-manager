// A scheduled scout could fail with BROKER_REJECTED before its run line (artifacts/reviews/
// 2026-11-19-scout-broker-rejected, cleared with conditions) when KIS refused the Korean account read once. KIS's code is now
// kept; with both markets a market's failed read leaves it out only when the run does not focus on it; a scheduled run
// refused in passing is tried once more two minutes later. Fakes only: no broker, no AI call.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const S=require('../electron/scout.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {rejected}=require('../electron/kis-client.cjs');
const full={summary:'s',cashTargetPct:20,focus:'f',targets:[{symbol:'005930',name:'S',role:'hold',targetWeightPct:10,thesis:'t',risks:''},{symbol:'NASD:NVDA',name:'N',role:'hold',targetWeightPct:5,thesis:'t',risks:''}],briefAnswers:[],retrospective:'',substitutions:[]};
const reject=code=>Object.assign(new Error('BROKER_REJECTED'),{code:'BROKER_REJECTED',...(code?{brokerCode:code}:{})});
function app({scope='both',kr=null,us=null}={}){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:500000,holdings:[{symbol:'005930',name:'Samsung',quantity:5,averagePrice:100,price:100}]};
  const state={kr,us,calls:0,logs:[]};
  const live=new LiveEngine(db,{request:async op=>{if(op==='live-context'&&state.kr){const e=state.kr;state.kr=null;throw e;}return {balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}};}},()=>({status:'connected',snapshot}));
  const provider={request:async()=>{state.calls++;return {plan:S.validatePlan(full),answer:full,skippedTargets:[],usage:{inputTokens:1,outputTokens:1}};}};
  const a=new Automation(db,paper,provider,(id,kind,title,body)=>state.logs.push([title,body]));a.live=live;a.providerStatus.aiConnected=true;a.discovery={list:()=>[],symbols:()=>[],marketOverview:()=>({})};
  const usSnapshot={accountKey:'acct:US',environment:'mock',source:'kis-us',currency:'USD',reportedTotal:1000,cash:1000,holdings:[]};
  a.usLive=new LiveEngine(db,{request:async()=>{if(state.us){const e=state.us;state.us=null;throw e;}return {balance:usSnapshot,quotes:[],marketSession:{open:false,status:'closed'}};}},()=>({status:'connected',snapshot:usSnapshot}),{market:'US'});a.refreshUS=async()=>null;
  a.configure({scope,provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});return {a,state};}
const US_SLOT={market:'US',label:'Before the U.S. opens'},KR_SLOT={market:'KR',label:'Before Korea opens'};

test('KIS\'s message code is kept on a refused balance or quote read, and nothing else of the reply',()=>{
  const e=rejected({rt_cd:'1',msg_cd:'EGW00123',msg1:'secret text',output:{acct:'123'}});assert.equal(e.message,'BROKER_REJECTED');assert.equal(e.brokerCode,'EGW00123');assert.equal(Object.keys(e).includes('msg1'),false);
  assert.equal(rejected({rt_cd:'1',msg_cd:'bad code!'}).brokerCode,undefined);assert.equal(rejected({}).brokerCode,undefined);
  const src=fs.readFileSync(path.join(__dirname,'../electron/kis-client.cjs'),'utf8');assert.ok(src.includes("if(body.rt_cd!=='0')throw rejected(body);"),'quotation');assert.ok(src.includes("if(result.body.rt_cd!=='0') throw rejected(result.body);"),'getBalance');});

test('both markets: a failed Korean read outside the run\'s focus leaves Korea out; the run goes on for the U.S.',async()=>{
  const {a,state}=app({kr:reject('EGW00123')});const p=await a.scout('Scheduled',{slot:US_SLOT});assert.ok(p.id);assert.equal(state.calls>0,true,'the run reached its AI request');
  assert.ok(state.logs.some(([t])=>/^Scout run · Scheduled · Before the U.S. opens/.test(t)));});

test('both markets: a failed Korean read fails a run that focuses on Korea; a failed U.S. read never stops a run, in focus or not',async()=>{
  const k=app({kr:reject('EGW00123')});const e=await k.a.scout('Scheduled',{slot:KR_SLOT}).catch(x=>x);assert.equal(e.message,'BROKER_REJECTED');assert.equal(k.state.calls,0);
  assert.ok(k.state.logs.some(([t,b])=>t==='Scout failed'&&b==='BROKER_REJECTED · KIS EGW00123'),'the line names KIS\'s code: '+JSON.stringify(k.state.logs));
  const u=app({us:reject()});const f=await u.a.scout('Scheduled',{slot:US_SLOT});assert.ok(f.id,'U.S. in focus: left out, the run goes on (as in every release)');assert.ok(u.state.calls>0);
  const w=app({us:reject()});const ok=await w.a.scout('Scheduled',{slot:KR_SLOT});assert.ok(ok.id,'U.S. outside the focus: left out');
  const kis=app({scope:'kis',kr:reject()});assert.equal((await kis.a.scout('Scheduled',{slot:US_SLOT}).catch(x=>x)).message,'BROKER_REJECTED','one market only: it fails as before');});

test('the retry: once per slot, two minutes later, it waits for a review or an order send, and is dropped when no longer on time',async()=>{
  const {a,state}=app();const slot={id:'2026-11-11:before-us-open',at:Date.parse('2026-11-11T14:00:00Z'),market:'US',label:'Before the U.S. opens'};const t0=slot.at+1000;
  assert.equal(a.noteScoutRetry(slot,new Error('AI_TIMEOUT'),t0),null,'not for other failures');
  const r=a.noteScoutRetry(slot,reject('EGW00123'),t0);assert.equal(r.at,t0+120000);assert.equal(r.brokerCode,'EGW00123');assert.equal(a.noteScoutRetry(slot,reject(),t0),null,'once per slot');
  assert.equal(a.scoutRetryTick(t0+60000),null,'not before two minutes');
  a.busy=true;assert.deepEqual(a.scoutRetryTick(t0+120000),{waiting:true},'a review is running');a.busy=false;
  a.live.busy=true;assert.deepEqual(a.scoutRetryTick(t0+130000),{waiting:true},'an order is being sent');a.live.busy=false;
  assert.deepEqual(a.scoutRetryTick(t0+140000),{retried:true});assert.ok(state.logs.some(([t])=>t==='Scout run · retry after BROKER_REJECTED (EGW00123)'));
  assert.equal(a.scoutRetry,null);assert.equal(a.scoutRetryTick(t0+200000),null,'nothing left to retry');
  await new Promise(r=>setTimeout(r,50));
  const late=app().a;late.noteScoutRetry(slot,reject(),t0);const d=late.scoutRetryTick(slot.at+31*60000);assert.ok(d.dropped,'more than 30 minutes late and the U.S. not open: dropped');});

test('the tick runs a due retry first; a scheduled run\'s failure is noted for a retry',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.ok(src.includes('{const retried=this.scoutRetryTick(now);if(retried)return retried;}'));
  assert.ok(src.includes(".catch(error=>this.noteScoutRetry(slot,error));return {slot,ran:true};"));
  assert.ok(src.includes("const SCOUT_RETRY_CODES=['BROKER_REJECTED','RATE_LIMITED','REQUEST_TIMEOUT','NETWORK_UNAVAILABLE'],SCOUT_RETRY_MS=120000;"));
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'e36e408915854800');assert.equal(RI.fingerprint(undefined,{orders:true}),'270c1047cfa0a70e');});
