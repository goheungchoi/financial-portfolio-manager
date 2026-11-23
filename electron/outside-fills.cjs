'use strict';
// Korean orders KIS lists that the app did not send (orders made in the KIS app or elsewhere), as fills the flow detector
// can explain cash changes with (found in live use: a sale made in the KIS app was recorded as a deposit, though the
// day's KIS order history already held its fill). Each is shaped as the detector reads an order (flow-detector.cjs
// cashEffect): its id, side, fill and its cash effect on the Korean cash the detector reads (KIS's D+2 figure).
// How each kind moves that cash, at the fill:
// - a cash sale (현금매도): + the amount less fees and tax; a cash purchase (현금매수): − the amount and fees;
// - a short sale (유대신규): − fees and tax only (its proceeds never reach cash);
// - its cover (유대상환): + the proceeds of the short it repays (same stock and loan date) less the buy-back and fees.
// Any other kind (margin loans, a name not listed) is left out, so its cash change is still held and recorded for the
// user: a wrong explanation would hide a real deposit or withdrawal, a missing one only asks.
// Fees: the broker's figure for the order once read for its current fill (charges: {"<day>|<number>": {charges, filled}}),
// otherwise the app's estimate. A fill of LARGE_KRW or more waits for the broker's figure, where the estimate's error
// could reach the detection threshold, unless reading it failed for good ({failed:true}): then it is estimated, and the
// fill says so (basis 'estimate-unread'), rather than leaving a silent hold.
// KIS numbers orders from 1 each day, so an order is known by its day and number together (keyOf).
const {norm}=require('./order-chain.cjs');const {estimateCosts}=require('./trading-costs.cjs');
const LARGE_KRW=20000000;
// The kind of a KIS order row by KIS's name for it. A row without a name (recorded before names were kept) is not
// explained: it may be a short sale, a cover or a margin order recorded as a plain sale or purchase.
function kindOf(row){const n=String(row?.creditName??'');if(!n)return null;if(n.includes('유대신규'))return 'short';if(n.includes('유대상환'))return 'cover';if(n.includes('현금'))return 'cash';return null;}
const dayOf=r=>typeof r?.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.day)?r.day:/^(\d{4})(\d{2})(\d{2}):/.test(String(r?.id??''))?String(r.id).replace(/^(\d{4})(\d{2})(\d{2}):.*/,'$1-$2-$3'):null;
const keyOf=(day,orderId)=>`${day}|${norm(orderId)}`;
// The app's own orders in these rows, as day|number: each number an app order was given on its day, and every revision
// linked to one through the original-order number on the same day (as the Activity tab joins them, activity-origin.cjs).
function appOrderIds(rows,intents){const ids=new Set();
  for(const intent of Array.isArray(intents)?intents:[]){if((intent?.market??'KR')!=='KR'||!intent.day)continue;for(const id of [intent.brokerOrderId,...(intent.brokerOrderIds??[])])if(norm(id))ids.add(keyOf(intent.day,id));}
  let grew=true;while(grew){grew=false;for(const r of rows){const d=dayOf(r);if(!d||!norm(r.originalOrderId))continue;const k=keyOf(d,r.orderId);if(!ids.has(k)&&ids.has(keyOf(d,r.originalOrderId))){ids.add(k);grew=true;}}}
  return ids;}
