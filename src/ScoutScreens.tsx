import {useState} from 'react';
// The Screens section of the Scout panel (note 5, S3): the scripts the latest scout run ran, what each printed and its
// coverage (loaded only when the section is opened), and the state of the screening history: per market the as-of day
// with how many stocks have it, full depth, stocks that stopped deepening, and why the refresh is not running.
export type ScreenCoverage={line:number;universe:string;size:number;evaluated:number;noHistory:number;stale:number;errors:number;noLive:number};
export type ScreenRecord={at:number;script:string;status:'ok'|'stopped'|'error';stopped?:{line:number|null;words:string};words?:string;lines?:string[];coverage?:ScreenCoverage[];asOf?:{KR:string|null;US:string|null};live?:{asked:number;read:number;stopped?:string}|null};
type Market={stocks:number;read:number;current:number;older:number;full:number;median:number;stopped:number};
export type ScreenStatus={enabled?:boolean;error?:boolean;asOf?:{KR:string|null;US:string|null};markets?:{KR?:Market;US?:Market};refresh?:{state:string;why:string|null};stopped?:{count:number;reasons:string[]};keep?:number};
type Loaded={runId?:string|null;failed:boolean;at:number|null;screens:ScreenRecord[]};
export type ScreenRun={runId:string|null;at:number;failed:boolean;count:number};
const MARKET:Record<string,string>={KR:'Korea',US:'U.S.'};
const n=(v:number)=>v.toLocaleString('en-US');
export function statusLines(s:ScreenStatus):string[]{
  if(s.error)return ['The screening history could not be read.'];const out:string[]=[];
  for(const m of ['KR','US'] as const){const d=s.markets?.[m];if(!d)continue;const day=s.asOf?.[m];
    if(!d.read){out.push(`${MARKET[m]}: no history yet (${n(d.stocks)} stocks to read).`);continue;}
    out.push(`${MARKET[m]} as of ${day??'—'}: ${n(d.current)} of ${n(d.stocks)} stocks${d.older?`; ${n(d.older)} older`:''}${d.stocks>d.read?`; ${n(d.stocks-d.read)} not read yet`:''}. Full depth: ${n(d.full)} (median ${n(d.median)} of ${n(s.keep??311)} days).`);}
  if(s.refresh&&['waiting','paused','stopped'].includes(s.refresh.state)&&s.refresh.why)out.push(`Not refreshing now: ${s.refresh.why}.`);
  if(s.stopped?.count)out.push(`${n(s.stopped.count)} ${s.stopped.count===1?'stock':'stocks'} stopped deepening (${s.stopped.reasons.join('; ')}); they try again after 30 days.`);
  return out;}
export function ScreenList({loaded}:{loaded:Loaded}){
  if(!loaded.screens.length)return <p className="muted">No scripts in the latest run.</p>;
  return <>{loaded.failed&&<p className="warning-text">The latest run failed; these are the scripts it ran.</p>}
    {loaded.screens.map((r,i)=><details key={i} className="scout-screen"><summary>{r.status==='ok'?'':r.status==='stopped'?'Stopped: ':'Not run: '}{r.script.split('\n').find(l=>l.trim()&&!l.trim().startsWith('#'))?.slice(0,80)??'Script'}</summary>
      <pre className="scout-script" aria-label="Script">{r.script}</pre>
      {r.lines&&r.lines.length>0&&<pre className="scout-output" aria-label="Printed">{r.lines.join('\n')}</pre>}
      {r.stopped&&<p className="warning-text">{r.stopped.words}</p>}{r.words&&<p className="warning-text">{r.words}</p>}
      {r.coverage&&r.coverage.length>0&&<table className="compact-table scout-coverage" aria-label="Coverage"><thead><tr><th>Line</th><th>Universe</th><th>Stocks</th><th>Evaluated</th><th>No history</th><th>Stale</th><th>Errors</th><th>No live price</th></tr></thead>
        <tbody>{r.coverage.map((c,j)=><tr key={j}><td>{c.line}</td><td>{c.universe}</td><td>{c.size}</td><td>{c.evaluated}</td><td>{c.noHistory}</td><td>{c.stale}</td><td>{c.errors}</td><td>{c.noLive}</td></tr>)}</tbody></table>}
      {r.live&&<p className="muted">Live prices: {r.live.read} of {r.live.asked} read{r.live.stopped?` · ${r.live.stopped}`:''}</p>}
    </details>)}</>;}
// The panel mounts this with the latest run's id as its key, so a new run starts with nothing loaded.
export function ScoutScreens({status,run}:{status?:ScreenStatus|null;run?:ScreenRun|null}){
  const [loaded,setLoaded]=useState<Loaded|null>(null);const screenCount=run?.count??0;
  if(!screenCount&&!status?.enabled)return null;
  const lines=status?statusLines(status):[];
  const open=()=>{if(loaded||!window.portfolio?.getScoutScreens)return;void window.portfolio.getScoutScreens().then(v=>setLoaded(v)).catch(()=>setLoaded({failed:false,at:null,screens:[]}));};
  return <details className="note" onToggle={e=>{if((e.currentTarget as HTMLDetailsElement).open)open();}}><summary>Screens{screenCount?` · ${screenCount} in the latest run${run?.failed?', which failed':''}`:''}</summary><div className="note-body">
    {lines.length>0&&<div className="scout-screen-status" aria-label="Screening history">{lines.map(l=><p key={l} className={l.startsWith('Not refreshing')?'warning-text':'muted'}>{l}</p>)}</div>}
    {screenCount?loaded?<ScreenList loaded={loaded}/>:<p className="muted">Loading the scripts…</p>:null}
  </div></details>;}
