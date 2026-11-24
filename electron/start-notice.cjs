'use strict';
// The start notice (restart part 1, step 2; artifacts/reviews/2026-11-12-restart): on a start after the app stopped, if
// stop orders are armed or auto trading was running, the app says that auto trading is paused, how many stop orders
// are not being watched, and how it last stopped. Also the best-effort phone message when Windows ends the session.

const kst=(ms,now)=>{const d=new Date(ms),n=new Date(now);const day=x=>x.toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});
  const time=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
  return day(d)===day(n)?time:`${d.toLocaleDateString('en-GB',{month:'short',day:'numeric',timeZone:'Asia/Seoul'})}, ${time}`;};

/** How the app last stopped, as one sentence, or null when it is not known (a first start). */
function stopSentence(stop,now=Date.now()){
  if(!stop)return null;const at=Number.isFinite(stop.at)?`${stop.timeUncertain?'about ':''}${kst(stop.at,now)}`:null;
  if(stop.kind==='windows-shutdown')return at?`The app was closed by a Windows restart or shutdown at ${at}.`:'The app was closed by a Windows restart or shutdown.';
  if(stop.kind==='unexpected')return at?`The app stopped unexpectedly after ${at}.`:'The app stopped unexpectedly.';
  // "Closed", not "you closed it": a session end that sent no word may also end in a normal quit (step 1 report).
  return at?`The app was closed at ${at}.`:'The app was closed.';
}

// stops: {count, any} from armedStops(): count is the watched account's armed, unexpired stop-loss orders, or null when
// that account is not known; any says whether there are such stops at all (then the text has no number).
const stopsText=stops=>stops.count!=null?`${stops.count} stop order${stops.count===1?' is':'s are'} not being watched.`:'Stop orders are not being watched.';
const hasStops=stops=>Boolean(stops&&(stops.count!=null?stops.count>0:stops.any));

/**
 * The notice for this start, or null: none on a first start (no record of a previous run), and none when no stop order
 * is armed and auto trading was not running.
 * @param {{previousStop:{kind:string,at:number|null,timeUncertain?:boolean}|null,stops:{count:number|null,any:boolean},wasRunning:boolean,now?:number}} input
 */
// trailing (trailing stops T3, review B): the watched account's armed trailing stops, counted only while Engine settings
// allow them (switched off they are fixed stops and do not catch up). On Start each catches up from the daily highs of
// the time the app was closed, so one may sell at once: the notice says so before the user presses Start.
const trailingText=n=>`${n} trailing stop${n===1?'':'s'} will catch up from daily highs when you press Start, and ${n===1?'it':'one'} may sell at once if its new level is at or above the price.`;
// watched (orders while stopped, B-4): the setting is on, so armed orders are watched once KIS connects, with no Start.
function startNotice({previousStop,stops,wasRunning,trailing=0,watched=false,now=Date.now()}){
  if(!previousStop)return null;const armed=hasStops(stops)||trailing>0;if(!armed&&!wasRunning)return null;
  const how=stopSentence(previousStop,now);
  if(watched&&armed){const n=stops.count;const what=n!=null?`${n} stop order${n===1?' is':'s are'} watched`:'Your stop orders are watched';
    return {title:n!=null?`Paused: ${n} stop order${n===1?'':'s'} watched`:'Paused: stop orders watched',message:[how,`The app started and auto trading is paused. ${what} once KIS connects, with your other armed orders.`,'Press Start auto trading to resume reviews.'].filter(Boolean).join(' '),how,armedStops:hasStops(stops)?stops.count:0,...(trailing>0?{trailingStops:trailing}:{}),wasRunning:Boolean(wasRunning),stopKind:previousStop.kind,watched:true};}
  const message=[how,`The app started and auto trading is paused.${hasStops(stops)?` ${stopsText(stops)}`:''}`,trailing>0?trailingText(trailing):null,'Open the app and press Start auto trading.'].filter(Boolean).join(' ');
  // Short enough for the Needs you row; the full sentence is the item's detail (tooltip) and the alerts.
  const title=!armed?'Auto trading paused after a restart':stops.count!=null?`Paused: ${stops.count} stop order${stops.count===1?'':'s'} not watched`:'Paused: stop orders not watched';
  return {title,message,how,armedStops:hasStops(stops)?stops.count:0,...(trailing>0?{trailingStops:trailing}:{}),wasRunning:Boolean(wasRunning),stopKind:previousStop.kind};
}

/**
 * The notice as it stands now (found in live use on 1.5.74: the setting turned on after a stopped start left "not
 * watched" on Home beside "still watched"): the launch facts (base: previousStop, wasRunning) with the present stops and
 * watch state, so it always agrees with what the app does. Null without a launch notice, or when nothing is left to say.
 */
function currentNotice(base,{stops,trailing=0,watched=false,now=Date.now()}){if(!base?.previousStop)return null;return startNotice({previousStop:base.previousStop,wasRunning:Boolean(base.wasRunning),stops,trailing:watched?0:trailing,watched,now});}
/**
 * Once KIS is connected, with the setting on (review of the start-notice fix): what a hit stop does in each market, from
 * the engine's permit as it holds now. markets: [{market:'KR'|'US', stops:n, state:'sent'|'proposed'|'not'}] for the
 * markets with armed stops. 'sent': the permit holds with auto (sent by itself); 'proposed': it holds without (only
 * proposed for your approval until the next Start); 'not': no permit (another account, an unclear order, Stop everything,
 * or a market its record does not allow). All 'not': the not-watched notice. Null without a launch notice.
 */
