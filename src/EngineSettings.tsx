import {useState} from 'react';
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {Card,Row,Switch,NumberField,Limit} from './SettingsUI';
import {Guardrails} from './Guardrails';
import {TokenSaving} from './TokenSaving';
type Edit=(key:keyof RuntimeConfig,value:string|number|boolean)=>void;
const usd=(micro:number)=>`$${(micro/1e6).toFixed(2)}`;
const SECTIONS:[string,string][]=[['eng-guidelines','Guidelines'],['eng-trading','Trading'],['eng-model','AI model'],['eng-schedule','Schedule'],['eng-budget','Budget'],['eng-guardrails','Guardrails'],['eng-saving','Token saving'],['eng-alerts','Alerts']];
const hourLabel=(h:number)=>String(h).padStart(2,'0')+':00 KST';
export function EngineSettings({state,config,busy,dirty,edit,setModel,onReview,onState}:{state:RuntimeState;config:RuntimeConfig;busy:boolean;dirty:boolean;edit:Edit;setModel(model:string):void;onReview():void;onState(state:RuntimeState):void}){
  const [preview,setPreview]=useState<string|null>(null);
  const loadPreview=async()=>{try{const digest=await window.portfolio?.previewDigest();setPreview(digest?.text??'Preview unavailable.');}catch{setPreview('Preview unavailable.');}};
  const jump=(id:string)=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});
  const efforts=config.openaiModel==='gpt-6-astra'?['low','medium','high']:['none','low','medium','high'];
  return <div className="engine-settings" aria-label="Engine settings">
    <div className="settings-jump"><nav aria-label="Settings sections">{SECTIONS.map(([id,label])=><button key={id} onClick={()=>jump(id)}>{label}</button>)}</nav>
      <button className="primary" disabled={busy||state.busy||dirty} title={dirty?'Save or discard your changes before reviewing':'Run one review now with the saved settings'} onClick={onReview}>{state.busy?'Reviewing…':'Run portfolio review'}</button></div>

    <Card id="eng-guidelines" title="Agent guidelines" label="Guidelines" hint="Your goals in plain language. The AI reads them on every review.">
      <label className="guidelines-editor"><textarea aria-label="Agent guidelines" rows={4} maxLength={6000} value={config.guidelines??''} placeholder="Example: Concentrated positions are fine; protect gains when the outlook weakens." onChange={e=>edit('guidelines',e.target.value)}/></label>
    </Card>

    <Card id="eng-trading" title="Trading">
      <Row title="Portfolio" hint="Which account the AI manages"><select disabled={busy} aria-label="Portfolio scope" value={config.scope} onChange={e=>edit('scope',e.target.value)}><option value="paper">Paper (simulated)</option><option value="kis">Korea · KIS</option><option value="us">U.S. · KIS</option><option value="both">Korea + U.S. · KIS</option></select></Row>
      <Row title="Decision maker"><select disabled={busy} aria-label="Decision provider" value={config.provider} onChange={e=>edit('provider',e.target.value)}><option value="local" disabled={config.scope!=='paper'}>Rules only (no AI, paper)</option><option value="openai">OpenAI</option><option value="external">External agent</option></select></Row>
      <Row title="Scheduled reviews" hint="Review on a timer and when prices move"><Switch label="Scheduled reviews" disabled={busy} checked={config.enabled} onChange={v=>edit('enabled',v)}/></Row>
      <Row title="Place orders automatically" hint={config.autoSubmit?'Orders that pass your limits are sent without asking':'Every AI order waits for your approval'}><Switch label="Place orders automatically" disabled={busy} checked={config.autoSubmit} onChange={v=>edit('autoSubmit',v)}/></Row>
      <Row title="Share KIS data with OpenAI" hint="Holdings and values; required for AI reviews of KIS accounts"><Switch label="Share KIS data with OpenAI" disabled={busy} checked={config.shareKisWithAI} onChange={v=>edit('shareKisWithAI',v)}/></Row>
    </Card>

    <Card id="eng-model" title="AI model" hint={state.providerStatus.aiConnected?undefined:'No OpenAI key loaded. Add one in Connections.'}>
      <Row title="Model"><select aria-label="OpenAI model" disabled={busy} value={config.openaiModel} onChange={e=>setModel(e.target.value)}><option value="gpt-6-luna">GPT-6 Luna</option><option value="gpt-6-sol">GPT-6 Sol</option><option value="gpt-6-astra">GPT-6 Astra</option></select></Row>
      <Row title="Reasoning effort" hint="Higher is slower and costs more"><select aria-label="Reasoning effort" disabled={busy} value={config.reasoningEffort} onChange={e=>edit('reasoningEffort',e.target.value)}>{efforts.map(v=><option key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</option>)}</select></Row>
      <Row title="Post-trade reflection" hint="After a trade closes, the AI drafts a lesson for you to approve"><Switch label="Post-trade reflection" disabled={busy} checked={config.reflectionEnabled} onChange={v=>edit('reflectionEnabled',v)}/></Row>
    </Card>

    <Card id="eng-schedule" title="Schedule">
      <Row title="Let the AI choose the interval" hint="Between 1 and 60 minutes, depending on the market"><Switch label="Auto review interval" disabled={busy} checked={config.autoReviewInterval} onChange={v=>edit('autoReviewInterval',v)}/></Row>
      <Row title={config.autoReviewInterval?'Initial review interval (minutes)':'Review interval (minutes)'} hint={config.autoReviewInterval&&state.reviewInterval?.auto?`Now every ${state.reviewInterval.minutes} min · ${state.reviewInterval.reason}`:undefined}><NumberField label="Review interval" min={1} max={1440} unit="min" disabled={busy} value={config.intervalMinutes} onChange={v=>edit('intervalMinutes',v)}/></Row>
      <Row title="Price move trigger" hint="Review early when a price moves this much"><NumberField label="Price move trigger" min={.1} max={50} step={.1} unit="%" disabled={busy} value={config.eventTolerancePct} onChange={v=>edit('eventTolerancePct',v)}/></Row>
    </Card>

    <Card id="eng-budget" title="Daily AI budget" aside={<span className="badge">Today {state.usage.calls} calls · {usd(state.usage.reservedMicro)}</span>} hint="A local estimate from reported tokens, not your OpenAI invoice.">
      <Row block title="Review calls"><Limit label="API calls per day" min={1} max={200} disabled={busy} unlimited={config.unlimitedCalls} value={config.maxCallsPerDay} onUnlimited={v=>edit('unlimitedCalls',v)} onValue={v=>edit('maxCallsPerDay',v)}/></Row>
      <Row block title="Review spending"><Limit label="Daily local API budget (USD)" min={.01} max={100} step={.01} unit="USD" disabled={busy} unlimited={config.unlimitedBudget} value={config.maxUSDPerDay} onUnlimited={v=>edit('unlimitedBudget',v)} onValue={v=>edit('maxUSDPerDay',v)}/></Row>
      <Row block title="Reflection calls"><Limit label="Reflection calls per day" min={1} max={200} disabled={busy} unlimited={config.reflectionUnlimitedCalls} value={config.reflectionCallsPerDay} onUnlimited={v=>edit('reflectionUnlimitedCalls',v)} onValue={v=>edit('reflectionCallsPerDay',v)}/></Row>
      <Row block title="Reflection spending"><Limit label="Daily reflection budget (USD)" min={.01} max={100} step={.01} unit="USD" disabled={busy} unlimited={config.reflectionUnlimitedBudget} value={config.reflectionUSDPerDay} onUnlimited={v=>edit('reflectionUnlimitedBudget',v)} onValue={v=>edit('reflectionUSDPerDay',v)}/></Row>
      <details className="inline-help"><summary>Recent API calls</summary>{state.aiCalls?.length?<table className="compact-table" aria-label="Recent API calls"><thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>{state.aiCalls.map((c,i)=><tr key={i}><td>{new Date(c.timestamp).toLocaleTimeString()}</td><td>{c.model}</td><td>{c.status}</td><td>{c.usage?`${c.usage.inputTokens.toLocaleString()} / ${c.usage.outputTokens.toLocaleString()}`:'—'}</td><td>{c.estimatedMicro==null?`${usd(c.reservedMicro)} reserved`:`$${(c.estimatedMicro/1e6).toFixed(4)}`}</td></tr>)}</tbody></table>:<p className="muted">No calls yet.</p>}</details>
    </Card>

    <Guardrails id="eng-guardrails" state={state} config={config} busy={busy} edit={edit}/>
    <TokenSaving id="eng-saving" state={state} config={config} busy={busy} edit={edit}/>

    <Card id="eng-alerts" title="Alerts">
      <Row title="Desktop alerts" hint="When orders fill, cancel or stop"><Switch label="Desktop alerts" disabled={busy} checked={config.desktopAlerts} onChange={v=>edit('desktopAlerts',v)}/></Row>
      <Row title="Phone alerts" hint={state.providerStatus.pushConnected?'Sent to your webhook':'Needs a webhook in Connections'}><Switch label="Phone alerts" disabled={busy} checked={config.mobileAlerts} onChange={v=>edit('mobileAlerts',v)}/></Row>
      <Row title="Daily digest" hint="A summary of the day's reviews and orders"><Switch label="Send a daily digest" disabled={busy} checked={config.digestEnabled} onChange={v=>edit('digestEnabled',v)}/></Row>
      {config.digestEnabled&&<Row title="Digest time"><select aria-label="Daily digest time" disabled={busy} value={config.digestHour} onChange={e=>edit('digestHour',Number(e.target.value))}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{hourLabel(h)}</option>)}</select></Row>}
      <div className="card-actions"><button disabled={busy} onClick={()=>void loadPreview()}>Preview today's digest</button></div>
      {preview&&<pre aria-label="Digest preview" className="digest-preview">{preview}</pre>}
      {config.mobileAlerts&&!state.providerStatus.pushConnected&&<div className="notice error">Phone alerts are on, but no webhook is set. Alerts are queued, not sent.</div>}
      {state.notifications.length>0&&<details className="inline-help"><summary>Phone alert outbox · {state.notifications.length}</summary>{state.notifications.map(item=><p key={item.id}>{item.delivered?'Delivered':item.attempts>=5?'Failed':'Queued'} · {item.message}</p>)}</details>}
    </Card>

    <Card title="AI review alerts" hint="Price levels and moves the AI asked to be woken up for." aside={<button onClick={async()=>{const value=await window.portfolio?.resetReviewWatches();if(value)onState(value);}}>Reset to default alerts</button>}>
      {state.watches?.length?<ul className="watch-list">{state.watches.map(w=><li key={w.symbol}><b>{w.symbol}</b><span>{w.percent??state.config.eventTolerancePct}% move{w.price!=null?` · ${w.direction} ${w.price.toLocaleString()} ${/^\d{6}$/.test(w.symbol)?'KRW':'USD'}${w.priceFired?' (triggered)':''}`:''}</span><small>{w.reason}</small></li>)}</ul>:<p className="muted">Default movement threshold: {state.config.eventTolerancePct}%</p>}
    </Card>
  </div>;
}
