import {useCallback,useEffect,useState} from 'react';
import {Note} from './Note';
import {toast} from './Toast';
// U.S. settlements to reconcile (stage 2b.5, electron/settlement-panel.cjs): each open piece with its evidence and what is
// unknown, Check again (one bounded KIS trade-history job, no AI), the audited reconciliation with its preview, every
// reconciliation by id with its signed amount and open settlement timing, and the timing entries to resolve.
type Range={low:number|null;high:number|null;exact?:boolean};
type Check={running:boolean;job:{state:string;stopped:string|null;code:string|null;nextAt:number|null;unread:{start:string;end:string}[]}|null;last:{at:number;done?:boolean;stopped?:string|null;code?:string|null;skipped?:string;nextAt?:number;read?:{start:string;end:string;complete:boolean;reason:string|null}[];unread?:{start:string;end:string}[]}|null};
export type SettlementPiece={pieceId:string;orderId:string;side:'Buy'|'Sell';symbol:string|null;shares:number|null;orderNumber:string|null;filledAt:number|null;usd:number;signedUSD:number;basis:string|null;state:string;why:string|null;since:number|null;overdue:boolean;pretracking:boolean;conflict:boolean;
  evidence:{k:{state:string;groupId?:string;version?:number;settlementDate?:string|null;settlementUSD?:number|null;reason?:string};allocatedUSD:number|null;standby:{id:string;usd:number;promotedUSD:number}[];reconciledUSD:number;historyGap:{start:string;end:string;reason:string}|null};unknown:string[];reconcilable:boolean;check:Check};
type Timing={entryId:string;ifPaidEarlierUSD:number;ifPaidHereUSD:number;low:number;high:number};
export type SettlementRecord={id:string;pieceId:string;orderId:string;side:'Buy'|'Sell';symbol:string|null;usd:number;signedUSD:number;explanation:string;route:string|null;kisReference:string;settledOn:string|null;note:string;confirmedAt:number;confirmedBy:{user:string|null;session:string}|null;flowId:string|null;reversed:{id:string;at:number;note:string}|null;timing:Timing[]};
type Entry={id:string;after:number|null;by:number|null;observedUSD:number;low:number;high:number;candidates:{reconciliationId:string;side:string|null;symbol:string|null;paymentUSD:number|null;ifPaidEarlierUSD:number}[]};
export type SettlementState={account:string;environment:string|null;pieces:SettlementPiece[];reconciliations:SettlementRecord[];timing:Entry[];funding:{orderId:string;symbol:string|null;retainedUSD:number;reason:string;detail:string;reconciliationIds:string[]}[];detectedFlows:{id:string;day:string;amountUSD:number}[];
  summary:{unresolved:{buysUSD:number;sellsUSD:number};overdue:{buysUSD:number;sellsUSD:number};pretracking:number;inFlight:{buysUSD:number;sellsUSD:number};timingOpen:number;timingRange:{low:number;high:number};fundingRetainedUSD:number};home:{title:string;detail:string;tone:string}|null};
