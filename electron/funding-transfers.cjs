'use strict';
// C1d-2 (settlement clean-up, artifacts/reviews/2026-11-14-settlement-cleanup/c1/c1d2-design.md): the KRW part of each
// U.S. buy, booked once as a transfer between the markets where KIS's figures show it, and the split of KIS's reported
// amount awaiting settlement (ustl_buy_amt_smtl) between the markets until then.
//
// KIS settles a U.S. buy from U.S. cash first and exchanges KRW for any shortfall (seen on several settlements).
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
// S3a-2: the states whose KRW has not been seen leaving Korean cash (current().krwUnpaidKRW); and the states KIS still
// reports (the split's groups).
const UNPAID=new Set(['krw','awaiting-kr','awaiting-reversal']),REPORTED=new Set(['us','krw','kr-paid']);
// M-1.6c2: groups KIS paid at least in part from KRW, as far as its figures have shown it.
const KRW_ROUTE=new Set(['krw','kr-paid','awaiting-kr','awaiting-krw','awaiting-reversal']);
// Of those, the ones KIS has settled (its reported total fell by them): awaiting the Korean fall, a KRW shortfall or a
// reversal, or booked by KRW or an exchange within 10 days. Booked by age is no evidence of how KIS paid.
// A K1 group KIS paid partly in USD ends booked by reversal with an exchange (exchangedKRW): a KRW-route settlement too;
// a full reversal (KIS paid it all in USD) is not.
// Not awaiting-krw: the Korean side does not deduct a shortfall before its exchange is seen (UNPAID), so until then the
// U.S. side keeps the obligation (a report gone before KIS's debit would otherwise read as paid: a false gain).
const krwSettled=(r,now)=>['awaiting-kr','awaiting-reversal'].includes(r.state)||r.state==='booked'&&(['krw','exchange'].includes(r.via)||r.via==='reversal'&&r.exchangedKRW>0)&&now-(r.settledAt??r.krPaidAt??r.exchangedAt??0)<=10*86400000;
// The first set (fewest members, then the earliest in the given order) whose amount(c) totals target within the band:
// the payment of groups of equal amount is the same whichever of them it is (no booking follows from it).
function firstSet(cands,target,amount){if(!(target>0)||!cands.length)return null;const c=cands.slice(0,MAX_SET),n=c.length,masks=[];
  for(let m=1;m<1<<n;m++)masks.push(m);const bits=m=>{let k=0;for(let i=0;i<n;i++)if(m&1<<i)k++;return k;},order=m=>c.map((_,i)=>m&1<<i?'0':'1').join('');
  masks.sort((a,b)=>bits(a)-bits(b)||order(a).localeCompare(order(b)));
  for(const m of masks){const s=c.filter((_,i)=>m&1<<i),t=s.reduce((x,r)=>x+amount(r),0);if(Math.abs(t-target)<=BAND*target)return s;}
  return null;}
const won=v=>Math.round(v),usd=v=>Math.round(v*100)/100;
const netUSD=o=>{const n=o?.resultCosts?.netCash;return Number.isFinite(n)?Math.abs(n):Math.abs((Number(o?.filled)||0)*(Number(o?.fillPrice)||0));};
const fillAt=o=>Number.isFinite(o.filledObservedAt)?o.filledObservedAt:Number.isFinite(o.createdAt)?o.createdAt:null;
const isBuy=o=>o&&o.side==='Buy'&&Number(o.filled)>0&&(o.market==='US'||String(o.accountKey??'').endsWith(':US'));
// The one set among the candidates whose amount(c) totals target within the band, or null (none, several, or too many).
// M-1.6d T1 (oldest first): KIS settles by U.S. trade date, so when several sets of groups fit a settlement, the
// earlier-reported groups are the ones settling: the one prefix of the groups in report order (then fill order) that fits
// within the band, or null when none or more than one prefix does.
function oldestPrefix(groups,target,amount){if(!(target>0)||!groups.length)return null;const g=[...groups].sort((a,b)=>(a.reportedAt??0)-(b.reportedAt??0)||(a.filledAt??0)-(b.filledAt??0));
  let t=0,found=null;for(let i=0;i<g.length;i++){t+=amount(g[i]);if(Math.abs(t-target)<=BAND*target){if(found)return null;found=g.slice(0,i+1);}}return found;}
