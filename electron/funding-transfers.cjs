'use strict';
// C1d-2 (settlement clean-up, artifacts/reviews/2026-11-14-settlement-cleanup/c1/c1d2-design.md): the KRW part of each
// U.S. buy, booked once as a transfer between the markets where KIS's figures show it, and the split of KIS's reported
// amount awaiting settlement (ustl_buy_amt_smtl) between the markets until then.
//
// KIS settles a U.S. buy from U.S. cash first and exchanges KRW for any shortfall (2026-10-24, 10-27, 10-28, 11-03).
// Until KIS's figures show the KRW part, the U.S. side carries the buy: an obligation in the U.S. low bound, nothing
// deducted in Korea ("assumed paid from U.S. cash or proceeds; KIS may take KRW"). The KRW part becomes known:
// - K1, at the report: the reported amount rises by the buy's KRW while the U.S. side holds no money that could pay it.
//   The rise is booked: Korea - the reported KRW, U.S. + the buy's net USD. From then on it is a Korean deduction.
// - K2, at settlement: the reported amount falls by the buy's KRW. The U.S. cash it took is the USD part; the rest
//   (the shortfall) is paid by an exchange, seen as a fall in Korean D+2 cash within one Korean business day, within
//   5% of the shortfall at the rate: booked as Korea - that fall, U.S. + the shortfall. A K1 buy that KIS pays partly in
//   USD after all gets a reversal entry of its own (the original is kept).
// Every amount booked is a KIS figure (the reported KRW, the Korean fall, the U.S. cash taken, the fill's net USD); the
// rate only attributes. Nothing is ever a detected flow or an alert, and the funding check before an order never reads
// this. Each booking has a deterministic id (funding:<key>:...), so a repeat or a restart writes nothing twice.
// explained(): cumulative amounts per market the flow detector leaves out (only changes this recorder has seen: M2).
const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');const B=require('./business-days.cjs');
const BAND=0.05,MAX_SET=8;
const won=v=>Math.round(v),usd=v=>Math.round(v*100)/100;
const netUSD=o=>{const n=o?.resultCosts?.netCash;return Number.isFinite(n)?Math.abs(n):Math.abs((Number(o?.filled)||0)*(Number(o?.fillPrice)||0));};
const fillAt=o=>Number.isFinite(o.filledObservedAt)?o.filledObservedAt:Number.isFinite(o.createdAt)?o.createdAt:null;
const isBuy=o=>o&&o.side==='Buy'&&Number(o.filled)>0&&(o.market==='US'||String(o.accountKey??'').endsWith(':US'));
// The one set among the candidates whose amount(c) totals target within the band, or null (none, several, or too many).
function uniqueSet(cands,target,amount){if(!(target>0)||!cands.length||cands.length>MAX_SET)return null;let found=null;
  for(let m=1;m<1<<cands.length;m++){let t=0;const s=[];for(let i=0;i<cands.length;i++)if(m&1<<i){t+=amount(cands[i]);s.push(cands[i]);}
    if(Math.abs(t-target)<=BAND*target){if(found)return null;found=s;}}
  return found;}
