// Local market clock for review scheduling: which markets in the review scope accept orders now, and when the next
// one opens. Korea uses KIS's order window (weekdays 09:00–15:20 Seoul); holidays are learned from KIS session checks.
const {usSession}=require('./kis-overseas.cjs');
const PRE_OPEN_MS=10*60000;
const seoul=t=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t)).map(r=>[r.type,r.value]));return {day:`${p.year}-${p.month}-${p.day}`,weekday:p.weekday,minutes:Number(p.hour)*60+Number(p.minute)};};
function krOpen(t,closedDays){const s=seoul(t);return !['Sat','Sun'].includes(s.weekday)&&!closedDays.has(s.day)&&s.minutes>=540&&s.minutes<920;}
const usOpen=t=>usSession(new Date(t)).open;
const marketsFor=scope=>scope==='kis'?['KR']:scope==='us'?['US']:scope==='both'?['KR','US']:[];
// The next opening minute within a week, found by stepping a minute at a time from the next whole minute.
function nextOpen(market,now,closedDays){const open=market==='KR'?t=>krOpen(t,closedDays):usOpen;let t=Math.ceil(now/60000)*60000;
  if(open(t))return t;
  // Coarse 30-minute steps to the first open slot, then back up to its first minute.
  for(let i=0;i<7*48;i++){t+=1800000;if(open(t)){let s=t;while(open(s-60000))s-=60000;return s;}}return null;}
// {open, markets:[{market,open,nextOpen}], preOpen:{market,at,key}|null, next:{market,at}|null}
function marketHours(scope,now=Date.now(),closedDays=new Set()){
  const markets=marketsFor(scope).map(market=>{const open=market==='KR'?krOpen(now,closedDays):usOpen(now);return {market,open,nextOpen:open?null:nextOpen(market,now,closedDays)};});
  const next=markets.filter(m=>m.nextOpen).sort((a,b)=>a.nextOpen-b.nextOpen)[0]??null;
  const preOpen=next&&next.nextOpen-now<=PRE_OPEN_MS?{market:next.market,at:next.nextOpen-PRE_OPEN_MS,key:`${next.market}:${next.nextOpen}`}:null;
  return {open:!markets.length||markets.some(m=>m.open),markets,preOpen,next:next?{market:next.market,at:next.nextOpen}:null};
}
module.exports={marketHours,marketsFor,krOpen,nextOpen,seoulDay:t=>seoul(t).day,PRE_OPEN_MS};
