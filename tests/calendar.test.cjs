const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const cal=require('../electron/event-calendar.cjs');
test('options expiries: KOSPI 200 on the second Thursday, U.S. on the third Friday, quarterly in Mar/Jun/Sep/Dec',()=>{
  assert.equal(cal.nthWeekday(2026,9,4,2),'2026-10-08');assert.equal(cal.nthWeekday(2026,9,5,3),'2026-10-16');assert.equal(cal.nthWeekday(2026,11,4,2),'2026-12-10');
  const e=cal.expiries('2026-11-01','2026-12-31');assert.deepEqual(e.map(x=>x.date),['2026-11-12','2026-11-20','2026-12-10','2026-12-18']);assert.match(e[2].title,/quarterly/);
});
test('the calendar merges macro releases with earnings, record dates and meetings for your stocks, inside the window',()=>{
  const events=cal.build({today:'2026-10-18',days:21,macroCalendar:[{date:'2026-10-20',market:'US',event:'U.S. CPI'},{date:'2026-12-01',event:'Too far'}],symbols:[{symbol:'105560',name:'KB금융'},{symbol:'005930'}],
    sources:s=>s==='105560'?{name:'KB금융',earnings:{nextExpected:'2026-10-23'},dividends:{upcoming:[{recordDate:'2026-10-31',perShare:null},{recordDate:'2026-09-30'}]},meetings:[{date:'2026-11-20'}]}:{}});
  assert.deepEqual(events.map(e=>[e.date,e.kind]),[['2026-10-20','macro'],['2026-10-23','earnings'],['2026-10-31','dividend']]);assert.ok(events[1].estimated);
  const {calendarRows}=require('../electron/macro.cjs');assert.deepEqual(calendarRows([{release_name:'FOMC Press Release',date:'2026-10-19'},{release_name:'Consumer Price Index',date:'2026-10-20'}],'2026-10-18').map(r=>r.date+' '+r.event),['2026-10-20 U.S. CPI','2026-10-28 FOMC decision'],'FRED FOMC Press Release dates are not meetings; the Fed schedule is');
});
test('the scoreboard groups scored decisions by the confidence the agent gave',()=>{
  const {Scoreboard}=require('../electron/scoreboard.cjs');const db=new DatabaseSync(':memory:');const board=new Scoreboard(db,()=>Date.parse('2026-10-18T00:00:00Z'));
  db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE benchmark_closes(idx TEXT,day TEXT,close REAL)');
  const days=Array.from({length:12},(_,i)=>new Date(Date.parse('2026-09-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
  board.saveCloses('005930',days.map((day,i)=>({day,close:100+i*2})));board.saveCloses('000660',days.map((day,i)=>({day,close:100-i})));for(const [i,day] of days.entries())db.prepare('INSERT INTO benchmark_closes VALUES(?,?,?)').run('KOSPI',day,1000);
  const review=(id,symbol,confidence)=>db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify({id,timestamp:Date.parse('2026-09-01T03:00:00Z'),decision:{action:'Buy',symbol,quantity:1,plan:{confidence}},contextEvidence:{environment:'kis'},provider:'openai'}));
  review('r1','005930','high');review('r2','000660','high');review('r3','005930','low');
  const b=board.build();assert.equal(b.byConfidence.high[5].count,2);assert.equal(b.byConfidence.high[5].hitRate,0.5);assert.equal(b.byConfidence.low[5].hitRate,1);assert.equal(b.byConfidence.medium[5].count,0);
  assert.deepEqual(Object.keys(board.context().byConfidence).sort(),['high','low']);
});
test('reviews receive the event calendar',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async(op,p)=>{supplied.push(p);return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}},()=>{});
  const soon=new Date(Date.now()+9*3600000+3*86400000).toISOString().slice(0,10);a.macro={get:()=>({calendar:[{date:soon,market:'US',event:'U.S. CPI'}],series:[]}),context:()=>null};
  a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  await a.review();const ctx=supplied[0].context;assert.ok(ctx.eventCalendar.some(e=>e.title==='U.S. CPI'));assert.ok(ctx.eventCalendar.every(e=>e.date&&e.title));assert.ok(a.getState().calendar.some(e=>e.kind==='macro'));
});