type Loss={breached:boolean;ambiguous:boolean;unavailable?:boolean;reasons?:string[];loss:number|null;limit:number|null;baseline:number|null;equity:number|null;adjustment:{low:number|null;high:number|null}|null;ifPaidBeforeBaseline:{low:number|null;high:number|null}|null;scenarios:{name:string;loss:number|null;breached:boolean}[];error?:string};
type Values={loss?:{KR:Loss|null;US:Loss|null};tracker:{buysUSD:number;sellsUSD:number;unresolved:{buysUSD:number;sellsUSD:number}};funding:{USD:number;KRW:number;capacity?:{KR?:number|null;US?:number|null;error?:string}};flows:{amount:number;detected:boolean}[]|null;valuation?:{US:Range|null;combined:Range}};
type Preview={kind:'preview';stateVersion:string;binding:string;before:Values;after:Values;effects?:{timing?:{entryId:string;candidateUSD:number;observedBefore:number;observedAfter:number;closed:boolean;flow:{amount:number}|null}[]};funding?:{releasedCents:number;alignmentCents:number;unreleasedEstimateCents:number;reason:string|null}};
export type SettlementReply={ok:boolean;error?:string;data?:any;preview?:Preview;remainingCents?:number;flowCents?:number;state:SettlementState|null};
const usd=(v:number|null|undefined)=>v==null?'—':`$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const signed=(v:number|null|undefined)=>v==null?'—':`${v<0?'−':v>0?'+':''}${usd(v)}`;
const krw=(v:number|null|undefined)=>v==null?'—':`₩${Math.round(v).toLocaleString('ko-KR')}`;
const when=(ms:number|null|undefined)=>ms?new Date(ms).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const short=(id:string)=>id.slice(0,10);
const ERRORS:Record<string,string>={AMOUNT_EXCEEDS_REMAINING:'The amount is more than what is left of this piece.',ROUTE_REQUIRED:'Say how the buy was paid: USD, KRW or unknown.',KIS_REFERENCE_REQUIRED:'Enter the KIS reference.',NOTE_REQUIRED:'Enter a note.',AMOUNT_REQUIRED:'Enter the amount.',
  ROUNDING_NOT_REMAINDER:'Rounding closes only a whole remainder under $1.',STATE_CHANGED:'Something changed since the preview. Check the updated preview and confirm again.',PREVIEW_MISMATCH:'The figures changed since the preview. Preview again.',
  FLOW_SPLIT_REQUIRED:'The flow differs from the amount: say what the rest of it was.',FLOW_SPLIT_MISMATCH:'The parts do not add up to the flow.',FLOW_SETTLEMENT_MISMATCH:'The settlement part must equal the amount.',PIECE_NOT_OPEN:'This piece is no longer open.',PIECE_UNDER_REVIEW:'Coverage under review cannot be reconciled here.',
  ALREADY_REVERSED:'This reconciliation was already reversed.',REVERSAL_OF_REVERSAL:'A reversal cannot be reversed; reconcile again instead.',REQUEST_ID_REUSED:'This form was already used for another request. Close it and start again.',CHECK_LIVE_ONLY:'Check again reads KIS trade history, which is available for live accounts only.',ORDER_UNKNOWN:'The order is no longer listed, so its dates are unknown.',
  TIMING_CANDIDATE_REQUIRED:'Choose which reconciliation you are resolving.',TIMING_ALREADY_RESOLVED:'That timing was already resolved the other way.',KIS_NOT_CONNECTED:'Connect KIS first.',SETTLED_ON_INVALID:'The settlement date is not a valid date.'};
const message=(r:SettlementReply)=>ERRORS[r.error??'']??(r.error??'Failed').replaceAll('_',' ').toLowerCase();
const rid=()=>crypto.randomUUID();
const call=(name:string,...args:unknown[])=>window.portfolio?window.portfolio.settlementAction(name,...args):Promise.resolve({ok:false,error:'NOT_CONNECTED',state:null} as SettlementReply);

export function SettlementPanel(){
  const [state,setState]=useState<SettlementState|null>(null);const [busy,setBusy]=useState('');const [open,setOpen]=useState<string|null>(null);
  const load=useCallback(async()=>{const r=await call('get');if(r.state!==undefined)setState(r.state);},[]);
  useEffect(()=>{void load();const t=setInterval(()=>void load(),30000);return()=>clearInterval(t);},[load]);
  const run=async(key:string,name:string,...args:unknown[])=>{setBusy(key);try{const r=await call(name,...args);if(r.state)setState(r.state);if(!r.ok)toast(message(r),'error');return r;}finally{setBusy('');}};
  if(!state)return null;
  const s=state.summary,quiet=!state.pieces.length&&!state.reconciliations.length&&!state.timing.length&&!state.funding.length;
  const line=quiet?'Nothing to reconcile.':[s.unresolved.buysUSD>0.005&&`${usd(s.unresolved.buysUSD)} of buys unresolved`,s.unresolved.sellsUSD>0.005&&`${usd(s.unresolved.sellsUSD)} of sales unresolved`,(s.overdue.buysUSD+s.overdue.sellsUSD)>0.005&&`${usd(s.overdue.buysUSD+s.overdue.sellsUSD)} overdue`,s.fundingRetainedUSD>0.005&&`${usd(s.fundingRetainedUSD)} of buy funding still committed`,s.timingOpen>0&&`${s.timingOpen} timing to confirm`].filter(Boolean).join(' · ')||'Fills settling normally.';
  return <section className="trade-card settlement-panel" id="settlements" aria-label="U.S. settlements">
    <div className="section-head"><div><h2>Settlements</h2><small>{line}</small></div></div>
    {state.pieces.length>0&&<ul className="settlement-list" aria-label="Open settlement pieces">{state.pieces.map(p=><li key={p.pieceId}><PieceRow piece={p} busy={busy} open={open===p.pieceId} onOpen={()=>setOpen(open===p.pieceId?null:p.pieceId)}
      onCheck={async()=>{const r=await run('check:'+p.pieceId,'check-again',p.pieceId);if(r.ok)toast(r.data?.busy?'A check of this order is already running.':r.data?.skipped?`Waiting after a failed read; try after ${when(r.data.nextAt)}.`:r.data?.done?'KIS trade history read for this order.':'The check stopped; it resumes where it stopped next time.');}}/>
      {open===p.pieceId&&p.reconcilable&&<ReconcileForm piece={p} flows={state.detectedFlows} onDone={()=>{setOpen(null);void load();}} onState={setState}/>}</li>)}</ul>}
    {state.timing.length>0&&<TimingList entries={state.timing} busy={busy} onResolve={async(entry,reconciliationId,paidHere)=>{const r=await run('timing:'+entry+reconciliationId,'resolve-timing',entry,{reconciliationId,paidHere});if(r.ok)toast(r.data?.flow?`Recorded a detected flow of ${signed(r.data.flow.amount)} to confirm or remove in Performance.`:'Timing recorded.');}}/>}
    {state.funding.length>0&&<div className="settlement-records" aria-label="Funding still committed"><h3>Funding still committed</h3><ul className="settlement-list">{state.funding.map(f=><li key={f.orderId}><div className="settlement-line"><span className="settlement-title"><b>Buy {f.symbol??f.orderId}</b> · {f.reason}</span><strong className="neg">{usd(f.retainedUSD)}</strong></div><small className="muted">{f.detail} Reconciliation{f.reconciliationIds.length===1?'':'s'} {f.reconciliationIds.map(short).join(', ')}.</small></li>)}</ul></div>}
    {state.reconciliations.length>0&&<RecordList records={state.reconciliations} onState={setState} onDone={()=>void load()}/>}
    <Note summary="How settlements are reconciled">A U.S. fill stays in flight until KIS figures show it. One the app cannot match is unresolved: buys lower equity's low bound and buying capacity, sales leave their proceeds out of the high bound. Reconcile a piece only with a KIS reference; the preview shows every effect before anything is written, and a reconciliation can be reversed. KIS settled-trade records are shown as supporting evidence only. Check again reads this order's KIS trade history once, within a page and time limit; it never starts an AI review.</Note>
  </section>;
}

function PieceRow({piece:p,busy,open,onOpen,onCheck}:{piece:SettlementPiece;busy:string;open:boolean;onOpen():void;onCheck():void}){
  const k=p.evidence.k,c=p.check;
  const checkLine=c.running?'Checking KIS trade history…':c.job?.nextAt?`Last check failed${c.job.code?` (${c.job.code})`:''}; next try after ${when(c.job.nextAt)}`:c.job?.unread.length?`Check stopped (${(c.job.stopped??'').toLowerCase()}); ${c.job.unread.length} range${c.job.unread.length===1?'':'s'} left`:c.last?.done?`Checked ${when(c.last.at)}: ${c.last.read?.every(r=>r.complete)?'read completely':'some dates could not be read completely'}`:null;
  return <div className={`settlement-piece state-${p.state.replace(/\s/g,'-')}`}>
    <div className="settlement-line"><span className="settlement-title"><b>{p.side} {p.symbol??p.orderId}</b>{p.shares!=null&&<> · {p.shares} sh</>}{p.orderNumber&&<small> · KIS order {p.orderNumber}</small>}</span>
      <strong className={p.signedUSD<0?'neg':'pos'} title={p.side==='Buy'?'Payment for the buy':'Proceeds of the sale'}>{signed(p.signedUSD)}</strong>
      <span className={`state-pill ${p.overdue?'warn':''}`}>{p.overdue?'overdue':p.state}</span>
      <span className="settlement-actions"><button disabled={busy==='check:'+p.pieceId||c.running} onClick={onCheck}>Check again</button>{p.reconcilable&&<button className={open?'':'primary'} onClick={onOpen}>{open?'Close':'Reconcile'}</button>}</span></div>
    <small className="muted">{p.why??'settling'}{p.since?` since ${when(p.since)}`:''}{p.basis?` · ${p.basis} amount`:''}{checkLine?` · ${checkLine}`:''}</small>
    <Note summary="Evidence and what is unknown"><ul className="settlement-facts">
      <li>Filled {when(p.filledAt)}{p.pretracking?' (before tracking started)':''} · piece {short(p.pieceId)}</li>
      <li>KIS settled record: {k.state==='linked'?`${usd(k.settlementUSD??null)}${k.settlementDate?`, settles ${k.settlementDate}`:''} (version ${k.version}; supporting only)`:k.state==='uncertain'?`possible match, not certain: ${k.reason}`:'none found'}</li>
      {p.evidence.allocatedUSD!=null&&<li>Evidence allocated: {usd(p.evidence.allocatedUSD)}{p.evidence.reconciledUSD>0?` · reconciled: ${usd(p.evidence.reconciledUSD)}`:''}</li>}
      {p.evidence.standby.map(x=><li key={x.id}>Standby evidence {usd(x.usd)}{x.promotedUSD?` (${usd(x.promotedUSD)} promoted)`:''}</li>)}
      {p.evidence.historyGap&&<li>Trade history {p.evidence.historyGap.start} to {p.evidence.historyGap.end} is incomplete.</li>}
      {p.unknown.map(u=><li key={u}>{u}</li>)}</ul></Note>
  </div>;
}

function PreviewTable({preview}:{preview:Preview}){
  const b=preview.before,a=preview.after;const rows:[string,string,string][]=[
    ['U.S. buys in flight',usd(b.tracker.buysUSD),usd(a.tracker.buysUSD)],['U.S. sales in flight',usd(b.tracker.sellsUSD),usd(a.tracker.sellsUSD)],
    ['Unresolved buys',usd(b.tracker.unresolved.buysUSD),usd(a.tracker.unresolved.buysUSD)],['Unresolved sales',usd(b.tracker.unresolved.sellsUSD),usd(a.tracker.unresolved.sellsUSD)],
    ...(b.valuation&&a.valuation?[['U.S. equity',`${usd(b.valuation.US?.low)} – ${usd(b.valuation.US?.high)}`,`${usd(a.valuation.US?.low)} – ${usd(a.valuation.US?.high)}`],['Combined equity',`${krw(b.valuation.combined.low)} – ${krw(b.valuation.combined.high)}`,`${krw(a.valuation.combined.low)} – ${krw(a.valuation.combined.high)}`]] as [string,string,string][]:[]),
    ['Funding committed (USD)',usd(b.funding.USD),usd(a.funding.USD)],['Funding committed (KRW)',krw(b.funding.KRW),krw(a.funding.KRW)],
    ...(b.funding.capacity&&a.funding.capacity&&!b.funding.capacity.error?[['U.S. buying capacity',usd(b.funding.capacity.US),usd(a.funding.capacity.US)],['Korean buying capacity',krw(b.funding.capacity.KR),krw(a.funding.capacity.KR)]] as [string,string,string][]:[]),
    ...(b.flows&&a.flows?[['Detected U.S. flows',signed(b.flows.filter(f=>f.detected).reduce((n,f)=>n+f.amount,0)),signed(a.flows.filter(f=>f.detected).reduce((n,f)=>n+f.amount,0))]] as [string,string,string][]:[])];
  const f=preview.funding;
  return <div className="settlement-preview"><table className="compact-table" aria-label="Preview"><thead><tr><th>Effect</th><th>Now</th><th>After</th></tr></thead><tbody>{rows.map(([n,x,y])=><tr key={n} className={x!==y?'changed':''}><td>{n}</td><td>{x}</td><td>{y}</td></tr>)}</tbody></table>
    {f&&<small className="muted">Funding released: {usd(f.releasedCents/100)}{f.alignmentCents?` (with ${usd(f.alignmentCents/100)} rounding alignment)`:''}{f.unreleasedEstimateCents?` · ${usd(f.unreleasedEstimateCents/100)} of the estimate stays committed`:''}{f.reason?` · ${f.reason}`:''}</small>}
    <LossTable before={b.loss} after={a.loss}/>
    {(preview.effects?.timing??[]).map(t=><small key={t.entryId} className="muted">Payment timing: withdrawn from an open entry; the interval reads {signed(t.observedAfter)} instead of {signed(t.observedBefore)}{t.closed?t.flow?`, and the entry closes as a detected flow of ${signed(t.flow.amount)} to confirm or remove`:', and the entry closes':''}.</small>)}
    <small className="muted">Returns: how a reconciliation counts in performance is not finished yet (Stage 3), so this preview does not show it.</small></div>;
}

function ReconcileForm({piece:p,flows,onDone,onState}:{piece:SettlementPiece;flows:SettlementState['detectedFlows'];onDone():void;onState(s:SettlementState):void}){
  const [requestId]=useState(rid);const [amount,setAmount]=useState(p.usd.toFixed(2));const [explanation,setExplanation]=useState<'settled'|'rounding'>('settled');const [route,setRoute]=useState(p.side==='Buy'?'':'USD');
  const [settledOn,setSettledOn]=useState('');const [reference,setReference]=useState(p.orderNumber??'');const [note,setNote]=useState('');const [flowId,setFlowId]=useState('');const [rest,setRest]=useState('unexplained');const [cite,setCite]=useState(false);
  const [preview,setPreview]=useState<Preview|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const cents=Math.round(Number(amount)*100),flow=flows.find(f=>f.id===flowId),settlement=p.side==='Buy'?-cents:cents,flowCents=flow?Math.round(flow.amountUSD*100):0;
  const request=()=>({requestId,pieceId:p.pieceId,cents,explanation,route:p.side==='Buy'&&explanation==='settled'?route||null:null,kisReference:reference,note,settledOn:settledOn||null,
    ...(flow&&explanation==='settled'?{flowId:flow.id,...(flowCents!==settlement?{split:[{kind:'settlement',cents:settlement},{kind:rest,cents:flowCents-settlement}]}:{})}:{}),
    ...(cite&&p.evidence.k.state==='linked'?{citation:{groupId:p.evidence.k.groupId,version:p.evidence.k.version}}:{})});
  // A changed field makes the shown preview stale; it must be previewed again.
  const edit=<T,>(set:(v:T)=>void)=>(v:T)=>{set(v);setPreview(null);setError('');};
  const ask=async(name:'preview'|'confirm')=>{setBusy(true);setError('');try{const r=await call(name,name==='confirm'&&preview?{...request(),stateVersion:preview.stateVersion,binding:preview.binding}:request());if(r.state)onState(r.state);
      if(r.ok){if(name==='preview')setPreview(r.data);else{toast(r.data?.repeat?'Already recorded.':'Reconciliation recorded.');onDone();}return;}
      if(r.preview){setPreview(r.preview);}else if(r.error==='PREVIEW_MISMATCH'){const again=await call('preview',request());if(again.ok)setPreview(again.data);}
      else setPreview(null);setError(message(r)+(r.remainingCents!=null?` Left: ${usd(r.remainingCents/100)}.`:''));}finally{setBusy(false);}};
  const restKind=flowCents-settlement>0?'deposit':'withdrawal';
  return <form className="settlement-form" aria-label={`Reconcile ${p.side} ${p.symbol??p.orderId}`} onSubmit={e=>{e.preventDefault();void ask('preview');}}>
    <div className="form-grid">
      <label>Amount (USD)<input inputMode="decimal" value={amount} onChange={e=>edit(setAmount)(e.target.value)} aria-describedby={'left-'+p.pieceId}/><small id={'left-'+p.pieceId}>Left: {usd(p.usd)}</small></label>
      <label>Explanation<select value={explanation} onChange={e=>edit(setExplanation)(e.target.value as 'settled'|'rounding')}><option value="settled">Settled</option>{p.usd<1&&<option value="rounding">Rounding remainder</option>}</select></label>
      {p.side==='Buy'&&explanation==='settled'&&<label>Paid in<select value={route} onChange={e=>edit(setRoute)(e.target.value)} required><option value="" disabled>Choose…</option><option value="USD">USD</option><option value="KRW">KRW</option><option value="unknown">Unknown (funding stays committed)</option></select></label>}
      <label>Settlement date<input type="date" value={settledOn} onChange={e=>edit(setSettledOn)(e.target.value)}/></label>
      <label>KIS reference<input value={reference} maxLength={120} required placeholder="Order number or trade-history line" onChange={e=>edit(setReference)(e.target.value)}/></label>
      <label className="wide">Note<input value={note} maxLength={500} required placeholder="What you checked" onChange={e=>edit(setNote)(e.target.value)}/></label>
      {explanation==='settled'&&flows.length>0&&<label className="wide">Payment recorded as a detected flow<select value={flowId} onChange={e=>edit(setFlowId)(e.target.value)}><option value="">None</option>{flows.map(f=><option key={f.id} value={f.id}>{f.day} · {signed(f.amountUSD)}</option>)}</select></label>}
      {flow&&flowCents!==settlement&&<label className="wide">Rest of the flow ({signed((flowCents-settlement)/100)})<select value={rest} onChange={e=>edit(setRest)(e.target.value)}><option value="unexplained">Unexplained (stays a detected flow)</option><option value={restKind}>{restKind==='deposit'?'A deposit':'A withdrawal'}</option></select></label>}
      {p.evidence.k.state==='linked'&&<label className="check"><input type="checkbox" checked={cite} onChange={e=>edit(setCite)(e.target.checked)}/>Cite the KIS settled record (version {p.evidence.k.version})</label>}
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    {preview&&<PreviewTable preview={preview}/>}
    <div className="form-actions"><button type="submit" disabled={busy}>{preview?'Preview again':'Preview'}</button><button type="button" className="primary" disabled={busy||!preview} onClick={()=>void ask('confirm')}>Confirm</button></div>
  </form>;
}

function TimingList({entries,busy,onResolve}:{entries:Entry[];busy:string;onResolve(entry:string,reconciliationId:string,paidHere:boolean):void}){
  return <div className="settlement-timing" aria-label="Settlement timing to confirm"><h3>Payment timing to confirm</h3>
    {entries.map(e=><div key={e.id} className="timing-entry"><small className="muted">Unexplained U.S. cash change between {when(e.after)} and {when(e.by)}: {signed(e.observedUSD)} if every payment below was made in that interval; {signed(Math.min(0,e.low))} to {signed(Math.max(0,e.high))} depending on when they were made. Until you confirm, both count in the loss check.</small>
      <ul className="settlement-list">{e.candidates.map(c=><li key={c.reconciliationId} className="settlement-line"><span className="settlement-title"><b title={c.reconciliationId}>Reconciliation {short(c.reconciliationId)}</b>{c.side&&<> · {c.side} {c.symbol??''}</>}</span>
        <strong className={(c.paymentUSD??0)<0?'neg':'pos'} title="The payment it reconciled">{signed(c.paymentUSD)}</strong><small className="muted">if paid earlier: {signed(c.ifPaidEarlierUSD)}</small>
        <span className="settlement-actions"><button disabled={busy!==''} onClick={()=>onResolve(e.id,c.reconciliationId,true)}>Paid in this interval</button><button disabled={busy!==''} onClick={()=>onResolve(e.id,c.reconciliationId,false)}>Paid earlier</button></span></li>)}</ul></div>)}</div>;
}

function RecordList({records,onState,onDone}:{records:SettlementRecord[];onState(s:SettlementState):void;onDone():void}){
  const [open,setOpen]=useState<string|null>(null);
  return <div className="settlement-records" aria-label="Reconciliations"><h3>Reconciliations</h3><ul className="settlement-list">{records.map(r=><li key={r.id}>
    <div className="settlement-line"><span className="settlement-title"><b title={r.id}>{short(r.id)}</b> · {r.side} {r.symbol??r.orderId}</span><strong className={r.signedUSD<0?'neg':'pos'}>{signed(r.signedUSD)}</strong>
      {r.reversed?<span className="state-pill">reversed</span>:r.timing.length?<span className="state-pill warn" title="Whether its payment fell in the interval is not known yet">timing open</span>:null}
      {!r.reversed&&<span className="settlement-actions"><button onClick={()=>setOpen(open===r.id?null:r.id)}>{open===r.id?'Close':'Reverse'}</button></span>}</div>
    <small className="muted">{r.explanation==='rounding'?'Rounding remainder':`Settled${r.route?` · paid in ${r.route==='unknown'?'unknown currency':r.route}`:''}${r.settledOn?` on ${r.settledOn}`:''}`} · KIS {r.kisReference} · {when(r.confirmedAt)}{r.confirmedBy?.user?` by ${r.confirmedBy.user}`:''}{r.flowId?' · flow reclassified':''}{r.reversed?` · reversed ${when(r.reversed.at)} (${short(r.reversed.id)})`:''}</small>
    {r.timing.map(t=><small key={t.entryId} className="muted timing-note">Timing open: the interval reads {signed(t.ifPaidHereUSD)} if paid in it, {signed(t.ifPaidEarlierUSD)} if paid earlier.</small>)}
    <Note summary="Note">{r.note}</Note>
    {open===r.id&&<ReverseForm record={r} onState={onState} onDone={()=>{setOpen(null);onDone();}}/>}</li>)}</ul></div>;
}

function ReverseForm({record,onState,onDone}:{record:SettlementRecord;onState(s:SettlementState):void;onDone():void}){
  const [requestId]=useState(rid);const [note,setNote]=useState('');const [reference,setReference]=useState('');const [preview,setPreview]=useState<Preview|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const request=()=>({requestId,reconciliationId:record.id,note,kisReference:reference||null});
  const ask=async(name:'preview-reversal'|'reverse')=>{setBusy(true);setError('');try{const r=await call(name,name==='reverse'&&preview?{...request(),stateVersion:preview.stateVersion,binding:preview.binding}:request());if(r.state)onState(r.state);
      if(r.ok){if(name==='preview-reversal')setPreview(r.data);else{toast('Reconciliation reversed.');onDone();}return;}
      if(r.preview)setPreview(r.preview);else if(r.error==='PREVIEW_MISMATCH'){const again=await call('preview-reversal',request());if(again.ok)setPreview(again.data);}else setPreview(null);setError(message(r));}finally{setBusy(false);}};
  return <form className="settlement-form" aria-label={`Reverse ${short(record.id)}`} onSubmit={e=>{e.preventDefault();void ask('preview-reversal');}}>
    <div className="form-grid"><label className="wide">Why it is reversed<input value={note} maxLength={500} required onChange={e=>{setNote(e.target.value);setPreview(null);}}/></label><label>KIS reference (optional)<input value={reference} maxLength={120} onChange={e=>{setReference(e.target.value);setPreview(null);}}/></label></div>
    {error&&<p role="alert" className="error">{error}</p>}{preview&&<PreviewTable preview={preview}/>}
    <div className="form-actions"><button type="submit" disabled={busy}>{preview?'Preview again':'Preview'}</button><button type="button" className="primary" disabled={busy||!preview} onClick={()=>void ask('reverse')}>Confirm reversal</button></div></form>;
}

// Each market's daily-loss check before and after: the verdict, the baseline adjustment for settlement corrections, and
// every scenario behind More.
function LossTable({before,after}:{before?:{KR:Loss|null;US:Loss|null};after?:{KR:Loss|null;US:Loss|null}}){
  if(!before||!after)return <small className="muted">Daily loss: not available (no day's baseline yet).</small>;
  const fmt=(m:'KR'|'US',v:number|null|undefined)=>m==='US'?usd(v):krw(v);
  const verdict=(m:'KR'|'US',l:Loss|null)=>!l?'no baseline today':l.error?'unavailable':l.unavailable?'cannot be checked now; new buys are restricted':`${fmt(m,l.loss)} loss${l.limit!=null?` of ${fmt(m,l.limit)} allowed`:''} · ${l.breached?'limit reached':l.ambiguous?'limit reached in some scenarios':'within the limit'}`;
  const sgn=(m:'KR'|'US',v:number|null)=>v==null?'—':m==='US'?signed(v):`${v<0?'−':v>0?'+':''}${krw(Math.abs(v))}`;
  const adj=(m:'KR'|'US',l:Loss|null)=>l?.adjustment?`low ${sgn(m,l.adjustment.low)}, high ${sgn(m,l.adjustment.high)}${l.ifPaidBeforeBaseline?` (or low ${fmt(m,l.ifPaidBeforeBaseline.low)}, high ${fmt(m,l.ifPaidBeforeBaseline.high)} if paid before the baseline)`:''}`:'none';
  const names=(m:'KR'|'US')=>[...new Set([...(before[m]?.scenarios??[]),...(after[m]?.scenarios??[])].map(x=>x.name))];
  return <><table className="compact-table" aria-label="Daily loss"><thead><tr><th>Daily loss</th><th>Now</th><th>After</th></tr></thead><tbody>
    {(['KR','US'] as const).flatMap(m=>[<tr key={m} className={verdict(m,before[m])!==verdict(m,after[m])?'changed':''}><td>{m==='US'?'U.S.':'Korea'}</td><td>{verdict(m,before[m])}</td><td>{verdict(m,after[m])}</td></tr>,
      <tr key={m+'-adj'} className={adj(m,before[m])!==adj(m,after[m])?'changed':''}><td>{m==='US'?'U.S.':'Korea'} baseline adjustment</td><td>{adj(m,before[m])}</td><td>{adj(m,after[m])}</td></tr>])}</tbody></table>
    <Note summary="Daily-loss scenarios">{(['KR','US'] as const).map(m=>names(m).length?<table key={m} className="compact-table" aria-label={`${m} loss scenarios`}><thead><tr><th>{m==='US'?'U.S.':'Korea'} scenario</th><th>Now</th><th>After</th></tr></thead><tbody>{names(m).map(n=>{const x=before[m]?.scenarios.find(y=>y.name===n),y=after[m]?.scenarios.find(z=>z.name===n);
      return <tr key={n}><td>{n}</td><td>{x?`${fmt(m,x.loss)}${x.breached?' · reached':''}`:'—'}</td><td>{y?`${fmt(m,y.loss)}${y.breached?' · reached':''}`:'—'}</td></tr>;})}</tbody></table>:<p key={m} className="muted">{m==='US'?'U.S.':'Korea'}: one scenario only.</p>)}</Note></>;
}
