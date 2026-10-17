import {useEffect,useState} from 'react';
type Stats={count:number;hitRate:number|null;meanExcess:number|null;medianExcess:number|null};
type Horizon={days:number;status:string;endDay?:string;stockReturn?:number;benchmarkReturn?:number|null;signedReturn?:number;excess?:number|null};
type Decision={id:string;timestamp:number;day:string;symbol:string;action:'Buy'|'Sell';quantity:number;provider:string;model:string|null;executed:boolean;benchmark:string;decisionPrice:number|null;baseClose:number|null;horizons:Horizon[]};
type LessonImpact={id:string;symbol:string|null;status:string;approvedAt:number|null;note:string;applicability:string;horizon:number;withLesson:Stats;without:Stats;difference:number|null;verdict:string;trials:{completed:number;meanRuleMinusHold:number|null}};
type Conflict={a:string;b:string;symbol:string;stances:string[];reason:string};
type Realized={id:string;symbol:string;soldAt:number;holdingDays:number|null;netReturn:number;benchmark:string;benchmarkReturn:number|null;excess:number|null};
export type ScoreboardState={horizons:number[];primary:number;minSample:number;counts:{reviews:number;holds:number;paper:number;scoredDecisions:number};summary:Record<string,Stats>;byConfidence?:Record<'low'|'medium'|'high',Record<string,Stats>>;byAction:Record<'Buy'|'Sell',Record<string,Stats>>;withLessons:Record<string,Stats>;withoutLessons:Record<string,Stats>;groups:{key:string;summary:Record<string,Stats>}[];decisions:Decision[];lessons:LessonImpact[];conflicts:Conflict[];realized:Realized[];pricesUpdatedAt:number|null;pricesError:string|null;refreshing:boolean;benchmarkUpdatedAt:number|null};
export type ScoreboardReply={ok:boolean;error?:string;state?:ScoreboardState};
const BENCH:Record<string,string>={KOSPI:'KOSPI',SPX:'S&P 500'};
const pct=(value:number|null|undefined,digits=2)=>value==null?'—':`${value>0?'+':''}${(value*100).toFixed(digits)}%`;
const rate=(value:number|null)=>value==null?'—':`${Math.round(value*100)}%`;
const tone=(value:number|null|undefined)=>value==null||Math.abs(value)<0.00005?'':value>0?'positive':'negative';
// Per-decision excess return at the primary horizon: diverging bars around zero, newest on the right.
function ExcessBars({decisions,days}:{decisions:Decision[];days:number}){
  const [hover,setHover]=useState<number|null>(null);
  const rows=decisions.map(d=>({d,h:d.horizons.find(h=>h.days===days)})).filter((r):r is {d:Decision;h:Horizon&{excess:number}}=>r.h?.status==='scored'&&r.h.excess!=null).reverse().slice(-40);
  if(rows.length<2)return null;
  const W=640,H=180,L=48,R=12,T=10,B=22;const max=Math.max(0.01,...rows.map(r=>Math.abs(r.h.excess)))*1.1;
  const step=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1].find(s=>max/s<=2.5)??1;const ticks:number[]=[];for(let t=-Math.floor(max/step)*step;t<=max+1e-9;t+=step)ticks.push(Math.round(t/step)*step);
  const y=(v:number)=>T+(max-v)*(H-T-B)/(2*max),band=(W-L-R)/rows.length,bar=Math.max(2,Math.min(18,band-2));const x=(i:number)=>L+i*band+(band-bar)/2;
  const r=hover==null?null:rows[hover];
  return <div className="perf-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Excess return ${days} trading days after each of the last ${rows.length} scored decisions`} onPointerLeave={()=>setHover(null)}>
    {ticks.map(t=><g key={t}><line className="perf-grid" x1={L} x2={W-R} y1={y(t)} y2={y(t)}/><text className="perf-axis" x={L-6} y={y(t)} textAnchor="end" dominantBaseline="middle">{pct(t,1)}</text></g>)}
    {rows.map((row,i)=>{const v=row.h.excess,top=v>=0?y(v):y(0),height=Math.max(1,Math.abs(y(v)-y(0)));const radius=Math.min(4,bar/2,height);
      // Rounded data end, square at the zero baseline.
      const d=v>=0?`M${x(i)},${top+height}V${top+radius}Q${x(i)},${top} ${x(i)+radius},${top}H${x(i)+bar-radius}Q${x(i)+bar},${top} ${x(i)+bar},${top+radius}V${top+height}Z`:`M${x(i)},${top}V${top+height-radius}Q${x(i)},${top+height} ${x(i)+radius},${top+height}H${x(i)+bar-radius}Q${x(i)+bar},${top+height} ${x(i)+bar},${top+height-radius}V${top}Z`;
      return <g key={row.d.id} onPointerEnter={()=>setHover(i)}><rect x={L+i*band} y={T} width={band} height={H-T-B} fill="transparent"/><path className={'score-bar '+(v>=0?'up':'down')+(hover===i?' active':'')} d={d}/></g>;})}
    <line className="perf-zero" x1={L} x2={W-R} y1={y(0)} y2={y(0)}/>
    <text className="perf-axis" x={L} y={H-6}>{rows[0].d.day}</text><text className="perf-axis" x={W-R} y={H-6} textAnchor="end">{rows.at(-1)!.d.day}</text>
  </svg>{r&&<div className="perf-tooltip" role="status" style={{left:`${Math.min(75,Math.max(10,(x(hover!)+bar/2)/W*100))}%`}}><b>{r.d.action} {r.d.symbol} · {r.d.day}</b><span>Stock {pct(r.h.stockReturn)} · {BENCH[r.d.benchmark]} {pct(r.h.benchmarkReturn)}</span><span>{r.h.excess>=0?'Ahead of':'Behind'} the benchmark by {pct(Math.abs(r.h.excess))}</span></div>}
    <div className="perf-legend"><span><i className="swatch score-up"/>Decision beat the benchmark</span><span><i className="swatch score-down"/>Decision trailed the benchmark</span></div></div>;
}
function StatsRow({label,stats}:{label:string;stats:Record<string,Stats>}){
  return <tr><td>{label}</td>{Object.values(stats).map((s,i)=><td key={i}>{s.count?<><span className={tone(s.meanExcess)}>{pct(s.meanExcess)}</span> <small className="muted">· {rate(s.hitRate)} of {s.count}</small></>:<small className="muted">No data</small>}</td>)}</tr>;
}
export function Scoreboard(){
  const [state,setState]=useState<ScoreboardState|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [table,setTable]=useState(false);
  const refreshing=Boolean(state?.refreshing);
  // Poll quickly while prices are being fetched so the result appears as soon as it lands.
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getScoreboard();if(alive&&reply?.state)setState(reply.state);}catch{}};void load();const timer=setInterval(load,refreshing?2000:30000);return()=>{alive=false;clearInterval(timer);};},[refreshing]);
  if(!window.portfolio)return null;
  const refresh=async()=>{setBusy(true);setError('');try{const reply=await window.portfolio!.refreshScoreboard();if(reply.state)setState(reply.state);if(!reply.ok)setError(reply.error==='KIS_NOT_CONNECTED'?'Connect KIS first.':'Price history could not be refreshed.');}catch{setError('Could not reach the engine.');}finally{setBusy(false);}};
  if(!state)return <section aria-label="Learning scoreboard"><h2>Learning scoreboard</h2><p className="muted">Loading…</p></section>;
  const main=state.summary[state.primary];const waiting=state.decisions.filter(d=>d.horizons.some(h=>h.status==='waiting')).length;
  return <section aria-label="Learning scoreboard">
    <div className="section-head"><div><h2>Learning scoreboard</h2><small>{state.counts.scoredDecisions} broker Buy/Sell recommendations · {state.counts.holds} holds not scored</small></div><button disabled={busy||state.refreshing} onClick={()=>void refresh()}>{busy||state.refreshing?'Refreshing…':'Refresh prices'}</button></div>
    <div className="metrics perf-metrics">
      <div><small>Beat the benchmark · {state.primary} trading days</small><strong>{rate(main?.hitRate??null)}</strong><span>{main?.count?`${main.count} scored decisions`:'No scored decisions yet'}</span></div>
      <div><small>Average excess return · {state.primary} days</small><strong className={tone(main?.meanExcess)}>{pct(main?.meanExcess)}</strong><span>Median {pct(main?.medianExcess)}</span></div>
      <div><small>Lesson conflicts</small><strong>{state.conflicts.length}</strong><span>{state.conflicts.length?'Approved lessons disagree':'None among approved lessons'}</span></div>
    </div>
    {main&&main.count>0&&main.count<state.minSample&&<p className="notice">Fewer than {state.minSample} scored decisions. Treat these numbers as anecdotes, not evidence.</p>}
    <ExcessBars decisions={state.decisions} days={state.primary}/>
    <table aria-label="Decision scores by horizon"><thead><tr><th>Recommendations</th>{state.horizons.map(h=><th key={h}>{h} day{h>1?'s':''}</th>)}</tr></thead><tbody>
      <StatsRow label="All" stats={state.summary}/><StatsRow label="Buy" stats={state.byAction.Buy}/><StatsRow label="Sell" stats={state.byAction.Sell}/>{state.byConfidence&&(["high","medium","low"] as const).filter(c=>state.byConfidence![c]&&Object.values(state.byConfidence![c]).some((x:any)=>x.count)).map(c=><StatsRow key={c} label={`${c[0].toUpperCase()+c.slice(1)} confidence`} stats={state.byConfidence![c]}/>)}
      <StatsRow label="With approved lessons" stats={state.withLessons}/><StatsRow label="Without lessons" stats={state.withoutLessons}/>
      {state.groups.length>1&&state.groups.map(g=><StatsRow key={g.key} label={g.key==='local'?'Local rules':g.key==='external'?'External agent':g.key} stats={g.summary}/>)}
    </tbody></table>
    <p className="muted small-print">Each cell: average excess return versus {BENCH.KOSPI} (Korean stocks) or {BENCH.SPX} (U.S. stocks) · share of decisions that beat it · count. A Buy scores when the stock beats the benchmark afterwards; a Sell scores when it trails. Measured close to close from the decision day, whether or not an order was placed. {waiting>0?`${waiting} decisions are still waiting for later closes. `:''}Prices {state.pricesUpdatedAt?`updated ${new Date(state.pricesUpdatedAt).toLocaleString()}`:'not fetched yet'}{state.pricesError?' · last refresh failed':''}.</p>
    <h3>Approved lessons</h3>
    {state.lessons.length?<table aria-label="Lesson impact"><thead><tr><th>Lesson</th><th>With lesson</th><th>Without</th><th>Difference</th><th>Result</th><th>Rule trials</th></tr></thead><tbody>{state.lessons.map(l=><tr key={l.id}><td>{l.symbol??'Paper'}<br/><small className="muted">{(l.note||l.applicability).slice(0,80)}</small></td><td>{pct(l.withLesson.meanExcess)} <small className="muted">· {l.withLesson.count}</small></td><td>{pct(l.without.meanExcess)} <small className="muted">· {l.without.count}</small></td><td className={tone(l.difference)}>{l.difference==null?'—':`${(l.difference*100).toFixed(2)} pts`}</td><td>{l.verdict}</td><td>{l.trials.completed?`${l.trials.completed} done · rule ${l.trials.meanRuleMinusHold!>=0?'+':''}${l.trials.meanRuleMinusHold!.toFixed(2)} vs hold`:'—'}</td></tr>)}</tbody></table>:<p className="muted">Approve a lesson to compare decisions made with and without it.</p>}
    <p className="muted small-print">Compares {state.primary}-day excess returns of recommendations on the lesson's symbol when the lesson was supplied to the AI versus when it was not. Results need at least {state.minSample} decisions on each side and are not a significance test; markets change, so a difference does not prove the lesson caused it.</p>
    {state.conflicts.length>0&&<><h3>Possible conflicts</h3><ul className="conflict-list">{state.conflicts.map(c=>{const a=state.lessons.find(l=>l.id===c.a),b=state.lessons.find(l=>l.id===c.b);return <li key={c.a+c.b} role="alert"><b>{c.symbol}</b> · {c.reason}<br/><small>“{(a?.note||a?.applicability||'').slice(0,100)}” vs “{(b?.note||b?.applicability||'').slice(0,100)}”</small></li>;})}</ul><p className="muted small-print">These lessons point in opposite directions. Retire or edit one.</p></>}
    {state.realized.length>0&&<><h3>Completed trades vs benchmark</h3><table aria-label="Realized trades versus benchmark"><thead><tr><th>Sold</th><th>Symbol</th><th>Held</th><th>Net return</th><th>Benchmark</th><th>Excess</th></tr></thead><tbody>{state.realized.map(r=><tr key={r.id}><td>{new Date(r.soldAt).toLocaleDateString()}</td><td>{r.symbol}</td><td>{r.holdingDays==null?'—':`${r.holdingDays} d`}</td><td className={tone(r.netReturn)}>{pct(r.netReturn)}</td><td>{BENCH[r.benchmark]} {pct(r.benchmarkReturn)}</td><td className={tone(r.excess)}>{pct(r.excess)}</td></tr>)}</tbody></table><p className="muted small-print">Net return after recorded fees. The entry is the latest earlier buy of the same symbol in this app, not tax-lot matching.</p></>}
    {state.decisions.length>0&&<><button className="link-button" onClick={()=>setTable(!table)}>{table?'Hide decision table':'Show decision table'}</button>{table&&<table aria-label="Scored decisions"><thead><tr><th>Day</th><th>Decision</th><th>Base close</th>{state.horizons.map(h=><th key={h}>{h}d excess</th>)}</tr></thead><tbody>{state.decisions.map(d=><tr key={d.id}><td>{d.day}</td><td>{d.action} {d.symbol}{d.executed?' · ordered':''}</td><td>{d.baseClose??'—'}</td>{d.horizons.map(h=><td key={h.days} className={tone(h.excess)}>{h.status==='scored'?pct(h.excess):h.status==='waiting'?'Waiting':h.status==='no-benchmark'?'No benchmark':'No price'}</td>)}</tr>)}</tbody></table>}</>}
    {error&&<div role="status" className="notice error">{error}</div>}
  </section>;
}
