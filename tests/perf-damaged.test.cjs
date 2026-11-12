// A damaged daily record must not stop a review (release gate 1.5.52, perf-fix-plan.md R1-R4). A nav_history or
// cash_flows row that cannot be parsed is skipped like a day that was never recorded and logged once per run; the
// review continues without the performance history when it cannot be built; with healthy records nothing changes.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const P=require('../electron/performance.cjs');const {PerformanceHistory,reviewPerformance}=P;
const at=day=>Date.parse(day+'T03:00:00Z');
const days=['2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07'];
function world(){let now=at(days[0]);const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const skipped=[];perf.onSkipped=(table,keys)=>skipped.push([table,keys]);
  days.forEach((d,i)=>{now=at(d);perf.record('acct',{totals:{KRW:1000000+i*10000,USD:null,equityKRW:1000000+i*10000},cash:{KRW:500000,USD:0},fx:{usdKRW:1400},rows:[{market:'KR',symbol:'005930',name:'S',quantity:5,price:100000+i*2000,cost:100000}]});});
  return {db,perf,skipped};}
const damage=(db,day)=>db.prepare("UPDATE nav_history SET payload='{damaged' WHERE account='acct' AND day=?").run(day);

test('R1/R2: history with one damaged row: the good days, the damaged day absent, one log line naming it, no second line',()=>{
  const {db,perf,skipped}=world();damage(db,'2026-10-05');
  assert.deepEqual(perf.history('acct').map(r=>r.day),['2026-10-01','2026-10-02','2026-10-06','2026-10-07']);
  assert.deepEqual(skipped,[['nav_history',['2026-10-05']]]);perf.history('acct');perf.summary('acct','KRW',null);assert.equal(skipped.length,1,'once per run');
  db.prepare("UPDATE nav_history SET payload='[]' WHERE account='acct' AND day='2026-10-06'").run();db.prepare("UPDATE nav_history SET payload='{\"x\":1}' WHERE account='acct' AND day='2026-10-07'").run();
  assert.deepEqual(perf.history('acct').map(r=>r.day),['2026-10-01','2026-10-02'],'a list or an object without its day is not a record');
});
test('R1: a summary across a skipped day equals the summary where that row was never recorded',()=>{
  const a=world(),b=world();damage(a.db,'2026-10-05');b.db.prepare("DELETE FROM nav_history WHERE account='acct' AND day='2026-10-05'").run();
  const strip=s=>JSON.parse(JSON.stringify(s));
  assert.deepEqual(strip(a.perf.summary('acct','KRW',null)),strip(b.perf.summary('acct','KRW',null)));
  assert.deepEqual(strip(a.perf.series('acct','KRW')),strip(b.perf.series('acct','KRW')));
  assert.equal(b.skipped.length,0,'a missing row is not logged as damaged');
});
test('R1: lastValuation reads the latest readable day; a damaged latest row does not hide the one before it',()=>{
  const {db,perf}=world();db.prepare("UPDATE nav_history SET payload=? WHERE account='acct' AND day='2026-10-06'").run(JSON.stringify({day:'2026-10-06',valuation:{ranges:{KR:{last:5}}}}));damage(db,'2026-10-07');
  assert.deepEqual(perf.lastValuation('acct','2026-10-08'),{ranges:{KR:{last:5}},previousDay:true});
});
test('R1/R2: a damaged cash_flows row is skipped and logged once, with its id; the other flows remain',()=>{
  const {db,perf,skipped}=world();perf.addFlow('acct',{day:'2026-10-02',market:'KR',amount:50000,note:'Deposit'});const f=perf.addFlow('acct',{day:'2026-10-06',market:'KR',amount:-20000,note:'Withdrawal'});
  db.prepare("UPDATE cash_flows SET payload='oops' WHERE id=?").run(f.id);
  assert.deepEqual(perf.flows('acct').map(x=>x.amount),[50000]);assert.deepEqual(skipped,[['cash_flows',[f.id]]]);perf.flows('acct');assert.equal(skipped.length,1);
  assert.ok(perf.summary('acct','KRW',null).periods.length>0,'the summary still builds');
});

