// Trailing stops, step T1: the recorder (artifacts/reviews/2026-11-15-trailing-stops: design.md, t0/note.md, review.md).
// A trailing stop is an armed cash Sell (stop_loss or take_profit) with one condition price("SYM") <= value and a `trail`
// object. Its level follows the price up and never comes down:
//   level = max(floor, previous level, high-based level), the high-based level being high × (1 − pct/100) or
//   high − distance (an ATR multiple fixed in price at arming), rounded down to the tick.
// The level is written into conditions[0].value, so the 5 s check, the re-check in fireConditional and every reader of
// the conditions see the current level; trail.floor keeps the value the AI gave.
// The high moves only on regular-session quotes, and only after two consecutive distinct quotes (by timestamp) are at or
// above it: the candidate is the lower of the two, so a single bad tick never raises the level for good.
// The row is written only when the level or the high-based level moves by a tick, when the trail activates, when the
// exchange day changes, or at most every 5 minutes for watchedAt; never on every 5 s check.
const {krTick}=require('./agent-desk.cjs');
const WATCHED_EVERY_MS=300000;
const MAX_AGE_MS={KR:60000,US:90000};// U.S. quotes are refreshed about once a minute (main.cjs).
const marketOf=symbol=>/:/.test(String(symbol??''))?'US':'KR';
const ZONE={KR:'Asia/Seoul',US:'America/New_York'};
// The exchange's own calendar day, YYYY-MM-DD.
const dayOf=(t,market)=>new Intl.DateTimeFormat('en-CA',{timeZone:ZONE[market],year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const tickOf=(price,market)=>market==='US'?0.01:krTick(price);
// Rounded down to the tick: a sell stop's level is never above its trailing level.
function roundDown(v,market){if(!Number.isFinite(v)||v<=0)return null;if(market==='US')return Math.floor(v*100+1e-7)/100;const t=krTick(v);return Math.floor(v/t+1e-9)*t;}
// The high-based level before the floor, or null while the trail is not active.
function rawLevel(trail,high,market){if(!trail?.active||!(high>0))return null;return roundDown(trail.kind==='atr'?high-trail.distance:high*(1-trail.pct/100),market);}
const stamp=q=>{const t=q?.timestamp??q?.retrievedAt;return typeof t==='number'?t:Date.parse(t??'');};
// A quote that may move the high: positive, fresh, inside the regular session (regular(t) for the quote's time and for
// now), and for the U.S. from the regular venue and not marked stale.
function usable(quote,{market,now,regular}){if(!(quote?.price>0))return false;const ts=stamp(quote);if(!Number.isFinite(ts)||now-ts>MAX_AGE_MS[market]||ts>now+5000)return false;
  if(market==='US'&&((quote.venue??'regular')!=='regular'||quote.stale===true))return false;return Boolean(regular(now)&&regular(ts));}
// A new trail for an order being armed. spec: {pct|null, atrMultiple|null, activateAt|null}; floor: the condition's
// value; price: the current price; atr: ATR(14) in price units when atrMultiple is given; startHigh: where the high
// starts (the fill price for a plan stop; T3), else the price. Validation is the caller's (T2).
// awaitingFill (T3): a plan stop armed with its purchase does not trail until the purchase fills; its high then starts
// at the fill price (startFromFill). catchUpFrom: the first daily bar a catch-up may use: never the arming (or fill)
// day's bar, which holds prices from before the stop existed (review C1).
const nextDay=day=>new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function create(spec,{floor,price,atr=null,atrDate=null,now,market,startHigh=null,awaitingFill=false}){
  const kind=spec.atrMultiple!=null?'atr':'pct',active=!awaitingFill&&spec.activateAt==null,high=active?(startHigh??price):null;
  const distance=kind==='atr'?Math.round(spec.atrMultiple*atr*10000)/10000:null;
  const t={kind,pct:kind==='pct'?spec.pct:null,atrMultiple:kind==='atr'?spec.atrMultiple:null,atr:kind==='atr'?atr:null,atrDate:kind==='atr'?atrDate:null,distance,floor,activateAt:spec.activateAt??null,active,high:active?high:null,highAt:active?now:null,level:floor,watchedDay:dayOf(now,market),watchedAt:now,catchUpFrom:nextDay(dayOf(now,market)),untracked:[],catchUp:null,startedFrom:awaitingFill?'fill':startHigh!=null?'fill':'price',...(awaitingFill?{awaitingFill:true}:{})};
  t.level=Math.max(floor,rawLevel(t,t.high,market)??-Infinity);return t;}
// The linked purchase filled (T3, ruling 4): the trail starts at the fill price, or at the first accepted quote when the
// record has none (high null until then); the fill day's bar never counts in a catch-up.
function startFromFill(order,{fillPrice,now}){const t=order.trail,market=marketOf(order.symbol);const high=fillPrice>0?fillPrice:null;
  const next={...t,awaitingFill:false,active:t.activateAt==null&&high!=null,high:t.activateAt==null?high:null,highAt:t.activateAt==null&&high!=null?now:null,watchedDay:dayOf(now,market),watchedAt:now,catchUpFrom:nextDay(dayOf(now,market)),...(high==null&&t.activateAt==null?{startOnQuote:true}:{})};
  next.level=Math.max(t.level,t.floor,rawLevel(next,next.high,market)??-Infinity);const [c0,...rest]=order.conditions;return {trail:next,conditions:[{...c0,value:next.level},...rest]};}
const fmt=(v,market)=>market==='US'?Number(v).toFixed(2):Math.round(v).toLocaleString('en-US');
const distanceText=(t,market)=>t.kind==='pct'?`${t.pct}%`:`${fmt(t.distance,market)} (${t.atrMultiple} × ATR ${fmt(t.atr,market)})`;
// One tracking step for an armed order with a trail. memory: a Map kept by the caller for this run (order id -> the last
// accepted quote). Returns null (nothing to write) or {patch, events}; events are Journal lines {title, body}.
function step(order,quote,{now,regular,memory}){
  const t=order?.trail;if(!t||t.awaitingFill)return null;const market=marketOf(order.symbol);
  if(!usable(quote,{market,now,regular}))return null;
  // A plan stop whose fill record had no price: the first accepted quote after the fill starts the high (T3).
  if(t.startOnQuote){const {startOnQuote,...rest}=t;const next={...rest,active:true,high:quote.price,highAt:now,highDay:null,watchedAt:now};next.level=Math.max(t.level,t.floor,rawLevel(next,next.high,market)??-Infinity);
    memory.set(order.id,{price:quote.price,at:stamp(quote),best:next.high,bestAt:now});const [c0,...more]=order.conditions;return {patch:{trail:next,conditions:[{...c0,value:next.level},...more]},events:[]};}
  // memory also keeps the run's highest confirmed high (review F1): a high that moves the level by less than a tick is
  // not written at once, but it is written with the next row write, so the stored high is never below a confirmed one.
  const ts=stamp(quote),prev=memory.get(order.id),kept=prev?.best>(t.high??-Infinity)?{high:prev.best,highAt:prev.bestAt}:{high:t.high,highAt:t.highAt};
  memory.set(order.id,{price:quote.price,at:ts,best:kept.high,bestAt:kept.highAt});
  if(!prev||prev.at===ts)return null;// one quote only seeds the memory; the same quote twice is not two checks
  const candidate=Math.min(prev.price,quote.price);const events=[];
  let active=t.active,high=t.active?kept.high:t.high,highAt=t.active?kept.highAt:t.highAt;
  if(!active){if(t.activateAt!=null&&candidate>=t.activateAt){active=true;high=candidate;highAt=now;}}
  else if(!(high>=candidate)){high=candidate;highAt=now;}
  const next={...t,active,high,highAt,...(high!==t.high?{highDay:null}:{})};const raw=rawLevel(next,high,market),before=rawLevel(t,t.high,market);
  const level=Math.max(t.level,t.floor,raw??-Infinity);next.level=level;
  if(active&&!t.active)events.push({title:`Trailing stop active · ${order.symbol}`,body:`${fmt(candidate,market)} reached activateAt ${fmt(t.activateAt,market)}; stop now ${fmt(level,market)}.`});
  const day=dayOf(now,market);if(active)memory.set(order.id,{price:quote.price,at:ts,best:high,bestAt:highAt});
  const moved=level!==t.level||active!==t.active||raw!=null&&raw!==before;
  if(!moved&&day===t.watchedDay&&now-(t.watchedAt??0)<WATCHED_EVERY_MS)return null;
  next.watchedDay=day;next.watchedAt=now;
  const [c0,...rest]=order.conditions;return {patch:{trail:next,conditions:[{...c0,value:level},...rest]},events};}
// The text added to a fired trailing stop's Journal outcome.
function firedText(order){const t=order?.trail;if(!t)return '';const market=marketOf(order.symbol);
  if(!t.active)return ` Trailing: not yet active (activateAt ${fmt(t.activateAt,market)}); stop ${fmt(t.level,market)}, the floor.`;
  return ` Trailing: high ${fmt(t.high,market)} on ${(t.highDay??dayOf(t.highAt,market)).slice(5)}${t.highDay?' (daily high)':''}, trail ${distanceText(t,market)}, stop ${fmt(t.level,market)}.`;}
const ZONE_LABEL={KR:'KST',US:'New York'};
const clock=(t,market)=>`${dayOf(t,market).slice(5)} ${new Intl.DateTimeFormat('en-GB',{timeZone:ZONE[market],hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t))}`;
const span=(from,to,market)=>`${clock(from,market)} to ${clock(to,market)} ${ZONE_LABEL[market]}`;
// The Journal line when a trailing stop is armed (T3; review T2 note 2).
function armedText(order){const t=order.trail,market=marketOf(order.symbol),d=distanceText(t,market),f=fmt(t.floor,market),head=`${order.side} ${order.quantity} (${order.purpose}): `;
  if(t.awaitingFill)return `${head}trails ${d} below the high from the fill of its purchase; floor ${f}; stop ${f} until then.`;
  if(!t.active)return `${head}trails ${d} below the high once ${fmt(t.activateAt,market)} is reached; floor ${f}; stop ${f} until then.`;
  return `${head}trails ${d} below the high from ${fmt(t.high,market)}; floor ${f}; stop now ${fmt(t.level,market)}.`;}
// The catch-up after a gap in tracking (decision 3 A; review C1, D). from: when tracking stopped. bars: the symbol's
// daily bars read fresh for the catch-up ({date, high}), or null when they could not be read. blocked: the reason not to
// catch up (a known split, rights issue or other capital change in the gap), or null. price: the current price, for the
// line. Counted: bars dated on or after watchedDay and on or after catchUpFrom (never the arming or fill day), through
// today. Unreadable bars: no catch-up, nothing guessed, watchedDay kept so a retry in 5 minutes covers the same days.
// Returns {patch, events}.
const RETRY_MS=300000,GAP_MS=120000;
// The first day a catch-up counts. While an earlier catch-up is owed (its bars could not be read), its days stay owed
// from catchUp.from, whatever watchedDay has become since through live tracking or a restart (review T3 F1).
function catchUpStart(t){const own=[t.watchedDay,t.catchUpFrom].filter(Boolean).sort().at(-1)??t.watchedDay;
  return t.catchUp?.status==='unavailable'&&typeof t.catchUp.from==='string'?[t.catchUp.from,own].sort()[0]:own;}
function catchUp(order,bars,{now,from,price=null,blocked=null}){const t=order.trail,market=marketOf(order.symbol),today=dayOf(now,market);
  const untracked=Number.isFinite(from)&&now-from>GAP_MS?[...(t.untracked??[]),{from,to:now}].slice(-3):(t.untracked??[]);
  const start=catchUpStart(t);const level0=fmt(t.level,market),events=[];
  const patch=next=>{const [c0,...rest]=order.conditions;return {patch:{trail:next,conditions:[{...c0,value:next.level},...rest]},events};};
  if(blocked){events.push({title:`Trailing stop not caught up · ${order.symbol}`,body:`${blocked} Daily highs are not applied for this gap; the stop stays at ${level0}.`});
    return patch({...t,untracked,watchedDay:today,watchedAt:now,catchUp:{status:'skipped',reason:blocked,at:now}});}
  if(!Array.isArray(bars))return patch({...t,untracked,catchUp:{status:'unavailable',at:now,retryAt:now+RETRY_MS,from:start}});
  const use=bars.filter(b=>b&&typeof b.date==='string'&&b.date>=start&&b.date<=today&&b.high>0);
  const top=use.reduce((m,b)=>!m||b.high>m.high?b:m,null);let {active,high,highAt,highDay}=t;
  if(top){if(!active){if(t.activateAt!=null&&top.high>=t.activateAt){active=true;high=top.high;highAt=now;highDay=top.date;}}else if(!(high>=top.high)){high=top.high;highAt=now;highDay=top.date;}}
  const next={...t,active,high,highAt,highDay:highDay??null,untracked,watchedDay:today,watchedAt:now,catchUp:{status:'done',from:start,to:today,high:top?.high??null,day:top?.date??null,at:now}};
  next.level=Math.max(t.level,t.floor,rawLevel(next,high,market)??-Infinity);
  if(high!==t.high||active!==t.active){const fires=price>0&&price<=next.level;
    events.push({title:`Trailing stop caught up · ${order.symbol}`,body:`Daily high ${fmt(high,market)} on ${top.date.slice(5)} while the app was not tracking${Number.isFinite(from)?` (${span(from,now,market)})`:''}; stop now ${fmt(next.level,market)}${fires?`, at or above the price ${fmt(price,market)}, so it fires at this check`:''}.`});}
  return patch(next);}
module.exports={catchUpStart,create,step,usable,rawLevel,roundDown,tickOf,dayOf,nextDay,marketOf,firedText,distanceText,armedText,catchUp,startFromFill,span,WATCHED_EVERY_MS,MAX_AGE_MS,RETRY_MS,GAP_MS};
