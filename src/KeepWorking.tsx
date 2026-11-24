// Orders while stopped, B-4: the setting "Keep them working while auto trading is stopped", in Engine settings →
// Conditional orders. Not part of the settings draft: turning it on is a consent for the connected KIS account and
// environment, given at once with its confirmation (electron/watch-while-stopped.cjs); off takes effect at once.
import {useState} from 'react';
import type {RuntimeState} from './RuntimeSettings';
import {Row,Switch} from './SettingsUI';

export function KeepWorking({state,busy,onState}:{state:RuntimeState;busy:boolean;onState(state:RuntimeState):void}){
  const w=state.desk?.whileStopped;const [asking,setAsking]=useState(false);const [note,setNote]=useState('');const [working,setWorking]=useState(false);
  if(!w||!window.portfolio)return null;
  const env=w.environment==='live'?'live':'mock',on=w.on&&!w.everythingStopped;
  const set=async(value:boolean)=>{setWorking(true);setNote('');try{const reply=await window.portfolio!.setWatchWhileStopped(value,value?`WATCH WHILE STOPPED ${env.toUpperCase()}`:undefined);if(reply.state)onState(reply.state);
      if(reply.ok)setAsking(false);else setNote(reply.error==='KIS_NOT_CONNECTED'?'Connect your KIS account first.':reply.error==='PAPER_SCOPE'?'This is for KIS accounts: choose Korea or U.S. in Trading first.':'Could not change it.');}catch{setNote('Could not reach the engine.');}finally{setWorking(false);}};
  const hint=w.on?(w.everythingStopped?'Stop everything is in force: nothing is watched until you start auto trading or turn this on again.':`On for the ${env} account. Stop everything on Home halts them, and so does closing the app.`):'Off: they are watched only while auto trading runs.';
  return <>
    <Row title="Keep them working while auto trading is stopped" hint={hint}><Switch label="Keep conditional orders working while auto trading is stopped" disabled={busy||working||!on&&(!w.connected||state.config.scope==='paper')} checked={on} onChange={v=>{if(v)setAsking(true);else void set(false);}}/></Row>
    {asking&&<div className="notice" role="dialog" aria-label="Keep conditional orders working while auto trading is stopped">
      <p><b>Keep conditional orders working on the {env} account?</b></p>
      <p>While auto trading is stopped, your armed conditional orders keep working: stops and take-profits may sell your shares, and conditional buys may buy, within your limits. Stop everything halts all of them, and so does closing the app. After the app restarts, they are watched again as soon as KIS connects, without pressing Start.</p>
      {!w.sendsNow&&<p>An order hit while auto trading is stopped will only be proposed and wait for your approval, until you next start auto trading with "Submit them automatically" on.</p>}
      <div className="actions"><button className="primary" disabled={working} onClick={()=>void set(true)}>Turn on</button><button disabled={working} onClick={()=>setAsking(false)}>Cancel</button></div>
    </div>}
    {on&&w.takesEffectAtStart&&<p className="muted small-line">"Submit them automatically" takes effect at the next Start.</p>}
    {note&&<p role="status" className="negative small-line">{note}</p>}
    {(on||asking)&&<details className="inline-help"><summary>More</summary>
      <p className="muted">They work exactly as while auto trading runs: the same checks and limits, and the switches in force when it last ran decide which are sent by themselves; the others wait for your approval.</p>
      <p className="muted">Two ways to halt every order: Stop everything on Home, or closing the app. Nothing is watched while the app is closed.</p>
      <p className="muted">If you stop one market's trading by hand while auto trading runs, that market's armed orders keep being sent by themselves as before; Stop everything halts them.</p>
      <p className="muted">Prices: a stock in the app's price lists is seen within about 30 seconds (Korea) or 60 seconds (U.S.). About 10 stocks outside those lists can be kept current; past that, prices age and Home says so.</p>
      <p className="muted">It is for the KIS account connected when you turn it on; another account or environment turns it off. It goes on after a restart without Start.</p>
      <p className="muted">If another program takes a KIS token with the same key, prices and orders wait about a minute.</p>
      <p className="muted">When the app trades short positions: with Stop everything or the app closed, a short has no stop; only KIS's own forced cover protects it.</p>
    </details>}
  </>;
}
