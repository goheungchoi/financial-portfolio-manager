// The token fix, fifth review: "KIS never took it". The confirmation shows what KIS listed when the order became
// Uncertain (the engine's kisCandidates, up to three) above the sentence, so you decide with the rows in front of you,
// and says when the market's trading is stopped. After it, what was armed again.
// Sixth review: no list (an order made Uncertain by an unclear reply, never checked against KIS's orders, or a record
// of ids only) says the app has not checked; an empty list after a real read keeps "KIS showed no order like it.". A
// row shows only the fields it has.
const STATUS={Filled:'filled','Partially filled':'partly filled',Canceled:'cancelled',Cancelled:'cancelled',Pending:'open',Open:'open',Accepted:'open',Rejected:'rejected'};
const time=(t,market)=>Number.isFinite(t)?new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:market==='US'?'America/New_York':'Asia/Seoul'})+(market==='US'?' New York':''):null;
const rowText=(r,market)=>{const what=[r.side,Number.isFinite(r.quantity)?r.quantity:null,r.symbol].filter(x=>x!=null&&x!=='').join(' ');
  const status=r.status!=null&&r.status!==''?(STATUS[r.status]??String(r.status).toLowerCase()):null;
  return [what||(r.orderId?`order ${r.orderId}`:null),status,time(r.timestamp,market)].filter(Boolean).join(', ');};
// outlook (seventh review): what will hold after the confirmation, decided in the main process (automation
// notTakenOutlook): 'running' no line; 'halted' nothing is sent until Start; 'watched' or anything else (not decided)
// may be sent right away: the line never promises that nothing is sent unless that is what will be true.
export function notTakenEvidence(order,market='KR',outlook='running'){const list=order?.kisCandidates;
  const rows=Array.isArray(list)?list.filter(x=>x&&typeof x==='object'):null;
  // Absent, or a record of ids only (fourth staging): the app did not read KIS's orders for it.
  const read=Array.isArray(list)&&rows.length===list.length;
  const lines=[!read?'The app has not checked KIS for this order. Look in KIS before you confirm.':rows.length?`KIS shows: ${rows.slice(0,3).map(r=>rowText(r,market)).join('; ')}`:'KIS showed no order like it.'];
  const who=market==='US'?'U.S.':'Korean';
  if(outlook==='halted')lines.push(`${who} auto trading is stopped: a stop armed again sends nothing until you press Start.`);
  else if(outlook!=='running')lines.push(`${who} auto trading is stopped, but orders are watched while stopped: a stop armed again may be sent right away.`);
  return lines;}
export function notTakenDone(data){const r=Array.isArray(data?.rearmed)?data.rearmed:[];if(!r.length)return 'Counted as not sent.';
  const what=r.map(o=>`${o.purpose==='stop_loss'?'the stop':'the order'} for ${o.symbol}`).join(', ');
  return `Counted as not sent; ${what} armed again.${data?.halted?` Nothing is sent until you press Start: ${data.market==='US'?'U.S.':'Korean'} auto trading is stopped.`:data?.watched?' It is watched while auto trading is stopped, so it may be sent before you press Start.':''}`;}
