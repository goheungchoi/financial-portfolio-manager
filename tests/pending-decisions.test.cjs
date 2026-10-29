const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PendingDecisions}=require('../electron/pending-decisions.cjs');
const t0=Date.parse('2026-10-29T05:00:00Z');
const sell=(extra={})=>({action:'Sell',symbol:'NASD:GOOGL',quantity:1,explanation:'Free cash flow fell; trim before the open.',plan:{invalidation:'Q3 cloud margin recovers'},...extra});
const ctx={positions:{'NASD:GOOGL':{quantity:1}},quotes:[{symbol:'NASD:GOOGL',price:290}]};
const closedUS=m=>m!=='US',allOpen=()=>true;
const setup=()=>{let now=t0;const db=new DatabaseSync(':memory:');return {p:new PendingDecisions(db,()=>now),db,at:t=>{now=t;}};};

test('repeated closed-market decisions keep one pending decision',()=>{
  // 2026-10-29: five Sell NASD:GOOGL decisions while the U.S. market was closed.
  const {p,at}=setup();for(let i=0;i<5;i++){at(t0+i*600000);p.record('s',{decision:sell(),reviewId:'R'+i,proposalId:i?null:'P0',context:ctx,marketOpen:closedUS});}
  const [one,...rest]=p.active('s');assert.equal(rest.length,0);assert.equal(one.reviews,5);assert.equal(one.reviewId,'R0');assert.equal(one.lastReviewId,'R4');assert.equal(one.proposalId,'P0');assert.equal(one.createdAt,t0);
  assert.equal(p.repeats('s',sell(),closedUS)?.id,one.id,'a sixth would repeat it');assert.equal(p.repeats('s',sell(),allOpen),null,'not once the market is open');
  assert.equal(p.repeats('s',sell({symbol:'NASD:NVDA'}),closedUS),null,'another symbol is its own decision');
  p.record('s',{decision:sell(),context:ctx,marketOpen:allOpen});assert.equal(p.active('s').length,0,'decided again with its market open');
  assert.equal(p.record('s',{decision:{action:'Hold',symbol:''},context:ctx,marketOpen:closedUS}),null,'a Hold is not pending');
});
test('the open market reassesses it; an order placed then carries it out, nothing executes from the list',()=>{
  const {p,db}=setup();p.record('s',{decision:sell(),reviewId:'R1',context:ctx,marketOpen:closedUS});
  const again=new PendingDecisions(db,()=>t0+3600000);assert.equal(again.active('s').length,1,'kept across a restart');assert.equal(again.active('other').length,0,'per account');
  again.record('s',{decision:sell(),reviewId:'R2',orderId:'O1',context:ctx,marketOpen:allOpen});
  const row=JSON.parse(db.prepare('SELECT payload FROM pending_decisions').get().payload);assert.equal(row.status,'carried-out');assert.equal(row.closedReviewId,'R2');
  const {p:q,db:d2}=setup();q.record('s',{decision:sell(),context:ctx,marketOpen:closedUS});q.record('s',{decision:{action:'Hold',symbol:''},context:ctx,marketOpen:allOpen});
  assert.equal(JSON.parse(d2.prepare('SELECT payload FROM pending_decisions').get().payload).status,'reassessed','Hold at the open: let go');
});
test('new evidence revises or cancels it; shares already gone cancel a Sell; it expires',()=>{
  const status=(db)=>db.prepare('SELECT status FROM pending_decisions ORDER BY rowid').all().map(r=>r.status);
  const {p,db}=setup();p.record('s',{decision:sell(),context:ctx,marketOpen:closedUS});p.record('s',{decision:sell({action:'Buy'}),context:ctx,marketOpen:closedUS});
  assert.deepEqual(status(db),['revised','pending'],'the opposite decision replaces it');
  const {p:c,db:d2}=setup();c.record('s',{decision:sell(),context:ctx,marketOpen:closedUS});c.record('s',{decision:{action:'Hold',symbol:'',planVerdicts:[{symbol:'NASD:GOOGL',verdict:'passed'}]},context:ctx,marketOpen:closedUS});
  assert.deepEqual(status(d2),['cancelled']);
  const {p:f,db:d3}=setup();f.record('s',{decision:sell(),context:ctx,marketOpen:closedUS});f.record('s',{decision:{action:'Hold',symbol:''},context:{...ctx,positions:{}},marketOpen:closedUS});
  assert.deepEqual(status(d3),['cancelled'],'sold elsewhere: nothing left to sell');
  const {p:e,at}=setup();e.record('s',{decision:sell(),context:ctx,marketOpen:closedUS});at(t0+3*86400000);assert.equal(e.active('s').length,0,'three days at most');
  assert.deepEqual(Object.keys(setup().p.record('s',{decision:sell(),context:ctx,marketOpen:closedUS})).includes('status'),true);
});
test('through the scheduler: a repeat while closed makes no new proposal and the context lists it',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];const contexts=[];
  const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const a=new Automation(db,paper,{request:async(op,payload)=>{contexts.push(payload.context);return {decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Add before the open.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}},(id,kind,title,body)=>events.push({title,body}));
  a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',skipUnchanged:false});a.marketOpenIn=()=>()=>false;
  const proposals=()=>db.prepare('SELECT COUNT(*) n FROM paper_proposals').get().n;
  await a.review('Scheduled review').catch(()=>{});const first=proposals();const pending=a.pending.active(a.watchScope());assert.equal(pending.length,1,'pending after the first');
  await a.review('Scheduled review').catch(()=>{});assert.equal(proposals(),first,'no second proposal');assert.ok(events.some(e=>e.title==='Pending decision kept'));
  assert.equal(contexts.at(-1).pendingDecisions?.[0]?.symbol,'005930','the second review saw it');assert.equal(a.pending.active(a.watchScope())[0].reviews,2);
});
