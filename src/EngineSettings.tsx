import {useEffect,useState} from 'react';
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {Card,Row,Switch,NumberField,Limit} from './SettingsUI';
import {Note} from './Note';
import {Guardrails} from './Guardrails';
import {TokenSaving} from './TokenSaving';
import {useDraftState} from './useDraftState';
import {AGENT_KEYS as DRAFT_KEYS,effortOptions} from './agentDraft.mjs';
type Edit=(key:keyof RuntimeConfig,value:string|number|boolean)=>void;
type Props={state:RuntimeState;config:RuntimeConfig;busy:boolean;dirty:boolean;edit:Edit;setModel(model:string):void;onReview():void;onState(state:RuntimeState):void};
const usd=(micro:number)=>`$${(micro/1e6).toFixed(2)}`;
// Engine settings in four tabs (step A3, artifacts/reviews/2026-11-12-engine-settings/plan.md). Only the open tab is
// rendered; the draft lives in RuntimeSettings, so switching tabs keeps unsaved changes, and the open tab is kept for
// the session like Journal's.
export const ENGINE_TABS=['Trading','Agents','Schedule and triggers','Alerts'] as const;
type Tab=typeof ENGINE_TABS[number];
const MODEL_NAMES:Record<string,string>={'gpt-6-luna':'GPT-6 Luna','gpt-6-sol':'GPT-6 Sol','gpt-6-astra':'GPT-6 Astra','claude-opus-5-5':'Claude Opus 5.5'};
const cap=(v:string)=>v[0].toUpperCase()+v.slice(1);
// Which providers receive KIS data given the selected models (trading and every agent with its own): one consent covers all.
const vendorName=(model:string)=>model.startsWith('claude-')?'Anthropic':'OpenAI';
const receivers=(config:RuntimeConfig)=>[...new Set([config.openaiModel,config.routineModel,config.scoutModel,config.narrativeModel,config.reflectionModel].filter(m=>m&&m!=='same').map(m=>vendorName(String(m))))].join(' and ');
const hourLabel=(h:number)=>String(h).padStart(2,'0')+':00 KST';
export function EngineSettings(props:Props){
  const {state,busy,dirty,onReview}=props;
  const [saved,setTab]=useDraftState<string>('engine:tab','Trading');const tab:Tab=(ENGINE_TABS as readonly string[]).includes(saved)?saved as Tab:'Trading';
  return <div className="engine-settings" aria-label="Engine settings">
    <div className="settings-jump"><div className="segmented engine-tabs" role="tablist" aria-label="Engine sections">{ENGINE_TABS.map(t=><button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</div>
      <button className="primary" disabled={busy||state.busy||dirty} title={dirty?'Save or discard your changes before reviewing':'Run one review now with the saved settings'} onClick={onReview}>{state.busy?'Reviewing…':'Run portfolio review'}</button></div>
    <div className="engine-panel" role="tabpanel" aria-label={tab}>
      {tab==='Trading'&&<TradingTab {...props}/>}
      {tab==='Agents'&&<AgentsTab {...props}/>}
      {tab==='Schedule and triggers'&&<ScheduleTab {...props}/>}
      {tab==='Alerts'&&<AlertsTab {...props}/>}
    </div>
  </div>;
}

function TradingTab({state,config,busy,edit}:Props){
  return <>
    <Card id="eng-guidelines" title="Agent guidelines" label="Guidelines" hint="Your goals in plain language. The AI reads them on every review.">
      <label className="guidelines-editor"><textarea aria-label="Agent guidelines" rows={4} maxLength={6000} value={config.guidelines??''} placeholder="Example: Concentrated positions are fine; protect gains when the outlook weakens." onChange={e=>edit('guidelines',e.target.value)}/></label>
    </Card>
    <Card id="eng-trading" title="Trading">
      <Row title="Portfolio" hint="Which account the AI manages"><select disabled={busy} aria-label="Portfolio scope" value={config.scope} onChange={e=>edit('scope',e.target.value)}><option value="paper">Paper (simulated)</option><option value="kis">Korea · KIS</option><option value="us">U.S. · KIS</option><option value="both">Korea + U.S. · KIS</option></select></Row>
      <Row title="Decision maker"><select disabled={busy} aria-label="Decision provider" value={config.provider} onChange={e=>edit('provider',e.target.value)}><option value="local" disabled={config.scope!=='paper'}>Rules only (no AI, paper)</option><option value="openai">OpenAI</option><option value="external">External agent</option></select></Row>
      <Row title="Scheduled reviews" hint="Review on a timer and when prices move"><Switch label="Scheduled reviews" disabled={busy} checked={config.enabled} onChange={v=>edit('enabled',v)}/></Row>
      <Row title="Place orders automatically" hint={config.autoSubmit?'Orders that pass your limits are sent without asking':'Every AI order waits for your approval'}><Switch label="Place orders automatically" disabled={busy} checked={config.autoSubmit} onChange={v=>edit('autoSubmit',v)}/></Row>
      <Row title="Risk per trade" hint="Largest loss at the stop, as a share of equity. Sets the AI's position-size ceiling."><NumberField label="Risk per trade" min={0.1} max={20} step={0.1} unit="%" value={config.sizingRiskPct} disabled={busy} onChange={v=>edit('sizingRiskPct',v)}/></Row>
      <Row title="Stop distance" hint="Multiple of the daily average true range (ATR)."><NumberField label="Stop distance in ATR" min={0.5} max={5} step={0.5} unit="× ATR" value={config.sizingAtrMultiple} disabled={busy} onChange={v=>edit('sizingAtrMultiple',v)}/></Row>
      <Row title="Share KIS data with the AI provider" hint={`Holdings and values, sent to ${receivers(config)}; required for AI reviews of KIS accounts`}><Switch label="Share KIS data with the AI provider" disabled={busy} checked={config.shareKisWithAI} onChange={v=>edit('shareKisWithAI',v)}/></Row>
      <StartWithWindows/>
    </Card>
    <ExtendedSessions config={config} busy={busy} edit={edit} live={state.accountEnvironment==='live'}/>
    <Guardrails id="eng-guardrails" state={state} config={config} busy={busy} edit={edit}/>
    <Card id="eng-execution" title="Order execution" hint="How KIS orders are placed and kept until they fill.">
      <Row title="Follow the best price" hint={config.orderTracking?'Orders go in at the best bid (sell) or ask (buy) and move with it every 3 seconds until filled, within any bound the AI set. Orders you change in KIS are left to you.':'Orders stay at the price they were placed at.'}><Switch label="Follow the best price" disabled={busy} checked={config.orderTracking} onChange={v=>edit('orderTracking',v)}/></Row>
    </Card>
    <Card id="eng-conditional" title="Conditional orders" label="Conditional order settings" hint="Stop-loss, take-profit and entry orders the AI arms with conditions. They fire only while auto trading is on and the market is open, and still pass every risk check.">
      <Row title="Let the AI set conditional orders" hint="Off by default."><Switch label="Let the AI set conditional orders" disabled={busy} checked={config.conditionalOrders} onChange={v=>edit('conditionalOrders',v)}/></Row>
      {config.conditionalOrders&&<>
        <Row title="Submit them automatically" hint={config.autoSubmit?'Otherwise each one waits for your approval.':'Needs automatic submission in Trading. Until then each one waits for approval.'}><Switch label="Submit conditional orders automatically" disabled={busy} checked={config.conditionalAutoSubmit} onChange={v=>edit('conditionalAutoSubmit',v)}/></Row>
        <Row title="Armed at once" hint="Most orders waiting at one time."><NumberField label="Most armed conditional orders" min={1} max={10} value={config.conditionalMaxActive} disabled={busy} onChange={v=>edit('conditionalMaxActive',v)}/></Row>
        <Row title="Largest order" hint="Share of account equity for one buy."><NumberField label="Largest conditional order" min={1} max={50} step={1} unit="%" value={config.conditionalMaxOrderPct} disabled={busy} onChange={v=>edit('conditionalMaxOrderPct',v)}/></Row>
        <Row title="Price drift allowed" hint="How far the limit may sit from the price when it fires."><NumberField label="Conditional order price drift" min={0.1} max={10} step={0.1} unit="%" value={config.conditionalMaxSlippagePct} disabled={busy} onChange={v=>edit('conditionalMaxSlippagePct',v)}/></Row>
        <Row title="Longest life" hint="Orders expire after this many hours."><NumberField label="Conditional order lifetime" min={1} max={336} unit="h" value={config.conditionalMaxHours} disabled={busy} onChange={v=>edit('conditionalMaxHours',v)}/></Row>
      </>}
    </Card>
  </>;
}

// One agent's Model and Effort rows (step A2 settings). "Same as the trading agent" follows the Trading review card.
// The hint shows what the agent runs on with the saved settings. Effort "None" is not offered where the engine refuses
// it: for the scout and the market narrative (they run with at least Low) and with GPT-6 Astra. Every draft edit runs
// through correctAgents (src/agentDraft.mjs, called by RuntimeSettings' edit), so an agent never stays on Astra with None.
// The select always shows the draft's value: a value the list would not offer is shown, marked, and cannot be picked.
type AgentKey='scout'|'narrative'|'compacting'|'reflection';
const AGENT_KEYS=DRAFT_KEYS as Record<AgentKey,[keyof RuntimeConfig,keyof RuntimeConfig]>;
function AgentModelRows({agent,name,state,config,busy,edit}:{agent:AgentKey;name:string}&Props){
  const [mk,ek]=AGENT_KEYS[agent];const model=String(config[mk]??'same'),effort=String(config[ek]??'same');
  const efforts=effortOptions(config,agent);
  const now=state.agentModels?.[agent];
  const pickModel=(v:string)=>edit(mk,v);
  return <>
    <Row title="Model" hint={now?`Now ${MODEL_NAMES[now.openaiModel]??now.openaiModel} · ${cap(now.reasoningEffort)}`:undefined}><select aria-label={`${name} model`} disabled={busy} value={model} onChange={e=>pickModel(e.target.value)}><option value="same">Same as the trading agent</option><option value="gpt-6-luna">GPT-6 Luna</option><option value="gpt-6-sol">GPT-6 Sol</option><option value="gpt-6-astra">GPT-6 Astra</option></select></Row>
    <Row title="Effort"><select aria-label={`${name} effort`} disabled={busy} value={effort} onChange={e=>edit(ek,e.target.value)}>{!efforts.includes(effort)&&<option value={effort} disabled>{cap(effort)} · not allowed with this model</option>}{efforts.map(v=><option key={v} value={v}>{v==='same'?'Same as the trading agent':cap(v)}</option>)}</select></Row>
  </>;
}

function AgentsTab(props:Props){
  const {state,config,busy,edit,setModel}=props;
  const efforts=config.openaiModel==='gpt-6-astra'||config.openaiModel.startsWith('claude-')?['low','medium','high']:['none','low','medium','high'];
  return <>
    <Card id="eng-model" title="Trading review" label="AI model" hint={state.providerStatus.aiConnected?'Decides Buy, Sell or Hold. The other agents can follow it.':'No OpenAI key loaded. Add one in Connections.'}>
      <Row title="Model" hint="Claude Opus 5.5: dry run only for now (Dashboard → Dry run)"><select aria-label="Trading model" disabled={busy} value={config.openaiModel} onChange={e=>setModel(e.target.value)}><optgroup label="OpenAI"><option value="gpt-6-luna">GPT-6 Luna</option><option value="gpt-6-sol">GPT-6 Sol</option><option value="gpt-6-astra">GPT-6 Astra</option></optgroup><optgroup label="Anthropic"><option value="claude-opus-5-5" disabled>Claude Opus 5.5 · dry run only</option></optgroup></select></Row>
      <Row title="Reasoning effort" hint="Higher is slower and costs more"><select aria-label="Reasoning effort" disabled={busy} value={config.reasoningEffort} onChange={e=>edit('reasoningEffort',e.target.value)}>{efforts.map(v=><option key={v} value={v}>{cap(v)}</option>)}</select></Row>
    </Card>
    <Card id="eng-scout-agent" title="AI scout" label="Scout agent" hint="Researches the market and writes the plan for the trading reviews. It never trades. When it runs: Schedule and triggers.">
      <AgentModelRows agent="scout" name="Scout" {...props}/>
    </Card>
    <Card id="eng-narrative" title="Market narrative" label="Narrative agent" hint="Summarises what is driving the market for the reviews. It never trades.">
      <Row title="Scheduled narrative" hint="Weekdays 08:30 and 16:30. Update now on Discover works either way."><Switch label="Scheduled market narrative" disabled={busy} checked={config.narrativeEnabled} onChange={v=>edit('narrativeEnabled',v)}/></Row>
      <AgentModelRows agent="narrative" name="Market narrative" {...props}/>
    </Card>
    <Card id="eng-compacting" title="Context compacting" hint="Shrinks research results that grow too large for a review.">
      <AgentModelRows agent="compacting" name="Context compacting" {...props}/>
    </Card>
    <Card id="eng-reflection" title="Reflection" label="Reflection agent" hint="After a trade closes, the AI drafts a lesson for you to approve.">
      <Row title="Post-trade reflection"><Switch label="Post-trade reflection" disabled={busy} checked={config.reflectionEnabled} onChange={v=>edit('reflectionEnabled',v)}/></Row>
      <AgentModelRows agent="reflection" name="Reflection" {...props}/>
      <Row block title="Reflection calls"><Limit label="Reflection calls per day" min={1} max={200} disabled={busy} unlimited={config.reflectionUnlimitedCalls} value={config.reflectionCallsPerDay} onUnlimited={v=>edit('reflectionUnlimitedCalls',v)} onValue={v=>edit('reflectionCallsPerDay',v)}/></Row>
      <Row block title="Reflection spending"><Limit label="Daily reflection budget (USD)" min={.01} max={100} step={.01} unit="USD" disabled={busy} unlimited={config.reflectionUnlimitedBudget} value={config.reflectionUSDPerDay} onUnlimited={v=>edit('reflectionUnlimitedBudget',v)} onValue={v=>edit('reflectionUSDPerDay',v)}/></Row>
    </Card>
    <Card id="eng-budget" title="Daily AI budget" aside={<span className="badge">Today {state.usage.calls} calls · {usd(state.usage.reservedMicro)}</span>} hint="A local estimate from reported tokens, not your OpenAI invoice.">
      <Row block title="Review calls"><Limit label="API calls per day" min={1} max={200} disabled={busy} unlimited={config.unlimitedCalls} value={config.maxCallsPerDay} onUnlimited={v=>edit('unlimitedCalls',v)} onValue={v=>edit('maxCallsPerDay',v)}/></Row>
      <Row block title="Review spending"><Limit label="Daily local API budget (USD)" min={.01} max={100} step={.01} unit="USD" disabled={busy} unlimited={config.unlimitedBudget} value={config.maxUSDPerDay} onUnlimited={v=>edit('unlimitedBudget',v)} onValue={v=>edit('maxUSDPerDay',v)}/></Row>
      <details className="inline-help"><summary>Recent API calls</summary>{state.aiCalls?.length?<table className="compact-table" aria-label="Recent API calls"><thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>{state.aiCalls.map((c,i)=><tr key={i}><td>{new Date(c.timestamp).toLocaleTimeString()}</td><td>{c.model}</td><td>{c.status}</td><td>{c.usage?`${c.usage.inputTokens.toLocaleString()} / ${c.usage.outputTokens.toLocaleString()}`:'—'}</td><td>{c.estimatedMicro==null?`${usd(c.reservedMicro)} reserved`:`$${(c.estimatedMicro/1e6).toFixed(4)}`}</td></tr>)}</tbody></table>:<p className="muted">No calls yet.</p>}</details>
    </Card>
  </>;
}

function ScheduleTab({state,config,busy,edit}:Props){
  return <>
    <Card id="eng-schedule" title="Schedule">
      <Row title="Let the AI choose the interval" hint="Between 1 and 60 minutes, depending on the market"><Switch label="Auto review interval" disabled={busy} checked={config.autoReviewInterval} onChange={v=>edit('autoReviewInterval',v)}/></Row>
      <Row title={config.autoReviewInterval?'Initial review interval (minutes)':'Review interval (minutes)'} hint={config.autoReviewInterval&&state.reviewInterval?.auto?`Now every ${state.reviewInterval.minutes} min · ${state.reviewInterval.reason}`:undefined}><NumberField label="Review interval" min={1} max={1440} unit="min" disabled={busy} value={config.intervalMinutes} onChange={v=>edit('intervalMinutes',v)}/></Row>
      <Row title="When markets are closed" hint={config.closedMarketReviews==='keep'?'Reviews follow the interval around the clock':config.closedMarketReviews==='off'?'No scheduled reviews until a market opens':'One review 10 minutes before the next open'}><select aria-label="Reviews while markets are closed" disabled={busy} value={config.closedMarketReviews} onChange={e=>edit('closedMarketReviews',e.target.value)}><option value="pre-open">Review once before the open</option><option value="off">Wait for the open</option><option value="keep">Keep the schedule</option></select></Row>
      <Row title="Price move trigger" hint={config.watchlistAlerts==='on'?'Review early when a holding moves this much':'Review early when a price moves this much'}><NumberField label="Price move trigger" min={.1} max={50} step={.1} unit="%" disabled={busy} value={config.eventTolerancePct} onChange={v=>edit('eventTolerancePct',v)}/></Row>
      <Row title="Watchlist alerts" hint={config.watchlistAlerts==='on'?'Stocks you don’t hold: entry levels when crossed, wider moves, grouped':config.watchlistAlerts==='observe'?'Logged beside the current rule; nothing changes':'Every quoted stock uses the price move trigger'}><select aria-label="Watchlist alerts" disabled={busy} value={config.watchlistAlerts} onChange={e=>edit('watchlistAlerts',e.target.value)}><option value="observe">Observe only</option><option value="on">On</option><option value="off">Off</option></select></Row>
      {config.watchlistAlerts!=='off'&&<Row title="Watchlist move trigger" hint={`Default ${2*config.eventTolerancePct}%, twice the price move trigger`}><NumberField label="Watchlist move trigger" min={.1} max={50} step={.1} unit="%" disabled={busy} value={config.watchlistMovePct??2*config.eventTolerancePct} onChange={v=>edit('watchlistMovePct',v)}/></Row>}
      {config.watchlistAlerts==='observe'&&<Row title="Watchlist alert trial" hint={config.alertTrial==='on'?'Price reviews use watchlist alerts; the current rule runs in shadow. Ends by itself on a rollback condition, after $2.50 of added reviews, or after 5 trading days per market':'Off: nothing changes. Only price-move reviews would change; protection and every other trigger stay as they are'}><select aria-label="Watchlist alert trial" disabled={busy} value={config.alertTrial??'off'} onChange={e=>edit('alertTrial',e.target.value)}><option value="off">Off</option><option value="on">On</option></select></Row>}
      {state.watchlistAlerts?.trial&&(()=>{const t=state.watchlistAlerts.trial;return <p className="muted" aria-label="Watchlist alert trial status">Trial {t.status}{t.endReason?` (${t.endReason})`:''}: {t.days.KR} Korean and {t.days.US} U.S. qualifying trading days{t.partialDays.KR.length+t.partialDays.US.length?` (${t.partialDays.KR.length+t.partialDays.US.length} not fully watched, not counted)`:''}, {t.priceReviews} price reviews, {t.addedReviews} the current rule would not have started (${t.addedUSD.toFixed(2)}).{t.endDetail?` ${t.endDetail}`:''}</p>;})()}
      {config.watchlistAlerts!=='off'&&state.watchlistAlerts?.summary&&(()=>{const s=state.watchlistAlerts.summary;return <p className="muted" aria-label="Watchlist alert observation">Last 7 days: {s.reviewsStarted??'?'} price reviews started. Checks that would alert: {s.checks.current} current rule, {s.checks.proposed} watchlist alerts, in {s.episodes.total} episodes ({s.episodes.oldOnly} current rule only, {s.episodes.newOnly} watchlist alerts only, {s.episodes.both} both){s.notHeldAlerts.length?` · ${s.delayed} of ${s.notHeldAlerts.length} alerts on stocks you don’t hold later, ${s.notAlerted} not alerted`:''}.</p>;})()}
    </Card>
    <Card id="eng-scout" title="AI scout runs" label="Scout settings" hint={state.scout?.blocked??'When the scout researches the market. Its model is on the Agents tab.'}>
      <Row title="Scheduled scout runs" hint="Weekdays, Seoul time. Uses the daily AI budget."><Switch label="Scheduled scout runs" disabled={busy} checked={config.scoutEnabled} onChange={v=>edit('scoutEnabled',v)}/></Row>
      <Row title="Reviews can ask for a scout run" hint="When the plan looks stale. Up to 3 a day, at least 2 hours apart."><Switch label="Reviews can request a scout run" disabled={busy} checked={config.scoutAiRequests} onChange={v=>edit('scoutAiRequests',v)}/></Row>
      {config.scoutEnabled&&<Row title="When"><select aria-label="Scout schedule" disabled={busy} value={config.scoutSchedule} onChange={e=>edit('scoutSchedule',e.target.value)}><option value="daily">09:10</option><option value="twice">09:10 and 13:00</option><option value="kr-us">09:10 and 22:40 (U.S. open)</option><option value="three">09:10, 13:00 and 22:40</option></select></Row>}
    </Card>
    <TokenSaving id="eng-saving" state={state} config={config} busy={busy} edit={edit}/>
  </>;
}

function AlertsTab({state,config,busy,dirty,edit,onState}:Props){
  const [preview,setPreview]=useState<string|null>(null);const [phoneNote,setPhoneNote]=useState('');
  const testPhone=async()=>{setPhoneNote('');try{const r=await window.portfolio?.testPhoneSnapshot();setPhoneNote(r?.ok?'Test snapshot queued. It should reach your phone within a few seconds.':r?.error==='NO_WEBHOOK'?'Add a webhook in Connections first.':'Turn on phone alerts and save first.');}catch{setPhoneNote('Could not reach the engine.');}};
  const loadPreview=async()=>{try{const digest=await window.portfolio?.previewDigest();setPreview(digest?.text??'Preview unavailable.');}catch{setPreview('Preview unavailable.');}};
  return <>
    <Card id="eng-alerts" title="Alerts">
      <Row title="Desktop alerts" hint="When orders fill, cancel or stop"><Switch label="Desktop alerts" disabled={busy} checked={config.desktopAlerts} onChange={v=>edit('desktopAlerts',v)}/></Row>
      <Row title="Phone alerts" hint={state.providerStatus.pushConnected?'Sent to your webhook':'Needs a webhook in Connections'}><Switch label="Phone alerts" disabled={busy} checked={config.mobileAlerts} onChange={v=>edit('mobileAlerts',v)}/></Row>
      {config.mobileAlerts&&<Row title="Snapshot on each trade" hint="Portfolio chart and the reason when a buy or sell fills"><Switch label="Snapshot on each trade" disabled={busy} checked={config.phoneSnapshots} onChange={v=>edit('phoneSnapshots',v)}/></Row>}
      {config.mobileAlerts&&config.phoneSnapshots&&<Row title="Show amounts" hint={config.phoneAmounts?'Won amounts and percentages':'Percentages only'}><Switch label="Show amounts in snapshots" disabled={busy} checked={config.phoneAmounts} onChange={v=>edit('phoneAmounts',v)}/></Row>}
      <Row title="Daily digest" hint="A summary of the day's reviews and orders"><Switch label="Send a daily digest" disabled={busy} checked={config.digestEnabled} onChange={v=>edit('digestEnabled',v)}/></Row>
      {config.digestEnabled&&<Row title="Digest time"><select aria-label="Daily digest time" disabled={busy} value={config.digestHour} onChange={e=>edit('digestHour',Number(e.target.value))}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{hourLabel(h)}</option>)}</select></Row>}
      <div className="card-actions"><button disabled={busy} onClick={()=>void loadPreview()}>Preview today's digest</button></div>
      {preview&&<pre aria-label="Digest preview" className="digest-preview">{preview}</pre>}
      {config.mobileAlerts&&state.providerStatus.pushConnected&&<div className="card-actions"><button disabled={busy||dirty} onClick={()=>void testPhone()}>Send a test snapshot</button></div>}
      {phoneNote&&<p className="muted">{phoneNote}</p>}
      {config.mobileAlerts&&!state.providerStatus.pushConnected&&<div className="notice error">Phone alerts are on, but no webhook is set. Alerts are queued, not sent.</div>}
      {state.notifications.length>0&&<details className="inline-help"><summary>Phone alert outbox · {state.notifications.length}</summary>{state.notifications.map(item=><p key={item.id}>{item.delivered?'Delivered':item.attempts>=99?'Expired':item.attempts>=5?'Failed':'Queued'} · {item.message}</p>)}</details>}
    </Card>
    <Card title="AI review alerts" hint="Price levels and moves the AI asked to be woken up for." aside={<button onClick={async()=>{const value=await window.portfolio?.resetReviewWatches();if(value)onState(value);}}>Reset to default alerts</button>}>
      {state.watches?.length?<ul className="watch-list">{state.watches.map(w=><li key={w.symbol}><b>{w.symbol}</b><span>{w.percent??state.config.eventTolerancePct}% move{w.price!=null?` · ${w.direction} ${w.price.toLocaleString()} ${/^\d{6}$/.test(w.symbol)?'KRW':'USD'}${w.priceFired?' (triggered)':''}`:''}</span><small>{w.reason}</small></li>)}</ul>:<p className="muted">Default movement threshold: {state.config.eventTolerancePct}%</p>}
    </Card>
  </>;
}

