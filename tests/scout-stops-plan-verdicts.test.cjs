// Two fixes found in live use (handoff 2026-11-25 scout-stops-plan-verdicts). Made-up codes and figures; no AI call, no
// broker. (1) The scout is told the orders armed now for each holding, in the review's own view, so a trailing stop
// shows its level as it stands and not the level the scout's previous plan named. (2) The one-share comparison belongs
// to targets the plan may buy (add, candidate): a hold, trim or exit target has no minimumPosition and raises no issue.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const PG=require('../electron/plan-gap.cjs');

function scoutSetup(conditionalOrders=true){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]);
  const a=new Automation(db,paper,{request:async()=>({})},()=>{});
  a.config={...a.config,scope:'kis',conditionalOrders,trailingStops:true};
  a.live={identity:()=>'acct-1',exposure:null,context:async()=>({market:'KR',currency:'KRW',equity:1000000,cash:400000,
    positions:{'990001':{quantity:3},'990002':{quantity:5},'990003':{quantity:2}},
    quotes:[{symbol:'990001',price:110000},{symbol:'990002',price:40000},{symbol:'990003',price:20000}],
    universe:[{symbol:'990001',name:'Alpha'},{symbol:'990002',name:'Beta'},{symbol:'990003',name:'Gamma'}]})};
  const scope=a.watchScope(),now=Date.now(),exp=now+86400000;
  const row=o=>a.desk.write('conditional_orders',{scope,status:'armed',createdAt:now,expiresAt:exp,combine:'all',limitPrice:null,...o});
  // A trailing stop armed at 92,000 whose level has since moved to 101,200 with the price.
  row({id:'t1',symbol:'990001',side:'Sell',quantity:3,purpose:'stop_loss',conditions:[{metric:'price',operator:'<=',value:92000}],
    trail:{kind:'pct',pct:8,floor:92000,activateAt:null,active:true,high:110000,highAt:now-60000,level:101200}});
  // A fixed stop loss.
  row({id:'f1',symbol:'990002',side:'Sell',quantity:5,purpose:'stop_loss',conditions:[{metric:'price',operator:'<=',value:36000}]});
  // A short's cover stop on a held symbol: not a holding's order.
  row({id:'c1',symbol:'990003',side:'Buy',quantity:1,purpose:'stop_loss',conditions:[{metric:'price',operator:'>=',value:23000}],credit:{kind:'cover',loanDate:'20261120',source:'self'}});
  return a;
}

test('the scout sees the orders armed now for each holding: a trailing stop at its level now, a fixed stop by its condition, none for a holding without',async()=>{
  const a=scoutSetup();const [kr]=await a.scoutAccount(['KR']);const by=Object.fromEntries(kr.positions.map(p=>[p.symbol,p]));
  const [trail]=by['990001'].armedOrders;
  assert.equal(trail.trail.level,101200,'the level now, not the 92,000 at arming');assert.equal(trail.trail.floor,92000);assert.equal(trail.trail.distance,'8%');
  assert.deepEqual(Object.keys(trail).sort(),['combine','conditions','expires','purpose','quantity','side','trail'],'facts only, no id or instruction');
  const {armedView}=require('../electron/agent-desk.cjs');
  assert.deepEqual(trail.trail,armedView(a.desk.orders(a.watchScope()).find(o=>o.id==='t1'),a.config).trail,'the review\'s own trail view');
  assert.deepEqual(by['990002'].armedOrders,[{side:'Sell',quantity:5,purpose:'stop_loss',conditions:[{metric:'price',operator:'<=',value:36000}],combine:'all',expires:by['990002'].armedOrders[0].expires}]);
  assert.equal('armedOrders' in by['990003'],false,'a cover stop is not a holding\'s order; no empty array');
});

test('with conditional orders off the scout gets no armedOrders',async()=>{
  const a=scoutSetup(false);const [kr]=await a.scoutAccount(['KR']);
  assert.ok(kr.positions.every(p=>!('armedOrders' in p)));
});

test('the review sees the same armed view as before (refactor only)',()=>{
  const a=scoutSetup();const ctx=a.desk.context(a.watchScope(),a.config,['990001','990002'],{});
  const t=ctx.conditionalOrders.armed.find(o=>o.id==='t1');
  assert.deepEqual(Object.keys(t),['id','symbol','side','quantity','limitPrice','purpose','conditions','combine','expires','trail']);
});

const ctx=(targets)=>({market:'KR',currency:'KRW',equity:1000000,cash:1000000,executionEnabled:true,marketSession:{open:true},
  quotes:targets.map((t,i)=>({symbol:t.symbol,price:10000+i})),positions:{'990011':{quantity:1},'990012':{quantity:1},'990013':{quantity:1}},
  positionSizing:{rows:targets.map(t=>({symbol:t.symbol,maxShares:10}))},scoutPlan:{asOf:'a',targets}});
const passed=s=>({symbol:s,verdict:'passed',reason:'r',condition:{kind:'none',unresolved:'',evidence:'',recheck:''},dataGap:null,minimumPosition:null});

test('plan verdicts: hold, trim and exit targets get no minimumPosition and no comparison issue; add and candidate still do',()=>{
  const roles={'990011':'hold','990012':'trim','990013':'exit','990014':'add','990015':'candidate'};
  const c=ctx(Object.entries(roles).map(([symbol,role])=>({symbol,name:symbol,role,targetWeightPct:5})));
  c.planGap=PG.planGap(c);PG.addMinimumPositions(c);const by=Object.fromEntries(c.planGap.targets.map(t=>[t.symbol,t]));
  for(const s of ['990011','990012','990013'])assert.equal('minimumPosition' in by[s],false,roles[s]+': no minimumPosition');
  for(const s of ['990014','990015'])assert.equal(by[s].minimumPosition.feasible,true,roles[s]+': still there');
  const issues=PG.verdictIssues(c,{action:'Hold',plan:{invalidation:'x'},planVerdicts:Object.keys(roles).map(passed)}).filter(i=>/no comparison/.test(i));
  assert.deepEqual(issues.map(i=>i.split(':')[0]),['990014','990015']);
  // The role is checked in verdictIssues too: a hold target carrying a feasible minimumPosition raises nothing.
  by['990011'].minimumPosition={feasible:true};
  assert.equal(PG.verdictIssues(c,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[passed('990011')]}).length,0);
});