class FundingTransfers {
  // performance: PerformanceHistory (addFlow); clock.
  constructor(db,{performance=null,clock=Date.now}={}){this.db=db;this.performance=performance;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS funding_transfers(account TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,key))');}
  rows(account){return this.db.prepare("SELECT key,payload FROM funding_transfers WHERE account=? AND key<>'#meta'").all(account).map(r=>({key:r.key,...JSON.parse(r.payload)}));}
  meta(account){const r=this.db.prepare("SELECT payload FROM funding_transfers WHERE account=? AND key='#meta'").get(account);return r?JSON.parse(r.payload):null;}
  put(account,key,v){const {key:_k,...rest}=v;this.db.prepare('INSERT INTO funding_transfers VALUES(?,?,?) ON CONFLICT(account,key) DO UPDATE SET payload=excluded.payload').run(account,key,JSON.stringify(rest));}
  // The split now: Korean deduction (K1 groups), U.S. obligation (groups not yet shown), and the reported amount no
  // tracked buy explains (provisional: purchases outside the app, or a report the rule could not attribute). M4: while
  // KIS reports an amount, every won of it is in exactly one of the three.
  current(account){const m=this.meta(account),rows=this.rows(account);const us=rows.filter(r=>r.state==='us');
    return {krwKRW:won(rows.filter(r=>r.state==='krw').reduce((n,r)=>n+r.reportedKRW,0)),usReportedKRW:won(us.reduce((n,r)=>n+r.reportedKRW,0)),usUSD:usd(us.reduce((n,r)=>n+r.usd,0)),usOrders:us.length,
      provisionalKRW:won(Math.max(0,m?.provisionalKRW??0)),reportedKRW:won(m?.reportedKRW??0),explained:{KR:won(m?.explainedKR??0),US:usd(m?.explainedUS??0)}};}
  book(account,key,leg,{market,amount,day,note,at}){if(!this.performance||!amount)return null;const id=`funding:${key}:${leg}`;
    if(this.db.prepare('SELECT 1 FROM cash_flows WHERE id=?').get(id))return null;
    return this.performance.addFlow(account,{id,day,market,amount,transfer:true,source:'funding',occurredBy:at,note});}
  // C1d-2b, F4: a reading's bookings, states and explained amounts commit together or not at all (no one-legged transfer).
  tx(fn){const own=!this.db.isTransaction;this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT funding_transfers');
    try{const r=fn();this.db.exec(own?'COMMIT':'RELEASE funding_transfers');return r;}
    catch(error){if(own)this.db.exec('ROLLBACK');else{this.db.exec('ROLLBACK TO funding_transfers');this.db.exec('RELEASE funding_transfers');}throw error;}}
  // One U.S. reading (the reading the app uses; a held or provisional one never comes here: C1d-1, M7). us: the U.S.
  // balance; orders: the account's U.S. orders; openOrderIds: orders the settlement tracker still holds in flight.
  observeUS(account,input){return this.tx(()=>this.readUS(account,input));}
  readUS(account,{us,orders=[],fx=null,openOrderIds=new Set(),openBuysUSD=0}){
    if(typeof account!=='string'||!account||!us)return this.current(account);
    const now=this.clock(),day=seoulDate(now),R=won(Math.max(0,(Number(us.unsettled?.buyKRW)||0)-(Number(us.unsettled?.sellKRW)||0))),cash=Number(us.cash)||0,pending=Number(us.pendingSaleProceeds)||0;
    // F3: only sales move U.S. cash plus pending at their fill (the proceeds); KIS takes a buy's cash at settlement, so a
    // buy filling in between is not part of what a settlement took.
    const m=this.meta(account);const buys=orders.filter(isBuy);const effects=Object.fromEntries(orders.filter(o=>Number(o.filled)>0&&o.side==='Sell').map(o=>[String(o.id),netUSD(o)]));
    const aged=t=>t==null||B.agedOut('US',{fillAt:t,now,n:B.SETTLE_DAYS}).aged;
    // M5: at the first reading, buys already past the age rule, or any buy when nothing is reported, are history.
    if(!m){for(const o of buys){const t=fillAt(o),old=R===0||aged(t);if(old)this.put(account,'o:'+o.id,{state:'none',orders:[String(o.id)],usd:usd(netUSD(o)),reason:'history at the first reading'});}}
    // Read after the first-reading step above, so a buy it marked as history is never taken for a new one.
    const rows=new Map(this.rows(account).map(r=>[r.key,r]));const known=new Set([...rows.values()].flatMap(r=>r.orders??[]));
    for(const o of buys){const id=String(o.id);if(known.has(id)||rows.has('o:'+id))continue;const r={state:'filled',orders:[id],usd:usd(netUSD(o)),filledAt:fillAt(o)};this.put(account,'o:'+id,r);rows.set('o:'+id,{key:'o:'+id,...r});}
    // F5: a filled buy KIS never reported, past the age rule, is history by the same rule (its cash was taken, or it
    // settled as USD before any report), so a later buy of the same size keeps its attribution.
    for(const [k,r] of rows)if(r.state==='filled'&&aged(r.filledAt)){const next={...r,state:'none',reason:'settled by age without a KIS report'};this.put(account,k,next);rows.set(k,{key:k,...next});}
    const meta={...(m??{explainedKR:0,explainedUS:0,provisionalKRW:0}),startedAt:m?.startedAt??now};
    const prevR=m?m.reportedKRW??0:0,dR=R-prevR;
    // The U.S. cash change since the previous reading less the fills seen meanwhile: what the settlement itself took.
    const prevFx=m?.effects??{},fillMove=Object.entries(effects).reduce((n,[id,e])=>n+e-(prevFx[id]??0),0);
    const cashMove=m?cash+pending-(m.cash??0)-(m.pending??0)-fillMove:0;
    const live=[...rows.values()];let event=false;
    if(dR>0){const cands=live.filter(r=>r.state==='filled'&&!r.orders.some(id=>openOrderIds.has(id)));
      const set=fx>0?uniqueSet(cands,dR,r=>r.usd*fx):null;
      if(set){event=true;const key=set.flatMap(r=>r.orders).sort().join('+'),total=usd(set.reduce((n,r)=>n+r.usd,0));for(const r of set)this.db.prepare('DELETE FROM funding_transfers WHERE account=? AND key=?').run(account,r.key);
        const others=live.filter(r=>r.state==='us'&&!set.includes(r)).reduce((n,r)=>n+r.usd,0),money=cash+pending-(Number(openBuysUSD)||0)-others;
        if(money<=0.005){// K1: nothing in U.S. money could pay it: all of it is KRW.
          this.put(account,key,{state:'krw',orders:key.split('+'),usd:total,reportedKRW:dR,reportedAt:now,via:'report'});
          this.book(account,key,'out',{market:'KR',amount:-dR,day,at:now,note:'Transfer between markets: KRW paying a U.S. buy (KIS reported it awaiting settlement; no U.S. cash could pay it).'});
          this.book(account,key,'in',{market:'US',amount:total,day,at:now,note:'Transfer between markets: into the U.S. account, paying a U.S. buy with KRW.'});
          meta.explainedKR-=dR;meta.explainedUS+=total;}
        else this.put(account,key,{state:'us',orders:key.split('+'),usd:total,reportedKRW:dR,reportedAt:now});}
}
    else if(dR<0){const F=-dR,groups=live.filter(r=>r.state==='us'||r.state==='krw');const set=uniqueSet(groups,F,r=>r.reportedKRW);
      if(set){event=true;const total=set.reduce((n,r)=>n+r.usd,0),paid=Math.max(0,-cashMove),Y=usd(Math.min(total,paid));
        for(const r of set){const share=total>0?r.usd/total:0,y=usd(Y*share);
          if(r.state==='us'){const S=usd(r.usd-y);
            // The U.S. side settled: its obligation left, the cash it took left; what stays is the shortfall.
            if(S<=0.005)this.put(account,r.key,{...r,state:'booked',paidUSD:y,settledAt:now,via:'usd'});
            else{this.put(account,r.key,{...r,state:'awaiting-krw',paidUSD:y,shortfallUSD:S,fx,settledAt:now});meta.explainedUS+=S;}}
          else{// K1 at the report; settled now.
            if(y>0.005&&r.reportedKRW-y*(fx??0)<=BAND*r.reportedKRW){// F1: KIS paid the whole buy in USD after all: the full reversal, now.
              this.book(account,r.key,'reversal-out',{market:'US',amount:-y,day,at:now,note:'Transfer between markets reversed: KIS paid this U.S. buy in USD.'});
              this.book(account,r.key,'reversal-in',{market:'KR',amount:r.reportedKRW,day,at:now,note:'Transfer between markets reversed: KRW not taken for this U.S. buy.'});
              this.put(account,r.key,{...r,state:'booked',paidUSD:y,settledAt:now,via:'reversal'});meta.explainedUS-=y;meta.explainedKR+=r.reportedKRW;}
            else if(y>0.005){this.put(account,r.key,{...r,state:'awaiting-reversal',paidUSD:y,fx,settledAt:now});meta.explainedUS-=y;}
            else this.put(account,r.key,{...r,state:'booked',settledAt:now,via:'krw'});}}}}
    // M4: every won KIS reports is a group's (U.S. obligation or Korean deduction) or provisional: the reported amount
    // no tracked buy explains (purchases outside the app, or a report the rule could not attribute).
    // KIS revalues the KRW it reports at each day's rate: with no buy reported or settled in this reading, a change within
    // the band rescales the groups and the provisional amount together, so the split keeps summing to what KIS reports.
    let groups=this.rows(account).filter(r=>r.state==='us'||r.state==='krw');const before=groups.reduce((n,r)=>n+r.reportedKRW,0)+(m?.provisionalKRW??0);
    if(!event&&dR!==0&&before>0&&R>0&&Math.abs(R-before)<=BAND*before){const k=R/before;for(const r of groups)this.put(account,r.key,{...r,reportedKRW:won(r.reportedKRW*k)});groups=this.rows(account).filter(r=>r.state==='us'||r.state==='krw');}
    const tracked=groups.reduce((n,r)=>n+r.reportedKRW,0);meta.provisionalKRW=Math.max(0,R-tracked);
    Object.assign(meta,{reportedKRW:R,cash,pending,effects,usAt:now});this.put(account,'#meta',meta);return this.current(account);}
  // One Korean reading: the change in D+2 cash less the Korean fills seen meanwhile pays any shortfall awaiting it.
  observeKR(account,input){return this.tx(()=>this.readKR(account,input));}
  readKR(account,{korea,orders=[]}){
    if(typeof account!=='string'||!account||!korea)return this.current(account);
    const now=this.clock(),day=seoulDate(now),settled=Number.isFinite(korea.settledCash)?korea.settledCash:Number(korea.cash);if(!Number.isFinite(settled))return this.current(account);
    const m=this.meta(account)??{explainedKR:0,explainedUS:0,provisionalKRW:0,startedAt:now};const kr=orders.filter(o=>Number(o.filled)>0&&o.market!=='US'&&!String(o.accountKey??'').endsWith(':US'));
    const effects=Object.fromEntries(kr.map(o=>{const n=o?.resultCosts?.netCash;const e=Number.isFinite(n)?n:(o.side==='Buy'?-1:1)*(Number(o.filled)||0)*(Number(o.fillPrice)||0);return [String(o.id),e];}));
    const prev=m.kr,move=prev?settled-prev.settled-Object.entries(effects).reduce((n,[id,e])=>n+e-(prev.effects?.[id]??0),0):0;
    let left=move<0?-move:0;
    for(const r of this.rows(account).filter(x=>x.state==='awaiting-krw'||x.state==='awaiting-reversal').sort((a,b)=>a.settledAt-b.settledAt)){
      const expired=B.agedOut('KR',{fillAt:r.settledAt,now,n:1}).aged;const need=r.state==='awaiting-krw'?r.shortfallUSD*(r.fx??0):r.reportedKRW-(r.paidUSD*(r.fx??0));
      if(left>0&&need>0&&Math.abs(left-need)<=BAND*need){const X=won(left);left=0;
        if(r.state==='awaiting-krw'){this.book(account,r.key,'out',{market:'KR',amount:-X,day,at:now,note:'Transfer between markets: KRW exchanged at settlement for the part of a U.S. buy U.S. cash did not cover.'});
          this.book(account,r.key,'in',{market:'US',amount:r.shortfallUSD,day,at:now,note:'Transfer between markets: into the U.S. account, the exchange paying part of a U.S. buy.'});
          this.put(account,r.key,{...r,state:'booked',exchangedKRW:X,exchangedAt:now,via:'exchange'});m.explainedKR-=X;}
        else{// The K1 booking took the whole reported KRW; KIS exchanged only X: the rest comes back as a reversal.
          const back=won(r.reportedKRW-X);this.book(account,r.key,'reversal-out',{market:'US',amount:-r.paidUSD,day,at:now,note:'Transfer between markets reversed in part: KIS paid part of this U.S. buy in USD.'});
          this.book(account,r.key,'reversal-in',{market:'KR',amount:back,day,at:now,note:'Transfer between markets reversed in part: KRW not taken for this U.S. buy.'});
          // The detector saw the deduction end (+reported KRW) at the U.S. reading and the exchange (-X) here: the
          // reversal's KRW (reported - X) is what it must leave out.
          this.put(account,r.key,{...r,state:'booked',exchangedKRW:X,exchangedAt:now,via:'reversal'});m.explainedKR+=back;}}
      else if(expired)this.put(account,r.key,{...r,state:'unmatched',expiredAt:now,reason:'no Korean exchange within one Korean business day of the U.S. settlement'});}
    m.kr={settled,effects,at:now};this.put(account,'#meta',m);return this.current(account);}
}
module.exports={FundingTransfers,uniqueSet,BAND};
