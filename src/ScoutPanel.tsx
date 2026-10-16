import {useEffect,useState} from 'react';
import type {ScoutState} from './RuntimeSettings';
import {Note} from './Note';
import './scout.css';
const ROLE:Record<string,string>={hold:'Hold',add:'Add',candidate:'Candidate',trim:'Trim',exit:'Exit'};
const ago=(t:number)=>{const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:new Date(t).toLocaleDateString();};
const pct=(v:number|null|undefined)=>v==null?'—':`${v>0?'+':''}${(v*100).toFixed(1)}%`;
const ACTED:Record<string,string>={bought:'Bought',proposed:'Proposed',recommended:'Recommended','not yet':'—'};
// One line on how the scout's picks did; small samples say so instead of implying a trend.
function scoreLine(card:NonNullable<ScoutState['scorecard']>){
  const month=card.summary['20'],week=card.summary['5'];const total=card.picks.length;
  if(month?.scored)return `Past picks: ${month.beatBenchmark} of ${month.scored} beat the market over 20 trading days${month.scored<card.minSample?' (too few to judge)':''}`;
  if(week?.scored)return `Past picks: ${week.beatBenchmark} of ${week.scored} beat the market over 5 trading days${week.scored<card.minSample?' (too few to judge)':''}`;
  return `Past picks: ${total} tracked, first results after 5 trading days`;
}
const ERRORS:Record<string,string>={AI_BUDGET_EXHAUSTED:'Daily AI budget reached',SCOUT_BUSY:'A scout run is already going',RATE_LIMITED:'KIS is rate limiting; try again shortly',AI_TIMEOUT:'OpenAI took too long',STALE_DECISION:'The account changed during the run'};
// The AI scout's latest plan, shown on Discover with a button to run it now.
export function ScoutPanel({onOpenChart,onNavigate}:{onOpenChart(symbol:string):void;onNavigate(tab:string):void}){
  const [scout,setScout]=useState<ScoutState|null>(null);const [running,setRunning]=useState(false);const [note,setNote]=useState('');
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getRuntime().then(v=>{if(alive)setScout(v.scout??null);}).catch(()=>{});void load();const t=setInterval(load,4000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!window.portfolio||!scout)return null;
  const busy=running||scout.busy;const latest=scout.latest;const plan=latest?.plan;
  const run=async()=>{setRunning(true);setNote('');try{const reply=await window.portfolio!.runScout();if(reply.state?.scout)setScout(reply.state.scout);if(!reply.ok){const detail=reply.state?.scout?.lastErrorDetail;setNote(ERRORS[reply.error??'']??(detail?`The scout run stopped: ${detail}.`:scout.blocked??'The scout run did not finish. See Console.'));}}catch{setNote('Could not reach the engine.');}finally{setRunning(false);}};
  const status=busy?'Researching the market…':scout.blocked?scout.blocked:latest?`Updated ${ago(latest.timestamp)}${latest.model?' · '+latest.model:''}`:'No plan yet';
  return <section className="scout-panel" aria-label="AI scout" aria-busy={busy}>
    <div className="section-head"><div><h2>AI scout</h2><small className={busy?'loading-label':''}>{busy&&<span className="spinner" aria-hidden="true"/>}{status}{scout.enabled&&!scout.blocked?` · runs ${scout.times.join(', ')} on weekdays`:''}</small></div>
      <div className="actions">{latest?.runId&&<button className="link-button" onClick={()=>onNavigate('AI console')}>Research log</button>}<button className="primary" disabled={busy||Boolean(scout.blocked)} title={scout.blocked??'Research the market now and update the shortlist and plan'} onClick={()=>void run()}>{busy?'Researching…':'Run scout'}</button></div></div>
    {note&&<p className="warning-text" role="status">{note}</p>}
    {!plan?<p className="muted">The scout studies rankings, analyst views and estimates, picks a shortlist for your watchlist and writes a plan the trading reviews follow.{scout.enabled?'':' Turn on scheduled runs in Engine settings.'}</p>:<>
      <p className="scout-summary">{plan.summary}</p>
      <div className="scout-facts">{plan.cashTargetPct!=null&&<span>Cash target <b>{plan.cashTargetPct}%</b></span>}{plan.focus&&<span title={plan.focus}>Watch <b>{plan.focus}</b></span>}</div>
      {plan.targets.length>0&&<table className="compact-table scout-targets" aria-label="Scout plan"><thead><tr><th>Stock</th><th>Role</th><th>Target</th><th>Why</th></tr></thead><tbody>{plan.targets.map(t=><tr key={t.symbol}><td><button className="link-button" onClick={()=>onOpenChart(t.symbol)}>{t.name||t.symbol}</button><small> {t.symbol}</small></td><td><span className={`role-tag role-${t.role}`}>{ROLE[t.role]??t.role}</span></td><td>{t.targetWeightPct==null?'—':`${t.targetWeightPct}%`}</td><td title={t.risks?`Risks: ${t.risks}`:undefined}>{t.thesis}</td></tr>)}</tbody></table>}
      {(latest?.answered?.length||scout.briefs?.length)?<div className="scout-briefs" aria-label="Briefs from trading reviews"><h3>From trading reviews</h3><ul>
        {latest?.answered?.map(a=><li key={a.briefId}><span className="brief-asked">{a.asked}</span><span className="brief-answer">{a.answer}</span></li>)}
        {scout.briefs?.map(b=><li key={b.id}><span className="brief-asked">{b.asked}</span><span className="muted">{b.request==='run'?'Run requested · ':''}Next run answers this</span></li>)}
      </ul></div>:null}
      {plan.retrospective&&<p className="scout-retro"><b>Self-review</b> {plan.retrospective}</p>}
    </>}
    {scout.scorecard&&scout.scorecard.picks.length>0&&<Note summary={scoreLine(scout.scorecard)}>
      <table className="compact-table scout-score" aria-label="Scout pick results"><thead><tr><th>Pick</th><th>Picked</th><th>5 days</th><th>20 days</th><th>Trading</th></tr></thead><tbody>{scout.scorecard.picks.map(p=><tr key={p.symbol+p.pickedAt}><td>{p.name||p.symbol}{p.endedAt?<small> dropped</small>:null}</td><td>{new Date(p.pickedAt).toLocaleDateString()}</td><td>{pct(p.horizons['5']?.excess)}</td><td>{pct(p.horizons['20']?.excess)}</td><td title={p.feedback?.reason}>{p.feedback?`${p.feedback.verdict[0].toUpperCase()+p.feedback.verdict.slice(1)}`:ACTED[p.acted]??p.acted}</td></tr>)}</tbody></table>
      <p className="muted">{'Return minus KOSPI or the S&P 500, from the close on the pick day. The scout reads this before each run.'}</p>
    </Note>}
  </section>;
}
