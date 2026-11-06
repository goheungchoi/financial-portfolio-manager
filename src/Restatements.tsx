import {useCallback,useEffect,useState} from 'react';
import {Card,Row} from './SettingsUI';
import {Note} from './Note';
import {toast} from './Toast';
// Stage 3.4: accounting corrections and historical restatements on the Performance page (electron/restatement-view.cjs).
// Corrections and days without a return are shown apart from investment performance. A restatement is only ever applied
// by an explicit approval of its current preview, with a note; a stale preview is replaced by a fresh one that needs
// another confirmation. Approval history shows which approvals are in force.
type Day={day:string;value:number;dailyReturn:number|null;pnl:number|null;correction:number;restated?:number;unavailable?:string[]};
type Span={from:string|null;to:string;twr:number|null;unavailable?:string[];days:Day[]};
type Live={label:string;start:string|null;end:string|null;before:{twr:number|null;gain:number|null};after:{twr:number|null;gain:number|null}};
type Candidate={id:string;usd:number;paymentDay:string;resolutionDay:string;days:string[];source:string;label?:string};
export type RestatementPreview={candidate:Candidate;binding:string;written:boolean;label:string;historical:Record<string,{before:Span;after:Span}>;live:{note:string;series:Record<string,Live[]>}};
type Record_={id:string;version:number;status:'active'|'inactive';reason:string|null;approvedAt:number;approval:{by:string|null;note:string|null};candidate:Candidate};
export type RestatementState={candidates:Candidate[];records:Record_[];unsupported:{id:string;usd:number;route:string;reason:string}[]};
export type RestatementReply={ok:boolean;error?:string;data?:any;preview?:RestatementPreview|null;restatements:RestatementState|null};
type Point={day:string;correction?:number;correctionItems?:{kind:string;usd:number|null}[];unavailable?:string[];restated?:number};
const usd=(v:number)=>`${v<0?'−':v>0?'+':''}$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const pct=(v:number|null)=>v==null?'Unavailable':`${v>0?'+':''}${(v*100).toFixed(2)}%`;
const SOURCE:Record<string,string>={'reclassified flow':'payment seen as a detected cash change','audited settlement date':'audited settlement date'};
const ERR:Record<string,string>={PREVIEW_MISMATCH:'The figures changed since this preview. Review the refreshed preview and approve again.',HISTORICAL_TIMING_UNPROVEN:'The evidence no longer supports this restatement.',HISTORICAL_ALREADY_APPROVED:'This restatement is already approved.',
  NOTE_REQUIRED:'Enter a note for the approval.',PREVIEW_REQUIRED:'Preview the restatement first.',REQUEST_REUSED:'This form was already used. Preview again.',APPROVER_UNKNOWN:'The approver could not be identified on this computer.',KIS_NOT_CONNECTED:'Connect KIS first.'};
const rid=()=>crypto.randomUUID();
// The selected series' corrections and days without a return, kept apart from the returns above.
export function SettlementEffects({points,money}:{points:Point[];money:(v:number)=>string}){
  const corrected=points.filter(p=>p.correction),missing=points.filter(p=>p.unavailable?.length),restated=points.filter(p=>p.restated);
  if(!corrected.length&&!missing.length&&!restated.length)return null;
  return <>{corrected.length>0&&<Row block title="Accounting corrections" hint="Settlement bookkeeping, not investment return. Kept out of returns and P/L."><span>{corrected.length} day{corrected.length>1?'s':''}</span></Row>}
    {corrected.length>0&&<Note summary={`Corrections by day · ${corrected.length}`}><table className="compact-table" aria-label="Accounting corrections"><thead><tr><th>Day</th><th>Correction</th><th>What</th></tr></thead><tbody>{corrected.map(p=><tr key={p.day}><td>{p.day}</td><td>{money(p.correction!)}</td><td>{[...new Set((p.correctionItems??[]).map(i=>i.kind))].join(', ')||'settlement change'}</td></tr>)}</tbody></table></Note>}
    {missing.length>0&&<Row block title="Days without a return" hint="Unknown, not zero: returns, drawdowns and gains spanning them are unavailable."><span className="role-tag unverified">{missing.length} day{missing.length>1?'s':''}</span></Row>}
    {missing.length>0&&<Note summary={`Why · ${missing.length}`}><ul aria-label="Days without a return">{missing.map(p=><li key={p.day}><b>{p.day}</b> {p.unavailable![0]}{p.unavailable!.length>1?` (+${p.unavailable!.length-1} more)`:''}</li>)}</ul></Note>}
    {restated.length>0&&<Row block title="Restated days" hint="Changed by a historical correction you approved."><span>{restated.length} day{restated.length>1?'s':''}</span></Row>}</>;
}
const won=(v:number)=>`${v<0?'−':v>0?'+':''}₩${Math.round(Math.abs(v)).toLocaleString('ko-KR')}`;
function SpanTable({label,h,krw=false}:{label:string;h:{before:Span;after:Span};krw?:boolean}){const m=(v:number|null|undefined)=>v==null?'Unavailable':krw?won(v):usd(v);
  const before=new Map(h.before.days.map(d=>[d.day,d]));
  return <table className="compact-table" aria-label={`${label} historical change`}><thead><tr><th>{label}</th><th>Return before</th><th>If approved</th><th>P/L before</th><th>If approved</th></tr></thead><tbody>
    {h.after.days.map(d=>{const b=before.get(d.day);return <tr key={d.day}><td>{d.day}</td><td title={b?.unavailable?.[0]}>{pct(b?.dailyReturn??null)}</td><td title={d.unavailable?.[0]}>{pct(d.dailyReturn)}</td><td>{m(b?.pnl)}</td><td>{m(d.pnl)}</td></tr>;})}
    <tr><td><b>{h.after.from} → {h.after.to}</b></td><td>{pct(h.before.twr)}</td><td><b>{pct(h.after.twr)}</b></td><td/><td/></tr></tbody></table>;
}
export function Restatements({onChanged}:{onChanged?:()=>void}={}){
  const [state,setState]=useState<RestatementState|null>(null);const [preview,setPreview]=useState<RestatementPreview|null>(null);const [note,setNote]=useState('');const [request,setRequest]=useState(rid());const [busy,setBusy]=useState(false);const [stale,setStale]=useState(false);
  const load=useCallback(async()=>{try{const r=await window.portfolio?.getRestatements();if(r?.restatements!==undefined)setState(r.restatements);}catch{}},[]);
  useEffect(()=>{void load();const t=setInterval(()=>void load(),60000);return()=>clearInterval(t);},[load]);
  if(!window.portfolio||!state)return null;
  if(!state.candidates.length&&!state.records.length&&!state.unsupported.length)return null;
  const show=(p:RestatementPreview|null)=>{setPreview(p);setRequest(rid());};
  const open=async(id:string)=>{setBusy(true);setStale(false);try{const r=await window.portfolio!.previewRestatement(id);if(r.restatements)setState(r.restatements);if(r.ok)show(r.data);else toast(ERR[r.error??'']??'The preview could not be made.','error');}finally{setBusy(false);}};
  const approve=async()=>{if(!preview)return;setBusy(true);try{const r=await window.portfolio!.approveRestatement({candidateId:preview.candidate.id,requestId:request,binding:preview.binding,note});if(r.restatements)setState(r.restatements);
      if(r.ok){toast('Restatement approved.');show(null);setNote('');setStale(false);onChanged?.();return;}
      // Stale: the refreshed preview replaces the old one; nothing was applied, and approving needs another click.
      if(r.error==='PREVIEW_MISMATCH'&&r.preview){show(r.preview);setStale(true);}else if(r.error==='HISTORICAL_TIMING_UNPROVEN'||r.error==='HISTORICAL_ALREADY_APPROVED')show(null);
      toast(ERR[r.error??'']??'The approval could not be completed.','error');}finally{setBusy(false);}};
  const c=preview?.candidate;
  return <Card title="Historical restatements" hint="Fix a past day that counted a payment twice. Nothing changes until you approve." label="Historical restatements">
    {state.candidates.map(x=><Row block key={x.id} title={`${usd(x.usd)} payment on ${x.paymentDay}`} hint={`Restates ${x.days[0]}${x.days.length>1?` to ${x.days.at(-1)}`:''}, resolved ${x.resolutionDay} · ${SOURCE[x.source]??x.source}`}><button disabled={busy} aria-label={`Preview restatement ${x.id.slice(0,10)}`} onClick={()=>void open(x.id)}>Preview</button></Row>)}
    {preview&&c&&<div className="restatement-preview" aria-label="Restatement preview">
      {stale&&<div role="status" className="notice warning">The figures changed since your last preview. This is the refreshed preview: review it and approve again.</div>}
      <b>Historical change you approve · {c.paymentDay} to {c.resolutionDay}</b>
      <SpanTable label="U.S. (USD)" h={preview.historical.USD}/>
      <SpanTable label="All markets (KRW)" h={preview.historical.COMBINED} krw/>
      <small className="muted">Korea is unchanged. Recorded values are not edited; the restatement is a versioned overlay with your approval.</small>
      <div className="restatement-live" aria-label="Live figures"><b>Live figures, not part of the approval</b><small className="muted"> {preview.live.note}</small>
        <table className="compact-table"><thead><tr><th>Period</th><th>Return now</th><th>If approved</th></tr></thead><tbody>{preview.live.series.USD.map(l=><tr key={l.label}><td>U.S. {l.label}</td><td>{pct(l.before.twr)}</td><td>{pct(l.after.twr)}</td></tr>)}</tbody></table></div>
      <label className="restatement-note">Approval note<textarea aria-label="Approval note" maxLength={500} value={note} onChange={e=>setNote(e.target.value)} placeholder="What you checked"/></label>
      <div className="actions"><button className="primary" disabled={busy||!note.trim()} onClick={()=>void approve()}>Approve restatement</button><button disabled={busy} onClick={()=>{show(null);setStale(false);}}>Cancel</button></div>
    </div>}
    {state.unsupported.map(u=><Row block key={u.id} title={`${usd(u.usd)} paid by ${u.route==='KRW'?'Korean cash':'an unknown route'}`} hint={`Cannot be restated yet: ${u.reason}. Its days stay without a return.`}><span className="role-tag inactive">Not supported</span></Row>)}
    {state.records.length>0&&<Note summary={`Approval history · ${state.records.length}`}><ul aria-label="Approval history">{state.records.map(r=><li key={r.id}><span className={`role-tag ${r.status}`}>{r.status==='active'?'In force':'Not in force'}</span> v{r.version} · {usd(r.candidate.usd)} payment on {r.candidate.paymentDay}, resolved {r.candidate.resolutionDay} · approved by {r.approval.by??'unknown'} {new Date(r.approvedAt).toLocaleString()} · “{r.approval.note}”{r.reason&&<small className="muted"> — {r.reason}</small>}</li>)}</ul></Note>}
  </Card>;
}
