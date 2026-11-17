// Item 9 (artifacts/reviews/2026-11-17-deposit-detection/design-note.md, cleared; R3, R6): the Home "Needs you" line for
// a cash change the flow detector holds. It is not counted as a return while held. One item per market, or one for both
// when a Korean and a U.S. change point opposite ways (they may be an exchange, which is not yours to record), and none
// to record for a change an open order may explain (most likely its fill).
// pending: FlowDetector.pending(account) rows {market, amount, since (ISO), usBalanceUnseen?, holdReason?, couldBeFill?}.
const {seoulDate}=require('./kis-activity.cjs');
const money=(market,amount)=>market==='US'?`$${Math.abs(amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:`₩${Math.abs(Math.round(amount)).toLocaleString('en-US')}`;
const label=market=>market==='US'?'U.S.':'Korean';
// "seen 14:02" today in Seoul; "seen 11-16 12:07" for a change first seen on an earlier day (held up to 4 days).
const seen=(iso,now)=>{const t=Date.parse(iso),time=new Date(t).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'}),day=seoulDate(t);return day===seoulDate(now)?time:`${day.slice(5)} ${time}`;};
// The amount for the form: whole won, or dollars rounded to cents (the money field takes two decimals at most).
const formAmount=(market,amount)=>market==='US'?String(Math.round(Math.abs(amount)*100)/100):String(Math.abs(Math.round(amount)));
const DETAIL='The app is checking whether a trade, a settlement or an exchange explains it. Until then it is not counted as a return. If it is your deposit or withdrawal, record it.';
function attentionItems(pending,now=Date.now()){const rows=(pending??[]).filter(p=>p&&Number.isFinite(p.amount)&&p.amount!==0);if(!rows.length)return [];
  const kr=rows.find(p=>p.market==='KR'),us=rows.find(p=>p.market==='US');
  const extra=p=>`${p.usBalanceUnseen?' · U.S. balance not compared yet':''}${p.holdReason?` · held 2 h: ${p.holdReason}`:''}`;
  if(kr&&us&&Math.sign(kr.amount)!==Math.sign(us.amount)){const first=[kr,us].sort((a,b)=>Date.parse(a.since)-Date.parse(b.since))[0];
    return [{id:'cash-check-both',tone:'info',title:`Korean cash ${kr.amount>0?'up':'down'} ${money('KR',kr.amount)} and U.S. cash ${us.amount>0?'up':'down'} ${money('US',us.amount)}, seen ${seen(first.since,now)} · checking; may be an exchange${extra(kr)}`,
      detail:'The app is checking whether this is money moving between your Korean and U.S. accounts. Until then neither change is counted as a return.',tab:'Performance',action:'Open Performance'}];}
  return rows.map(p=>{const head=`${label(p.market)} cash ${p.amount>0?'up':'down'} ${money(p.market,p.amount)}, seen ${seen(p.since,now)}`;
    // F1 (planner): an open order may explain it (most likely its fill): nothing to record.
    if(p.couldBeFill)return {id:'cash-check-'+p.market,tone:'info',title:`${head} · checking; an open order may explain it`,detail:'An open order in this account could explain this change when its fill is counted. The app waits for the order before deciding.',tab:'Performance',action:'Open Performance'};
    return {id:'cash-check-'+p.market,tone:'info',title:`${head} · checking; not a ${p.amount>0?'return':'loss'} yet${extra(p)}`,
      detail:DETAIL,tab:'Performance',action:'Record it',draft:{key:'performance:flow',value:{day:seoulDate(Date.parse(p.since)),market:p.market,direction:p.amount>0?'deposit':'withdrawal',amount:formAmount(p.market,p.amount),note:''}}};});}
// The planner's condition on commit 4: the review context's cashChangesBeingChecked keeps exactly the keys it had before
// item 9 (market, currency, amount, since, usBalanceUnseen); the detector's newer fields (holdReason, couldBeFill) are
// for the Home line only, so item 9 does not change what the model is given.
const contextRows=pending=>(pending??[]).map(p=>({market:p.market,currency:p.currency,amount:p.amount,since:p.since,...(p.usBalanceUnseen?{usBalanceUnseen:true}:{})}));
module.exports={attentionItems,contextRows};
