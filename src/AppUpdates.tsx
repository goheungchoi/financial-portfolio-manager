import {Note} from './Note';
import {useEffect,useState} from 'react';
export type UpdateState={status:'disabled'|'idle'|'checking'|'available'|'up-to-date'|'downloading'|'downloaded'|'error';current:string;available:{version:string;releaseDate:string|null;notes:string|null}|null;progress:number|null;error:string|null;checkedAt:number|null;settings:{checkAutomatically:boolean};blockedReason:string|null};
export type UpdateReply={ok:boolean;error?:string;state:UpdateState};
const BLOCKED:Record<string,string>={AUTO_TRADING_ARMED:'Stop auto trading first; updating restarts the app.',ORDERS_OPEN:'Wait until open broker orders are filled, canceled or reconciled.',REVIEW_RUNNING:'An AI review is running; try again when it finishes.'};
const ERRORS:Record<string,string>={NETWORK_UNAVAILABLE:'Could not reach GitHub. Check the connection.',RELEASE_NOT_FOUND:'No published release was found for this app yet.',CHECKSUM_MISMATCH:'The download did not match its published checksum and was discarded.',SIGNATURE_INVALID:'The download signature did not verify and was discarded.',UPDATE_FAILED:'The update could not be completed.',...BLOCKED};
export function AppUpdates(){
  const [state,setState]=useState<UpdateState|null>(null);const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{const api=window.portfolio;if(!api)return;let alive=true;const off=api.onUpdates(value=>{if(alive)setState(value);});void api.getUpdates().then(reply=>{if(alive)setState(reply.state);}).catch(()=>{});return()=>{alive=false;off();};},[]);
  if(!window.portfolio||!state)return null;
  const act=async(task:()=>Promise<UpdateReply>)=>{setBusy(true);setNotice('');try{const reply=await task();setState(reply.state);if(!reply.ok)setNotice(ERRORS[reply.error??'']??'The request could not be completed.');}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  const s=state;const label=s.status==='disabled'?'Development build':s.status==='checking'?'Checking…':s.status==='available'?`Version ${s.available?.version} available`:s.status==='downloading'?`Downloading ${s.progress??0}%`:s.status==='downloaded'?`Version ${s.available?.version} ready to install`:s.status==='up-to-date'?'Up to date':s.status==='error'?'Last check failed':'Not checked yet';
  return <section aria-label="App updates"><div className="section-head"><div><h2>App updates</h2><small>Version {s.current}{s.checkedAt?` · checked ${new Date(s.checkedAt).toLocaleString()}`:''}</small></div><span className="badge">{label.toUpperCase()}</span></div>
    {s.status==='disabled'?<p className="muted">Updates are available in the installed app. This copy runs from source or a portable folder.</p>:<>
      <div className="actions">
        <button disabled={busy||['checking','downloading'].includes(s.status)} onClick={()=>void act(()=>window.portfolio!.checkForUpdates())}>Check for updates</button>
        {s.status==='available'&&<button className="primary" disabled={busy} onClick={()=>void act(()=>window.portfolio!.downloadUpdate())}>Download {s.available?.version}</button>}
        {s.status==='downloaded'&&<button className="primary" disabled={busy||Boolean(s.blockedReason)} onClick={()=>void act(()=>window.portfolio!.installUpdate())}>Restart and install</button>}
      </div>
      {s.status==='downloaded'&&s.blockedReason&&<p className="notice">{BLOCKED[s.blockedReason]??'Installing is blocked right now.'}</p>}
      {s.status==='error'&&s.error&&<p className="notice error">{ERRORS[s.error]??ERRORS.UPDATE_FAILED}</p>}
      {s.available?.notes&&<details className="inline-help"><summary>Release notes</summary><p>{s.available.notes}</p></details>}
      <label className="inline-check"><input type="checkbox" aria-label="Check for updates automatically" checked={s.settings.checkAutomatically} onChange={e=>void act(()=>window.portfolio!.saveUpdateSettings({checkAutomatically:e.target.checked}))}/>Check for updates automatically (every 6 hours; downloading and installing always wait for you)</label>
      <Note summary="Updates are checksum-verified. Installing restarts the app once trading is idle.">Updates come from this app's GitHub Releases and are verified against the published SHA-512 checksum. Installing restarts the app, so it is blocked while auto trading is armed, a broker order is open or a review is running. Your data and settings are kept.</Note>
    </>}
    {notice&&<p role="status" className="notice">{notice}</p>}
  </section>;
}
