// The Activity tab's Today strip (artifacts/reviews/2026-11-18-activity-tab, step 3): today's orders by what happened
// to them, and the latest five, from the app's own records only (live_intents of both markets, its reviews and its
// conditional orders), so it shows before KIS answers and costs no KIS request. Orders made outside the app are not
// in these records; they appear in the period list once KIS is read.
const {originOf}=require('./order-origin.cjs');
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
// Why an order did not reach KIS, in words.
const NOT_SENT={'ticket-expired':'the check with KIS expired before it was sent','rate-limit':'the KIS request limit was reached',SESSION_CLOSED:'the market was closed',
  CREDIT_PATH_UNVERIFIED:'its credit path is not verified',INTEGRATED_MARGIN_AUTOMATION_BLOCKED:'automatic U.S. purchases are off (integrated margin not verified)',APPROVAL_REQUIRED:'it needed your approval',SUPERSEDED:'a newer order replaced it',EXPIRED:'it expired unapproved'};
const seoulDay=t=>Number.isFinite(t)?new Date(t+9*3600000).toISOString().slice(0,10):null;
// What happened to one order: {kind, label, reason?}. kind: filled | partly | open | notSent | rejected | waiting | canceled.
function stateOf(o,now=Date.now()){
  const filled=Number(o.filled)||0,qty=Number(o.quantity)||0;
  if(o.status==='Filled'||qty>0&&filled>=qty)return {kind:'filled',label:'Filled'};
  if(o.status==='Rejected'){if(o.reason==='BROKER_REJECTED')return {kind:'rejected',label:'Rejected by KIS'};
    const why=o.reason==='ORDER_NOT_SENT'?NOT_SENT[o.notSentCause]??'it could not be sent':NOT_SENT[o.reason]??String(o.reason??'not sent').toLowerCase().replace(/_/g,' ');return {kind:'notSent',label:'Not sent',reason:why};}
  if(filled>0&&!OPEN.includes(o.status))return {kind:'partly',label:`Partly filled (${filled} of ${qty})`};
  if(OPEN.includes(o.status))return filled>0?{kind:'partly',label:`Partly filled (${filled} of ${qty}), open`}:{kind:'open',label:o.status==='Accepted'?'Open':o.status};
  if(o.status==='Ready'){const expired=Number.isFinite(o.expiresAt)&&o.expiresAt<=now;return expired?{kind:'notSent',label:'Not sent',reason:NOT_SENT[o.reason]??NOT_SENT.EXPIRED}:{kind:'waiting',label:'Waiting for your approval'};}
  if(o.status==='Canceled')return {kind:'canceled',label:'Canceled'};
  return {kind:'open',label:String(o.status??'Unknown')};}
// intents: both markets' live_intents rows; reviews, conditionals: payloads. Returns {day, counts, latest}.
function today({intents=[],reviews=[],conditionals=[],now=Date.now()}={}){
  const day=seoulDay(now);const mine=intents.filter(o=>seoulDay(o.createdAt)===day).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
  const counts={orders:mine.length,sent:0,filled:0,partly:0,open:0,notSent:0,rejected:0,waiting:0,canceled:0};
  const rows=mine.map(o=>{const s=stateOf(o,now);counts[s.kind]++;if(o.brokerOrderId)counts.sent++;return {o,s};});
  const latest=rows.slice(0,5).map(({o,s})=>({id:o.id,at:o.createdAt??null,market:o.market??'KR',symbol:o.symbol,side:o.side,quantity:o.quantity,filled:Number(o.filled)||0,
    state:s.kind,label:s.label,...(s.reason?{reason:s.reason}:{}),origin:originOf(o,{reviews,conditionals}).label}));
  return {day,counts,latest};}
module.exports={today,stateOf,NOT_SENT,seoulDay};
