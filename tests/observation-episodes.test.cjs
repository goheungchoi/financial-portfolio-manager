// Observation episodes (audit 2026-11-04, Stage 5): polling checks grouped into episodes per subject, with the reason
// each ended; counters say checks, episodes and reviews started apart.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const E=require('../electron/observation-episodes.cjs');const {AlertObservations,RULES_VERSION,parts}=require('../electron/watch-alerts.cjs');
const t0=Date.parse('2026-11-04T01:00:00Z'),min=n=>t0+n*60000;
const pct=(symbol,changePct,baseline=100)=>({kind:'percent',symbol,changePct,baseline});
test('100 identical poll checks are one episode, with every check kept',()=>{
  const o=new AlertObservations(new DatabaseSync(':memory:'));const held=new Set();
  for(let i=0;i<100;i++)o.record(min(i/2),{current:pct('396500',4.3),proposed:null,held,scope:'acct'});
  const [ep,...rest]=o.episodes(t0);assert.equal(rest.length,0);assert.equal(ep.count,100);assert.equal(ep.ids.length,100);assert.equal(ep.first,t0);assert.equal(ep.last,min(49.5));assert.equal(ep.endReason,'open');
  assert.equal(ep.detail.condition,'old-only');assert.equal(ep.key,`acct|KR|2026-11-04|396500|${RULES_VERSION}`);
});
test('an episode ends on a gap, a changed outcome, a new crossing or a review that assessed the symbol; other symbols never split it',()=>{
  const o=new AlertObservations(new DatabaseSync(':memory:'));const held=new Set();const r=(m,cur,pro=null)=>o.record(min(m),{current:cur,proposed:pro,held,scope:'acct'});
  r(0,{...pct('396500',4.3),alongside:[pct('462330',5)]});r(10,pct('396500',4.4));r(20,{...pct('462330',5),alongside:[pct('396500',4.5)]});
  r(90,pct('396500',4.6));                                   // gap over 60 minutes
  r(100,pct('396500',4.6),{kind:'watchlist',alerts:[{kind:'watchlist-move',symbol:'396500',changePct:7,baseline:90}]});  // outcome changed: both rules
  r(110,pct('396500',-4.1),{kind:'watchlist',alerts:[{kind:'watchlist-move',symbol:'396500',changePct:-7,baseline:90}]}); // the other side: a new crossing
  r(115,pct('396500',-4.2,95),{kind:'watchlist',alerts:[{kind:'watchlist-move',symbol:'396500',changePct:-7,baseline:90}]}); // a new baseline: reset
  r(120,pct('396500',-4.2,95),{kind:'watchlist',alerts:[{kind:'watchlist-move',symbol:'396500',changePct:-7,baseline:90}]});
  const reviewedAt=min(118);const eps=o.episodes(t0,{assessed:(s,from,to)=>s==='396500'&&reviewedAt>from&&reviewedAt<=to?reviewedAt:null}).filter(e=>e.detail.symbol==='396500');
  assert.deepEqual(eps.map(e=>[e.count,e.endReason]),[[3,'gap'],[1,'outcome-changed'],[1,'reset'],[1,'reset'],[1,'reviewed'],[1,'open']]);
  assert.equal(eps[4].endedAt,reviewedAt);assert.equal(o.episodes(t0).filter(e=>e.detail.symbol==='462330').length,1,'462330 checks at 0 and 20 are one episode');
});
test('rows from before Stage 5 group by symbol with an unrecorded account and rules version',()=>{
  const db=new DatabaseSync(':memory:');const o=new AlertObservations(db);
  db.prepare('INSERT INTO alert_observations(at,payload) VALUES(?,?)').run(min(0),JSON.stringify({current:{kind:'percent',symbols:['488080','005930'],changePct:3.2},proposed:null,currentHeld:false}));
  const p=parts({at:min(0),...JSON.parse(db.prepare('SELECT payload FROM alert_observations').get().payload)});assert.deepEqual(p.map(x=>x.key),['unrecorded|KR|2026-11-04|488080|unrecorded','unrecorded|KR|2026-11-04|005930|unrecorded']);
  assert.equal(o.episodes(t0).length,2);assert.equal(p[0].detail.held,false);
});
test('a U.S. check belongs to the New York trading day; the terms are shared',()=>{
  const [p]=parts({at:Date.parse('2026-11-04T03:00:00Z'),current:{kind:'percent',symbols:['NASD:NVDA']},proposed:null});assert.match(p.key,/\|US\|2026-11-03\|NASD:NVDA\|/);
  assert.deepEqual(Object.keys(E.TERMS),['check','episode','reviewStarted','comparison']);assert.equal(E.GAP_MS,3600000);
});
test('the routing report counts pairs selected for the audit apart from validly adjudicated ones',()=>{
  const {report}=require('../scripts/routing-report.cjs');const out=report({records:[],contextOf:()=>null,freeze:{evaluationStart:'2026-11-01T00:00:00Z',binding:{}},currentBinding:{}});
  assert.match(out.checks.adjudicationComplete.detail,/0 same\/wording pairs selected for the audit, 0 validly adjudicated \(at least 20 adjudicated\)/);
});
