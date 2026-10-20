const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const pr=require('../electron/portfolio-risk.cjs');
const series=(n,f)=>Array.from({length:n},(_,i)=>({date:new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10),close:f(i),high:f(i)+1,low:f(i)-1}));
test('exposure: sector weights with cash, concentration, weighted beta and holdings that move together',()=>{
  const wave=i=>100+10*Math.sin(i/3);const daily={A:series(80,wave),B:series(80,i=>200+20*Math.sin(i/3)),C:series(80,i=>100+5*Math.cos(i*1.7))};
  const e=pr.exposure([{symbol:'A',name:'Samsung',market:'KR',valueKRW:500},{symbol:'B',name:'SK hynix',market:'KR',valueKRW:300},{symbol:'C',name:'KB',market:'KR',valueKRW:100}],{daily:s=>daily[s],sector:s=>s==='C'?'금융':'전기·전자',beta:s=>({A:1.2,B:1.5})[s]??null,cashKRW:100});
  assert.equal(e.investedPct,90);assert.equal(e.cashPct,10);assert.deepEqual(e.sectors,[{name:'전기·전자',weightPct:80},{name:'금융',weightPct:10}]);assert.equal(e.largest.weightPct,50);
  assert.equal(e.effectiveHoldings,Math.round(1/((5/9)**2+(3/9)**2+(1/9)**2)*10)/10);
  assert.deepEqual(e.movesTogether,[{symbols:['A','B'],names:['Samsung','SK hynix'],weightPct:80}]);
  assert.equal(e.portfolioBeta,Math.round((50*1.2+30*1.5)/80*0.9*100)/100);assert.equal(e.betaCoveragePct,80);
  assert.deepEqual(pr.exposure([],{daily:()=>[],sector:()=>null,beta:()=>null,cashKRW:5}),{holdings:0,cashPct:100});
});
test('sizing caps the position so a stop of k×ATR loses at most the risk budget',()=>{
  const s=pr.sizing({equityKRW:10000000,riskPct:1,atrMultiple:2,rows:[{symbol:'005930',price:217000,atr:8000,fx:1},{symbol:'NASD:NVDA',price:200,atr:6,fx:1400},{symbol:'X',price:0,atr:1}]});
  assert.equal(s.riskBudgetKRW,100000);assert.deepEqual(s.rows.map(r=>[r.symbol,r.maxShares,r.suggestedStop]),[['005930',6,201000],['NASD:NVDA',5,188]]);assert.equal(s.rows[0].maxWeightPct,13);
  assert.equal(pr.sizing({equityKRW:0,riskPct:1,atrMultiple:2,rows:[]}),null);
});
test('the regime gauge adds stress readings and needs at least three',()=>{
  const off=pr.regime({vix:28,vix5dChangePct:35,hySpread:5.2,hySpreadChange:0.4,advanceRatioPct:20,kospiVs50dPct:-7,sox20dPct:-15,oil20dPct:13});
  assert.equal(off.regime,'risk_off');assert.equal(off.score,-8);
  const on=pr.regime({vix:13,hySpread:3.2,advanceRatioPct:80,kospiVs50dPct:4});assert.equal(on.regime,'risk_on');assert.equal(on.score,4);
  assert.equal(pr.regime({vix:20,hySpread:4}),null);
  assert.equal(pr.regime({vix:20,hySpread:4,advanceRatioPct:50}).regime,'neutral');
});
test('a Buy needs a complete trade plan; otherwise it becomes a Hold with the reason',()=>{
  const {validateDecision}=require('../electron/ai-client.cjs');const base={action:'Buy',symbol:'005930',quantity:3,credit:'none',loanDate:'',explanation:'Buy on the dip.'};
  const plan={thesis:'Memory upcycle',invalidation:'Margins fall below 30%',stopPrice:200000,targetPrice:260000,horizonDays:60,confidence:'medium'};
  assert.deepEqual(validateDecision({...base,plan},['005930'],{requirePlan:true}).plan,plan);
  const held=validateDecision({...base,plan:{...plan,stopPrice:null}},['005930'],{requirePlan:true});assert.equal(held.action,'Hold');assert.equal(held.withheld.reason,'no stop price');assert.match(held.explanation,/held back a Buy of 3 005930/);
  assert.equal(validateDecision({...base,plan:{...plan,thesis:' '}},['005930'],{requirePlan:true}).withheld.reason,'no thesis');
  assert.equal(validateDecision({...base},['005930']).action,'Buy','external and local decisions keep working without a plan');
  assert.equal(validateDecision({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Wait',plan:{thesis:'',invalidation:'',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low'}},[],{requirePlan:true}).action,'Hold');
});
function harness(decision,{conditional=false}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:10000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const events=[];const provider={request:async(op,payload)=>{supplied.push([op,payload]);return {decision,usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({kind,title,body}));a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.series={closes:()=>series(60,i=>200000+i*300),ensure:async()=>{}};a.indexCloses=()=>({KOSPI:series(60,i=>5000+i),VIX:series(10,()=>18)});
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',conditionalOrders:conditional});
  return {a,supplied,events};
}
test('reviews get sizing and the regime gauge; a stop not below the price holds the Buy back',async()=>{
  const plan={thesis:'t',invalidation:'i',stopPrice:230000,targetPrice:null,horizonDays:30,confidence:'low'};
  const {a,supplied,events}=harness({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'Buy.',plan});
  await a.review();const ctx=supplied.find(([op])=>op==='decision')[1].context;
  assert.equal(ctx.positionSizing.rows[0].symbol,'005930');assert.equal(ctx.positionSizing.riskPerTradePct,1);
  assert.ok(events.some(e=>e.title==='Buy held back · trade plan'&&/not below the price/.test(e.body)));assert.equal(a.getState().reviews[0].decision.action,'Hold');
});
test('a Buy with a complete plan saves the plan as a note and arms a stop-loss when conditional orders are on',async()=>{
  const plan={thesis:'Memory upcycle',invalidation:'Margins fall',stopPrice:205000,targetPrice:250000,horizonDays:45,confidence:'medium'};
  const {a,events}=harness({action:'Buy',symbol:'005930',quantity:2,credit:'none',loanDate:'',explanation:'Buy.',plan},{conditional:true});
  a.live.enabled=true;a.live.policy=()=>({anyStock:true,symbols:[],maxOrderKRW:null});
  await a.review();const scope=a.watchScope();
  assert.match(a.desk.notes(scope)[0].note,/Stop 205000, target 250000, horizon 45 days, confidence medium/);
  const stop=a.desk.orders(scope)[0];assert.equal(stop.purpose,'stop_loss');assert.equal(stop.quantity,2);assert.equal(stop.conditions[0].value,205000);assert.ok(events.some(e=>e.title==='Stop-loss armed from the plan'));
});
test('sizing never allows more shares than the available cash buys',()=>{
  const pr=require('../electron/portfolio-risk.cjs');const s=pr.sizing({equityKRW:500001,riskPct:10,atrMultiple:2,rows:[{symbol:'360750',price:25505,atr:100,fx:1,cashKRW:500001},{symbol:'005930',price:209000,atr:12863,fx:1,cashKRW:500001},{symbol:'NASD:A',price:100,atr:1,fx:1300,cashKRW:0}]});
  assert.deepEqual(s.rows.map(r=>[r.symbol,r.maxShares,r.limitedBy??null]),[['360750',19,'cash'],['005930',1,null],['NASD:A',0,'cash']]);
});
