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
function startNotice({previousStop,stops,wasRunning,now=Date.now()}){
  if(!previousStop)return null;const armed=hasStops(stops);if(!armed&&!wasRunning)return null;
  const how=stopSentence(previousStop,now);
  const message=[how,`The app started and auto trading is paused.${armed?` ${stopsText(stops)}`:''}`,'Open the app and press Start auto trading.'].filter(Boolean).join(' ');
  // Short enough for the Needs you row; the full sentence is the item's detail (tooltip) and the alerts.
  const title=!armed?'Auto trading paused after a restart':stops.count!=null?`Paused: ${stops.count} stop order${stops.count===1?'':'s'} not watched`:'Paused: stop orders not watched';
  return {title,message,how,armedStops:armed?stops.count:0,wasRunning:Boolean(wasRunning),stopKind:previousStop.kind};
}

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
module.exports={stopSentence,startNotice,sessionEndMessage,armedStops};