// Extended-hours trading, one switch per session. Live accounts only (KIS offers none of these sessions on mock accounts).
function ExtendedSessions({config,busy,edit,live}:{config:RuntimeConfig;busy:boolean;edit:Edit;live:boolean}){
  const row=(key:'sessionKrNxt'|'sessionUsPre'|'sessionUsAfter'|'sessionUsDaytime',title:string,hint:string)=><Row title={title} hint={hint}><Switch label={title} disabled={busy} checked={config[key]} onChange={v=>edit(key,v)}/></Row>;
  const any=config.sessionKrNxt||config.sessionUsPre||config.sessionUsAfter||config.sessionUsDaytime;
  return <Card id="eng-extended" title="Extended hours" hint="Trade outside regular sessions. Each session has its own switch; all start off." aside={<span className="badge">{any?'On':'Off'}</span>}>
    {!live&&<div className="notice">The connected account is a mock account, which accepts no extended-session orders. These switches take effect on a live account.</div>}
    {row('sessionKrNxt','Korea · Nextrade (NXT)','Pre-market 08:00–08:50 and after-market 15:30–20:00 KST, limit orders on NXT')}
    {row('sessionUsDaytime','U.S. · KIS daytime session','During Korean daytime (09:00–17:00 KST in summer), limit orders only')}
    {row('sessionUsPre','U.S. · Pre-market','04:00–09:30 New York time; every order waits for your approval')}
    {row('sessionUsAfter','U.S. · After-market','16:00–20:00 New York time; needs KIS after-market extension on your account; every order waits for your approval')}
    <Row title="Largest extended-session order" hint="Share of the market's equity per order"><NumberField label="Largest extended-session order" min={0.5} max={50} step={0.5} unit="%" disabled={busy} value={config.extendedMaxOrderPct} onChange={v=>edit('extendedMaxOrderPct',v)}/></Row>
    <Note summary="How extended orders work">Orders go out only while a session you switched on is open, and stop 5 minutes before it ends. Korean NXT orders are sent to Nextrade with NXT prices. U.S. daytime orders use KIS's daytime endpoint. KIS's documentation does not confirm how U.S. pre- and after-market orders are handled, so those always wait for your approval. KRX closing-price windows (08:30–08:40, 15:40–16:00) are not traded. Credit (margin and short) orders are regular-session only. KRX ended its after-hours single-price auction on 2026-09-14, so the app no longer offers it.</Note>
  </Card>;
}
// Start with Windows (restart part 1, step 3): applies at once (it is Windows' setting, not a saved engine setting) and
// shows Windows' real state, read each time. The hint says the limit on the row itself.
type LoginItemState={available:boolean;on:boolean;reason?:string;error?:string};
function StartWithWindows(){
  const [state,setState]=useState<LoginItemState|null>(null);const [busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;void window.portfolio?.getLoginItem?.().then(v=>{if(alive&&v)setState(v);}).catch(()=>{});return()=>{alive=false;};},[]);
  const change=async(on:boolean)=>{setBusy(true);try{const v=await window.portfolio?.setLoginItem?.(on);if(v)setState(v);}catch{}finally{setBusy(false);}};
  const hint=state&&!state.available?(state.reason??'Not available.'):'Opens the app when you sign in to Windows. After a restart at night it opens only once you sign in. It starts paused.';
  return <Row title="Start with Windows" hint={state?.error?`${hint} ${state.error}`:hint}><Switch label="Start with Windows" disabled={busy||!state?.available} checked={Boolean(state?.on)} onChange={v=>void change(v)}/></Row>;
}
