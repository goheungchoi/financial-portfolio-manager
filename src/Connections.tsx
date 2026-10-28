import {Note} from './Note';
import {Row} from './SettingsUI';
import {useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import type {KisState} from './KisAccount';
import type {RuntimeState,RuntimeReply} from './RuntimeSettings';

const money=(n:number)=>new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(n);
const kisErrors:Record<string,string>={INVALID_CREDENTIAL_FILE:'Check the credential JSON format.',AUTH_FAILED:'Authentication failed. Check your KIS credentials and API access.',RATE_LIMITED:'KIS rate limit reached. Wait before refreshing.',BROKER_REJECTED:'KIS rejected the query. Check account permissions and environment.',INCOMPLETE_BALANCE:'The complete balance could not be retrieved. No partial balance is displayed.',INVALID_RESPONSE:'KIS returned an unexpected response.',REQUEST_FAILED:'The request failed. Check connectivity and retry.',BROKER_UNAVAILABLE:'Broker process unavailable. Import credentials again.',BUSY:'A request is already running.'};

function StatusPill({tone,children}:{tone:'ok'|'warn'|'off'|'error';children:ReactNode}){
  return <span className={`status-pill ${tone}`}><i aria-hidden="true"/>{children}</span>;
}

/** One place for every private connection: the KIS brokerage account and the optional provider keys. */
export function Connections({kis,kisBusy,onImport,onRefresh,onDisconnect,onNavigate}:{kis:KisState;kisBusy:boolean;onImport():void;onRefresh():void;onDisconnect():void;onNavigate(tab:string):void}){
  const [runtime,setRuntime]=useState<RuntimeState|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
  useEffect(()=>{let alive=true,pending=false;const load=async()=>{if(pending)return;pending=true;try{const next=await window.portfolio?.getRuntime();if(alive&&next)setRuntime(next);}catch{if(alive)setMessage('Could not load connection status.');}finally{pending=false;}};void load();const timer=setInterval(load,2000);return()=>{alive=false;clearInterval(timer);};},[]);
  // A reconnect reports how it ended, from the connection's own status: the request returns once it has finished, or,
  // when another connect was already running, the status polled every 2 seconds settles it. A success note clears itself.
  const [reconnecting,setReconnecting]=useState<'kis'|'providers'|'calendar'|null>(null);
  useEffect(()=>{if(!reconnecting||!runtime)return;const file=runtime.connections[reconnecting];if(file.status==='connecting')return;
    const name={kis:'KIS',providers:'AI, news and alert keys',calendar:'Market calendar'}[reconnecting];setReconnecting(null);
    setMessage(file.status==='connected'?`${name} reconnected.`:`${name} could not reconnect${file.error?`: ${String(file.error).replace(/\.$/,'')}`:''}.`);},[reconnecting,runtime]);
  useEffect(()=>{if(!/ reconnected\.$/.test(message))return;const t=setTimeout(()=>setMessage(m=>m===message?'':m),6000);return()=>clearTimeout(t);},[message]);
  const fileAction=async(kind:'kis'|'providers'|'calendar',action:'forget'|'reconnect')=>{const api=window.portfolio;if(!api)return;setBusy(true);setMessage(action==='reconnect'?'Reconnecting…':'');try{const next=action==='reconnect'?await api.reconnectConnection(kind):await api.forgetConnection(kind);setRuntime(next);if(action==='reconnect')setReconnecting(kind);else setMessage('Connection forgotten. It will not reopen at the next launch.');}catch{setMessage(action==='reconnect'?'Could not reconnect.':'Could not forget this connection.');}finally{setBusy(false);}};
  const importProviders=async()=>{const api=window.portfolio;if(!api)return;setBusy(true);setMessage('');try{const reply:RuntimeReply=await api.importProviders();if(reply.state)setRuntime(reply.state);setMessage(reply.ok?'Provider keys imported.':reply.message??reply.error??'Import failed.');}catch{setMessage('Import failed.');}finally{setBusy(false);}};

  const data=kis.snapshot;const kisFile=runtime?.connections.kis;const providerFile=runtime?.connections.providers;const providers=runtime?.providerStatus;
  const kisTone=kis.error?'error':kis.status==='connected'||data?'ok':kis.status==='connecting'?'warn':'off';
  const kisLabel=kis.error?'Needs attention':kis.status==='connecting'?'Connecting…':data?`Connected · ${data.environment.toUpperCase()}`:'Not connected';
  const providerCount=providers?[providers.aiConnected,providers.dartConnected,providers.pushConnected].filter(Boolean).length:0;
  const providerTone=providerFile?.error?'error':providerFile?.status==='connecting'?'warn':providerCount?'ok':'off';
  const holdingsAtKis=data?data.holdings.reduce((sum,row)=>sum+row.marketValue,0):0;
  const kisCash=data?data.reportedTotal-holdingsAtKis:0;const settled=data?.settledCash??null;const unsettled=data?data.cash-(settled??kisCash):0;

  const keyRow=(name:string,loaded:boolean|undefined,missing='Not set',hint?:string)=><Row block title={name} hint={hint}><StatusPill tone={loaded?'ok':'off'}>{loaded?'Loaded':missing}</StatusPill></Row>;
  return <div className="engine-settings">
    {message&&<div role="status" className="notice">{message}</div>}

    <section className="settings-card connection-card" aria-label="KIS brokerage connection">
      <div className="card-head"><div><h2>KIS brokerage</h2><small>Korean and U.S. accounts · read only until you activate trading</small></div><StatusPill tone={kisTone}>{kisLabel}</StatusPill></div>
      <div className="setting-rows">
        {kis.error&&<div role="alert" className="notice error">{kisErrors[kis.error]??'Unable to query the account.'}{data?' The previous snapshot is retained; it may be stale.':''}</div>}
        {kisFile?.error&&!kis.error&&<div role="alert" className="notice error">{kisFile.error}</div>}
        <Row block title="Credential file" hint={kisFile?.name??'None imported'}><button className={data?'':'primary'} disabled={kisBusy} onClick={onImport}>{kisBusy?'Connecting…':data?'Import different credentials':'Import credentials and connect'}</button></Row>
        {data&&<Row block title="Balance" hint={`${money(data.reportedTotal)} reported by KIS · ${data.holdings.length} Korean positions · checked ${new Date(data.timestamp).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'})} KST`}><span className="control-pair"><button disabled={kisBusy||!data} onClick={onRefresh}>Refresh balance</button><button className="link-button" onClick={()=>onNavigate('Holdings')}>View holdings →</button></span></Row>}
        <Row block title="At launch" hint={kisFile?.remembered?'Reconnects automatically':'Stays disconnected'}><span className="control-pair"><button disabled={busy||kisBusy||!kisFile?.remembered||kisFile.status==='connecting'} onClick={()=>void fileAction('kis','reconnect')}>Reconnect</button><button disabled={kisBusy||!data} onClick={onDisconnect} title="End this session. The remembered file still reconnects at the next launch.">Disconnect</button><button className="danger" disabled={busy||!kisFile?.remembered||kisFile.status==='connecting'} onClick={()=>void fileAction('kis','forget')} title="Disconnect and stop reconnecting at launch">Forget &amp; disconnect</button></span></Row>
        {data?<details className="inline-help reconciliation"><summary>Settled cash and why totals differ from Home</summary>
          <table><tbody>
            <tr><td>Korean holdings at KIS prices</td><td>{money(holdingsAtKis)}</td></tr>
            <tr><td>Cash counted by KIS (reported total − holdings)</td><td>{money(kisCash)}</td></tr>
            <tr><th>KIS reported total</th><th>{money(data.reportedTotal)}</th></tr>
            <tr><td>Settled (D+2) cash used by Home</td><td>{settled==null?'Not reported':money(settled)}</td></tr>
            <tr><td>Total deposit balance</td><td>{money(data.cash)}</td></tr>
            <tr><td>Still settling (deposit − settled cash)</td><td className={Math.abs(unsettled)>0?'warning-text':''}>{money(unsettled)}</td></tr>
          </tbody></table>
          <Note summary="Why this can differ from the KIS total">Both KIS and Home value Korean cash at settled (D+2) cash, which already removes money for purchases that have not settled and adds proceeds of unsettled sales. Home can still differ from the KIS total because it prices holdings with streamed quotes, and in “All markets” it adds the U.S. account converted at the displayed exchange rate. A non-zero “still settling” amount means recent trades have not settled yet.</Note>
        </details>:<details className="inline-help" open={!kisFile?.remembered}><summary>Credential file format</summary><pre>{JSON.stringify({environment:'mock',appKey:'YOUR_APP_KEY',appSecret:'YOUR_APP_SECRET',accountNumber:'12345678',accountProductCode:'01'},null,2)}</pre><p className="muted">Use mock or live credentials matching the selected environment. Keep the original file outside this workspace; importing does not remove or protect it.</p></details>}
      </div>
    </section>
    <CalendarKeyCard file={runtime?.connections.calendar} busy={busy} onImport={async()=>{const api=window.portfolio;if(!api)return;setBusy(true);setMessage('');try{const r=await api.importCalendarKey();if(r.state)setRuntime(r.state);if(!r.ok&&r.error)setMessage(r.error);}catch{setMessage('Could not import the calendar key.');}finally{setBusy(false);}}} onAction={action=>void fileAction('calendar',action)}/>

    <section className="settings-card connection-card" aria-label="Provider keys">
      <div className="card-head"><div><h2>AI, news and alert keys</h2><small>Optional · one JSON file</small></div><StatusPill tone={providerTone}>{providerFile?.status==='connecting'?'Loading…':providerCount?`${providerCount} of 3 loaded`:'Not configured'}</StatusPill></div>
      <div className="setting-rows">
        {providerFile?.error&&<div role="alert" className="notice error">{providerFile.error}</div>}
        {keyRow('OpenAI',providers?.aiConnected,'Not set','Turns on AI reviews')}
        {keyRow('Open DART',providers?.dartConnected,'Not set','Korean disclosures')}
        {keyRow('Bank of Korea ECOS',providers?.ecosConnected,'Sample access','Korean macro data')}
        {keyRow('FRED',providers?.fredConnected,'Not set','U.S. release calendar')}
        {keyRow('Mobile webhook',providers?.pushConnected,'Not set','Phone alerts')}
        <Row block title="Provider file" hint={`${providerFile?.name??'None imported'}${providerFile?.remembered?' · reconnects at launch':''}`}><span className="control-pair"><button className={providerCount?'':'primary'} disabled={busy||!runtime} onClick={()=>void importProviders()}>Import provider JSON</button><button disabled={busy||!providerFile?.remembered||providerFile.status==='connecting'} onClick={()=>void fileAction('providers','reconnect')}>Reconnect</button><button className="danger" disabled={busy||!providerFile?.remembered||providerFile.status==='connecting'} onClick={()=>void fileAction('providers','forget')}>Forget &amp; disconnect</button></span></Row>
        <details className="inline-help"><summary>Provider JSON format</summary><pre>{JSON.stringify({openaiApiKey:'OPTIONAL_OPENAI_API_KEY',dartApiKey:'OPTIONAL_OPEN_DART_KEY',ecosApiKey:'OPTIONAL_ECOS_KEY',fredApiKey:'OPTIONAL_FRED_KEY',secContactEmail:'OPTIONAL_CONTACT_FOR_SEC_EDGAR',pushWebhookURL:'https://YOUR_PRIVATE_WEBHOOK'},null,2)}</pre><Note summary="An OpenAI key turns the AI on. Macro keys are optional.">Importing an OpenAI key selects and saves the OpenAI decision provider automatically. Choose the model and budget in Engine settings. Macro data works without keys (FRED downloads and ECOS sample access); an ECOS key removes the sample row limit and a FRED key adds the U.S. release calendar. Both keys are free from ecos.bok.or.kr and fred.stlouisfed.org.</Note></details>
      </div>
    </section>

    <SecCard/>

    <section className="settings-card connection-card" aria-label="External agent bridge">
      <div className="card-head"><div><h2>External agent bridge</h2><small>MCP stdio bridge · paper snapshots and risk-checked proposals only</small></div></div>
      <div className="setting-rows"><details className="inline-help"><summary>Setup command</summary><p className="muted">No KIS credentials, live-account data or live-order tools are exposed. Select “External agent bridge” as the decision provider in Engine settings.</p>{runtime&&<pre>{`node "${runtime.bridgeScript}" "${runtime.bridgePipe}"`}</pre>}</details></div>
    </section>

    <Note summary="How automatic reconnection works">Successful imports remember the file location in your app data, shared across builds. On startup the private brokers reopen those files. Keys are not copied into the database. Trading and scheduled reviews still start paused.</Note>
  </div>;
}

// A live KIS key used only for the official Korean market calendar (holidays); it never reads balances or places orders.
function CalendarKeyCard({file,busy,onImport,onAction}:{file?:{remembered:boolean;name:string|null;status:string;error:string|null};busy:boolean;onImport():void;onAction(action:'forget'|'reconnect'):void}){
  const connected=file?.status==='connected';
  return <section className="settings-card connection-card" aria-label="Market calendar key">
    <div className="card-head"><div><h2>Market calendar</h2><small>Optional · official KRX holidays</small></div><StatusPill tone={connected?'ok':file?.status==='error'?'error':'off'}>{file?.status==='connecting'?'Loading…':connected?'Official calendar':'Weekdays only'}</StatusPill></div>
    <div className="setting-rows">
      {file?.error&&<div role="alert" className="notice error">{file.error}</div>}
      <Row block title="Live key for the calendar" hint={`${file?.name??'None imported'}${file?.remembered?' · reconnects at launch':''}`}><span className="control-pair"><button className={connected?'':'primary'} disabled={busy} onClick={onImport}>Import live key</button><button disabled={busy||!file?.remembered||file.status==='connecting'} onClick={()=>onAction('reconnect')}>Reconnect</button><button className="danger" disabled={busy||!file?.remembered||file.status==='connecting'} onClick={()=>onAction('forget')}>Forget</button></span></Row>
      <Note summary="Used only to read the KRX holiday calendar.">KIS offers its market calendar (국내휴장일조회) only to live keys, so mock accounts otherwise assume every weekday is a trading day. The key runs in its own process that can do one thing: read the calendar once every six hours. It never reads balances, quotes or orders, and trading still uses your connected account.</Note>
    </div>
  </section>;
}

// SEC EDGAR: U.S. company financials, dividends and filings. SEC asks every client to name a contact email,
// which is sent only to sec.gov in the request header.
type SecState={email:string|null;fromFile:boolean;ready:boolean};
const SEC_ERRORS:Record<string,string>={INVALID_EMAIL:'Enter a valid email address.',SEC_RATE_LIMITED:'SEC refused the request (rate limit or contact). Try again in a few minutes.',SEC_UNAVAILABLE:'SEC EDGAR did not respond. Try again later.',SEC_CONTACT_MISSING:'Save a contact email first.',NOT_IN_SEC:'SEC has no filings for the test company.',BROKER_UNAVAILABLE:'The provider process is not running. Reconnect the provider file and try again.'};
function SecCard(){
  const [state,setState]=useState<SecState|null>(null);const [draft,setDraft]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState<{tone:'ok'|'error';text:string}|null>(null);
  useEffect(()=>{window.portfolio?.getSecContact().then(v=>{setState(v);setDraft(v.email??'');}).catch(()=>{});},[]);
  if(!state)return null;
  const save=async(email:string)=>{setBusy(true);setMessage(null);try{const r=await window.portfolio!.setSecContact(email);setState(r.state);if(r.ok){setDraft(r.state.email??'');setMessage({tone:'ok',text:email?'Saved. U.S. company research now loads SEC filings.':'Cleared.'});}else setMessage({tone:'error',text:SEC_ERRORS[r.error]??r.error});}finally{setBusy(false);}};
  const test=async()=>{setBusy(true);setMessage(null);try{const r=await window.portfolio!.testSec();setMessage(r.ok?{tone:'ok',text:`Connected: ${r.name}, ${r.filings} recent filings${r.latestFiscalYear?`, financials through ${r.latestFiscalYear}`:''}.`}:{tone:'error',text:SEC_ERRORS[r.error]??r.error});}finally{setBusy(false);}};
  const source=state.email?'Saved in the app':state.fromFile?'From the provider file':null;
  return <section className="settings-card connection-card" aria-label="SEC EDGAR">
    <div className="card-head"><div><h2>SEC EDGAR</h2><small>Optional · U.S. financials, dividends and filings</small></div><StatusPill tone={state.ready?'ok':'off'}>{state.ready?'On':'Not set'}</StatusPill></div>
    <div className="setting-rows">
      {message&&<div role={message.tone==='error'?'alert':'status'} className={`notice ${message.tone==='error'?'error':''}`}>{message.text}</div>}
      <Row block title="Contact email" hint={source??'SEC asks every app to name a contact. No key or account is needed.'}><span className="control-pair"><input type="email" aria-label="SEC contact email" placeholder="you@example.com" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)}/><button className={state.ready?'':'primary'} disabled={busy||!draft.trim()||draft.trim()===state.email} onClick={()=>void save(draft.trim())}>Save</button><button disabled={busy||!state.ready} onClick={()=>void test()}>Test</button>{state.email&&<button disabled={busy} onClick={()=>void save('')}>Clear</button>}</span></Row>
      <Note summary="Sent only to sec.gov.">SEC EDGAR is free and public, but SEC asks every client to identify itself with a contact email in each request. The app sends it only in requests to sec.gov, never to OpenAI or anyone else. Requests happen when U.S. company research loads (cached), and when you press Test, which reads Apple’s filings.</Note>
    </div>
  </section>;
}

