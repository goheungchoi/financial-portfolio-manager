'use strict';
// When the nightly history reads may run (note 6, S2): the rules main.cjs wires, kept here so they can be tested.
const {windowOpen}=require('./history-store.cjs');
const {zoned,localDay,usTradingDay}=require('./market-sessions.cjs');
const ACTIVE=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
const UNCLEAR=['Submitting','Uncertain','Cancellation uncertain'];
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// Until when an order can still fill: Korea 20:00 KST of its day (NXT after-market ends). The U.S.: 20:00 New York of the
// first U.S. trading day whose 20:00 comes after the order was made, so an order made in the KIS daytime session
// (after 20:00 New York, dated that New York day) counts until the next session day's after-market ends.
function activeUntil(o){const market=o.market==='US'?'US':'KR';
  if(market==='KR')return o.day?zoned(o.day,'20:00','Asia/Seoul'):Infinity;
  const made=Number.isFinite(o.createdAt)?o.createdAt:o.day?zoned(o.day,'12:00','America/New_York'):null;if(made==null)return Infinity;
  let day=localDay(made,'America/New_York');for(let i=0;i<10;i++,day=addDays(day,1)){const end=zoned(day,'20:00','America/New_York');if(usTradingDay(day)&&end>made)return end;}return Infinity;}
// An app order open, being sent or being cancelled in either market stops the reads: an engine sending (busy), or an order
// Submitting, Uncertain, Cancellation uncertain, Accepted or Partially filled until it can no longer fill (activeUntil;
// one of unclear status counts at least to the end of its own day). A missing engine, or any error reading the orders,
// counts as active.
function makeOrdersActive({engines,today}){return now=>{try{const list=engines();if(!Array.isArray(list)||!list.length||list.some(e=>!e))return true;
  for(const e of list){if(e.busy)return true;
    for(const o of e.orders()??[]){if(!ACTIVE.includes(o?.status))continue;const market=o.market==='US'?'US':'KR';const until=activeUntil(o);
      const dayEnd=o.day?zoned(addDays(o.day,1),'00:00',market==='US'?'America/New_York':'Asia/Seoul'):Infinity;
      if(now<(UNCLEAR.includes(o.status)?Math.max(until,dayEnd):until))return true;}}return false;}catch{return true;}};}
// allowed(now) → {ok, why, outside}. The window is worked out at most once a minute; a throw is "not allowed" and is not
// remembered. The order test runs only when everything else allows a read.
function makeAllowed({closing,scoutOn,connected,sessionsOf,lateWindow,queueBusy,cooldownUntil,ordersActive}){let cacheKey=null,cacheOpen=false;
  const open=now=>{const key=Math.floor(now/60000);if(key===cacheKey)return cacheOpen;let value;try{value=windowOpen(now,{sessionsOf,lateWindow});}catch{return null;}cacheKey=key;cacheOpen=value;return value;};
  return now=>{if(closing())return {ok:false,why:'closing'};if(!scoutOn())return {ok:false,why:'the scout is off'};if(!connected())return {ok:false,why:'not connected'};
    const w=open(now);if(w===null)return {ok:false,why:'the read window could not be worked out'};if(!w)return {ok:false,outside:true,why:'outside the read window'};
    if(queueBusy()||now<(cooldownUntil()??0))return {ok:false,why:'the KIS queue is in use'};
    if(ordersActive(now))return {ok:false,why:'an order of the app is open'};return {ok:true};};}
module.exports={makeOrdersActive,makeAllowed,activeUntil,ACTIVE};
