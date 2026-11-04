// Versioned valuation corrections (audit 2026-11-04, Stage 2): previewed without writing, applied only with approval,
// originals kept, later versions supersede earlier ones for their days.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {ValuationCorrections}=require('../electron/valuation-corrections.cjs');
const at=day=>Date.parse(day+'T03:00:00Z');
function history(){let now=at('2026-10-29');const db=new DatabaseSync(':memory:');const h=new PerformanceHistory(db,()=>now);const c=new ValuationCorrections(db,()=>now);h.adjustments=a=>c.inForce(a);
  const row=(krw,usd)=>({totals:{KRW:krw,USD:usd,equityKRW:krw+usd*1335},cash:{KRW:krw,USD:usd},rows:[],fx:{usdKRW:1335}});
  for(const [day,usd] of [['2026-10-29',559],['2026-10-30',656.66],['2026-10-31',656.66],['2026-11-03',559]]){now=at(day);h.record('acct',row(700000,usd));}return {db,h,c};}
const rddt=['2026-10-30','2026-10-31'].map(day=>({day,market:'US',amount:-97.66,reason:'RDDT cost not deducted before settlement',evidence:'KIS ledger entry (to be supplied)'}));
test('a preview shows returns, drawdown and the corrected days, and writes nothing',()=>{
  const {db,h,c}=history();const before=JSON.stringify(db.prepare('SELECT * FROM nav_history').all());
  const p=c.preview('acct',h,rddt);assert.equal(p.written,false);assert.deepEqual(p.days.map(d=>d.day),['2026-10-30','2026-10-31']);
  assert.ok(Math.abs(p.days[0].before-p.days[0].after-97.66*1335)<0.01);assert.notEqual(p.before.maxDrawdownPct,p.after.maxDrawdownPct,'the false peak and drawdown go');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM nav_history').all()),before,'recorded values untouched');assert.equal(c.versions('acct').length,0);
});
test('a correction applies only with approval, keeps the recorded value, and a later version supersedes it',()=>{
  const {h,c}=history();assert.throws(()=>c.apply('acct',rddt,null),/APPROVAL_REQUIRED/);assert.throws(()=>c.apply('acct',[{day:'2026-10-30',market:'US',amount:-1,reason:'',evidence:'x'}],{by:'user'}),/INVALID_CORRECTION/);
  const v1=c.apply('acct',rddt,{by:'user',note:'approved in chat'});assert.equal(v1.version,1);const s=h.series('acct','COMBINED');const d=s.find(p=>p.day==='2026-10-30');
  assert.ok(Math.abs(d.recorded-d.value-97.66*1335)<0.01,'recorded value kept beside the corrected one');assert.equal(h.history('acct').find(r=>r.day==='2026-10-30').USD.equity,656.66);
  c.apply('acct',[{...rddt[0],amount:-50,reason:'ledger shows $50'}],{by:'user'});assert.deepEqual(c.inForce('acct').map(a=>[a.day,a.amount,a.version]).sort(),[['2026-10-30',-50,2],['2026-10-31',-97.66,1]]);
  assert.equal(c.versions('acct').length,2,'every version kept');
});
