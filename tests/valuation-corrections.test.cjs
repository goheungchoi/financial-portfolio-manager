// Versioned valuation corrections (audit 2026-11-04, Stage 2): previewed without writing, applied only with approval,
// originals kept, later versions supersede earlier ones for their days.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {ValuationCorrections}=require('../electron/valuation-corrections.cjs');
const at=day=>Date.parse(day+'T03:00:00Z');
function history(){let now=at('2026-10-22');const db=new DatabaseSync(':memory:');const h=new PerformanceHistory(db,()=>now);const c=new ValuationCorrections(db,()=>now);h.adjustments=a=>c.inForce(a);
  const row=(krw,usd)=>({totals:{KRW:krw,USD:usd,equityKRW:krw+usd*1335},cash:{KRW:krw,USD:usd},rows:[],fx:{usdKRW:1335}});
  for(const [day,usd] of [['2026-10-22',554],['2026-10-23',651.04],['2026-10-24',651.04],['2026-10-27',554]]){now=at(day);h.record('acct',row(700000,usd));}return {db,h,c};}
const tlsp=['2026-10-23','2026-10-24'].map(day=>({day,market:'US',amount:-94.38,reason:'TLSP cost not deducted before settlement',evidence:'KIS ledger entry (to be supplied)'}));
test('a preview shows returns, drawdown and the corrected days, and writes nothing',()=>{
  const {db,h,c}=history();const before=JSON.stringify(db.prepare('SELECT * FROM nav_history').all());
  const p=c.preview('acct',h,tlsp);assert.equal(p.written,false);assert.deepEqual(p.days.map(d=>d.day),['2026-10-23','2026-10-24']);
  assert.ok(Math.abs(p.days[0].before-p.days[0].after-94.38*1335)<0.01);assert.notEqual(p.before.maxDrawdownPct,p.after.maxDrawdownPct,'the false peak and drawdown go');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM nav_history').all()),before,'recorded values untouched');assert.equal(c.versions('acct').length,0);
});
test('a correction applies only with approval, keeps the recorded value, and a later version supersedes it',()=>{
  const {h,c}=history();assert.throws(()=>c.apply('acct',tlsp,null),/APPROVAL_REQUIRED/);assert.throws(()=>c.apply('acct',[{day:'2026-10-23',market:'US',amount:-1,reason:'',evidence:'x'}],{by:'user'}),/INVALID_CORRECTION/);
  const v1=c.apply('acct',tlsp,{by:'user',note:'approved in chat'});assert.equal(v1.version,1);const s=h.series('acct','COMBINED');const d=s.find(p=>p.day==='2026-10-23');
  assert.ok(Math.abs(d.recorded-d.value-94.38*1335)<0.01,'recorded value kept beside the corrected one');assert.equal(h.history('acct').find(r=>r.day==='2026-10-23').USD.equity,651.04);
  c.apply('acct',[{...tlsp[0],amount:-50,reason:'ledger shows $50'}],{by:'user'});assert.deepEqual(c.inForce('acct').map(a=>[a.day,a.amount,a.version]).sort(),[['2026-10-23',-50,2],['2026-10-24',-94.38,1]]);
  assert.equal(c.versions('acct').length,2,'every version kept');
});