function uniqueSet(cands,target,amount){if(!(target>0)||!cands.length||cands.length>MAX_SET)return null;let found=null;
  for(let m=1;m<1<<cands.length;m++){let t=0;const s=[];for(let i=0;i<cands.length;i++)if(m&1<<i){t+=amount(cands[i]);s.push(cands[i]);}
    if(Math.abs(t-target)<=BAND*target){if(found)return null;found=s;}}
  return found;}
// M-1.6b (multi-order design, c1 half 2): a batch, when uniqueSet gives up (more than MAX_SET candidates, or several sets
// fit): KIS reports what filled since its last report, in the order trades occur. The whole candidate set when its total
// fits the band; else the one prefix by fill time whose total fits; else none (the amount stays provisional and the
// valuation's split places it). Only which orders belong is assumed (all, or the earliest); every amount booked stays
// KIS's (the reported KRW) or the fills' (their USD).
function batchSet(cands,target,amount){if(!(target>0)||!cands.length)return null;const fits=t=>Math.abs(t-target)<=BAND*target;
  const sorted=[...cands].sort((a,b)=>(a.filledAt??Infinity)-(b.filledAt??Infinity)||String(a.key).localeCompare(String(b.key)));
  if(fits(sorted.reduce((n,r)=>n+amount(r),0)))return sorted;
  let t=0,found=null;for(let k=0;k<sorted.length-1;k++){t+=amount(sorted[k]);if(fits(t)){if(found)return null;found=sorted.slice(0,k+1);}}return found;}
