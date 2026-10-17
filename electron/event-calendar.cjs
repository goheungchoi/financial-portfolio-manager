// Upcoming events the agents should know before opening positions: macro releases, options expiries,
// and earnings, dividend record dates and shareholder meetings for holdings and watchlist stocks.
const iso=d=>d.toISOString().slice(0,10);
// The nth given weekday (0 = Sunday) of a month, as YYYY-MM-DD.
function nthWeekday(year,month,weekday,n){const first=new Date(Date.UTC(year,month,1));const offset=(weekday-first.getUTCDay()+7)%7;return iso(new Date(Date.UTC(year,month,1+offset+(n-1)*7)));}
// KOSPI 200 options expire on the second Thursday, U.S. monthly options on the third Friday; March, June, September and December add futures.
function expiries(from,to){
  const out=[];const start=new Date(from+'T00:00:00Z');
  for(let i=0;i<3;i++){const y=start.getUTCFullYear(),m=start.getUTCMonth()+i;const yy=y+Math.floor(m/12),mm=m%12;const quarterly=mm%3===2;
    out.push({date:nthWeekday(yy,mm,4,2),kind:'expiry',market:'KR',title:quarterly?'KOSPI 200 futures and options expiry (quarterly)':'KOSPI 200 options expiry'});
    out.push({date:nthWeekday(yy,mm,5,3),kind:'expiry',market:'US',title:quarterly?'U.S. quarterly options and futures expiry':'U.S. monthly options expiry'});}
  return out.filter(e=>e.date>=from&&e.date<=to);
}
// sources(symbol) → {name, earnings, dividends, meetings} from cached research; nothing is fetched here.
function build({today,days=21,macroCalendar=[],symbols=[],sources}){
  const to=iso(new Date(Date.parse(today+'T00:00:00Z')+days*86400000));const events=[...expiries(today,to)];
  for(const row of macroCalendar??[])if(row?.date>=today&&row.date<=to)events.push({date:row.date,kind:'macro',market:row.market??'US',title:row.event});
  for(const s of symbols){const r=sources(s.symbol)??{};const name=r.name??s.name??s.symbol;
    const next=r.earnings?.nextExpected;if(next&&next>=today&&next<=to)events.push({date:next,kind:'earnings',symbol:s.symbol,title:`${name} earnings (estimated)`,estimated:true});
    for(const p of r.dividends?.upcoming??[])if(p.recordDate>=today&&p.recordDate<=to)events.push({date:p.recordDate,kind:'dividend',symbol:s.symbol,title:`${name} dividend record date${p.perShare?` · ${p.perShare.toLocaleString()} KRW`:''}`});
    for(const m of r.meetings??[])if(m.date>=today&&m.date<=to)events.push({date:m.date,kind:'meeting',symbol:s.symbol,title:`${name} shareholder meeting`});}
  const seen=new Set();return events.filter(e=>{const k=e.date+e.title;if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>a.date.localeCompare(b.date)||a.kind.localeCompare(b.kind));
}
module.exports={nthWeekday,expiries,build};
