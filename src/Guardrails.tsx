import {useState} from 'react';
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
const kinds:Record<string,string>={'auto-stopped':'Auto trading stopped','buys-blocked':'Buys blocked','order-limit':'Order limit reached'};
const hourLabel=(h:number)=>String(h).padStart(2,'0')+':00 KST';
export function Guardrails({state,config,busy,edit}:{state:RuntimeState;config:RuntimeConfig;busy:boolean;edit(key:keyof RuntimeConfig,value:string|number|boolean):void}){
  const [preview,setPreview]=useState<string|null>(null);const g=state.guardrails;
  const loadPreview=async()=>{try{const digest=await window.portfolio?.previewDigest();setPreview(digest?.text??'Preview unavailable.');}catch{setPreview('Preview unavailable.');}};
  const latest=state.digests?.[0];
  return <section aria-label="Autopilot guardrails"><div className="section-head"><h2>Autopilot guardrails</h2><span className="badge">{g?.trippedToday?'TRIPPED TODAY':config.lossAction==='review'&&!config.maxAutoOrdersPerDay&&!config.maxConsecutiveFailures?'ADVISORY ONLY':'ACTIVE'}</span></div>
    <p className="muted">Hard limits for unattended trading. Daily loss limits themselves are set per market in Paper trading, KIS trading and U.S. stocks.</p>
    <div className="settings-grid">
      <label>Loss-limit response<select aria-label="Loss-limit response" disabled={busy} value={config.lossAction} onChange={e=>edit('lossAction',e.target.value)}><option value="review">Emergency reviews only (sells and buys allowed)</option><option value="block-buys">Block new AI buys; allow sells</option><option value="stop">Stop auto trading for the day</option></select></label>
      <label>Automatic orders per day (0 = no limit)<input aria-label="Automatic orders per day" type="number" min="0" max="100" step="1" disabled={busy} value={config.maxAutoOrdersPerDay} onChange={e=>edit('maxAutoOrdersPerDay',Number(e.target.value))}/></label>
      <label>Stop after consecutive failed reviews (0 = never)<input aria-label="Stop after consecutive failed reviews" type="number" min="0" max="20" step="1" disabled={busy} value={config.maxConsecutiveFailures} onChange={e=>edit('maxConsecutiveFailures',Number(e.target.value))}/></label>
      <label>Daily digest time<select aria-label="Daily digest time" disabled={busy||!config.digestEnabled} value={config.digestHour} onChange={e=>edit('digestHour',Number(e.target.value))}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
    </div>
    <div className="settings-checks"><label><input type="checkbox" aria-label="Send a daily digest" disabled={busy} checked={config.digestEnabled} onChange={e=>edit('digestEnabled',e.target.checked)}/>Send a daily digest through the desktop and webhook alerts selected below</label></div>
    {g&&<div className="saved-summary"><span>Automatic orders today <b>{g.autoOrdersToday}{config.maxAutoOrdersPerDay?` of ${config.maxAutoOrdersPerDay}`:''}</b></span><span>Failed reviews in a row <b>{g.failureStreak}</b></span><span>Last digest <b>{latest?latest.day:'None sent'}</b></span></div>}
    {g?.trippedToday&&<div className="notice error" role="status">A guardrail stopped auto trading today. Positions and accepted broker orders are unchanged; check AI console before restarting.</div>}
    <div className="actions"><button disabled={busy} onClick={()=>void loadPreview()}>Preview today's digest</button></div>
    {preview&&<pre aria-label="Digest preview" className="digest-preview">{preview}</pre>}
    <details className="inline-help"><summary>Recent guardrail events · {g?.events.length??0}</summary>{g?.events.length?g.events.map(e=><p key={e.id}><b>{kinds[e.kind]??e.kind}</b> · {new Date(e.timestamp).toLocaleString()}<br/><small>{e.detail}</small></p>):<p>No guardrail has triggered.</p>}</details>
    <details className="inline-help"><summary>How guardrails work</summary><p className="muted">Guardrails act on AI decisions and automatic submission. Manual proposals you approve in the trading tabs are not blocked. Blocking buys keeps sells and emergency reviews running. Stopping turns off scheduled reviews and automatic orders until you restart; with the stop response, restart is refused while the loss limit is still breached that day. The order limit counts automatic submissions per Seoul calendar day across markets; later proposals wait for approval. Each guardrail alerts once per day, and every stop alerts. The digest is built locally once a day at or after the chosen time while the app is open; missed days are not sent later.</p></details>
  </section>;
}
