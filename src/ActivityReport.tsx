import {useDraftState} from './useDraftState';
import {useEffect,useRef,useState} from 'react';
import {dailyRealized,executionSummary,seoulDate} from './activity.mjs';
export type OrderRecord={id:string;orderId:string;originalOrderId:string|null;symbol:string;name:string;timestamp:number;side:string;quantity:number;filled:number;remaining:number;rejected:number;executionAmount:number;averagePrice:number;orderPrice:number;status:string;market?:'KR'|'US';currency?:'KRW'|'USD';channel?:string|null;chainOverfill?:boolean;chainId?:string};
export type ProfitRecord={timestamp:number;symbol:string;name:string;realized:number;fee:number|null;tax:number|null};
export type ReportData={source:string;environment:string;startDate:string;endDate:string;retrievedAt:string;usError?:string;orders?:OrderRecord[];records?:ProfitRecord[];summary?:{realized:number;fee:number|null;tax:number|null;returnPct:number|null}};
export type ActivityReply={ok:boolean;error?:string;data?:ReportData};
const money=(value:number|null|undefined,currency='KRW')=>value==null?'Unavailable':new Intl.NumberFormat(currency==='USD'?'en-US':'ko-KR',{style:'currency',currency,maximumFractionDigits:currency==='USD'?2:0}).format(value);
// Totals stay in each currency: KRW and USD are never added together.
const both=(krw:number|null,usd:number|null,hasUS:boolean)=>hasUS?`${money(krw)} · ${money(usd,'USD')}`:money(krw);
// A period total per currency (activity.mjs executionSummary): a side with an amount KIS did not report says so.
type Totals=ReturnType<typeof executionSummary>;
const missingOf=(s:Totals,key:'buy'|'sell'|'grossFlow')=>key==='grossFlow'?s.missing.buy+s.missing.sell:s.missing[key];
const total=(s:Totals,key:'buy'|'sell'|'grossFlow',currency:string)=>s[key]==null?`Not reported for ${missingOf(s,key)} ${missingOf(s,key)===1?'order':'orders'}`:money(s[key],currency);
const pair=(kr:Totals,us:Totals,key:'buy'|'sell'|'grossFlow',hasUS:boolean)=>hasUS?`${total(kr,key,'KRW')} · ${total(us,key,'USD')}`:total(kr,key,'KRW');
const plural=(n:number,one:string)=>`${n} ${one}${n===1?'':'s'}`;
const time=(value:number|string)=>new Date(value).toLocaleString('en-GB',{timeZone:'Asia/Seoul'});
const errors:Record<string,string>={NOT_CONNECTED:'Connect your KIS account first.',BUSY:'An account request is running. Try again shortly.',INVALID_DATE_RANGE:'Choose valid dates within the last 60 days, ending today or earlier.',FEATURE_UNAVAILABLE:'This version supports realized-P&L reports for live accounts only.',INCOMPLETE_HISTORY:'The complete report could not be retrieved. Narrow the date range and retry; no partial report is shown.',BROKER_REJECTED:'KIS rejected the report request. Check account permissions.',RATE_LIMITED:'KIS rate limit reached. Wait before retrying.',AUTH_FAILED:'KIS authentication failed. Reconnect your account.',CONNECTION_CHANGED:'Your connection changed. Load the report again.',INVALID_RESPONSE:'KIS returned an unexpected report format.'};
// Why an automatic refresh did not run (electron/activity-cache.cjs skipReason), in plain words.
const SKIPPED:Record<string,string>={order:'an order is being sent',review:'an AI review is running',account:'another account request is running'};
// A report is fresh for five minutes; an older one, or one of another period, is refreshed on opening.
const FRESH_MS=5*60000;
const hhmm=(iso:string)=>new Date(iso).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
export function ActivityReport({mode,connected,loadReport,loadCached}:{mode:'orders'|'profit';connected:boolean;loadReport(kind:'orders'|'profit',start:string,end:string,options?:{automatic?:boolean}):Promise<ActivityReply>;loadCached?(kind:'orders'|'profit'):Promise<ActivityReply>}) {
  const [start,setStart]=useDraftState('report:'+mode+':start',seoulDate(Date.now()-29*86400000));
  const [end,setEnd]=useDraftState('report:'+mode+':end',seoulDate());
  const [data,setData]=useState<ReportData|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  // One line about the rows on screen when a refresh did not replace them: why, and when they were read.
  const [note,setNote]=useState('');
  const [query,setQuery]=useDraftState('report:'+mode+':query','');
  const [side,setSide]=useDraftState('report:'+mode+':side','All');
  const [status,setStatus]=useDraftState('report:'+mode+':status','All');
  const [executionsOnly,setExecutionsOnly]=useState(false);
  const sequence=useRef(0);
  const shown=useRef<ReportData|null>(null);shown.current=data;
  // Activity step 2: a refresh keeps the rows on screen until new ones arrive; a skipped or failed one keeps them and
  // says why in one line. With nothing on screen, a failure is shown as before.
  async function load(range={start,end},automatic=false) {
    const request=++sequence.current;setBusy(true);setError('');setNote('');
    const keep=(why:string)=>{const d=shown.current;if(d)setNote(`Not refreshed: ${why}. Showing the list read at ${hhmm(d.retrievedAt)}.`);else setError(why.charAt(0).toUpperCase()+why.slice(1)+'.');};
    try {
      const result=await loadReport(mode,range.start,range.end,automatic?{automatic:true}:undefined);
      if(request!==sequence.current)return;
      if(result.ok&&result.data)setData(result.data);
      else if(result.error==='SKIPPED'){const why=SKIPPED[(result as {skipped?:string}).skipped??'']??'the account is busy';if(shown.current)keep(why);else setNote(`Not loaded yet: ${why}. Use Refresh in a moment.`);}
      else{const text=errors[result.error??'']??'The report request failed. Retry or reconnect.';if(shown.current)keep(text.replace(/\.$/,'').replace(/^./,c=>c.toLowerCase()));else setError(text);}
    }catch{if(request===sequence.current){if(shown.current)keep('the request failed');else setError('The report request failed. Retry or reconnect.');}}
    finally{if(request===sequence.current)setBusy(false);}
  }
  // On opening: the last report at once, then a refresh by itself when it is older than five minutes or of another period.
  useEffect(()=>{if(!connected)return;let live=true;(async()=>{let cached:ReportData|null=null;
      try{const r=await loadCached?.(mode);if(r?.ok&&r.data)cached=r.data;}catch{}
      if(!live)return;if(cached){shown.current=cached;setData(cached);}
      const stale=!cached||Date.now()-Date.parse(cached.retrievedAt)>FRESH_MS||cached.startDate!==start||cached.endDate!==end;
      if(stale)void load({start,end},true);})();
    return ()=>{live=false;sequence.current++;};
  // Once per opening: the screen is mounted per tab and connection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // A new period is read at once, as an automatic read (the same skips as on opening); the rows on screen stay, marked as
  // another period, until it arrives. Only the Refresh button is a manual read.
  function changeDate(value:string,isStart:boolean) {
    const range=isStart?{start:value,end}:{start,end:value};if(isStart)setStart(value);else setEnd(value);if(value&&range.start<=range.end)void load(range,true);
  }
  const orders=data?.orders??[];
  const summary=executionSummary(orders);const kr=executionSummary(orders.filter(o=>o.currency!=='USD')),us=executionSummary(orders.filter(o=>o.currency==='USD')),hasUS=orders.some(o=>o.currency==='USD');
  const visible=orders.filter(order=>(side==='All'||order.side===side)&&(status==='All'||order.status===status)&&(!executionsOnly||order.filled>0)&&`${order.name} ${order.symbol} ${order.orderId}`.toLowerCase().includes(query.toLowerCase()));
  const days=dailyRealized(data?.records??[]);
  const max=Math.max(1,...days.map(day=>Math.abs(day.realized)));
  return <><section><div className="section-head"><h2>{mode==='orders'?'Orders and execution summaries':'Realized performance'}</h2><span className="badge">READ ONLY</span></div><div className="report-toolbar"><label>From<input aria-label="Report start date" type="date" min={seoulDate(Date.now()-60*86400000)} max={end} value={start} disabled={busy} onChange={e=>changeDate(e.target.value,true)}/></label><label>Through<input aria-label="Report end date" type="date" min={start} max={seoulDate()} value={end} disabled={busy} onChange={e=>changeDate(e.target.value,false)}/></label><button className="primary" disabled={busy||!connected||!start||!end} onClick={()=>void load()}>{busy?'Refreshing…':'Refresh'}</button></div>{!connected&&<p>Connect KIS to see order history.</p>}{error&&<div role="alert" className="notice error">{error}</div>}{note&&<p className="muted small-line" role="status" aria-label="Refresh status">{note}</p>}{data&&<p className="muted" aria-label="Report period">KIS {data.environment.toUpperCase()} · {data.startDate} through {data.endDate} · Updated {time(data.retrievedAt)} KST{(data.startDate!==start||data.endDate!==end)?' · another period than the dates above':''}</p>}<p className="muted">{mode==='orders'?'Records show order time and cumulative executed quantity/amount per order, not individual execution times. Orders may originate outside this app; their manual/AI origin is unknown.':'Broker-reported realized P&L, not total portfolio return. Fees and taxes are shown separately without subtracting them again. Deposits, withdrawals, dividends and unrealized changes are excluded from this report.'}</p></section>
  {data&&mode==='orders'&&<><div className="metrics"><section><small>Gross purchases</small><strong className={hasUS?'small-metric':''}>{pair(kr,us,'buy',hasUS)}</strong><span>Reported execution amounts</span></section><section><small>Gross sales</small><strong className={hasUS?'small-metric':''}>{pair(kr,us,'sell',hasUS)}</strong><span>Reported execution amounts</span></section><section><small>Sales minus purchases</small><strong className={hasUS?'small-metric':''}>{pair(kr,us,'grossFlow',hasUS)}</strong><span>Gross trading cash flow · not profit</span></section></div>{(summary.corrected>0||summary.excluded>0)&&<p className="muted small-line" aria-label="Corrected orders">{[summary.corrected>0?`Includes ${plural(summary.corrected,'corrected order')}.`:'',summary.excluded>0?`${plural(summary.excluded,'corrected order')} not included: KIS reports more filled shares than the order had.`:''].filter(Boolean).join(' ')}</p>}<section><div className="report-toolbar"><button aria-pressed={!executionsOnly} onClick={()=>setExecutionsOnly(false)}>Orders ({orders.length})</button><button aria-pressed={executionsOnly} onClick={()=>setExecutionsOnly(true)}>Execution totals ({summary.executedOrders})</button><input aria-label="Search orders" placeholder="Company, symbol, or order number" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Order side" value={side} onChange={e=>setSide(e.target.value)}>{['All','Buy','Sell'].map(value=><option key={value}>{value}</option>)}</select><select aria-label="Order status" value={status} onChange={e=>setStatus(e.target.value)}>{['All',...new Set(orders.map(order=>order.status))].map(value=><option key={value}>{value}</option>)}</select></div><div className="table-scroll"><table><thead><tr>{['Order / company','Order time (KST)','Side / status','Ordered / executed','Remaining','Average execution','Executed amount'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{visible.map(order=><tr key={order.id}><td><b>{order.name}</b><small>{order.market==='US'?'U.S. · ':''}{order.symbol} · #{order.orderId}{order.originalOrderId?` · Original #${order.originalOrderId}`:''}</small></td><td>{time(order.timestamp)}</td><td>{order.side}<small>{order.status}</small></td><td>{order.quantity} / {order.filled}</td><td>{order.remaining}</td><td>{order.filled?money(order.averagePrice,order.currency):'—'}</td><td>{money(order.executionAmount,order.currency)}</td></tr>)}</tbody></table></div>{!visible.length&&<p>No matching order records in this period.</p>}{data.usError&&<p className="notice">U.S. orders could not be loaded ({data.usError}); Korean orders are shown.</p>}</section></>}
  {data&&mode==='profit'&&<><div className="metrics"><section><small>KIS realized P&L</small><strong>{money(data.summary?.realized)}</strong><span>Broker-reported period total</span></section><section><small>KIS fees / taxes</small><strong className="small-metric">{money(data.summary?.fee)} / {money(data.summary?.tax)}</strong><span>Not deducted again</span></section><section><small>KIS reported return</small><strong>{data.summary?.returnPct==null?'Unavailable':`${data.summary.returnPct.toFixed(2)}%`}</strong><span>Broker trade-report basis</span></section></div><section><h2>Daily reported realized P&L</h2>{days.length?<svg className="realized-chart" viewBox="0 0 900 280" role="img" aria-label="Daily realized profit and loss"><line x1="30" x2="870" y1="130" y2="130" className="grid-line"/>{days.map((day,index)=>{const step=820/days.length;const height=Math.abs(day.realized)/max*95;return <g key={day.timestamp}><rect x={35+index*step} y={day.realized>=0?130-height:130} width={Math.min(24,step*.7)} height={height||1} fill={day.realized>=0?'var(--accent)':'#d96c6c'}/><title>{time(day.timestamp)} · {money(day.realized)}</title></g>;})}<text x="30" y="260">{seoulDate(days[0].timestamp)}</text><text x="735" y="260">{seoulDate(days.at(-1)!.timestamp)}</text></svg>:<p>No realized-P&L records in this period.</p>}<p className="muted">Bars sum returned report rows by trading date. Days without records are omitted. Full portfolio returns require equity and external cash-flow history.</p><div className="table-scroll"><table><thead><tr>{['Trade date (KST)','Company','Realized P&L','Fees','Taxes'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{data.records?.map((record,index)=><tr key={`${record.timestamp}:${record.symbol}:${index}`}><td>{seoulDate(record.timestamp)}</td><td>{record.name}<small>{record.symbol}</small></td><td>{money(record.realized)}</td><td>{money(record.fee)}</td><td>{money(record.tax)}</td></tr>)}</tbody></table></div></section></>}
  </>;
}
