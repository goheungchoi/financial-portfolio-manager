// The Activity period list (artifacts/reviews/2026-11-18-activity-tab, step 4): each KIS row says where its order came
// from, and the orders the app decided but did not send are listed with their reason. KIS rows are joined to the app's
// order records by order number (leading zeros compared away, order-chain.cjs norm), following revisions through the
// original-order number:
// - a row whose number the app created (brokerOrderId, brokerOrderIds): the app order's origin (order-origin.cjs);
// - a revision or cancellation of an app order made outside the app: "Changed outside the app";
// - no app record: "Outside the app", plus KIS's channel for U.S. rows when it gives one.
// Not-sent rows have filled 0 and notSent:true; the totals leave them out (src/activity.mjs).
const {norm}=require('./order-chain.cjs');const {originOf}=require('./order-origin.cjs');const {stateOf}=require('./activity-today.cjs');
const seoulDay=t=>Number.isFinite(t)?new Date(t+9*3600000).toISOString().slice(0,10):null;
// rows: the report's orders; intents: both markets' live_intents; reviews, conditionals: as originOf takes them;
// startDate, endDate: the period (YYYY-MM-DD). Returns the rows with origin (and originDetail), plus not-sent rows.
function labelRows(rows,intents,{reviews=[],conditionals=[],startDate=null,endDate=null,now=Date.now()}={}){
  if(!Array.isArray(rows))return rows;const marks=new Map();
  for(const intent of Array.isArray(intents)?intents:[]){const root=norm(intent?.brokerOrderId);if(!root)continue;const market=intent.market??'KR';
    const own=new Set([root,...(intent.brokerOrderIds??[]).map(norm).filter(Boolean)]);const mine=rows.filter(r=>(r.market??'KR')===market);const byId=new Map(mine.map(r=>[norm(r.orderId),r]));
    const ids=[...own].filter(id=>byId.has(id));if(!ids.length)continue;
    for(let i=0;i<ids.length;i++)for(const r of mine){const id=norm(r.orderId);if(norm(r.originalOrderId)===ids[i]&&!ids.includes(id))ids.push(id);}
    const label=originOf(intent,{reviews,conditionals}).label;
    for(const id of ids)marks.set(byId.get(id),own.has(id)?{origin:label}:{origin:'Changed outside the app',originDetail:`a revision of the app's order (${label})`});}
  const labelled=rows.map(r=>({...r,...(marks.get(r)??{origin:'Outside the app',...(r.channel?{originDetail:`KIS channel: ${r.channel}`}:{})})}));
  const inPeriod=t=>{const d=seoulDay(t);return d&&(!startDate||d>=startDate)&&(!endDate||d<=endDate);};
  const notSent=(Array.isArray(intents)?intents:[]).filter(o=>!o.brokerOrderId&&inPeriod(o.createdAt)).map(o=>({o,s:stateOf(o,now)})).filter(({s})=>s.kind==='notSent').map(({o,s})=>({
    id:'not-sent:'+o.id,orderId:'',originalOrderId:null,symbol:o.symbol,name:o.name??o.symbol,timestamp:o.createdAt,side:o.side,quantity:o.quantity,filled:0,remaining:0,rejected:0,executionAmount:0,averagePrice:0,
    orderPrice:o.limitPrice??0,status:'Not sent',market:o.market??'KR',currency:(o.market??'KR')==='US'?'USD':'KRW',notSent:true,reason:s.reason,origin:originOf(o,{reviews,conditionals}).label}));
  return [...labelled,...notSent].sort((a,b)=>b.timestamp-a.timestamp);}
module.exports={labelRows};
