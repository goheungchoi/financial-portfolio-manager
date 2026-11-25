import {useState} from 'react';
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {Card,Row,Switch} from './SettingsUI';
import {PHONE_GUIDE,PHONE_CONFIRM} from './phone-guide.mjs';
type Edit=(key:keyof RuntimeConfig,value:string|number|boolean)=>void;
const PIN_ERRORS:Record<string,string>={PIN_FORMAT:'Use 6 to 12 digits.',PIN_DIFFERENT:'The two PINs differ.',PIN_NOT_SAVED:'The PIN could not be saved.'};
// Phone control (1.6.0, stage P6): the switch (off by default; turned on only through its confirmation, which needs the
// PIN set first; off at once), the PIN (typed twice, set on this PC only, never shown back: the window only learns "set"
// and "locked") and the connection in one line (electron/phone-words.cjs). The setup guide is behind More.
export function PhoneControl({state,config,busy,edit,onState}:{state:RuntimeState;config:RuntimeConfig;busy:boolean;edit:Edit;onState(state:RuntimeState):void}){
  const [asking,setAsking]=useState(false);const [pin,setPin]=useState('');const [again,setAgain]=useState('');const [note,setNote]=useState('');
  const p=state.phone;const on=config.phoneControl===true;const pinSet=p?.pin.set===true,locked=p?.pin.locked===true;
  const savePin=async()=>{setNote('');try{const r=await window.portfolio!.setPhonePin(pin,again);setPin('');setAgain('');if(r.state)onState(r.state);setNote(r.ok?'PIN saved.':PIN_ERRORS[r.error??'']??'The PIN could not be saved.');}catch{setNote('Could not reach the engine.');}};
  const unlock=async()=>{setNote('');try{const r=await window.portfolio!.unlockPhonePin();if(r.state)onState(r.state);setNote(r.ok?'Unlocked.':'Could not unlock.');}catch{setNote('Could not reach the engine.');}};
  return <Card id="eng-phone" title="Phone control" hint="Commands from Discord on your phone.">
    <Row title="Phone control" hint={on&&p?(p.line.tone==='action'?'On. Needs you: see below.':p.line.text):'Off. Off by default.'}><Switch label="Phone control" disabled={busy||asking} checked={on} onChange={v=>v?setAsking(true):edit('phoneControl',false)}/></Row>
    {on&&p?.line.tone==='action'&&<div className="notice error" role="status">{p.line.text}</div>}
    {asking&&<div className="notice" role="dialog" aria-label={PHONE_CONFIRM.title}>
      <p><b>{PHONE_CONFIRM.title}</b></p><p>{PHONE_CONFIRM.body}</p>
      <details className="inline-help"><summary>More</summary><ul>{PHONE_CONFIRM.more.map(t=><li key={t}>{t}</li>)}</ul></details>
      {!pinSet&&<p className="muted">Set a PIN below first.</p>}
      <div className="actions"><button className="primary" disabled={busy||!pinSet} onClick={()=>{edit('phoneControl',true);setAsking(false);}}>Turn on</button><button disabled={busy} onClick={()=>setAsking(false)}>Cancel</button></div>
    </div>}
    <Row block title="PIN" hint={locked?'Locked after 5 wrong entries. Start and the lost-order fixes wait until you unlock.':pinSet?'Set. Needed for Start and the lost-order fixes.':'Not set. 6 to 12 digits, set on this PC only.'}>
      <span className="pin-fields"><input type="password" inputMode="numeric" autoComplete="off" maxLength={12} aria-label={pinSet?'New PIN':'PIN'} placeholder={pinSet?'New PIN':'PIN'} value={pin} disabled={busy} onChange={e=>setPin(e.target.value.replace(/\D/g,''))}/>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} aria-label="PIN again" placeholder="Again" value={again} disabled={busy} onChange={e=>setAgain(e.target.value.replace(/\D/g,''))}/>
        <button disabled={busy||!pin||!again} onClick={()=>void savePin()}>{pinSet?'Change PIN':'Set PIN'}</button>
        {locked&&<button disabled={busy} onClick={()=>void unlock()}>Unlock</button>}</span></Row>
    {note&&<p className="muted" role="status">{note}</p>}
    <details className="inline-help"><summary>More: setup guide</summary><ol>{PHONE_GUIDE.map(t=><li key={t}>{t}</li>)}</ol></details>
  </Card>;
}
