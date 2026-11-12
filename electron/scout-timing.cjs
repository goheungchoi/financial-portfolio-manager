'use strict';
// Scout timing (step A4, artifacts/reviews/2026-11-12-engine-settings/plan.md and design.md "Scout timing, final").
// Four switches, each tied to a market event; the time of each run comes from the session calendar
// (market-sessions.cjs), so it follows daylight saving and holidays:
// - Before Korea opens: 20 minutes before the KRX regular open (08:40), after the 08:30 market narrative.
// - After Korea opens: scoutAfterOpenMinutes after the open, default 60. Measured on 9 days (A0): the foreign
//   investor-flow list fills at about 09:20 to 09:26 and the institution list always by 62 minutes.
// - Korea midday: 4 hours after the open (13:00, the old midday time).
// - Before the U.S. opens: 30 minutes before the NYSE regular open (23:00 KST in winter, 22:00 in summer).
// A slot belongs to a Seoul calendar day; the U.S. session that opens that Seoul evening has the same date in New
// York. A day without the market's regular session (weekend or holiday) has no slot. Each run focuses its research on
// the slot's market, whatever the clock distance to its session.
const S=require('./market-sessions.cjs');
const SLOTS=[
  {id:'before-kr-open',key:'scoutBeforeKrOpen',label:'Before Korea opens',market:'KR',at:(open,c)=>open-20*60000},
  {id:'after-kr-open',key:'scoutAfterKrOpen',label:'After Korea opens',market:'KR',at:(open,c)=>open+c.scoutAfterOpenMinutes*60000},
  {id:'kr-midday',key:'scoutKrMidday',label:'Korea midday',market:'KR',at:(open,c)=>open+240*60000},
  {id:'before-us-open',key:'scoutBeforeUsOpen',label:'Before the U.S. opens',market:'US',at:(open,c)=>open-30*60000},
];
// The old presets' default ('twice'): after the Korean open and at midday.
const TIMING_DEFAULTS={scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:false,scoutAfterOpenMinutes:60};
// The old clock presets on upgrade. Every old preset had 09:10, which becomes "After Korea opens"; 13:00 becomes
// "Korea midday" and 22:40 (U.S. open) becomes "Before the U.S. opens".
const PRESETS={daily:['scoutAfterKrOpen'],twice:['scoutAfterKrOpen','scoutKrMidday'],'kr-us':['scoutAfterKrOpen','scoutBeforeUsOpen'],three:['scoutAfterKrOpen','scoutKrMidday','scoutBeforeUsOpen']};
const OFFSET={min:10,max:240};
// A scheduled run is skipped when a scout run whose research focus included the slot's market finished within this many
// minutes, unless the slot's market opened in between (its regular session was closed when that run finished and is
// open now). A run that researched other markets never cancels a slot (A4 review F2).
const SKIP_WITHIN_MINUTES=60;
// A slot runs only on time: within this many minutes of its time, or, for a slot whose time lies inside its market's
// regular session (After Korea opens, Korea midday), while that session is still open, with the lateness in the log.
// Any other slot found later (the app was not running) is dropped with a logged reason, so a run never carries a
// market focus or label its time no longer fits (A4 review F1 and its refinement).
const ON_TIME_MINUTES=30;

/** Settings saved before A4 (scoutSchedule, no switches) as switches; null when there is nothing to map. */
function migrate(saved){
  if(!saved||typeof saved!=='object'||!Object.hasOwn(saved,'scoutSchedule'))return null;
  if(SLOTS.some(s=>Object.hasOwn(saved,s.key)))return null;
  const on=PRESETS[saved.scoutSchedule]??PRESETS.twice;
  return Object.fromEntries(SLOTS.map(s=>[s.key,on.includes(s.key)]));
}
function validate(c){
  for(const s of SLOTS)if(typeof c[s.key]!=='boolean')throw new Error('INVALID_SETTINGS');
  if(!Number.isInteger(c.scoutAfterOpenMinutes)||c.scoutAfterOpenMinutes<OFFSET.min||c.scoutAfterOpenMinutes>OFFSET.max)throw new Error('INVALID_SETTINGS');
}
const regularOn=(market,day,opts)=>S.sessionsOn(market,day,market==='KR'?opts:{...opts,closedDays:undefined}).find(x=>x.regular)??null;
const seoulDay=now=>S.localDay(now,'Asia/Seoul');
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const hhmm=t=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t));