// Reviews: the app's Automation with a fake transport, performanceSummary wired as electron/main.cjs wires it.
function reviewHarness(perf){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=perf.db;const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[],events=[];const provider={request:async(op,payload)=>{supplied.push([op,payload]);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({kind,title,body}));a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};
  a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',reviewGate:'off'});
  a.performanceSummary=market=>{const kind=market==='US'?'USD':'KRW';const s=perf.summary('acct',kind,P.benchmarkFor(kind));if(!s.start)return null;return reviewPerformance(s,{unconfirmed:[],checking:[]});};
  const context=()=>supplied.filter(([op])=>op==='decision').at(-1)?.[1]?.context;
  return {a,supplied,events,context};
}
// The context drops null, undefined and empty-list keys when it is shaped; compare both sides the same way.
const bare=x=>JSON.parse(JSON.stringify(x,(k,v)=>v===null||Array.isArray(v)&&!v.length&&k!==''?undefined:v));
const run=async a=>{await a.review('User request');assert.equal(a.lastError,null,`${a.lastError} ${a.lastErrorDetail}`);};

test('a review with a damaged row completes; its performance history is built from the good days',async()=>{
  const {db,perf}=world();damage(db,'2026-10-05');const h=reviewHarness(perf);await run(h.a);
  const history=h.context().performance.history;assert.ok(history&&!history.unavailable,'the history is there');
  assert.deepEqual(bare(history),bare(reviewPerformance(perf.summary('acct','KRW',P.benchmarkFor('KRW')),{unconfirmed:[],checking:[]})),'the same figures the good days give');
  assert.ok(!JSON.stringify(history).includes('2026-10-05'),'the damaged day is not in it');
});
test('R3: performanceSummary throwing: the review completes, the context says the history is unavailable, one log line per run',async()=>{
  const {perf}=world();const h=reviewHarness(perf);h.a.performanceSummary=()=>{throw new SyntaxError('Unexpected token');};
  await run(h.a);assert.deepEqual(h.context().performance.history,{unavailable:'The performance records could not be read.'});
  await run(h.a);const lines=h.events.filter(e=>e.title==='Performance history unavailable');assert.equal(lines.length,1,'once per run');
  assert.match(lines[0].body,/^The review runs without the performance history: the performance records could not be read \(SyntaxError at [a-z0-9_-]+\.cjs:\d+\)\. Logged once per run\.$/);
});
test('R3: with healthy records the guard is transparent: the context carries exactly what performanceSummary returns',async()=>{
  const {perf}=world();const h=reviewHarness(perf);await run(h.a);
  assert.deepEqual(bare(h.context().performance.history),bare(h.a.performanceSummary('KR')));assert.equal(h.events.filter(e=>e.title==='Performance history unavailable').length,0);
  assert.equal(perf.skipLogged,undefined,'nothing was skipped');
});
test('change 1: a skipped cash_flows row is marked: the summary counts it, the review section states it; healthy summaries have no mark',async()=>{
  const {db,perf}=world();const f=perf.addFlow('acct',{day:'2026-10-06',market:'KR',amount:-20000,note:'Withdrawal'});
  const clean=perf.summary('acct','KRW',null);assert.equal('unreadableFlows' in clean,false,'healthy: no new key');assert.equal('unreadableFlows' in reviewPerformance(clean,{}),false);
  db.prepare("UPDATE cash_flows SET payload='oops' WHERE id=?").run(f.id);
  const s=perf.summary('acct','KRW',null);assert.equal(s.unreadableFlows,1);
  assert.deepEqual(reviewPerformance(s,{}).unreadableFlows,{count:1,fact:'1 recorded deposit or withdrawal record could not be read; returns are estimates and may count it as gain or loss.'});
  const h=reviewHarness(perf);await run(h.a);assert.equal(h.context().performance.history.unreadableFlows.count,1,'the review context carries the fact');
});
test('change 2: the log line in the review guard failing does not fail the review',async()=>{
  const {perf}=world();const h=reviewHarness(perf);h.a.performanceSummary=()=>{throw new Error('BROKEN');};
  const log=h.a.log.bind(h.a);h.a.log=(id,kind,title,body)=>{if(title==='Performance history unavailable')throw new Error('LOG_DOWN');return log(id,kind,title,body);};
  await run(h.a);assert.deepEqual(h.context().performance.history,{unavailable:'The performance records could not be read.'});
});
