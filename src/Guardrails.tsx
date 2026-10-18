import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {Card,Row,Limit} from './SettingsUI';
// Stored as 0 when off; turning a limit back on starts from these values.
const ORDER_DEFAULT=10,FAILURE_DEFAULT=3;
const kinds:Record<string,string>={'auto-stopped':'Auto trading stopped','buys-blocked':'Buys blocked','order-limit':'Order limit reached'};
const HOW='Guardrails act on AI decisions and automatic orders, not on orders you approve yourself. Daily loss limits are set per market on the trading pages. The order limit counts automatic orders per Seoul day across markets; later proposals wait for approval. Stopping turns off reviews and automatic orders until you restart.';
export function Guardrails({id,state,config,busy,edit}:{id?:string;state:RuntimeState;config:RuntimeConfig;busy:boolean;edit(key:keyof RuntimeConfig,value:string|number|boolean):void}){
  const g=state.guardrails;
  const status=g?.trippedToday?'Tripped today':config.lossAction==='review'&&!config.maxAutoOrdersPerDay&&!config.maxConsecutiveFailures?'Advisory only':'Active';
  return <Card id={id} title="Guardrails" label="Autopilot guardrails" hint="Hard limits for unattended trading." aside={<span className={`badge ${g?.trippedToday?'warning-badge':''}`} title={HOW}>{status}</span>}>
    <Row title="When a daily loss limit is hit"><select aria-label="Loss-limit response" disabled={busy} value={config.lossAction} onChange={e=>edit('lossAction',e.target.value)}><option value="review">Review more often, keep trading</option><option value="block-buys">Block new AI buys</option><option value="stop">Stop auto trading for the day</option></select></Row>
    <Row title="Automatic orders per day" hint={`${config.maxAutoOrdersPerDay?`Later proposals wait for approval`:'No cap on automatic orders'} · ${g?.autoOrdersToday??0} today`}><Limit label="Automatic orders per day" min={1} max={100} disabled={busy} unlimited={!config.maxAutoOrdersPerDay} value={config.maxAutoOrdersPerDay||ORDER_DEFAULT} onUnlimited={v=>edit('maxAutoOrdersPerDay',v?0:ORDER_DEFAULT)} onValue={v=>edit('maxAutoOrdersPerDay',Math.max(1,v))}/></Row>
    <Row title="Stop after failed reviews in a row" hint={`${config.maxConsecutiveFailures?'Auto trading stops at this many':'Never stops for failed reviews'} · ${g?.failureStreak??0} in a row now`}><Limit label="Stop after consecutive failed reviews" offLabel="Never stop" min={1} max={20} disabled={busy} unlimited={!config.maxConsecutiveFailures} value={config.maxConsecutiveFailures||FAILURE_DEFAULT} onUnlimited={v=>edit('maxConsecutiveFailures',v?0:FAILURE_DEFAULT)} onValue={v=>edit('maxConsecutiveFailures',Math.max(1,v))}/></Row>
    {g?.trippedToday&&<div className="notice error" role="status">A guardrail stopped auto trading today. Positions and accepted broker orders are unchanged.</div>}
    {(g?.events.length??0)>0&&<details className="inline-help"><summary>Recent guardrail events · {g!.events.length}</summary>{g!.events.map(e=><p key={e.id}><b>{kinds[e.kind]??e.kind}</b> · {new Date(e.timestamp).toLocaleString()}<br/><small>{e.detail}</small></p>)}</details>}
  </Card>;
}
