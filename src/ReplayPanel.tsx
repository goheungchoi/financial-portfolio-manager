import {useEffect,useState} from 'react';
import {Note} from './Note';
// Replay saved reviews with a change, next to an unchanged baseline, and compare both with what prices did afterwards.
type Decision={action:string;symbol:string|null;quantity:number}|null;
type Side={decision:Decision;explanation:string|null;outcome:{excessPct:number|null;basis:string}};
type Run={id:string;timestamp:number;variant:{instructions:string;withoutNarrative:boolean;withoutEpisodes:boolean;withoutRegime:boolean;model?:{openaiModel:string;reasoningEffort:string}};rows:{reviewId:string;day:string;approximate:boolean;original:Decision;baseline:Side;variant:Side;changed:boolean}[];summary:{reviews:number;changed:number;scored:number;baselineExcessPct:number;variantExcessPct:number;note:string}};
const ERRORS:Record<string,string>={INVALID_MODEL_SETTINGS:'That model and effort combination is not allowed.',REPLAY_NO_CHANGE:'Add instructions, remove a section or pick another model to compare.',REPLAY_NOTHING:'No saved reviews in that period.',REPLAY_UNAVAILABLE:'Replay needs the OpenAI decision maker and a key.',AI_BUDGET_EXHAUSTED:'Daily AI budget reached.',REPLAY_BUSY:'A replay is already running.'};
// Model choices for the change; the baseline always uses the review model from Engine settings.
const MODELS:[string,string][]=[['','Same model as reviews'],['gpt-6-luna/none','GPT-6 Luna · no reasoning'],['gpt-6-luna/low','GPT-6 Luna · low'],['gpt-6-sol/low','GPT-6 Sol · low'],['gpt-6-sol/medium','GPT-6 Sol · medium']];
const fmt=(d:Decision)=>!d||d.action==='Hold'?'Hold':`${d.action} ${d.quantity} ${d.symbol}`;
const ex=(v:number|null)=>v==null?'waiting':`${v>0?'+':''}${v.toFixed(2)}%`;
const daysAgo=(n:number)=>new Date(Date.now()+9*3600000-n*86400000).toISOString().slice(0,10);
export function ReplayPanel(){
  const [runs,setRuns]=useState<Run[]>([]);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
  const [form,setForm]=useState({from:daysAgo(7),to:daysAgo(0),limit:4,instructions:'',withoutNarrative:false,withoutEpisodes:false,withoutRegime:false,model:''});
  useEffect(()=>{void window.portfolio?.listReplays().then(r=>{setRuns(r.runs as Run[]);setBusy(r.busy);}).catch(()=>{});},[]);
  if(!window.portfolio)return null;
  const run=async()=>{setBusy(true);setNote('');try{const [openaiModel,reasoningEffort]=form.model.split('/');const r=await window.portfolio!.runReplay({...form,model:form.model?{openaiModel,reasoningEffort}:undefined});if(r.ok)setRuns(v=>[r.run as Run,...v]);else setNote(ERRORS[r.error??'']??'The replay did not finish. See Console.');}catch{setNote('Could not reach the engine.');}finally{setBusy(false);}};
  const latest=runs[0];
  return <section className="replay-panel" aria-label="Replay">
    <div className="section-head"><div><h2>Replay</h2><small className="muted">Test a change on past reviews before using it. Uses two AI calls per review; no orders.</small></div></div>
    <div className="settings-grid"><label>From<input aria-label="Replay from" type="date" value={form.from} onChange={e=>setForm({...form,from:e.target.value})}/></label><label>To<input aria-label="Replay to" type="date" value={form.to} onChange={e=>setForm({...form,to:e.target.value})}/></label><label>Reviews<input aria-label="Replay reviews" type="number" min={1} max={12} value={form.limit} onChange={e=>setForm({...form,limit:Number(e.target.value)})}/></label></div>
    <label className="guidelines-editor">Change to test<textarea aria-label="Replay instructions" rows={3} maxLength={1500} placeholder="For example: Do not add to semiconductor stocks while the regime is risk-off." value={form.instructions} onChange={e=>setForm({...form,instructions:e.target.value})}/></label>
    <label>Run the change on<select aria-label="Replay model" value={form.model} onChange={e=>setForm({...form,model:e.target.value})}>{MODELS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <div className="replay-options">{([['withoutNarrative','Without the market narrative'],['withoutEpisodes','Without similar episodes'],['withoutRegime','Without the regime gauge and sizing']] as const).map(([k,l])=><label key={k} className="inline-check"><input type="checkbox" checked={form[k]} onChange={e=>setForm({...form,[k]:e.target.checked})}/>{l}</label>)}</div>
    <div className="actions"><button className="primary" disabled={busy} onClick={()=>void run()}>{busy?'Replaying…':'Run replay'}</button></div>
    {note&&<p className="warning-text">{note}</p>}
    {latest&&<><p className="research-line">Last run {new Date(latest.timestamp).toLocaleString()}: <b>{latest.summary.changed}</b> of {latest.summary.reviews} decisions changed{latest.variant.model?` (on ${latest.variant.model.openaiModel}, ${latest.variant.model.reasoningEffort} effort)`:''} · excess return baseline {ex(latest.summary.baselineExcessPct)} vs change {ex(latest.summary.variantExcessPct)} over {latest.summary.scored} scored</p>
      <table className="compact-table research-table" aria-label="Replay results"><thead><tr><th>Day</th><th>Original</th><th>Baseline</th><th>With change</th><th>Baseline result</th><th>Change result</th></tr></thead><tbody>{latest.rows.map(r=><tr key={r.reviewId} className={r.changed?'research-self':''}><td>{r.day}{r.approximate?' *':''}</td><td>{fmt(r.original)}</td><td title={r.baseline.explanation??undefined}>{fmt(r.baseline.decision)}</td><td title={r.variant.explanation??undefined}>{fmt(r.variant.decision)}</td><td>{ex(r.baseline.outcome.excessPct)}</td><td>{ex(r.variant.outcome.excessPct)}</td></tr>)}</tbody></table>
      <Note summary="How to read this">Both columns re-run the same saved review without tools; only your change differs, so differences come from it. Results are excess returns against KOSPI or the S&amp;P 500 over five trading days (a Buy gains with the stock, a Sell with its fall, a Hold scores zero). * marks reviews from before full contexts were saved, rebuilt from the console log. {latest.summary.note}</Note></>}
  </section>;
}
