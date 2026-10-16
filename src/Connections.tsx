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
  const fileAction=async(kind:'kis'|'providers',action:'forget'|'reconnect')=>{const api=window.portfolio;if(!api)return;setBusy(true);setMessage('');try{const next=action==='reconnect'?await api.reconnectConnection(kind):await api.forgetConnection(kind);setRuntime(next);setMessage(action==='reconnect'?'Reconnecting…':'Connection forgotten. It will not reopen at the next launch.');}catch{setMessage(action==='reconnect'?'Could not reconnect.':'Could not forget this connection.');}finally{setBusy(false);}};
  const importProviders=async()=>{const api=window.portfolio;if(!api)return;setBusy(true);setMessage('');try{const reply:RuntimeReply=await api.importProviders();if(reply.state)setRuntime(reply.state);setMessage(reply.ok?'Provider keys imported.':reply.message??reply.error??'Import failed.');}catch{setMessage('Import failed.');}finally{setBusy(false);}};

  const data=kis.snapshot;const kisFile=runtime?.connections.kis;const providerFile=runtime?.connections.providers;const providers=runtime?.providerStatus;
  const kisTone=kis.error?'error':kis.status==='connected'||data?'ok':kis.status==='connecting'?'warn':'off';
  const kisLabel=kis.error?'Needs attention':kis.status==='connecting'?'Connecting…':data?`Connected · ${data.environment.toUpperCase()}`:'Not connected';
  const providerCount=providers?[providers.aiConnected,providers.dartConnected,providers.pushConnected].filter(Boolean).length:0;
  const providerTone=providerFile?.error?'error':providerFile?.status==='connecting'?'warn':providerCount?'ok':'off';
  const holdingsAtKis=data?data.holdings.reduce((sum,row)=>sum+row.marketValue,0):0;
  const kisCash=data?data.reportedTotal-holdingsAtKis:0;const settled=data?.settledCash??null;const unsettled=data?data.cash-(settled??kisCash):0;

  return <>
    {message&&<div role="status" className="notice">{message}</div>}

    <section className="connection-card" aria-label="KIS brokerage connection">
      <div className="section-head"><div><h2>KIS brokerage</h2><small>Korea Investment &amp; Securities · Korean and U.S. accounts</small></div><StatusPill tone={kisTone}>{kisLabel}</StatusPill></div>
      <div className="connection-facts">
        <span>Credential file <b>{kisFile?.name??'None imported'}</b></span>
        <span>At launch <b>{kisFile?.remembered?'Reconnects automatically':'Stays disconnected'}</b></span>
        <span>Last balance query <b>{data?new Date(data.timestamp).toLocaleString('en-GB',{timeZone:'Asia/Seoul'})+' KST':'—'}</b></span>
      </div>
      {kis.error&&<div role="alert" className="notice error">{kisErrors[kis.error]??'Unable to query the account.'}{data?' The previous snapshot is retained; it may be stale.':''}</div>}
      {kisFile?.error&&!kis.error&&<div role="alert" className="notice error">{kisFile.error}</div>}
      <div className="actions kis-actions">
        <button className={data?'':'primary'} disabled={kisBusy} onClick={onImport}>{kisBusy?'Connecting…':data?'Import different credentials':'Import credentials and connect'}</button>
        <button disabled={kisBusy||!data} onClick={onRefresh}>Refresh balance</button>
        <button disabled={busy||kisBusy||!kisFile?.remembered||kisFile.status==='connecting'} onClick={()=>void fileAction('kis','reconnect')}>Reconnect</button>
        <span className="action-spacer"/>
        <button disabled={kisBusy||!data} onClick={onDisconnect} title="End this session. The remembered file still reconnects at the next launch.">Disconnect</button>
        <button className="danger" disabled={busy||!kisFile?.remembered||kisFile.status==='connecting'} onClick={()=>void fileAction('kis','forget')} title="Disconnect and stop reconnecting at launch">Forget &amp; disconnect</button>
      </div>
      {data?<>
        <div className="metrics connection-metrics">
          <div><small>KIS reported total · Korea</small><strong>{money(data.reportedTotal)}</strong><span>Broker's own valuation</span></div>
          <div><small>Settled cash (D+2)</small><strong>{settled==null?'—':money(settled)}</strong><span>Deposit {money(data.cash)} · not confirmed buying power</span></div>
          <div><small>Korean positions</small><strong>{data.holdings.length}</strong><button className="link-button" onClick={()=>onNavigate('Holdings')}>View holdings →</button></div>
        </div>
        <details className="inline-help reconciliation"><summary>Why this differs from Combined equity on Overview</summary>
          <table><tbody>
            <tr><td>Korean holdings at KIS prices</td><td>{money(holdingsAtKis)}</td></tr>
            <tr><td>Cash counted by KIS (reported total − holdings)</td><td>{money(kisCash)}</td></tr>
            <tr><th>KIS reported total</th><th>{money(data.reportedTotal)}</th></tr>
            <tr><td>Settled (D+2) cash used by Overview</td><td>{settled==null?'Not reported':money(settled)}</td></tr>
            <tr><td>Total deposit balance</td><td>{money(data.cash)}</td></tr>
            <tr><td>Still settling (deposit − settled cash)</td><td className={Math.abs(unsettled)>0?'warning-text':''}>{money(unsettled)}</td></tr>
          </tbody></table>
          <p className="muted">Both KIS and Overview value Korean cash at settled (D+2) cash, which already removes money for purchases that have not settled and adds proceeds of unsettled sales. Overview can still differ from the KIS total because it prices holdings with streamed quotes, and in “All markets” it adds the U.S. account converted at the displayed exchange rate. A non-zero “still settling” amount means recent trades have not settled yet.</p>
        </details>
      </>:<details className="inline-help" open={!kisFile?.remembered}><summary>Credential file format</summary><pre>{JSON.stringify({environment:'mock',appKey:'YOUR_APP_KEY',appSecret:'YOUR_APP_SECRET',accountNumber:'12345678',accountProductCode:'01'},null,2)}</pre><p className="muted">Use mock or live credentials matching the selected environment. Keep the original file outside this workspace; importing does not remove or protect it.</p></details>}
      <p className="muted small-print">Read only. Keys and access tokens stay in the broker process. Balances refresh every two minutes; connecting alone does not enable trading.</p>
    </section>

    <section className="connection-card" aria-label="Provider keys">
      <div className="section-head"><div><h2>AI, news &amp; alert keys</h2><small>Optional · OpenAI, Open DART and a mobile webhook in one JSON file</small></div><StatusPill tone={providerTone}>{providerFile?.status==='connecting'?'Loading…':providerCount?`${providerCount} of 3 loaded`:'Not configured'}</StatusPill></div>
      <div className="connection-facts">
        <span>OpenAI <b>{providers?.aiConnected?'Key loaded':'Not configured'}</b></span>
        <span>Open DART <b>{providers?.dartConnected?'Key loaded':'Not configured'}</b></span>
        <span>Mobile webhook <b>{providers?.pushConnected?'Configured':'Not configured'}</b></span>
        <span>File <b>{providerFile?.name??'None imported'}{providerFile?.remembered?' · reconnects at launch':''}</b></span>
      </div>
      {providerFile?.error&&<div role="alert" className="notice error">{providerFile.error}</div>}
      <div className="actions kis-actions">
        <button className={providerCount?'':'primary'} disabled={busy||!runtime} onClick={()=>void importProviders()}>Import provider JSON</button>
        <button disabled={busy||!providerFile?.remembered||providerFile.status==='connecting'} onClick={()=>void fileAction('providers','reconnect')}>Reconnect</button>
        <span className="action-spacer"/>
        <button className="danger" disabled={busy||!providerFile?.remembered||providerFile.status==='connecting'} onClick={()=>void fileAction('providers','forget')}>Forget &amp; disconnect</button>
      </div>
      <details className="inline-help"><summary>Provider JSON format</summary><pre>{JSON.stringify({openaiApiKey:'OPTIONAL_OPENAI_API_KEY',dartApiKey:'OPTIONAL_OPEN_DART_KEY',pushWebhookURL:'https://YOUR_PRIVATE_WEBHOOK'},null,2)}</pre><p className="muted">Importing an OpenAI key selects and saves the OpenAI decision provider automatically. Choose the model and budget in Engine settings.</p></details>
    </section>

    <section className="connection-card" aria-label="External agent bridge">
      <div className="section-head"><div><h2>External agent bridge</h2><small>MCP stdio bridge · paper snapshots and risk-checked proposals only</small></div></div>
      <details className="inline-help"><summary>Setup command</summary><p className="muted">No KIS credentials, live-account data or live-order tools are exposed. Select “External agent bridge” as the decision provider in Engine settings.</p>{runtime&&<pre>{`node "${runtime.bridgeScript}" "${runtime.bridgePipe}"`}</pre>}</details>
    </section>

    <details className="inline-help"><summary>How automatic reconnection works</summary><p className="muted">Successful imports remember the file location in your app data, shared across builds. On startup the private brokers reopen those files. Keys are not copied into the database. Trading and scheduled reviews still start paused.</p></details>
  </>;
}
