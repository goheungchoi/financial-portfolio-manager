const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {annotate}=require('../electron/note-staleness.cjs');
// The 2026-10-23 case: a review saved this while the filled buy was still recorded as Accepted.
const STALE='Oct 23 15:11 KST: 3 held (avg ₩60,300), Buy 3 accepted 0 filled; don’t submit another buy. If filled all 6 ≈23.9% of ₩1.498m; existing conditional stop ₩54,000 covers only original 3.';
// A live KR engine whose order history can be broken or repaired, holding 3 Samsung E&A shares after the buy fills.
function setup(){
  const {LiveEngine}=require('../electron/live-engine.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');let history='broken';let held=0;
  const balance=()=>({accountKey:'acct',environment:'live',reportedTotal:1500001,cash:1500001-held*60300,holdings:held?[{symbol:'028050',name:'Samsung E&A',quantity:held,cost:60300,price:59100}]:[]});
  const broker={request:async op=>{
    if(op==='prepare-order')return {balance:balance(),price:60300,ticket:'t',session:{id:'krx-regular',regular:true}};if(op==='place-order')return {brokerOrderId:'0007143000'};
    if(op==='orders'){if(history==='broken')throw new Error('INVALID_RESPONSE');return {orders:[{orderId:'0007143000',filled:3,status:'Filled',averagePrice:60300}]};}
    if(op==='live-context')return {balance:balance(),quotes:[{symbol:'028050',price:59100,retrievedAt:Date.now()}],marketSession:{open:false,status:'closed'}};throw new Error(op);}};
  const live=new LiveEngine(db,broker,()=>({status:'connected',snapshot:balance()}),{market:'KR'});
  live.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:1}],()=>[]),{request:async()=>({decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'})},()=>{});
  a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  return {a,live,db,setHistory:v=>{history=v;},setHeld:n=>{held=n;}};
}
const snapshotOf=(db,id)=>JSON.parse(db.prepare('SELECT payload FROM dry_runs WHERE id=?').get(id).payload).snapshot;
test('regression (2026-10-23): a stale "buy pending" note is marked superseded once the buy is reconciled as filled and 3 shares are held',async()=>{
  const {a,live,db,setHistory,setHeld}=setup();
  const order=live.propose({symbol:'028050',side:'Buy',quantity:3,limitPrice:60300});await live.submit(order.id,'PLACE LIVE ORDER');setHeld(3);
  // The review at 15:11 saw the order as Accepted and wrote the note; the history read then failed.
  const scope=a.watchScope();await a.deskActions(scope,{universe:[{symbol:'028050'}]},'r1',()=>{}).save_note({action:'set',symbol:'028050',note:STALE,expiresInDays:45});
  assert.deepEqual(a.desk.notes(scope)[0].orderIds,[order.id],'the note is linked to the open order it describes');
  // While order status cannot be confirmed, the claim is unverified, not superseded.
  await assert.rejects(live.reconcile());let r=await a.dryRun('inputs');let note=snapshotOf(db,r.id).agentDesk.notes[0];
  assert.ok(note.orderClaimUnverified,'unconfirmed: report uncertainty');assert.equal(note.accountStateConflict,undefined);
  // The repaired history confirms the fill.
  setHistory('fixed');r=await a.dryRun('inputs');const snap=snapshotOf(db,r.id);note=snap.agentDesk.notes[0];
  assert.deepEqual(snap.positions['028050'].quantity,3);assert.equal((snap.orders??[]).length,0,'no open order');assert.equal(snap.orderReconciliation,undefined);
  assert.ok(note.accountStateConflict,'the stale note is explicitly superseded');assert.equal(note.accountStateConflict.current.held,3);assert.equal(note.accountStateConflict.current.openOrders,'none','stated, not omitted');
  assert.deepEqual(note.accountStateConflict.resolvedOrders,[{side:'Buy',quantity:3,filled:3,status:'Filled',fillPrice:60300}]);assert.match(note.accountStateConflict.note,/thesis may still apply/);
  assert.equal(snap.agentDesk.conditionalOrders.monitoring.startsWith('inactive'),true);
});
test('a legacy note with no order link is superseded by its text only when a confirmed check after it shows nothing open',()=>{
  const at=Date.parse('2026-10-23T06:11:00Z');const note={symbol:'028050',note:STALE,updatedAt:at,expiresAt:at+45*86400000};
  const filled=[{id:'i1',symbol:'028050',side:'Buy',quantity:3,filled:3,status:'Filled',fillPrice:60300,reconciledAt:at+3600000}];
  assert.ok(annotate([note],{orders:filled,positions:{'028050':{quantity:3}},confirmedAt:at+3600000})[0].accountStateConflict);
  assert.equal(annotate([note],{orders:filled,positions:{'028050':{quantity:3}},confirmedAt:at-60000})[0].accountStateConflict,undefined,'a check older than the note proves nothing');
  assert.equal(annotate([note],{orders:[{...filled[0],status:'Accepted',filled:0}],confirmedAt:at+3600000})[0].accountStateConflict,undefined,'an order really is open');
  assert.equal(annotate([{...note,note:'Thesis: buyback and Q3 profit; reassess near ₩54,000.'}],{orders:filled,confirmedAt:at+3600000})[0].accountStateConflict,undefined,'a thesis without order claims is untouched');
});
test('a corrected note keeps the original in history and its expiry; reviews are told account state outranks notes',()=>{
  const {AgentDesk}=require('../electron/agent-desk.cjs');const db=new DatabaseSync(':memory:');let now=1000;const desk=new AgentDesk(db,()=>now);
  desk.saveNote('s',{action:'set',symbol:'028050',note:STALE,expiresInDays:45});const original=desk.notes('s')[0];now=2000;
  const fixed=desk.correctNote('s','028050',{note:'Reconciled: the buy filled; 3 held.',reason:'pending-order claim superseded by reconciled fill'});
  assert.equal(fixed.expiresAt,original.expiresAt);assert.equal(fixed.corrected.reason,'pending-order claim superseded by reconciled fill');
  const [h]=desk.noteHistory('s','028050');assert.equal(h.note,STALE);assert.equal(h.reason,'pending-order claim superseded by reconciled fill');
  now=3000;desk.saveNote('s',{action:'set',symbol:'028050',note:'later',expiresInDays:5});assert.equal(desk.noteHistory('s','028050').length,2,'replacements are archived too');
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');assert.match(src,/take precedence over any note about holdings, orders or stop coverage/);
});
