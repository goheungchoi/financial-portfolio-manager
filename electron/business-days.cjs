// Business days of a fill's market, for the settlement age rule (settlement simplification S1a,
// artifacts/reviews/2026-11-10-settlement-simplify): a filled order is in flight for at most N business days of its
// market, counted from its trade date; after that it is settled.
// - U.S.: New York dates; weekends and the NYSE holidays (the same rules as kis-overseas.cjs usSession).
// - Korea: Seoul dates; a day in the KIS calendar (kr_calendar) counts when open; a day not in it counts as a business
//   day when it is a weekday.
// Never fewer than N calendar days, which bounds a wrong calendar row.
const SETTLE_DAYS=3;
const DAY=86400000;
const fmt=d=>d.toISOString().slice(0,10);
// NYSE/Nasdaq full-day holidays of a year (observed dates).
function usHolidays(year){
  const nth=(month,weekday,n)=>{const d=new Date(Date.UTC(year,month-1,1));return new Date(Date.UTC(year,month-1,1+(weekday-d.getUTCDay()+7)%7+7*(n-1)));};
  const observed=(y,m,d)=>{const value=new Date(Date.UTC(y,m-1,d));const w=value.getUTCDay();if(w===6)value.setUTCDate(d-1);if(w===0)value.setUTCDate(d+1);return fmt(value);};
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),ed=(h+l-7*m+114)%31+1;
  const goodFriday=new Date(Date.UTC(year,month-1,ed-2));const memorial=new Date(Date.UTC(year,4,31));memorial.setUTCDate(31-(memorial.getUTCDay()+6)%7);
  return new Set([observed(year,1,1),fmt(nth(1,1,3)),fmt(nth(2,1,3)),fmt(goodFriday),fmt(memorial),observed(year,6,19),observed(year,7,4),fmt(nth(9,1,1)),fmt(nth(11,4,4)),observed(year,12,25)]);
}
const ZONE={US:'America/New_York',KR:'Asia/Seoul'};
const FORMAT={US:new Intl.DateTimeFormat('en-CA',{timeZone:ZONE.US}),KR:new Intl.DateTimeFormat('en-CA',{timeZone:ZONE.KR})};
// The market's calendar date of a time (YYYY-MM-DD).
const dateIn=(market,ms)=>FORMAT[market==='US'?'US':'KR'].format(new Date(ms));
const weekday=day=>{const w=new Date(day+'T00:00:00Z').getUTCDay();return w!==0&&w!==6;};
const nextDay=day=>fmt(new Date(Date.parse(day+'T00:00:00Z')+DAY));
// Whether a date is a business day of the market. krOpen(day): true, false, or null/undefined when the KIS calendar
// does not have the day.
function isBusinessDay(market,day,{krOpen=null}={}){
  if(market==='US')return weekday(day)&&!usHolidays(Number(day.slice(0,4))).has(day);
  const known=typeof krOpen==='function'?krOpen(day):null;return known===true||known===false?known:weekday(day);
}
// Business days after the trade date up to and including the given date (the trade date itself does not count).
function businessDaysBetween(market,tradeDay,untilDay,options={}){let n=0;for(let d=nextDay(tradeDay);d<=untilDay;d=nextDay(d))if(isBusinessDay(market,d,options))n++;return n;}
// Settled by age: at least n business days of the market after the trade date, and at least n calendar days.
// fillAt and now are times (ms); tradeDay overrides the fill's market date (a Korean order's recorded day).
function agedOut(market,{fillAt=null,tradeDay=null,now=Date.now(),n=SETTLE_DAYS,krOpen=null}={}){
  const start=typeof tradeDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(tradeDay)?tradeDay:Number.isFinite(fillAt)?dateIn(market,fillAt):null;if(!start)return {aged:false,days:0,tradeDay:null};
  const today=dateIn(market,now);const days=businessDaysBetween(market,start,today,{krOpen});
  const calendar=Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/DAY);
  return {aged:days>=n&&calendar>=n,days,tradeDay:start};
}
module.exports={SETTLE_DAYS,usHolidays,dateIn,isBusinessDay,businessDaysBetween,agedOut};