// An engine's permit as it holds now: 'not' (none, or for another account), 'sent' (auto), 'proposed' (without auto).
function permitState(e){let holds=false;try{holds=Boolean(e?.permitHolds?.());}catch{holds=false;}return !holds?'not':e.conditionalPermit?.auto===true?'sent':'proposed';}
const where=m=>m==='US'?'the U.S.':'Korea',tab=m=>m==='US'?'the U.S. tab':'the Korea tab';
const orders=n=>`${n} stop order${n===1?'':'s'}`,isAre=n=>n===1?'is':'are';
function connectedNotice(base,{markets,now=Date.now()}){if(!base?.previousStop)return null;const ms=(markets??[]).filter(m=>m.stops>0);
  if(!ms.length||ms.every(m=>m.state==='not'))return currentNotice(base,{stops:{count:ms.reduce((s,m)=>s+m.stops,0),any:ms.length>0},watched:false,now});
  const how=stopSentence(base.previousStop,now);const total=ms.reduce((s,m)=>s+m.stops,0),states=new Set(ms.map(m=>m.state));const one=ms.length===1;
  const line=m=>m.state==='sent'?`${orders(m.stops)}${one?'':` in ${where(m.market)}`} ${isAre(m.stops)} watched and sent by ${m.stops===1?'itself':'themselves'} if hit.`
    :m.state==='proposed'?`${orders(m.stops)}${one?'':` in ${where(m.market)}`} ${isAre(m.stops)} watched, but a hit stop is only proposed: it sells nothing until you approve it on ${tab(m.market)}. "Submit them automatically" takes effect at the next Start.`
    :`${orders(m.stops)}${one?'':` in ${where(m.market)}`} ${isAre(m.stops)} not being watched now.`;
  const title=states.size===1?(states.has('sent')?`Paused: ${orders(total)} watched`:`Paused: ${orders(total)} watched, proposed only`):'Paused: stop orders partly watched';
  const message=[how,'The app started and auto trading is paused.',...ms.map(line),'Press Start auto trading to resume reviews.'].filter(Boolean).join(' ');
  return {title,message,how,armedStops:total,wasRunning:Boolean(base.wasRunning),stopKind:base.previousStop.kind,markets:ms.map(m=>({market:m.market,stops:m.stops,state:m.state}))};}
/** The phone message when Windows ends the session, or null when there is nothing to warn about. */
function sessionEndMessage({stops,running}){
  const armed=hasStops(stops);if(!armed&&!running)return null;
  const what=!armed?'Auto trading stops until you open it again and press Start.':stops.count!=null?`${stops.count} stop order${stops.count===1?'':'s'} will not be watched until you open it again.`:'Stop orders will not be watched until you open it again.';
  return `Windows is closing the app (restart or shutdown). ${what}`;
}

/**
 * Armed stop-loss orders that have not expired, read straight from the table (expiry is applied lazily per scope, so a
 * stop past its expiry can still be marked armed). With the account scope known (the one being watched, or the one the
 * last run watched): its count. Unknown: count null, and any = whether such stops exist in any account scope (not paper).
 * Never throws: an unreadable table gives {count:null, any:false}.
 */
function armedStops(db,{scope=null,now=Date.now()}={}){
  try{const rows=db.prepare("SELECT scope,payload FROM conditional_orders WHERE status='armed'").all();
    const live=rows.map(r=>{try{return {scope:String(r.scope),o:JSON.parse(r.payload)};}catch{return null;}}).filter(r=>r&&r.o?.purpose==='stop_loss'&&Number(r.o.expiresAt)>now);
    const known=typeof scope==='string'&&scope.includes(':')&&!scope.endsWith(':disconnected');
    if(known){const count=live.filter(r=>r.scope===scope).length;return {count,any:count>0};}
    return {count:null,any:live.some(r=>r.scope!=='paper'&&!r.scope.startsWith('paper:'))};}catch{return {count:null,any:false};}
}
// The watched account's armed, unexpired stop-loss orders per market ({KR, US}); zeros when the account is not known.
function armedStopsByMarket(db,{scope=null,now=Date.now()}={}){const out={KR:0,US:0};try{if(typeof scope!=='string'||!scope.includes(':')||scope.endsWith(':disconnected'))return out;
  for(const r of db.prepare("SELECT payload FROM conditional_orders WHERE status='armed' AND scope=?").all(scope)){let o=null;try{o=JSON.parse(r.payload);}catch{}if(o?.purpose==='stop_loss'&&Number(o.expiresAt)>now)out[String(o.symbol).includes(':')?'US':'KR']++;}}catch{}return out;}
// Armed, unexpired trailing stops (stop_loss or take_profit with a trail) of the watched account; 0 when it is not known.
function armedTrailing(db,{scope=null,now=Date.now()}={}){try{if(typeof scope!=='string'||!scope.includes(':'))return 0;return db.prepare("SELECT payload FROM conditional_orders WHERE status='armed' AND scope=?").all(scope).map(r=>{try{return JSON.parse(r.payload);}catch{return null;}}).filter(o=>o?.trail&&Number(o.expiresAt)>now).length;}catch{return 0;}}
module.exports={stopSentence,startNotice,currentNotice,connectedNotice,permitState,sessionEndMessage,armedStops,armedStopsByMarket,armedTrailing};
