// Journal redesign (1.5.50, artifacts/reviews/2026-11-11-next-update/journal-plan.md): the tab model (J1) and the
// decision summary (J2), from src/journalTabs.ts.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const load=()=>import(require('node:url').pathToFileURL(path.join(__dirname,'../src/journalTabs.ts')).href);
test('J1: six tabs in order, Decisions by default; an unknown saved tab falls back; "Reviewed lessons" is Lessons',async()=>{
  const J=await load();assert.deepEqual([...J.JOURNAL_TABS],['Decisions','Orders and triggers','Trades','Lessons','Scoreboard','Replay']);
  assert.equal(J.journalTab(undefined),'Decisions');assert.equal(J.journalTab(null),'Decisions');assert.equal(J.journalTab('Timeline'),'Decisions');
  assert.equal(J.journalTab('Reviewed lessons'),'Lessons');for(const t of J.JOURNAL_TABS)assert.equal(J.journalTab(t),t);
});
test('J1: badges count armed conditional orders and lessons awaiting review; the orders tab warns only when armed and not monitored',async()=>{
  const J=await load();const lessons=[{lifecycle:null},{lifecycle:{status:'pending'}},{lifecycle:{status:'needs-review'}},{lifecycle:{status:'approved'}}];
  assert.deepEqual(J.journalBadges({desk:{orders:[{},{}],monitoringActive:true},lessons}),{'Orders and triggers':2,Lessons:3,unmonitored:false});
  assert.equal(J.journalBadges({desk:{orders:[{}],monitoringActive:false},lessons:[]}).unmonitored,true);
  assert.equal(J.journalBadges({desk:{orders:[],monitoringActive:false},lessons:[]}).unmonitored,false,'nothing armed: no warning');
  assert.deepEqual(J.journalBadges({desk:null,lessons:[]}),{'Orders and triggers':0,Lessons:0,unmonitored:false},'no desk yet');
});
test('J2: the first three sentences, and whether there is more',async()=>{
  const J=await load();assert.deepEqual(J.firstSentences('One. Two! Three? Four.'),{short:'One. Two! Three?',more:true});
  assert.deepEqual(J.firstSentences('Only one sentence'),{short:'Only one sentence',more:false});assert.deepEqual(J.firstSentences('A. B. C.'),{short:'A. B. C.',more:false});
  assert.deepEqual(J.firstSentences('He said "stop." Then two. Three. Four.').more,true);assert.deepEqual(J.firstSentences(''),{short:'',more:false});
});
test('J2: the facts row: order, plan, AI use; a fact not recorded is left out',async()=>{
  const J=await load();const usage={calls:3,micro:420000};
  assert.deepEqual(J.decisionFacts({orderId:'o',decision:{plan:{thesis:'Trim into strength. Keep the core.'}}},usage),[{label:'Order',value:'Order submitted'},{label:'Plan',value:'Trim into strength.'},{label:'AI',value:'3 AI calls · $0.42'}]);
  assert.deepEqual(J.decisionFacts({proposalId:'p',decision:{}},null),[{label:'Order',value:'Proposal created'}],'no plan and no usage: only the order');
  assert.deepEqual(J.decisionFacts({decision:{plan:{thesis:'  '}}},{calls:1,micro:0}),[{label:'Order',value:'No order'},{label:'AI',value:'1 AI call'}],'no cost recorded: calls only');
  assert.deepEqual(J.decisionFacts({decision:{}},{calls:2,micro:150}).at(-1),{label:'AI',value:'2 AI calls · < $0.01'},'a cost under a cent is not shown as $0.00');
  assert.deepEqual(J.decisionFacts({decision:{withheld:{symbol:'X'}}},{calls:0,micro:0}),[{label:'Order',value:'No order'}],'withheld, no calls');
});
