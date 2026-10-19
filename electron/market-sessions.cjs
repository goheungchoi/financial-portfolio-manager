// Every session of each market on a given day, for display and for the agents: what is open now, what comes next,
// and whether this app can trade it. Times are the exchanges' published hours in their own time zone. The app trades
// regular sessions only; extended sessions are shown for awareness (the mock account accepts none of them).
const {usSession}=require('./kis-overseas.cjs');
const parts=(t,tz)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t)).map(r=>[r.type,r.value]));
const localDay=(t,tz)=>{const p=parts(t,tz);return `${p.year}-${p.month}-${p.day}`;};
// Epoch ms for a local wall time on a local date in a time zone (two passes settle daylight-saving offsets).
function zoned(day,hhmm,tz){const [y,m,d]=day.split('-').map(Number),[hh,mm]=hhmm.split(':').map(Number);let t=Date.UTC(y,m-1,d,hh,mm);
  for(let i=0;i<2;i++){const p=parts(t,tz);const shown=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute));t+=Date.UTC(y,m-1,d,hh,mm)-shown;}return t;}
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const weekday=day=>new Date(day+'T00:00:00Z').getUTCDay();
// Korean trading days: weekdays not closed by the official KIS calendar (or learned closures).
const krTradingDay=(day,closedDays)=>![0,6].includes(weekday(day))&&!closedDays.has(day);
// U.S. trading days and early closes follow the NYSE rules built into usSession (checked against nyse.com for 2026–2027).
const usTradingDay=day=>usSession(new Date(zoned(day,'12:00','America/New_York'))).open;
const usEarlyClose=day=>usTradingDay(day)&&!usSession(new Date(zoned(day,'13:30','America/New_York'))).open;
// tradable: 'app' when the app places orders in it; otherwise the reason it does not.
const KR_SESSIONS=[
  {id:'nxt-pre',label:'NXT pre-market',venue:'Nextrade',start:'08:00',end:'08:50'},
  {id:'krx-pre',label:'KRX pre-open (previous close)',venue:'KRX',start:'08:30',end:'08:40'},
  {id:'krx-regular',label:'KRX regular session',venue:'KRX',start:'09:00',end:'15:30',regular:true,appEnd:'15:20'},
  {id:'krx-post',label:'KRX after close (closing price)',venue:'KRX',start:'15:40',end:'16:00'},
  {id:'krx-single',label:'KRX after-hours single price',venue:'KRX',start:'16:00',end:'18:00'},
  {id:'nxt-after',label:'NXT after-market',venue:'Nextrade',start:'15:30',end:'20:00'}];
const US_SESSIONS=day=>{const early=usEarlyClose(day);return [
  {id:'us-daytime',label:'KIS daytime session',venue:'KIS (Blue Ocean)',startDay:addDays(day,-1),start:'20:00',end:'04:00'},
  {id:'us-pre',label:'Pre-market',venue:'U.S. exchanges',start:'04:00',end:'09:30'},
  {id:'us-regular',label:'Regular session',venue:'NYSE / Nasdaq',start:'09:30',end:early?'13:00':'16:00',regular:true,appEndMinutesBefore:10,early},
  {id:'us-after',label:'After-market',venue:'U.S. exchanges',start:early?'13:00':'16:00',end:early?'17:00':'20:00'}];};
function sessionsOn(market,day,{closedDays=new Set(),environment='mock'}={}){
  const tz=market==='KR'?'Asia/Seoul':'America/New_York';
  if(market==='KR'?!krTradingDay(day,closedDays):!usTradingDay(day))return [];
  return (market==='KR'?KR_SESSIONS:US_SESSIONS(day)).map(s=>{const startAt=zoned(s.startDay??day,s.start,tz),endAt=zoned(day,s.end,tz);
    const appEndAt=s.appEnd?zoned(day,s.appEnd,tz):s.appEndMinutesBefore?endAt-s.appEndMinutesBefore*60000:endAt;
    return {id:s.id,label:s.label,venue:s.venue,day,startAt,endAt,regular:Boolean(s.regular),...(s.early?{earlyClose:true}:{}),
      tradable:s.regular?'app':environment==='mock'?'Not offered on mock accounts':'Not supported by the app yet',...(s.regular?{appEndAt}:{})};});
}
// Status per market: the sessions of the current trading day (the first day with a session not yet over), what is open
// now, and the next session to start, looking ahead across days and holidays.
function marketStatus(market,now=Date.now(),opts={}){
  const tz=market==='KR'?'Asia/Seoul':'America/New_York';const today=localDay(now,tz);
  const all=[];for(let i=-1;i<=10;i++)all.push(...sessionsOn(market,addDays(today,i),opts));all.sort((x,y)=>x.startAt-y.startAt);
  const current=all.find(x=>x.endAt>now);const day=current?.day??today;const sessions=all.filter(x=>x.day===day);
  const open=all.filter(x=>x.startAt<=now&&now<x.endAt).map(x=>x.id);const regular=sessions.find(x=>x.regular);const next=all.find(x=>x.startAt>now)??null;const nextRegular=all.find(x=>x.regular&&x.startAt>now)??null;
  const appTrading=Boolean(regular&&regular.startAt<=now&&now<regular.appEndAt);
  return {market,timeZone:tz,day,sessions,open,appTrading,
    regular:regular?{startAt:regular.startAt,endAt:regular.endAt,appEndAt:regular.appEndAt,earlyClose:Boolean(regular.earlyClose)}:null,next:next?{id:next.id,label:next.label,at:next.startAt}:null,nextRegular:nextRegular?{at:nextRegular.startAt}:null};
}
module.exports={marketStatus,sessionsOn,zoned,localDay,krTradingDay,usTradingDay,usEarlyClose};