// rows: KIS order rows of the days compared (kis-activity normalizeOrders records, each with its day); intents: the app's
// Korean orders; charges: as above; settings, classify: for the estimate.
// Returns the outside fills, oldest first, each {id, market, side, symbol, filled, fillPrice, status, createdAt (the
// order's time; KIS gives no fill time), resultCosts:{netCash, basis}, outside:{orderId, kind, name, day}}.
function outsideFills(rows,intents,{charges={},settings,classify=()=>null}={}){
  const list=(Array.isArray(rows)?rows:[]).filter(r=>r&&(r.market??'KR')==='KR'&&dayOf(r));const mine=appOrderIds(list,intents);const out=[];
  for(const r of list){const filled=Number(r.filled)||0,gross=Number(r.executionAmount)||0,day=dayOf(r),key=keyOf(day,r.orderId);if(!(filled>0)||!(gross>0)||mine.has(key))continue;
    const kind=kindOf(r);if(!kind)continue;const c=charges[key];const reported=Number.isFinite(c?.charges)&&c.filled===filled?c.charges:null,unread=Boolean(c?.failed);
    // Waiting for KIS's figure: listed so the detector holds the change it makes (never recorded early), not counted yet.
    if(reported==null&&gross>=LARGE_KRW&&!unread){out.push({id:'kis:'+r.id,market:'KR',side:r.side,symbol:r.symbol,filled,status:'Filled',createdAt:r.timestamp,awaitingCharge:true,outside:{orderId:String(r.orderId),kind,name:r.creditName??null,day}});continue;}
    const price=gross/filled;let fees=reported;
    if(fees==null){const side=kind==='short'?'Sell':kind==='cover'?'Buy':r.side;try{const e=estimateCosts({market:'KR',side,quantity:filled,price,symbol:r.symbol,...(settings?{settings}:{}),classification:classify(r.symbol)});fees=side==='Sell'?gross-e.netCash:-e.netCash-gross;}catch{continue;}}
    let netCash;
    if(kind==='cash')netCash=r.side==='Sell'?gross-fees:-(gross+fees);
    else if(kind==='short')netCash=-fees;
    else{const sold=list.filter(s=>s.symbol===r.symbol&&kindOf(s)==='short'&&s.loanDate&&s.loanDate===r.loanDate&&Number(s.filled)>0);
      const shares=sold.reduce((n,s)=>n+Number(s.filled),0),proceeds=sold.reduce((n,s)=>n+Number(s.executionAmount),0);if(!(shares>0))continue;
      netCash=proceeds/shares*filled-gross-fees;}
    out.push({id:'kis:'+r.id,market:'KR',side:r.side,symbol:r.symbol,filled,fillPrice:price,status:'Filled',createdAt:r.timestamp,resultCosts:{netCash:Math.round(netCash),basis:reported!=null?'broker':unread&&gross>=LARGE_KRW?'estimate-unread':'estimate'},
      outside:{orderId:String(r.orderId),kind,name:r.creditName??null,day}});}
  return out.sort((a,b)=>a.createdAt-b.createdAt);}
// Words for one outside fill: "your sale of 1 share of X made outside the app (KIS order 123)".
function describe(f){const n=`${f.filled} share${f.filled===1?'':'s'} of ${f.symbol}`;const what=f.outside.kind==='short'?`short sale of ${n}`:f.outside.kind==='cover'?`cover of ${n}`:f.side==='Sell'?`sale of ${n}`:`purchase of ${n}`;
  return `your ${what} made outside the app (KIS order ${norm(f.outside.orderId)})`;}
module.exports={outsideFills,appOrderIds,kindOf,describe,dayOf,keyOf,LARGE_KRW};
// When Korean orders can fill outside the app's session (lateWindow: a Korean business day, 08:00 to 09:00 and 15:20 to
// 20:10 KST: NXT before the open, the closing auction, after-close and evening orders) and
// the day's last fill time once it has passed (afterLastFill: 20:00 KST that day, or null before it or on a closed day).
const {isBusinessDay}=require('./business-days.cjs');const seoul=t=>new Date(t+9*3600000).toISOString();
function lateWindow(now){const s=seoul(now),hm=Number(s.slice(11,13))*60+Number(s.slice(14,16));return isBusinessDay('KR',s.slice(0,10))&&(hm>=8*60&&hm<9*60||hm>=15*60+20&&hm<20*60+10);}
function afterLastFill(now){const day=seoul(now).slice(0,10),last=Date.parse(day+'T20:00:00+09:00');return isBusinessDay('KR',day)&&now>=last?last:null;}
// Up to when the Korean history is known to be complete: the last read, never later; or, when that read came after the
// day's last fill (20:00 KST) or on a day with no session, until the next session can fill an order (08:00 KST of the
// next business day). ready: today's history and the missed days were read for this account.
function historyThrough({readAt,ready,now=Date.now()}){if(!ready||!Number.isFinite(readAt))return null;const day=seoul(readAt).slice(0,10);
  if(isBusinessDay('KR',day)&&readAt<Date.parse(day+'T20:00:00+09:00'))return readAt;
  let t=Date.parse(day+'T00:00:00Z')+86400000,d=new Date(t).toISOString().slice(0,10);while(!isBusinessDay('KR',d)){t+=86400000;d=new Date(t).toISOString().slice(0,10);}
  return Math.min(now,Date.parse(d+'T08:00:00+09:00'));}
Object.assign(module.exports,{lateWindow,afterLastFill,historyThrough});
