'use strict';
// Stage 3.4: historical restatements as the Performance page shows them (electron/settlement-restatements.cjs holds the
// rules). Discovery, preview and approval only; nothing here approves on its own, and nothing restores an approval that
// is no longer in force.
// - The account and the approver are given by the main process, never taken from the renderer.
// - Approval needs the preview's binding, a request id and a note. A stale preview is refused and a fresh one returned,
//   which needs another explicit confirmation.
// - A preview separates the historical change being approved (the days up to the resolution day, which the binding
//   covers) from live figures (periods ending today, which move with every reading and are not part of the approval).
// - Buys paid from Korean cash or by an unknown route have no candidate: listed apart, their days stay unavailable.
const SERIES=['USD','COMBINED','KRW'];
const fail=code=>Object.assign(new Error(code),{code});
const r6=v=>v==null||!Number.isFinite(v)?null:Math.round(v*1e6)/1e6;
function day(p){return p?{day:p.day,value:p.value,dailyReturn:r6(p.dailyReturn),pnl:p.pnl==null?null:p.pnl,correction:p.correction??0,...(p.restated?{restated:p.restated}:{}),...(p.unavailable?{unavailable:p.unavailable}:{})}:null;}
// The chained return from point a to point b (indexes), or null with reasons when a day between has no single return.
function chain(pts,a,b){if(a<0||b<=a)return {twr:null};const blocked=pts.slice(a+1,b+1).filter(p=>p.unavailable||p.bounded);
  return {twr:blocked.length?null:r6(pts[b].index/pts[a].index-1),...(blocked.length?{unavailable:blocked.map(p=>`${p.day}: ${(p.unavailable??['a return range']).join('; ')}`)}:{})};}
// What the approval changes and its binding covers (stage 3.4 review, P2): the restated days D..R-1 and their chained
// return from D-1, and the resolution day's accounting correction. Day R's own return and P/L depend on its value,
// which later readings that day still change, so they are live figures (below), not part of this.
function span(summary,candidate){const pts=summary.points,i=pts.findIndex(p=>p.day===candidate.paymentDay),j=pts.findIndex(p=>p.day===candidate.resolutionDay);
  if(i<1||j<=i)return {from:null,to:null,twr:null,days:[],resolution:null};const r=pts[j];
  return {from:pts[i-1].day,to:pts[j-1].day,...chain(pts,i-1,j-1),days:pts.slice(i,j).map(day),resolution:{day:r.day,correction:r.correction??0,items:[...new Set((r.correctionItems??[]).map(x=>x.kind))]}};}
// Day R's return and P/L, and the chained return through R: live while R's value can still change.
function resolutionLive(summary,candidate){const pts=summary.points,i=pts.findIndex(p=>p.day===candidate.paymentDay),j=pts.findIndex(p=>p.day===candidate.resolutionDay);
  if(j<0)return null;const r=pts[j];return {day:r.day,dailyReturn:r6(r.dailyReturn),pnl:r.pnl??null,...(r.unavailable?{unavailable:r.unavailable}:{}),through:{from:i>0?pts[i-1].day:null,...chain(pts,i-1,j)}};}
function previewView(p){const c=p.candidate;
  const historical=Object.fromEntries(SERIES.map(k=>[k,{before:span(p.before[k],c),after:span(p.after[k],c)}]));
  const live=Object.fromEntries(SERIES.map(k=>[k,{resolutionDay:{before:resolutionLive(p.before[k],c),after:resolutionLive(p.after[k],c)},
    periods:['All','1M'].map(label=>{const b=p.before[k].periods.find(x=>x.label===label),a=p.after[k].periods.find(x=>x.label===label);return {label,start:a?.start??b?.start??null,end:a?.end??null,before:{twr:r6(b?.twr),gain:b?.gain??null},after:{twr:r6(a?.twr),gain:a?.gain??null}};})}]));
  return {candidate:{id:c.id,usd:c.usd,paymentDay:c.paymentDay,resolutionDay:c.resolutionDay,days:c.days,source:c.source},binding:p.binding,written:p.written,label:p.label,historical,
    live:{note:'Live figures can still change with later readings: the resolution day\'s own return and P/L, and periods ending today. They are shown for context and are not part of what you approve.',series:live}};}
