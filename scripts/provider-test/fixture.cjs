'use strict';
// Isolated provider test: the composed fixture (design option B) and the tools that answer from it.
// compose() reads a read-only copy of the profile database and builds the review input from one saved dry run:
// - the snapshot the dry run saved is kept exactly as recorded, session and staleness flags included;
// - the fields the current context builder adds that the recorded build did not are rebuilt by current code from
//   records demonstrably in force at the cutoff (the moment the snapshot was assembled), or marked unavailable when
//   that state cannot be recovered; nothing from after the cutoff is used and current state is never substituted;
// - every field says where it came from, as of when, and how;
// - the tool results the dry run recorded are a timeline with their own times (they arrived after the snapshot), and a
//   result cut off in the log is not served.
// With anything unavailable or kept in an older format, the fixture is a synthetic compatibility fixture, not an exact
// historical replay, and says so.
const crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const canonicalJSON=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(key=>[key,x[key]])):x);
const digest=v=>crypto.createHash('sha256').update(canonicalJSON(v)).digest('hex');
// The build that recorded the snapshot is not stored in the dry-run record; it is given by the caller with its evidence.
// Fields the current builder sets that the recorded build (49b6b37) did not (git diff 49b6b37..HEAD of
// electron/automation.cjs), and context producers whose format changed since (electron/live-engine.cjs, waits.cjs).
const ADDED={positionMemory:'Stage 4: the last filled entry and exit per symbol, which reversal validation reads',equityUncertainty:'Stage 2: how far the net-equity valuation may understate equity'};
const KEPT={equity:'recorded by the Stage 1 build before the Stage 2 net-equity valuation; the broker balance fields the current valuation needs were not recorded (no broker_balances table in the source), so it is kept as recorded, not recomputed',
  waits:'recorded in the Stage 1 format; Stage 4 dated check reasons are not converted',
  risk:'recorded before Stage 3; risk.credit is added by the current builder only when margin or short trading is enabled or a credit position is held, and the recorded risk and positions show neither (the saved preferences at the cutoff are not kept, so this rests on the recorded section)',
  markets:'per-market fields recorded by the Stage 1 build (electron/live-engine.cjs changed since for credit paths and loss valuation)'};