// A group's key: its order ids joined, as before, while a booking id built from it fits addFlow's fixed-id limit
// (funding:<key>:reversal-out within 160 characters); a longer one (5 or more app orders) is a digest of them, so the
// booking keeps a deterministic id and a repeat writes nothing twice.
const keyOf=ids=>{const k=[...ids].sort().join('+');return k.length<=139?k:'g'+require('node:crypto').createHash('sha256').update(k).digest('hex').slice(0,32);};
class FundingTransfers {
  // performance: PerformanceHistory (addFlow); clock; log(title, body): one System line (S3a-2: a group whose Korean
  // payment or exchange is never seen).
  constructor(db,{performance=null,clock=Date.now,log=null}={}){this.db=db;this.performance=performance;this.clock=clock;this.log=log;db.exec('CREATE TABLE IF NOT EXISTS funding_transfers(account TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,key))');}
  // S3a-2: a group no evidence closed: the row keeps its reason, one System line says what and how much; no booking.
  unmatched(account,r,reason,now){this.put(account,r.key,{...r,state:'unmatched',expiredAt:now,reason});
    try{this.log?.('U.S. buy funding not matched',`${(r.orders??[]).join('+')}: ${reason}. KRW ${Math.round(r.reportedKRW??0).toLocaleString('en-US')} (U.S. $${usd(r.usd??0).toFixed(2)}); nothing was booked for it.`);}catch{}}
  // M-1.6b: a batch group KIS settles in parts. When no unique set of groups matches a fall F, the one batch group with a
  // prefix of its orders (by fill time) whose share of the group's reported KRW fits F within the band is split: the
  // settled part takes F (KIS's figure), the rest keeps the group's remaining KRW and USD. Several fits, or none: no
  // split (the fall settles nothing now, as before). Returns [the settled part] or null.
  splitBatch(account,groups,F){let found=null;
    for(const g of groups){if(g.via!=='batch'||!(g.parts?.length>1)||!(g.usd>0))continue;const parts=[...g.parts].sort((a,b)=>(a.filledAt??Infinity)-(b.filledAt??Infinity)||String(a.id).localeCompare(String(b.id)));
      let u=0;for(let k=0;k<parts.length-1;k++){u+=parts[k].usd;if(Math.abs(g.reportedKRW*u/g.usd-F)<=BAND*F){if(found)return null;found={g,head:parts.slice(0,k+1),tail:parts.slice(k+1)};}}}
    if(!found)return null;const {g,head,tail}=found,hu=usd(head.reduce((n,p)=>n+p.usd,0));
    const a={...g,key:keyOf(head.map(p=>p.id)),orders:head.map(p=>p.id),usd:hu,reportedKRW:F,parts:head,splitFrom:g.key},b={...g,key:keyOf(tail.map(p=>p.id)),orders:tail.map(p=>p.id),usd:usd(g.usd-hu),reportedKRW:won(g.reportedKRW-F),parts:tail,splitFrom:g.key};
    this.db.prepare('DELETE FROM funding_transfers WHERE account=? AND key=?').run(account,g.key);this.put(account,a.key,a);this.put(account,b.key,b);return [a];}
  rows(account){return this.db.prepare("SELECT key,payload FROM funding_transfers WHERE account=? AND key<>'#meta'").all(account).map(r=>({key:r.key,...JSON.parse(r.payload)}));}
  meta(account){const r=this.db.prepare("SELECT payload FROM funding_transfers WHERE account=? AND key='#meta'").get(account);return r?JSON.parse(r.payload):null;}
  put(account,key,v){const {key:_k,...rest}=v;this.db.prepare('INSERT INTO funding_transfers VALUES(?,?,?) ON CONFLICT(account,key) DO UPDATE SET payload=excluded.payload').run(account,key,JSON.stringify(rest));}
  // The split now: Korean deduction (K1 groups), U.S. obligation (groups not yet shown), and the reported amount no
  // tracked buy explains (provisional: purchases outside the app, or a report the rule could not attribute). M4: while
  // KIS reports an amount, every won of it is in exactly one of the three.
  // S3a-2 (s3a-f1.md, B): krwUnpaidKRW, the KRW of K1 groups not yet seen leaving Korean cash (reported and unsettled;
  // settled by KIS with the Korean fall not yet read; partly paid in USD with the exchange not yet read). The Korean
  // daily-loss value and the flow detector's Korean cash deduct it, so the deduction ends at the reading that shows the
  // Korean cash fall, whichever of the U.S. and Korean readings comes first. krwKRW keeps its meaning (the groups KIS
  // still reports, for the valuation's split).
  current(account){const m=this.meta(account),rows=this.rows(account);const us=rows.filter(r=>r.state==='us');
    return {krwKRW:won(rows.filter(r=>r.state==='krw'||r.state==='kr-paid').reduce((n,r)=>n+r.reportedKRW,0)),krwUnpaidKRW:won(rows.filter(r=>UNPAID.has(r.state)).reduce((n,r)=>n+r.reportedKRW,0)),usReportedKRW:won(us.reduce((n,r)=>n+r.reportedKRW,0)),usUSD:usd(us.reduce((n,r)=>n+r.usd,0)),usOrders:us.length,
      provisionalKRW:won(Math.max(0,m?.provisionalKRW??0)),reportedKRW:won(m?.reportedKRW??0),explained:{KR:won(m?.explainedKR??0),US:usd(m?.explainedUS??0)},
      // F-d1: the KRW of K1 groups KIS has settled from Korea (its report no longer carries them) not yet seen leaving
      // Korean cash: the Korean value deducts it, as the loss value does through krwUnpaidKRW. A partial reversal leaves
      // only the reported KRW less the USD KIS took (at the rate of its settlement).
      // F-d3: the USD still owed by U.S. buys whose report KIS dropped before taking U.S. cash or exchanging KRW (awaiting-krw,
      // not deferred: a deferred group's pieces are still in flight and carry it). The U.S. value deducts it until then.
      usAwaitingUSD:usd(rows.filter(r=>r.state==='awaiting-krw'&&!r.deferred).reduce((n,r)=>n+(r.shortfallUSD??0),0)),
      krwSettledUnpaidKRW:won(rows.reduce((n,r)=>n+(r.state==='awaiting-kr'?r.reportedKRW:r.state==='awaiting-reversal'?Math.max(0,r.reportedKRW-(r.paidUSD??0)*(r.fx??0)):0),0)),
      // M-1.6c1: the groups KIS still reports, with their orders, for the valuation's coverage of in-flight pieces.
      reportedGroups:rows.filter(r=>REPORTED.has(r.state)).map(r=>({orders:[...(r.orders??[])],reportedKRW:won(r.reportedKRW??0),state:r.state})),
      // M-1.6c2 (C1): the groups whose KRW route KIS has shown (reported KRW-paid, settled with a KRW part, or booked from
      // KRW within ten days), with their orders, for the settlement tracker's zero-report closes.
      krwRouteGroups:rows.filter(r=>KRW_ROUTE.has(r.state)||krwSettled(r,this.clock())||r.state==='booked'&&r.via==='age'&&this.clock()-(r.settledAt??r.krPaidAt??r.exchangedAt??0)<=10*86400000).map(r=>({key:r.key,orders:[...(r.orders??[])],state:r.state,settled:krwSettled(r,this.clock()),paidUSD:usd(r.paidUSD??0)})),
      // The groups KIS settled through the KRW route (its reported total fell by them and U.S. cash did not pay all):
      // their pieces still in flight are covered up to the KRW part until the tracker closes them (no one-reading gap).
      krwSettledGroups:rows.filter(r=>krwSettled(r,this.clock())).map(r=>({key:r.key,orders:[...(r.orders??[])],state:r.state,reportedKRW:won(r.reportedKRW??0),paidUSD:usd(r.paidUSD??0)}))};}
  // S3a (G1, ruling R2): each leg carries the window in which its own market's figure moved: occurredAfter, the reading
  // before that move (after), and occurredBy, the reading that showed it (by, default at). The daily-loss checks place it
  // against their baseline by that window (PerformanceHistory.flowsSince). Where the reading before cannot be named
  // (the recorder's first reading, rows from before this), only occurredBy is kept and the leg stays of uncertain timing.
  // - The Korean figure's U.S.-buy deduction is computed from the U.S. reading and this recorder (valuation.cjs korea),
  //   so a Korean move at a U.S. reading lies after the later of the previous U.S. and Korean readings. A Korean D+2
  //   cash fall lies between two Korean readings.
  // - The U.S. figure depends on U.S. readings only.
  // The booking day stays the day of the reading that booked it.
  book(account,key,leg,{market,amount,day,note,at,by=at,after=null}){if(!this.performance||!amount)return null;const id=`funding:${key}:${leg}`;
    if(this.db.prepare('SELECT 1 FROM cash_flows WHERE id=?').get(id))return null;
    return this.performance.addFlow(account,{id,day,market,amount,transfer:true,source:'funding',occurredBy:by,...(Number.isFinite(after)&&after<by?{occurredAfter:after}:{}),note});}
  // C1d-2b, F4: a reading's bookings, states and explained amounts commit together or not at all (no one-legged transfer).
  tx(fn){const own=!this.db.isTransaction;this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT funding_transfers');
    try{const r=fn();this.db.exec(own?'COMMIT':'RELEASE funding_transfers');return r;}
    catch(error){if(own)this.db.exec('ROLLBACK');else{this.db.exec('ROLLBACK TO funding_transfers');this.db.exec('RELEASE funding_transfers');}throw error;}}
  // One U.S. reading (the reading the app uses; a held or provisional one never comes here: C1d-1, M7). us: the U.S.
  // balance; orders: the account's U.S. orders; openOrderIds: orders the settlement tracker still holds in flight.
  observeUS(account,input){return this.tx(()=>this.readUS(account,input));}
  // reportedOpenIds (M-1.6c1): of openOrderIds, the buys the settlement tracker flags as possibly in KIS's report; only the
  // batch path may take them (a unique set never does, as before).
  readUS(account,{us,orders=[],fx=null,openOrderIds=new Set(),openBuysUSD=0,reportedOpenIds=new Set()}){
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
    // S3a-3: a group whose Korean payment was read (kr-paid) but whose report KIS never took away by an amount it could be
    // matched to, past the same age rule, is settled: booked, with no flow and no line. If KIS still reports it, that
    // amount is then unattributed (provisional), like any report no tracked buy explains.
    for(const [k,r] of rows)if(r.state==='kr-paid'&&aged(Number.isFinite(r.filledAt)?r.filledAt:r.reportedAt)){const next={...r,state:'booked',via:'age',reason:'settled by age after its Korean payment',settledAt:now};this.put(account,k,next);rows.set(k,{key:k,...next});}
    const meta={...(m??{explainedKR:0,explainedUS:0,provisionalKRW:0}),startedAt:m?.startedAt??now};
    // S3a (G1): the readings before this one, for the legs' windows (book): the U.S. figure's (the previous U.S. reading)
    // and the Korean figure's (the later of the previous U.S. and Korean readings); none at the first reading.
    const prevUS=Number.isFinite(m?.usAt)?m.usAt:null,krAfter=prevUS==null?null:Math.max(prevUS,Number.isFinite(m?.kr?.at)?m.kr.at:-Infinity),window={US:prevUS,KR:krAfter};
    const prevR=m?m.reportedKRW??0:0,dR=R-prevR;
    // The U.S. cash change since the previous reading less the fills seen meanwhile: what the settlement itself took.
    const prevFx=m?.effects??{},fillMove=Object.entries(effects).reduce((n,[id,e])=>n+e-(prevFx[id]??0),0);
    const cashMove=m?cash+pending-(m.cash??0)-(m.pending??0)-fillMove:0;
    let live=[...rows.values()];let event=false;
    // M-1.6c2: KIS's late debit of a deferred group (its report gone, U.S. cash still holding it): a U.S. cash fall
    // within the band of its shortfall, oldest first. Booked by usd; what it took is not a settlement payment again below.
    let lateDebit=0;
    // F-d3: any group awaiting a KRW shortfall, deferred or not (KIS's report gone with U.S. cash still able to pay it).
    // A group that was not deferred had its shortfall explained as a U.S. rise at the report's fall: the debit takes it back.
    for(const r of live.filter(x=>x.state==='awaiting-krw').sort((a,b)=>a.settledAt-b.settledAt)){const fall=-(cashMove+lateDebit);
      if(fall>0&&Math.abs(fall-r.shortfallUSD)<=BAND*r.shortfallUSD){lateDebit+=fall;event=true;const next={...r,state:'booked',paidUSD:usd((r.paidUSD??0)+fall),settledAt:now,via:'usd',lateDebit:true};delete next.deferred;if(!r.deferred)meta.explainedUS-=fall;this.put(account,r.key,next);rows.set(r.key,{key:r.key,...next});}
      // Smaller, with U.S. cash exhausted after it: KIS took the USD there was and exchanges the rest; the shortfall the
      // Korean exchange must match is what is left.
      else if(fall>0.005&&fall<r.shortfallUSD&&cash<=0.01){lateDebit+=fall;event=true;const next={...r,paidUSD:usd((r.paidUSD??0)+fall),shortfallUSD:usd(r.shortfallUSD-fall),settledAt:now};if(!r.deferred)meta.explainedUS-=fall;this.put(account,r.key,next);rows.set(r.key,{key:r.key,...next});}}
    live=[...rows.values()];
    if(dR>0){const cands=live.filter(r=>r.state==='filled'&&!r.orders.some(id=>openOrderIds.has(id)));
      // M-1.6c1 (Alt 3): a batch may also take buys still in flight that the tracker flags as possibly reported (over its
      // bound it settles none of them); the valuation then counts their obligation once, through the group (coverage).
      const batchCands=live.filter(r=>r.state==='filled'&&!r.orders.some(id=>openOrderIds.has(id)&&!reportedOpenIds.has(id)));
      const unique=fx>0?uniqueSet(cands,dR,r=>r.usd*fx):null,batch=!unique&&fx>0?batchSet(batchCands,dR,r=>r.usd*fx):null,set=unique??batch;
      // Their own USD is part of openBuysUSD; it is not another buy's claim on U.S. money.
      const ownOpen=batch?batch.filter(r=>r.orders.some(id=>reportedOpenIds.has(id))).reduce((n,r)=>n+r.usd,0):0;
      // A batch keeps each order's USD and fill time (parts), so a settlement in parts can be split from it (M-1.6b).
      const extra=batch?{via:'batch',parts:batch.flatMap(r=>r.orders.map(id=>({id,usd:r.usd/r.orders.length,filledAt:r.filledAt??null})))}:{};
      if(set){event=true;const key=keyOf(set.flatMap(r=>r.orders)),total=usd(set.reduce((n,r)=>n+r.usd,0));for(const r of set)this.db.prepare('DELETE FROM funding_transfers WHERE account=? AND key=?').run(account,r.key);
        const others=live.filter(r=>r.state==='us'&&!set.includes(r)).reduce((n,r)=>n+r.usd,0),money=cash+pending-Math.max(0,(Number(openBuysUSD)||0)-ownOpen)-others;
        if(money<=0.005){// K1: nothing in U.S. money could pay it: all of it is KRW.
          // S3a-2: the group keeps its earliest fill time, for the guard on its Korean payment (readKR).
          const filled=set.map(r=>r.filledAt).filter(Number.isFinite);
          this.put(account,key,{state:'krw',orders:set.flatMap(r=>r.orders).sort(),usd:total,reportedKRW:dR,reportedAt:now,via:'report',...extra,...(filled.length?{filledAt:Math.min(...filled)}:{})});
          this.book(account,key,'out',{market:'KR',amount:-dR,day,at:now,after:window.KR,note:'Transfer between markets: KRW paying a U.S. buy (KIS reported it awaiting settlement; no U.S. cash could pay it).'});
          this.book(account,key,'in',{market:'US',amount:total,day,at:now,after:window.US,note:'Transfer between markets: into the U.S. account, paying a U.S. buy with KRW.'});
          meta.explainedKR-=dR;meta.explainedUS+=total;}
        else this.put(account,key,{state:'us',orders:set.flatMap(r=>r.orders).sort(),usd:total,reportedKRW:dR,reportedAt:now,...extra});}
}
    else if(dR<0){const F=-dR,groups=live.filter(r=>REPORTED.has(r.state));const set=uniqueSet(groups,F,r=>r.reportedKRW)??oldestPrefix(groups,F,r=>r.reportedKRW)??this.splitBatch(account,groups,F);
      if(set){event=true;const total=set.reduce((n,r)=>n+r.usd,0),paid=Math.max(0,-(cashMove+lateDebit)),Y=usd(Math.min(total,paid));
        for(const r of set){const share=total>0?r.usd/total:0,y=usd(Y*share);
          if(r.state==='us'){const S=usd(r.usd-y);
            // The U.S. side settled: its obligation left, the cash it took left; what stays is the shortfall.
            // F-d3: a residue within the band of the group's amount while U.S. cash could still pay it is the batch's own band (a
            // set booked within 5% of KIS's part), not a KRW shortfall: settled in USD. A real shortfall leaves U.S. cash exhausted.
            if(S<=0.005||S<=BAND*r.usd&&cash>=S)this.put(account,r.key,{...r,state:'booked',paidUSD:y,settledAt:now,via:'usd',...(S>0.005?{bandResidueUSD:S}:{})});
            // M-1.6c2: explained only when the tracker closed its pieces in this reading (as for one buy: the unique
            // reported fall). A batch over the tracker's bound keeps its pieces until their payment (zero-report): then
            // the U.S. basis has not moved, and the group is deferred: a later U.S. cash fall that fits it is KIS's
            // late debit (booked by usd), the Korean exchange is booked as usual.
            else{const deferred=r.orders.some(id=>openOrderIds.has(String(id)));this.put(account,r.key,{...r,state:'awaiting-krw',paidUSD:y,shortfallUSD:S,fx,settledAt:now,window,...(deferred?{deferred:true}:{})});if(!deferred)meta.explainedUS+=S;}}
          else if(r.state==='kr-paid'){// S3a-2: its Korean payment was read before this U.S. reading.
            if(y>0.005)this.unmatched(account,{...r,paidUSD:y,settledAt:now},'KIS took U.S. cash for it after its KRW payment was seen',now);
            else this.put(account,r.key,{...r,state:'booked',settledAt:now,via:'krw'});}
          else{// K1 at the report; settled now.
            if(y>0.005&&r.reportedKRW-y*(fx??0)<=BAND*r.reportedKRW){// F1: KIS paid the whole buy in USD after all: the full reversal, now.
              this.book(account,r.key,'reversal-out',{market:'US',amount:-y,day,at:now,after:window.US,note:'Transfer between markets reversed: KIS paid this U.S. buy in USD.'});
              this.book(account,r.key,'reversal-in',{market:'KR',amount:r.reportedKRW,day,at:now,after:window.KR,note:'Transfer between markets reversed: KRW not taken for this U.S. buy.'});
              this.put(account,r.key,{...r,state:'booked',paidUSD:y,settledAt:now,via:'reversal'});meta.explainedUS-=y;meta.explainedKR+=r.reportedKRW;}
            // Part USD: the U.S. leg back now, where U.S. cash fell (S3a-2; it was booked at the Korean reading); the KRW
            // part waits for the Korean exchange.
            else if(y>0.005){this.book(account,r.key,'reversal-out',{market:'US',amount:-y,day,at:now,after:window.US,note:'Transfer between markets reversed in part: KIS paid part of this U.S. buy in USD.'});
              this.put(account,r.key,{...r,state:'awaiting-reversal',paidUSD:y,fx,settledAt:now,window});meta.explainedUS-=y;}
            // All KRW: settled by KIS; the KRW stays deducted until the Korean cash fall is read (S3a-2).
            else this.put(account,r.key,{...r,state:'awaiting-kr',settledAt:now});}}}}
    // M4: every won KIS reports is a group's (U.S. obligation or Korean deduction) or provisional: the reported amount
    // no tracked buy explains (purchases outside the app, or a report the rule could not attribute).
    // KIS revalues the KRW it reports at each day's rate: with no buy reported or settled in this reading, a change within
    // the band rescales the groups and the provisional amount together, so the split keeps summing to what KIS reports.
    let groups=this.rows(account).filter(r=>REPORTED.has(r.state));const before=groups.reduce((n,r)=>n+r.reportedKRW,0)+(m?.provisionalKRW??0);
    if(!event&&dR!==0&&before>0&&R>0&&Math.abs(R-before)<=BAND*before){const k=R/before;for(const r of groups)this.put(account,r.key,{...r,reportedKRW:won(r.reportedKRW*k)});groups=this.rows(account).filter(r=>REPORTED.has(r.state));}
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
    // S3a (G1): the Korean fall lies between the previous Korean reading and this one; a U.S. leg booked here keeps the
    // window of the U.S. settlement reading that moved the U.S. figure (the row's window, from readUS).
    const prevKR=Number.isFinite(prev?.at)?prev.at:null;
    for(const r of this.rows(account).filter(x=>x.state==='awaiting-krw'||x.state==='awaiting-reversal').sort((a,b)=>a.settledAt-b.settledAt)){
      const expired=B.agedOut('KR',{fillAt:r.settledAt,now,n:1}).aged;const need=r.state==='awaiting-krw'?r.shortfallUSD*(r.fx??0):r.reportedKRW-(r.paidUSD*(r.fx??0));
      if(left>0&&need>0&&Math.abs(left-need)<=BAND*need){const X=won(left);left=0;
        if(r.state==='awaiting-krw'){this.book(account,r.key,'out',{market:'KR',amount:-X,day,at:now,after:prevKR,note:'Transfer between markets: KRW exchanged at settlement for the part of a U.S. buy U.S. cash did not cover.'});
          this.book(account,r.key,'in',{market:'US',amount:r.shortfallUSD,day,at:now,by:r.settledAt,after:r.window?.US,note:'Transfer between markets: into the U.S. account, the exchange paying part of a U.S. buy.'});
          // M-1.6c2: a deferred group's shortfall leaves the U.S. basis now (the settled group covers its pieces), not at
          // its report's fall: explained here.
          {const next={...r,state:'booked',exchangedKRW:X,exchangedAt:now,via:'exchange'};delete next.deferred;this.put(account,r.key,next);}m.explainedKR-=X;if(r.deferred)m.explainedUS+=r.shortfallUSD;}
        else{// The K1 booking took the whole reported KRW; KIS exchanged only X: the rest comes back as a reversal.
          // S3a-2: the reported KRW stayed deducted until now (krwUnpaidKRW), so the Korean loss value moves here only, by
          // + reported - X: the KRW leg's window is the Korean pair. The U.S. leg was booked at the U.S. settlement reading
          // (a group settled by the code before S3a-2 gets it now; a repeat books nothing).
          const back=won(r.reportedKRW-X);
          this.book(account,r.key,'reversal-out',{market:'US',amount:-r.paidUSD,day,at:now,by:r.settledAt,after:r.window?.US,note:'Transfer between markets reversed in part: KIS paid part of this U.S. buy in USD.'});
          this.book(account,r.key,'reversal-in',{market:'KR',amount:back,day,at:now,after:prevKR,note:'Transfer between markets reversed in part: KRW not taken for this U.S. buy.'});
          // The detector saw the deduction end (+reported KRW) at the U.S. reading and the exchange (-X) here: the
          // reversal's KRW (reported - X) is what it must leave out.
          this.put(account,r.key,{...r,state:'booked',exchangedKRW:X,exchangedAt:now,via:'reversal'});m.explainedKR+=back;}}
      else if(expired)this.unmatched(account,r,'no Korean exchange within one Korean business day of the U.S. settlement',now);}
    // S3a-2: the Korean payment of K1 groups (all KRW): a fall in D+2 cash (what the exchanges above did not take) within
    // the band of a group's KRW, or of the first set of groups that totals it, pays them. Guard: only once one U.S.
    // business day has passed since the group's fill (its U.S. settlement date), so a Korean withdrawal between KIS's
    // report and the settlement is never taken for it. A group written before S3a-2 has no fill time: its report time
    // stands in (KIS reports the fill on the evening of its New York trade date, so the date is the same; a later report
    // only makes the guard later). Read before KIS's report goes (krw: becomes kr-paid) or after (awaiting-kr: booked).
    const due=r=>B.agedOut('US',{fillAt:Number.isFinite(r.filledAt)?r.filledAt:r.reportedAt,now,n:1}).aged;
    const unpaid=this.rows(account).filter(x=>(x.state==='awaiting-kr'||x.state==='krw')&&due(x)).sort((a,b)=>(a.state==='awaiting-kr'?0:1)-(b.state==='awaiting-kr'?0:1)||(a.settledAt??a.reportedAt)-(b.settledAt??b.reportedAt));
    const paid=left>0?firstSet(unpaid,left,r=>r.reportedKRW):null;
    if(paid){left=0;for(const r of paid)this.put(account,r.key,r.state==='awaiting-kr'?{...r,state:'booked',krPaidAt:now,via:'krw'}:{...r,state:'kr-paid',krPaidAt:now});}
    for(const r of this.rows(account).filter(x=>x.state==='awaiting-kr'))if(B.agedOut('KR',{fillAt:r.settledAt,now,n:1}).aged)this.unmatched(account,r,'no Korean cash fall paying it within one Korean business day of the U.S. settlement',now);
    m.kr={settled,effects,at:now};this.put(account,'#meta',m);return this.current(account);}
}
module.exports={FundingTransfers,uniqueSet,BAND};
