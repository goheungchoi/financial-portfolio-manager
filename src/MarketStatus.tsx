import {useEffect,useState} from 'react';
// Market sessions at a glance: whether each market's regular session is open, which extended session is running,
// when the next one starts (in Korean time), and which sessions this app can trade.
type Session={id:string;label:string;venue:string;day:string;startAt:number;endAt:number;regular:boolean;earlyClose?:boolean;tradable:string;appEndAt?:number};
type Status={market:'KR'|'US';day:string;sessions:Session[];open:string[];appTrading:boolean;regular:{startAt:number;endAt:number;appEndAt:number;earlyClose:boolean}|null;next:{id:string;label:string;at:number}|null;nextRegular:{at:number}|null};
export type MarketStatusState={at:number;environment:string;KR:Status;US:Status;calendar:{KR:{source:string;days:number;updatedAt:number|null;error:string|null};US:{source:string}}};
const kst=(t:number,withDay=false)=>new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',...(withDay?{weekday:'short'}:{})});
const sameDay=(a:number,b:number)=>new Date(a+9*3600000).toISOString().slice(0,10)===new Date(b+9*3600000).toISOString().slice(0,10);
const NAMES={KR:'Korea',US:'U.S.'};
function headline(s:Status,now:number){
  const reg=s.sessions.find(x=>x.regular);const extended=s.sessions.filter(x=>!x.regular&&s.open.includes(x.id));
  if(reg&&s.open.includes(reg.id))return {tone:'open',title:`Open · regular session until ${kst(reg.endAt)} KST`,sub:s.appTrading?`The app trades until ${kst(reg.appEndAt!)}${reg.earlyClose?' (early close)':''}`:'Past the app’s order cutoff'};
  const nextRegular=s.nextRegular;const opens=nextRegular?`opens ${kst(nextRegular.at,!sameDay(nextRegular.at,now))} KST`:s.next?`next: ${s.next.label} ${kst(s.next.at,true)}`:'';
  return {tone:extended.length?'extended':'closed',title:`${extended.length?'Extended hours':'Closed'} · ${opens}`,sub:extended.length?`Now: ${extended.map(x=>x.label).join(', ')}, not tradable on this account`:'Regular session closed'};
}
export function MarketStatus({markets=['KR','US'],compact=false}:{markets?:('KR'|'US')[];compact?:boolean}){
  const [state,setState]=useState<MarketStatusState|null>(null);const [now,setNow]=useState(Date.now());
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getMarketStatus().then(v=>{if(alive){setState(v);setNow(Date.now());}}).catch(()=>{});void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!state)return null;
  return <section className={`market-status ${compact?'compact':''}`} aria-label="Market status">
    <div className="market-status-head"><h2>Markets</h2><small className="muted">Korean time · the app trades regular sessions</small></div>
    <div className="market-status-grid">{markets.map(m=>{const s=state[m];const h=headline(s,now);const cal=state.calendar[m];
      return <div key={m} className="market-col">
        <div className="market-line"><span className={`market-dot ${h.tone}`} aria-hidden="true"/><b>{NAMES[m]}</b><span className={`market-state ${h.tone}`}>{h.title}</span></div>
        <small className="muted market-sub">{h.sub}</small>
        <details className="market-sessions" open={!compact}><summary>Sessions {sameDay(s.sessions[0]?.startAt??now,now)?'today':`on ${s.day}`}</summary>
          <ul>{s.sessions.map(x=>{const live=s.open.includes(x.id),done=x.endAt<=now;return <li key={x.id} className={live?'live':done?'done':''}>
            <span className="market-time">{kst(x.startAt)}–{kst(x.endAt)}</span><span className="market-label">{x.label}{x.earlyClose?' (early close)':''}</span>
            <span className={`market-tag ${x.tradable==='app'?'tradable':''}`} title={x.tradable==='app'?'The app places orders in this session':x.tradable}>{x.tradable==='app'?'App trades':x.tradable==='Not offered on mock accounts'?'Not on mock':'Not supported'}</span></li>;})}</ul>
          <small className="muted">{m==='KR'?`Holidays: ${cal.source}${'updatedAt' in cal&&cal.updatedAt?`, updated ${new Date(cal.updatedAt).toLocaleString()}`:''}${'error' in cal&&cal.error?' · last refresh failed':''}`:`Holidays: ${cal.source}`}</small>
        </details>
      </div>;})}</div>
  </section>;
}