const TOOL_OF=e=>e.title==='Market data request'?'get_market_evidence':e.title==='Discovery request'?(a=>a&&Object.keys(a).length===0?'get_market_overview':Array.isArray(a?.sections)?'get_company_research':null):null;
const LOG_LIMIT=4000;
function compose({source,dryRun,recordedBuild=null}){
  const db=new DatabaseSync(source,{readOnly:true});
  try{
    const rows=db.prepare("SELECT id,payload FROM dry_runs WHERE id LIKE ?").all(dryRun+'%');if(rows.length!==1)throw Object.assign(new Error('FIXTURE_SOURCE'),{detail:`${rows.length} dry runs match ${dryRun}`});
    const record=JSON.parse(rows[0].payload);const snapshot=record.snapshot,assembledAt=record.summary?.assembledAt;const cutoff=Date.parse(assembledAt);
    if(!snapshot||!Number.isFinite(cutoff))throw Object.assign(new Error('FIXTURE_SOURCE'),{detail:'the dry run kept no snapshot or assembly time'});
    const context=structuredClone(snapshot),provenance={},unavailable=[];
    for(const key of Object.keys(snapshot))provenance[key]={source:`dry_runs ${rows[0].id}: snapshot`,at:assembledAt,method:KEPT[key]?'as recorded; '+KEPT[key]:'as recorded'};
    // Position memory: the outcome version in force at the cutoff (the latest recorded at or before it), and only
    // reviews made by then.
    const tag=record.summary?.account?.key??null;
    const versions=new Map();for(const v of db.prepare('SELECT outcomeId,recordedAt,payload FROM outcome_versions').all()){if(!versions.has(v.outcomeId))versions.set(v.outcomeId,[]);versions.get(v.outcomeId).push(v);}
    const used=[],excluded=[],missing=[];
    for(const row of db.prepare('SELECT id,payload FROM trade_outcomes').all()){const now=JSON.parse(row.payload);
      const before=(versions.get(row.id)??[]).filter(v=>v.recordedAt<=cutoff).sort((a,b)=>a.recordedAt-b.recordedAt).at(-1);
      if(before){used.push({id:row.id,recordedAt:before.recordedAt,outcome:JSON.parse(before.payload)});continue;}
      if(now.timestamp>cutoff){excluded.push({id:row.id,reason:'filled after the cutoff'});continue;}
      if(Number.isFinite(now.updatedAt)&&now.updatedAt<=cutoff){used.push({id:row.id,recordedAt:now.updatedAt,outcome:now});continue;}
      missing.push({id:row.id,reason:'filled before the cutoff, but no version of it recorded by then'});}
    if(!tag)unavailable.push({field:'positionMemory',reason:'the dry run does not name its account'});
    else if(missing.length)unavailable.push({field:'positionMemory',reason:`${missing.length} outcome(s) filled before the cutoff have no version recorded by then`,outcomes:missing.map(m=>m.id)});
    else{
      const reviews=db.prepare("SELECT id,json_extract(payload,'$.timestamp') AS t,json_extract(payload,'$.account.key') AS k FROM reviews").all().filter(r=>Number.isFinite(r.t)&&r.t<=cutoff);
      const reviewAt=new Map(reviews.map(r=>[r.id,r.t]));const mine=reviews.filter(r=>r.k===tag);
      const memory=require('../../electron/position-memory.cjs').build(used.map(u=>u.outcome),{accounts:[tag,tag+':US'],positions:snapshot.positions??{},reviewAt,reviewsSince:(symbol,t)=>mine.filter(r=>r.t>t).length,now:cutoff});
      context.positionMemory=memory;
      provenance.positionMemory={source:'trade_outcomes and outcome_versions, reviews (source copy)',at:new Date(Math.max(...used.map(u=>u.recordedAt))).toISOString(),
        method:`current position-memory.build applied to the ${used.length} outcome versions in force at the cutoff and the ${reviews.length} reviews made by then (effects derived by outcome-evaluation.effectOf); ${excluded.length} later outcome(s) left out`,entries:memory.length};}
    if(!context.equityUncertainty){context.equityUncertainty={unavailable:true,reason:'the broker balance fields the current net-equity valuation needs were not recorded at the cutoff; how far equity may be understated is unknown'};
      unavailable.push({field:'equityUncertainty',reason:context.equityUncertainty.reason});provenance.equityUncertainty={source:'none',at:null,method:'marked unavailable'};}
    // The recorded tool results, in the order and at the times they arrived; a result cut off by the log is not served.
    const transcript=record.review?.transcript??[],tools=[],unmapped=[];
    for(let i=0;i<transcript.length;i++){const e=transcript[i];if(!/request$/.test(e.title))continue;const res=transcript[i+1];let args;try{args=JSON.parse(e.body);}catch{unmapped.push({title:e.title,reason:'arguments not readable'});continue;}
      const tool=(f=>typeof f==='function'?f(args):f)(TOOL_OF(e));if(!tool||!res||!/result$/.test(res.title)){unmapped.push({title:e.title,args,reason:'no tool or result could be matched'});continue;}
      let result=null,status='available';try{result=JSON.parse(res.body);}catch{status='truncated';}if(res.body.length>=LOG_LIMIT)status='truncated';
      tools.push({tool,args,requestedAt:e.at,recordedAt:res.at,status,...(status==='available'?{result}:{recordedChars:res.body.length})});}
    const kind=unavailable.length||Object.keys(KEPT).some(k=>k in snapshot)?'synthetic compatibility fixture':'historical replay';
    const meta={kind,dryRun:rows[0].id,assembledAt,cutoff:assembledAt,account:record.summary?.account?.label??null,recordedBuild,
      session:record.summary?.sessions??null,quotes:record.summary?.quotes??null,recordedReview:record.review?{model:record.review.model,effort:record.review.effort,requests:record.review.calls,costUSD:record.review.costUSD}:null,
      added:ADDED,kept:KEPT,unavailable,excludedAfterCutoff:excluded,unmappedTools:unmapped,
      note:'Broker and market data are frozen as recorded at the cutoff; the market was closed and every quote stale, so this fixture does not test open-market behaviour.'};
    const fixture={meta,context,provenance,tools};const found=credentialsIn(fixture);if(found.length)throw Object.assign(new Error('FIXTURE_HOLDS_CREDENTIALS'),{detail:found.slice(0,5)});
    return {...fixture,digest:digest(fixture)};
  }finally{db.close();}
}
// Anything in the fixture that looks like a credential, a token or an account number. The fixture is refused if found.
const KEY=/^(app_?key|app_?secret|secret|password|api_?key|authorization|credential|access_?token|refresh_?token|bearer)$/i;
const VALUE=[/\bsk-[A-Za-z0-9_-]{16,}/,/\bBearer\s+\S{10,}/i,/\b\d{8}-\d{2}\b/];
function credentialsIn(v,at='$',out=[]){if(Array.isArray(v))v.forEach((x,i)=>credentialsIn(x,`${at}[${i}]`,out));
  else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(KEY.test(k)&&typeof x==='string'&&x)out.push(at+'.'+k);credentialsIn(x,at+'.'+k,out);}
  else if(typeof v==='string'&&VALUE.some(r=>r.test(v)))out.push(at);return out;}
function verify(fixture){const {digest:d,...rest}=fixture;if(d!==digest(rest))throw Object.assign(new Error('FIXTURE_ALTERED'),{detail:'its digest does not match'});const found=credentialsIn(rest);if(found.length)throw Object.assign(new Error('FIXTURE_HOLDS_CREDENTIALS'),{detail:found.slice(0,5)});return true;}
// The tools of an isolated review: a recorded result for an exact request, otherwise explicitly unavailable; write
// tools are not applied. Every call is kept for the report.
function server(fixture){
  const byKey=new Map(fixture.tools.map(t=>[t.tool+' '+canonicalJSON(t.args??{}),t]));const calls=[];
  const lookup=(tool,args)=>{const f=byKey.get(tool+' '+canonicalJSON(args??{}));let value,served;
    if(f?.status==='available'){value=structuredClone(f.result);served='recorded';}
    else if(f){value={status:'unavailable',reason:'the recorded result was cut off in the log, so it is not served; the isolated test does not fetch'};served='unavailable: recording cut off';}
    else{value={status:'unavailable',reason:'no recorded result for this request; the isolated test does not fetch'};served='unavailable: not recorded';}
    calls.push({tool,args:args??{},served,recordedAt:f?.recordedAt??null,at:new Date().toISOString()});return value;};
  const inert=tool=>async args=>{calls.push({tool,args:args??{},served:'not applied',at:new Date().toISOString()});return {status:'not-applied',reason:`Isolated provider test: ${tool} was not applied.`};};
  return {lookup,inert,calls};
}
module.exports={compose,verify,server,credentialsIn,canonicalJSON,digest,ADDED,KEPT};
