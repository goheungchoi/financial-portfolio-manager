const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const PG=require('../electron/plan-gap.cjs');const {validateDecision,decisionSchema}=require('../electron/ai-client.cjs');
const ctx=(extra={})=>({market:'KR',currency:'KRW',equity:505000,cash:505000,executionEnabled:true,marketSession:{open:true},quotes:[{symbol:'005930',price:209000},{symbol:'360750',price:25415}],
  positionSizing:{rows:[{symbol:'005930',maxShares:1},{symbol:'360750',maxShares:19}]},scoutPlan:{asOf:'a',targets:[{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:42},{symbol:'360750',name:'ETF',role:'candidate',targetWeightPct:5}]},...extra});
test('the minimum feasible position is one share, weighed against total equity, with cash, sizing and cap checks',()=>{
  const c=ctx();c.planGap=PG.planGap(c);PG.addMinimumPositions(c);const [sam,etf]=c.planGap.targets;
  assert.deepEqual([sam.minimumPosition.weightPct,sam.minimumPosition.feasible],[41.4,true],'one Samsung share is 41.4% of equity');assert.equal(etf.minimumPosition.weightPct,5);
  const capped=ctx({risk:{markets:{KR:{maxCompanyPct:30}}}});capped.planGap=PG.planGap(capped);PG.addMinimumPositions(capped);assert.equal(capped.planGap.targets[0].minimumPosition.checks.companyCap,false);assert.equal(capped.planGap.targets[0].minimumPosition.feasible,false);
  const poor=ctx({cash:100000});poor.planGap=PG.planGap(poor);PG.addMinimumPositions(poor);assert.equal(poor.planGap.targets[0].minimumPosition.feasible,false,'not affordable');
  const us={markets:[{market:'KR',currency:'KRW',equity:505000,cash:505000},{market:'US',currency:'USD',equity:0,cash:0,buyingPower:{usd:350}}],cash:{KRW:505000,USD:0},macro:{indicators:[{name:'USD/KRW',value:1300}]},quotes:[{symbol:'NASD:A',price:100}],scoutPlan:{targets:[{symbol:'NASD:A',role:'candidate',targetWeightPct:10}]}};
  us.planGap=PG.planGap(us);PG.addMinimumPositions(us);assert.equal(us.planGap.targets[0].minimumPosition.valueKRW,130000);assert.equal(us.planGap.targets[0].minimumPosition.checks.cash,true,'integrated buying power counts');
});
test('a single-market account applies its own order and concentration limits, counting shares already held',()=>{
  const small=ctx({cash:505000,quotes:[{symbol:'005930',price:100000},{symbol:'360750',price:25415}],risk:{maxOrderKRW:50000,maxCompanyPct:5}});small.planGap=PG.planGap(small);PG.addMinimumPositions(small);
  assert.deepEqual(small.planGap.targets[0].minimumPosition.checks,{cash:true,sizing:true,companyCap:false,orderCap:false,marketOpen:true});assert.equal(small.planGap.targets[0].minimumPosition.feasible,false);
  const four=ctx({positions:{'360750':{quantity:3}},risk:{maxCompanyPct:20}});four.planGap=PG.planGap(four);PG.addMinimumPositions(four);assert.equal(four.planGap.targets[1].minimumPosition.checks.companyCap,false,'3 held + 1 = 101,660 is 20.1% of equity, over 20%');
  const ok=ctx({positions:{'360750':{quantity:2}},risk:{maxCompanyPct:20}});ok.planGap=PG.planGap(ok);PG.addMinimumPositions(ok);assert.equal(ok.planGap.targets[1].minimumPosition.checks.companyCap,true,'2 held + 1 = 76,245 is 15.1%');
  // A combined account's U.S. limits are in dollars against the U.S. account value plus the KRW integrated margin lends it.
  const us=fx=>({markets:[{market:'KR',currency:'KRW',equity:505000,cash:505000},{market:'US',currency:'USD',equity:0,cash:0,buyingPower:{usd:350,...(fx?{fromKRWUSD:350,integratedMargin:true}:{})}}],cash:{KRW:505000,USD:0},macro:{indicators:[{name:'USD/KRW',value:1300}]},quotes:[{symbol:'NASD:A',price:100}],scoutPlan:{targets:[{symbol:'NASD:A',role:'candidate',targetWeightPct:10}]},risk:{markets:{US:{maxOrderKRW:150,maxCompanyPct:50}}}});
  const funded=us(true);funded.planGap=PG.planGap(funded);PG.addMinimumPositions(funded);assert.deepEqual(funded.planGap.targets[0].minimumPosition.checks,{cash:true,sizing:null,companyCap:true,orderCap:true,marketOpen:null},'$100 is 28.6% of the $350 funded through KRW');
  const empty=us(false);empty.planGap=PG.planGap(empty);PG.addMinimumPositions(empty);assert.equal(empty.planGap.targets[0].minimumPosition.checks.companyCap,false,'an account with nothing fails the concentration check');
});
// Plan verdicts (artifacts/reviews/2026-11-19-plan-verdicts/handoff.md, step 1): a target whose market does not take the
// app's orders now is not feasible, so the review is not asked to compare buying it now with cash. Made-up values.
test('the minimum position is feasible only while its market takes the app orders; a closed market raises no comparison issue',()=>{
  const wait=s=>({symbol:s,verdict:'waiting',reason:'r',condition:{kind:'price',unresolved:'u',evidence:'a close above the level',recheck:'next session'},dataGap:null,minimumPosition:null});
  const closed=ctx({marketSession:{open:false,status:'closed'}});closed.planGap=PG.planGap(closed);PG.addMinimumPositions(closed);const t=closed.planGap.targets[1];
  assert.equal(t.minimumPosition.checks.marketOpen,false);assert.equal(t.minimumPosition.feasible,false,'what the model reads: feasible false, checks.marketOpen false');
  assert.deepEqual(PG.verdictIssues(closed,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[wait('360750')]}),[],'no comparison asked for a market that is closed');
  const open=ctx();open.planGap=PG.planGap(open);PG.addMinimumPositions(open);assert.equal(open.planGap.targets[1].minimumPosition.feasible,true);
  assert.match(PG.verdictIssues(open,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[wait('360750')]}).join(),/360750: no comparison/,'open: still asked');
  // Combined: each market by its own session; a U.S. target during Korean hours is not feasible, a Korean one is.
  const both={markets:[{market:'KR',currency:'KRW',equity:505000,cash:505000,marketSession:{open:true}},{market:'US',currency:'USD',equity:0,cash:0,buyingPower:{usd:350},marketSession:{open:false,status:'closed'}}],cash:{KRW:505000,USD:0},macro:{indicators:[{name:'USD/KRW',value:1300}]},
    quotes:[{symbol:'NASD:A',price:100},{symbol:'360750',price:25415}],scoutPlan:{targets:[{symbol:'NASD:A',role:'candidate',targetWeightPct:10},{symbol:'360750',role:'candidate',targetWeightPct:5}]}};
  both.planGap=PG.planGap(both);PG.addMinimumPositions(both);const [us,kr]=both.planGap.targets;
  assert.deepEqual([us.minimumPosition.checks.marketOpen,us.minimumPosition.feasible],[false,false]);assert.deepEqual([kr.minimumPosition.checks.marketOpen,kr.minimumPosition.feasible],[true,true]);
  both.markets[1].marketSession={open:true};both.markets[0].marketSession={open:false};both.planGap=PG.planGap(both);PG.addMinimumPositions(both);
  assert.deepEqual(both.planGap.targets.map(x=>x.minimumPosition.feasible),[true,false],'the other clock: U.S. open, Korea closed');
  // A single-market context cannot buy the other market's target; one with no session reported leaves it unknown.
  const krOnly=ctx({quotes:[{symbol:'NASD:A',price:100}],macro:{indicators:[{name:'USD/KRW',value:1300}]},scoutPlan:{targets:[{symbol:'NASD:A',role:'candidate',targetWeightPct:10}]}});krOnly.planGap=PG.planGap(krOnly);PG.addMinimumPositions(krOnly);
  assert.equal(krOnly.planGap.targets[0].minimumPosition.checks.marketOpen,false);assert.equal(krOnly.planGap.targets[0].minimumPosition.feasible,false);
  const none=ctx({marketSession:undefined});none.planGap=PG.planGap(none);PG.addMinimumPositions(none);assert.equal(none.planGap.targets[1].minimumPosition.checks.marketOpen,null);assert.equal(none.planGap.targets[1].minimumPosition.feasible,true);
});
test('verdict issues: untestable waiting, vague evidence, unassessed data gaps, missing comparisons, Hold without reconsideration',()=>{
  const c=ctx();c.planGap=PG.planGap(c);PG.addMinimumPositions(c);
  const good={action:'Hold',plan:{invalidation:'Reconsider if preliminary figures show margin recovery.'},planVerdicts:[
    {symbol:'005930',verdict:'waiting',reason:'r',condition:{kind:'data',unresolved:'Q3 net income not disclosed',evidence:'the board-approved Q3 figures',recheck:'the Q3 report filing'},dataGap:{material:true,why:'w',otherSource:'none',alternative:'ETF',retry:'next filing'},minimumPosition:{bull:'b',base:'b',bear:'b',conclusion:'c'}},
    {symbol:'360750',verdict:'passed',reason:'r',condition:{kind:'none',unresolved:'',evidence:'',recheck:''},dataGap:null,minimumPosition:{bull:'b',base:'b',bear:'b',conclusion:'c'}}]};
  assert.deepEqual(PG.verdictIssues(c,good),[]);
  const bad={action:'Hold',plan:{invalidation:''},planVerdicts:[{symbol:'005930',verdict:'waiting',reason:'r',condition:{kind:'data',unresolved:'x',evidence:'stronger evidence',recheck:'later'},dataGap:null,minimumPosition:null},{symbol:'360750',verdict:'waiting',reason:'r'}]};
  const issues=PG.verdictIssues(c,bad).join(' | ');
  for(const re of [/005930: the resolving evidence is vague/,/005930: missing data without a data-gap assessment/,/005930: no comparison of the minimum feasible position/,/360750: waiting without a specific condition/,/Hold without a reconsideration condition/])assert.match(issues,re);
});
test('the decision format: testable verdict fields survive validation, and every object is strict',()=>{
  const d=validateDecision({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'x',plan:{thesis:'',invalidation:'i',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low'},complexity:{score:10,reason:'r'},
    planVerdicts:[{symbol:'005930',verdict:'waiting',reason:'r',condition:{kind:'event',unresolved:'u',evidence:'e',recheck:'k'},dataGap:null,minimumPosition:{bull:'b',base:'m',bear:'d',conclusion:'c'}}]},['005930']);
  assert.deepEqual(d.planVerdicts[0].condition,{kind:'event',unresolved:'u',evidence:'e',recheck:'k'});assert.equal(d.planVerdicts[0].minimumPosition.conclusion,'c');assert.equal(d.planVerdicts[0].dataGap,undefined);
  const strict=(s,path='')=>{if(s.anyOf){s.anyOf.forEach((x,i)=>strict(x,path+'/anyOf'+i));return;}if(s.type==='object'||(Array.isArray(s.type)&&s.type.includes('object'))){assert.equal(s.additionalProperties,false,path);assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort(),path);for(const [k,v] of Object.entries(s.properties))strict(v,path+'/'+k);}if(s.items)strict(s.items,path+'[]');};
  strict(decisionSchema(true,true));const item=decisionSchema(false,true).properties.planVerdicts.items;assert.ok(item.properties.dataGap.anyOf.some(x=>x.type==='null'),'nullable objects use anyOf');
});
test('end to end: a stale breadth reading reaches the review labeled stale and out of the regime score',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:1}],()=>[]),{request:async()=>({})},()=>{});
  a.indexCloses=()=>({});a.macro={get:()=>({series:[{id:'US_VIX',value:20},{id:'US_HY_SPREAD',value:4,change:0}]})};a.marketOverviewCache=()=>({value:{breadth:[{index:'KOSPI',advanceRatioPct:13.2}]},at:Date.now()-10*86400000});
  const r=a.regimeState();const c=r.components.find(x=>x.name==='KOSPI advancers %');assert.equal(c.stale,true);assert.equal(c.score,0);assert.match(c.reading,/stale/);
  a.marketOverviewCache=()=>({value:{breadth:[{index:'KOSPI',advanceRatioPct:13.2}]},at:undefined});assert.equal(a.regimeState().components.find(x=>x.name==='KOSPI advancers %').stale,true,'unknown time is stale');
});
test('end to end: the stale label and its time survive into the review context, and the cheaper model has room for the verdict format',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:1}],()=>[]),{request:async()=>({})},()=>{});
  a.indexCloses=()=>({});a.macro={get:()=>({series:[{id:'US_VIX',value:20},{id:'US_HY_SPREAD',value:4,change:0}]})};a.marketOverviewCache=()=>({value:{breadth:[{index:'KOSPI',advanceRatioPct:13.2}]},at:Date.now()-10*86400000});
  const c=a.riskContext({universe:[],quotes:[]}).marketRegime.components.find(x=>x.name==='KOSPI advancers %');assert.equal(c.stale,true);assert.ok(c.asOf);assert.match(c.reading,/^stale: from an earlier session/);
  assert.ok(require('../electron/ai-models.cjs').settings({openaiModel:'gpt-6-luna',reasoningEffort:'none'}).maxOutput>=4096);
});
