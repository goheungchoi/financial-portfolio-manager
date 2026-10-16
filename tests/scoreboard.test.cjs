const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Scoreboard,stances,closesFromCandles}=require('../electron/scoreboard.cjs');const {LearningMemory}=require('../electron/learning-memory.cjs');
const DAY=86400000;const kst=(day,hour=10)=>Date.parse(`${day}T${String(hour).padStart(2,'0')}:00:00+09:00`);
const days=['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-07','2026-09-08','2026-09-09','2026-09-10'];
function setup(){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0);CREATE TABLE benchmark_closes(idx TEXT NOT NULL,day TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(idx,day))');
  const memory=new LearningMemory(db);const board=new Scoreboard(db,()=>kst('2026-09-20'));let n=0;
  const review=(day,action,symbol='005930',extra={})=>{const id='r'+(++n);db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify({id,timestamp:kst(day),provider:'openai',model:'gpt-6-luna',decision:{action,symbol,quantity:1,explanation:''},contextEvidence:{environment:'kis',quote:{symbol,price:100},reviewedLessons:[],...extra},orderId:null}));return id;};
  const bench=closes=>{for(const [i,c] of closes.entries())db.prepare('INSERT INTO benchmark_closes VALUES(?,?,?)').run('KOSPI',days[i],c);};
  const lesson=(id,symbol,note,source='broker')=>{db.prepare('INSERT INTO lessons VALUES(?,?,1)').run(id,'Lesson '+id);db.prepare('INSERT INTO lesson_evidence VALUES(?,?,?)').run(id,'sig',JSON.stringify({symbol,source,accountKey:'acct',assessment:{eligible:true}}));memory.saveLifecycle(id,{status:'approved',signature:'sig',approvedAt:kst('2026-08-01'),expiresAt:kst('2026-12-01'),note,applicability:'Only '+symbol});};
  return {db,board,review,bench,lesson};
}
test('decisions are scored against the benchmark from the decision-day close; sells score when the stock trails',()=>{
  const {board,review,bench}=setup();board.saveCloses('005930',days.map((day,i)=>({day,close:100+i*2})));bench([100,100,100,101,101,101,102,102]);
  review('2026-09-01','Buy');review('2026-09-01','Sell');review('2026-09-01','Hold');review('2026-09-08','Buy');
  const [late,sell,buy]=board.decisions().reverse();
  const one=buy.horizons.find(h=>h.days===1);assert.equal(one.status,'scored');assert.equal(one.endDay,'2026-09-02');assert.ok(Math.abs(one.excess-0.02)<1e-12);
  const five=buy.horizons.find(h=>h.days===5);assert.equal(five.endDay,'2026-09-08');assert.ok(Math.abs(five.excess-(0.10-0.01))<1e-12);
  assert.ok(Math.abs(sell.horizons.find(h=>h.days===5).excess+(0.09))<1e-12,'a sell before a rise scores negatively');
  assert.equal(buy.horizons.find(h=>h.days===20).status,'waiting');assert.equal(late.horizons.find(h=>h.days===5).status,'waiting');
  const built=board.build();assert.equal(built.counts.holds,1);assert.equal(built.counts.scoredDecisions,3);assert.equal(built.summary[1].count,3);assert.equal(built.summary[5].count,2);assert.equal(built.summary[5].hitRate,0.5);
  assert.deepEqual(board.pendingSymbols(),[],'fetched within the last six hours');
});
test('paper decisions are not scored and unfetched symbols are pending',()=>{
  const {db,board,review}=setup();review('2026-09-01','Buy','000660');db.prepare('INSERT INTO reviews VALUES(?,?)').run('p',JSON.stringify({id:'p',timestamp:kst('2026-09-01'),provider:'local',decision:{action:'Buy',symbol:'005930',quantity:1},contextEvidence:{environment:'local-paper'}}));
  assert.equal(board.decisions().length,1);assert.deepEqual(board.pendingSymbols(),['000660']);assert.equal(board.decisions()[0].horizons[0].status,'waiting');
});
test('lesson impact compares decisions with and without the lesson; old reviews match by lesson text',()=>{
  const {board,review,bench,lesson}=setup();board.saveCloses('005930',days.map((day,i)=>({day,close:100+i})));bench([100,100,100,100,100,100,100,100]);lesson('L1','005930','Hold through earnings');
  for(let i=0;i<5;i++)review('2026-09-01','Buy','005930',{lessonIds:['L1']});
  for(let i=0;i<4;i++)review('2026-09-01','Sell','005930',{lessonIds:[]});
  review('2026-09-01','Sell','005930',{reviewedLessons:['Lesson L1 Applicability: Only 005930']});
  let impact=board.build().lessons.find(l=>l.id==='L1');assert.equal(impact.withLesson.count,6);assert.equal(impact.without.count,4);assert.equal(impact.verdict,'Too few decisions');
  review('2026-09-01','Sell','005930',{lessonIds:[]});impact=board.build().lessons.find(l=>l.id==='L1');
  assert.equal(impact.without.count,5);assert.ok(impact.difference>0);assert.equal(impact.verdict,'Higher with lesson');
});
test('contradiction check pairs approved lessons on the same symbol and account with opposite notes',()=>{
  assert.deepEqual(stances('Avoid buying after a gap up').sort(),['avoid']);assert.deepEqual(stances("Don't sell on the first dip"),['hold']);assert.deepEqual(stances('실적 발표 전 추가 매수').sort(),['enter']);assert.deepEqual(stances('손절은 -5%에서').sort(),['exit']);
  const {board,lesson}=setup();lesson('A','005930','Add on pullbacks');lesson('B','005930','Do not buy more until margins recover');lesson('C','000660','Take profits above 20%');lesson('D','005930','Hold for the dividend');lesson('E','005930','Trim into strength');
  const found=board.conflicts().map(c=>[c.a,c.b].sort().join('-')+':'+[...c.stances].sort().join('/')).sort();
  assert.deepEqual(found,['A-B:avoid/enter','D-E:exit/hold']);
});
test('closes come from KIS daily candles in exchange-local days',()=>{
  assert.deepEqual(closesFromCandles('005930',[{timestamp:Date.parse('2026-09-01T00:00:00+09:00'),close:70000}]),[{day:'2026-09-01',close:70000}]);
  assert.deepEqual(closesFromCandles('NASD:AAPL',[{timestamp:0,date:'2026-09-01',close:200},{timestamp:0,date:'2026-09-02',close:NaN}]),[{day:'2026-09-01',close:200}]);
});
test('relevant lessons keep their ids so reviews can record which lessons were supplied',()=>{
  const {db,lesson}=setup();const memory=new LearningMemory(db);lesson('L9','005930','note');
  const rows=memory.relevantLessons({environment:'kis',universe:[{symbol:'005930'}],positions:{}},['acct']);assert.equal(rows[0].id,'L9');assert.ok(rows[0].text.startsWith('Lesson L9'));
  assert.deepEqual(memory.relevant({environment:'kis',universe:[{symbol:'005930'}],positions:{}},['acct']),[rows[0].text]);
});