// Each approval with whether it is in force, and why not.
function records(restatements,account,rows){const current=new Map(restatements.candidates(account,rows).map(c=>[c.id,c])),seen=new Set();
  return restatements.records(account).map(r=>{const c=current.get(r.candidate.id);let status='active',reason=null;
    if(!c){status='inactive';reason='its reconciliation was reversed, or its evidence no longer supports the payment day';}
    else if(c.fingerprint!==r.candidate.fingerprint){status='inactive';reason='the evidence or the recorded values it rests on changed after approval; preview it again to approve the current version';}
    else if(seen.has(c.id)){status='inactive';reason='an earlier approval of the same version is in force';}
    if(status==='active')seen.add(c.id);
    return {id:r.id,version:r.version,status,reason,approvedAt:r.approvedAt,approval:{by:r.approval?.by??null,note:r.approval?.note??null},candidate:{id:r.candidate.id,usd:r.candidate.usd,paymentDay:r.candidate.paymentDay,resolutionDay:r.candidate.resolutionDay,days:r.candidate.days,source:r.candidate.source}};}).reverse();}
function restatementActions({restatements,reconciliation,identity}){
  const state=account=>{const history=restatements.performance.history(account),list=records(restatements,account,history),active=new Set(list.filter(r=>r.status==='active').map(r=>r.candidate.id));
    const candidates=restatements.candidates(account,history).filter(c=>!active.has(c.id)).map(c=>({id:c.id,usd:c.usd,paymentDay:c.paymentDay,resolutionDay:c.resolutionDay,days:c.days,source:c.source,label:'if approved'}));
    const unsupported=(reconciliation?.active(account)??[]).filter(r=>r.side==='Buy'&&r.explanation==='settled'&&r.route!=='USD').map(r=>({id:r.id,usd:r.cents/100,route:r.route??'unknown',reason:r.route==='KRW'?'paid from Korean cash: the cross-market accounting is not built yet':'the funding route is unknown'}));
    return {candidates,records:list,unsupported};};
  return {state,
    preview(account,candidateId){if(typeof candidateId!=='string'||!candidateId)throw fail('INVALID_REQUEST');return previewView(restatements.preview(account,candidateId));},
    // req from the renderer: {candidateId, requestId, binding, note}; account and identity are the main process's.
    approve(account,req){if(!req||typeof req!=='object'||Array.isArray(req))throw fail('INVALID_REQUEST');const {candidateId,requestId,binding,note}=req;
      if(typeof candidateId!=='string'||!candidateId)throw fail('INVALID_REQUEST');
      if(typeof requestId!=='string'||requestId.length<8||requestId.length>80||typeof binding!=='string'||!binding)throw fail('PREVIEW_REQUIRED');
      if(typeof note!=='string'||!note.trim()||note.length>500)throw fail('NOTE_REQUIRED');
      const who=identity();if(!who||typeof who.by!=='string'||!who.by.trim())throw fail('APPROVER_UNKNOWN');
      try{const r=restatements.approve({account,candidateId,requestId,binding,approval:{by:who.by,...(who.session?{session:who.session}:{}),note:note.trim()}});return {recordId:r.id,version:r.version};}
      catch(e){// Stale: a fresh preview, for another explicit confirmation; never applied here.
        if(e.code==='PREVIEW_MISMATCH'){let fresh=null;try{fresh=previewView(restatements.preview(account,candidateId));}catch{}throw Object.assign(fail('PREVIEW_MISMATCH'),{preview:fresh});}
        throw e;}}};}
module.exports={restatementActions,previewView,records};