/** The switched-on slots of one Seoul day for the given markets, in time order: {id, slot, label, market, at}. */
function slotsOn(config,day,markets,opts={}){
  const out=[];
  for(const s of SLOTS){if(!config[s.key]||!markets.includes(s.market))continue;const regular=regularOn(s.market,day,opts);if(!regular)continue;
    out.push({id:`${day} ${s.id}`,slot:s.id,label:s.label,market:s.market,at:s.at(regular.startAt,config)});}
  return out.sort((a,b)=>a.at-b.at);
}
/** The most recent slot of today (Seoul) whose time has passed, or null. Each is handled once: run on time or dropped. */
function dueSlot(config,markets,now=Date.now(),opts={}){
  const passed=slotsOn(config,seoulDay(now),markets,opts).filter(x=>x.at<=now);return passed.at(-1)??null;
}
/** The next run of each switched-on slot (today or a later day), as "Label HH:MM" in Seoul time, in time order. */
function nextTimes(config,markets,now=Date.now(),opts={}){
  const next=new Map();const today=seoulDay(now);
  for(let i=0;i<10&&next.size<SLOTS.filter(s=>config[s.key]&&markets.includes(s.market)).length;i++)
    for(const x of slotsOn(config,addDays(today,i),markets,opts))if(x.at>now&&!next.has(x.slot))next.set(x.slot,x);
  return [...next.values()].sort((a,b)=>a.at-b.at).map(x=>({slot:x.slot,label:x.label,market:x.market,at:x.at,text:`${x.label} ${hhmm(x.at)}`}));
}
const isOpen=(market,t,opts)=>{const r=[0,-1].map(i=>regularOn(market,S.localDay(t+i*86400000,market==='KR'?'Asia/Seoul':'America/New_York'),opts)).find(Boolean);return Boolean(r&&r.startAt<=t&&t<r.endAt);};
/** The regular session of a market that contains time t, or null. */
const sessionAt=(market,t,opts)=>{const r=regularOn(market,S.localDay(t,market==='KR'?'Asia/Seoul':'America/New_York'),opts);return r&&r.startAt<=t&&t<r.endAt?r:null;};
/**
 * Whether a due slot is on time: {onTime:true} (with note when it runs late inside its open session) or
 * {onTime:false, reason} when it is dropped.
 */
function lateness(slot,now=Date.now(),opts={}){
  const late=Math.round((now-slot.at)/60000);if(late<=ON_TIME_MINUTES)return {onTime:true};
  const session=sessionAt(slot.market,slot.at,opts);
  if(session&&now<session.endAt)return {onTime:true,note:`Due at ${hhmm(slot.at)} KST, run ${late} min late while ${slot.market==='KR'?'Korea':'the U.S.'} is still open`};
  return {onTime:false,reason:`Due at ${hhmm(slot.at)} KST and found ${late} min late (the app was not running then). A scheduled run more than ${ON_TIME_MINUTES} min late is dropped, not run late, unless its time is in its market's session and that session is still open. Dropped "${slot.label}".`};
}
/**
 * Whether a due scheduled run is skipped. last is the latest scout run: {finishedAt, focus} with focus the markets its
 * research covered. Skipped when that run covered the slot's market, finished within SKIP_WITHIN_MINUTES, and the slot's
 * market did not open in between. Returns {skip:false}, possibly with a reason, or {skip:true, reason} for the log.
 */
function skipRule(slot,last,now=Date.now(),opts={}){
  const lastFinishedAt=last?.finishedAt??null;
  if(!lastFinishedAt||now-lastFinishedAt>SKIP_WITHIN_MINUTES*60000)return {skip:false};
  if(!Array.isArray(last.focus)||!last.focus.includes(slot.market))return {skip:false};
  const minutes=Math.max(0,Math.round((now-lastFinishedAt)/60000));const name=slot.market==='KR'?'Korea':'The U.S.';
  if(!isOpen(slot.market,lastFinishedAt,opts)&&isOpen(slot.market,now,opts))return {skip:false,reason:`${name} opened since the last scout run (${minutes} min ago)`};
  return {skip:true,reason:`A scout run that researched ${slot.market==='KR'?'Korea':'the U.S.'} finished at ${hhmm(lastFinishedAt)} KST, ${minutes} min ago, and ${slot.market==='KR'?'Korea':'the U.S.'} has not opened since: no new market data to research. Skipped "${slot.label}".`};
}
module.exports={SLOTS,TIMING_DEFAULTS,PRESETS,OFFSET,SKIP_WITHIN_MINUTES,ON_TIME_MINUTES,lateness,migrate,validate,slotsOn,dueSlot,nextTimes,skipRule,isOpen};
