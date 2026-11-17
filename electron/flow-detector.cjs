// Deposits and withdrawals the user did not record, detected from cash changes that reconciled trades do not explain.
// Between two balance observations, each market's cash change minus the cash effect of orders placed and filled in
// between is unexplained. M-3.2 (multi-order, m3-2-design.md): every reading is compared, orders open or not; a change an
// open order's fill not yet counted could explain (its direction, within that order's unfilled amount) is held and never
// recorded while such an order is open, so a fill not yet reconciled is never mistaken for a flow. KIS reports the Korean and U.S. balances separately, so the two sides of one movement can arrive in
// different readings: an unexplained change is first held as provisional (later changes in the same market add to
// it), and it is resolved by evidence, not by timing:
// - balances that return to where they were leave nothing to record;
// - Korean and U.S. changes that offset at the exchange rate are money moving between the markets. When a U.S. buy
//   filled in between, it is integrated-margin funding, recorded as a transfer that awaits its currency exchange. An
//   exchange that matches a transfer already recorded that way (or by the user) while U.S. buys await or have just
//   had settlement is that transfer being completed, and is not counted again; any other exchange is a transfer;
// - a fall in Korean or U.S. cash that matches the payment still outstanding for U.S. buys that settled while their
//   funding was unknown (the settled amount less the cash already seen falling at settlement) is that payment;
// - anything else is recorded as a detected flow once it has stood for HOLD_MS (up to MAX_HOLD_MS while it could
//   still be the settlement of U.S. buys whose funding is unknown). Detected flows count in returns and wait for the
//   user to confirm or remove them.
const {seoulDate}=require('./kis-activity.cjs');const {randomUUID}=require('node:crypto');
const THRESHOLD_KRW=10000;
// Settlement evidence lasts a day: KIS takes the payment at settlement, so an older record would only hide a withdrawal.
const HOLD_MS=2*3600000,MAX_HOLD_MS=4*86400000,EVIDENCE_MS=86400000,MATCH_DAYS=10;
// What each market's cash reading includes. Change a market's name here whenever what the caller passes as its cash
// changes: a saved reading of another basis is not compared, so the change in definition is never taken for money moving.
// KR: Korean cash net of the KRW known to be committed to unsettled U.S. buys (electron/integrated-settlement.cjs).
// US: U.S. cash plus the proceeds of U.S. sales not yet settled (1.5.46).
// 1.5.46 added the unsettled proceeds without a new basis; its first reading took the sale proceeds already
// counted as a withdrawal (cash alone) for a deposit.
// 2026-11-04 (audit, Stage 2): U.S. cash is cash plus pending proceeds, less U.S. buys filled that KIS does not reflect
// yet, plus sales filled that it does not reflect yet (electron/valuation.cjs InFlight). Before, a buy paid from
// unsettled proceeds was counted as spent at the fill while KIS moved nothing until settlement, and the difference
// (a small positive amount) was recorded as a deposit.
// 2026-11-14 (settlement clean-up C1d-2): Korean cash is net of the KRW KIS has shown for U.S. buys (funding-transfers.cjs),
// and U.S. cash also less the U.S. buys whose funding route KIS has not shown; the recorder's own bookings come as funding.
// 2026-11-15 (S3a-2): Korean cash is net of the KRW of K1 groups not yet seen leaving it (krwUnpaidKRW), so it does not
// move when KIS's report goes before the Korean cash falls, nor when the cash falls first.
const BASIS={KR:'net-of-unpaid-funding',US:'with-pending-in-flight-and-route'};
// Readings saved under the single name name only the Korean basis: builds before 1.5.46 wrote it for U.S. cash alone and
// 1.5.46 for cash plus unsettled proceeds, and nothing saved tells them apart, so their U.S. basis is unknown (an upgrade
// need not pass through 1.5.46). Readings without a name predate both.
const basisOf=b=>typeof b==='string'?{KR:b,US:null}:b&&typeof b==='object'?b:{};
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
// An order's cash effect in its market currency: the broker's net cash when known, otherwise the gross amount.
function cashEffect(order){
  if(!(order.filled>0)||!(order.fillPrice>0))return 0;const net=order.resultCosts?.netCash;
  if(Number.isFinite(net))return net;const gross=order.filled*order.fillPrice;return order.side==='Sell'?gross:-gross;
}
// Each order's cash effect at a reading, by order: the next reading is explained only by what changed since, so an
// order placed before a reading and filled hours later is still counted once, when its fill appears.
const orderKey=o=>o.id??`${o.market??'KR'}|${o.side}|${o.symbol}|${o.createdAt}`;
const fillsOf=orders=>Object.fromEntries(orders.map(o=>[orderKey(o),Math.round(cashEffect(o)*100)/100]).filter(([,effect])=>effect!==0));
// M-3.2: what fills of open orders the app has not counted yet could move a market's cash by: buys a fall up to their
// unfilled shares at the highest price they may carry (limit, confirmed revision, or one sent but not confirmed), with
// 1% for fees; sales a rise up to their unfilled shares at that price. Your own orders in KIS are not the app's records.
const FILL_FEE=1.01;
function fillEnvelope(orders,market){let fall=0,rise=0;for(const o of orders){if(!OPEN.includes(o.status)||(o.market??'KR')!==market)continue;
    const rem=Math.max(0,(Number(o.quantity)||0)-(Number(o.filled)||0)),px=Math.max(Number(o.limitPrice)||0,Number(o.currentPrice)||0,Number(o.pendingRevision?.price)||0,Number(o.unconfirmed?.price)||0);
    if(o.side==='Buy')fall+=rem*px*FILL_FEE;else rise+=rem*px;}return {fall,rise};}
// Unexplained cash change per market since the previous observation, or null when it cannot be judged now.
function unexplained(prev,now,orders){
  // An order missing from the previous reading's fills had none then, unless it was already seen filled before it.
  // Readings saved before fills were kept fall back to the orders placed in between.
  const change=o=>{const effect=cashEffect(o);if(!prev.fills)return o.createdAt>prev.at&&o.createdAt<=now.at?effect:0;
    const before=Object.hasOwn(prev.fills,orderKey(o))?prev.fills[orderKey(o)]:Number.isFinite(o.filledObservedAt)&&o.filledObservedAt<=prev.at?effect:0;return effect-before;};
  const moved=orders.map(o=>({market:o.market??'KR',amount:change(o)})).filter(m=>Math.abs(m.amount)>=0.005);
  const usTraded=moved.some(m=>m.market==='US');
  if(!Number.isFinite(now.krCash)||!Number.isFinite(prev.krCash))return null;
  // Without both U.S. readings a U.S. fill funded from KRW could look like a withdrawal.
  const usKnown=Number.isFinite(now.usCash)&&Number.isFinite(prev.usCash);if(usTraded&&!usKnown)return null;
  const explained=market=>moved.filter(m=>m.market===market).reduce((sum,m)=>sum+m.amount,0);
  // usAdjust: the settlement tracker's own changes to the U.S. basis since the previous reading (stage 2b.4), less a
  // pre-tracking fill's part for an order whose fill this comparison explains already (usPretracking, by order).
  const pre=now.usPretracking??{},overlap=orders.filter(o=>(o.market??'KR')==='US'&&Math.abs(change(o))>=0.005&&Number.isFinite(pre[String(orderKey(o))])).reduce((n,o)=>n+pre[String(orderKey(o))],0);
  // C1d-2: what the funding-transfer recorder booked or saw settle in between (cumulative amounts, so a reading the
  // detector did not judge loses nothing).
  const fund=m=>(Number(now.funding?.[m])||0)-(Number(prev.funding?.[m])||0);
  return {KR:now.krCash-prev.krCash-explained('KR')-fund('KR'),US:usKnown?now.usCash-prev.usCash-explained('US')-((Number(now.usAdjust)||0)-overlap)-fund('US'):0,usTraded};
}
// Whether an amount in a market's currency is large enough to matter (U.S. amounts at the rate, or $10 without one).
const big=(market,amount,fx)=>market==='US'?(fx>0?Math.abs(amount*fx)>=THRESHOLD_KRW:Math.abs(amount)>=10):Math.abs(amount)>=THRESHOLD_KRW;
const near=(a,b,floor)=>Math.abs(a-b)<=Math.max(floor,Math.abs(b)*0.03);
const round=(market,amount)=>market==='US'?Math.round(amount*100)/100:Math.round(amount);
// Which flows an unexplained change within one reading amounts to: none below the threshold. KRW and USD changes that
// offset each other are money moving between the two markets: a transfer pair, so each market's own returns stay right;
// transfers do not count in the combined account.
function flowsFrom(u,fx){
  const usKRW=fx>0?u.US*fx:null;
  if(usKRW!=null&&!big('KR',u.KR+usKRW))return big('KR',u.KR)&&big('US',u.US,fx)?[{market:'KR',amount:Math.round(u.KR),transfer:true},{market:'US',amount:Math.round(u.US*100)/100,transfer:true}]:[];
  const out=[];if(big('KR',u.KR))out.push({market:'KR',amount:Math.round(u.KR)});
  if(big('US',u.US,fx))out.push({market:'US',amount:Math.round(u.US*100)/100});
  return out;
}
// The window a set of changes happened in: after the earliest reading before any of them, by the last reading of any.
const spanOf=parts=>{const after=parts.map(x=>x.after);return {occurredAfter:after.every(Number.isFinite)?Math.min(...after):null,occurredBy:Math.max(...parts.map(x=>x.by))};};
// The flows a held change is recorded as. Changes all in one direction each stay a flow of their own with their own
// window (a small one joins the change before it, or after it when first, widening that window to cover both), so a
// flow before the day's baseline and one after it are told apart. Changes in both directions (a partial reversal) are
// one flow of the net amount whose window covers all of them: when it happened is then only known that widely. The
// amounts always sum to the held amount.
const idsOf=parts=>parts.map(x=>x.id).filter(Boolean);
function piecesOf(m,q,fx){const parts=q.parts?.length?q.parts:[{amount:q.amount,after:q.after??null,by:q.since}];
  if(parts.some(x=>Math.sign(x.amount)!==Math.sign(q.amount)))return [{amount:q.amount,...spanOf(parts),pendingIds:idsOf(parts),mixed:true}];
  const merged=[];for(const x of parts){const last=merged[merged.length-1];if(last&&(!big(m,x.amount,fx)||!big(m,last.amount,fx)))merged[merged.length-1]={amount:last.amount+x.amount,parts:[...last.parts,x]};else merged.push({amount:x.amount,parts:[x]});}
  if(merged.length>1&&!big(m,merged[0].amount,fx)){const [a,b]=merged.splice(0,2);merged.unshift({amount:a.amount+b.amount,parts:[...a.parts,...b.parts]});}
  const out=merged.map(g=>({amount:round(m,g.amount),...spanOf(g.parts),pendingIds:idsOf(g.parts)}));out[out.length-1].amount=round(m,q.amount-out.slice(0,-1).reduce((n,x)=>n+x.amount,0));return out;}
// M-3.2: each held change, at every reading: marked couldBeFill while open orders of its market could explain it (its
// direction, and within their envelope); the time the mark clears is kept, and the 2-hour hold runs from it.
function markFills(state,orders,at){for(const m of ['KR','US']){const q=state.pending[m];if(!q)continue;const env=fillEnvelope(orders,m),room=q.amount<0?env.fall:env.rise;
    const could=room>0&&Math.abs(q.amount)<=room;if(q.couldBeFill&&!could)q.fillClearedAt=at;if(could)q.couldBeFill=true;else delete q.couldBeFill;}}
const label=market=>market==='US'?'U.S.':'Korean';
const money=(market,amount)=>market==='US'?`$${Math.abs(amount).toFixed(2)}`:`₩${Math.abs(Math.round(amount)).toLocaleString('en-US')}`;
class FlowDetector {
  constructor(db,performance,clock=Date.now){this.db=db;this.performance=performance;this.clock=clock;this.onNote=null;db.exec('CREATE TABLE IF NOT EXISTS flow_watch(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  // Records and returns the flows resolved at this observation; the observation advances only when it was judged.
  // provisionalKRW: unsettled U.S. buys whose funding is not yet known (KRW or USD); unsettledKRW: all unsettled U.S. buys.
  // usExplained({afterId, since}): {usd, through}: USD the settlement tracker moved the U.S. basis by after the last
  // ledger event the previous reading accounted for (or since its time) without cash or a fill (InFlight.explained);
  // (A late pre-tracking fill or a correction is no deposit or withdrawal. S5: the coverage under review, usReview, is
  // gone; a stored usReview, always 0, is not read.)
  // funding: the recorder's cumulative explained amounts {KR, US} (electron/funding-transfers.cjs explained).
  observe(account,{krCash,usCash=null,fx=null,orders=[],provisionalKRW=0,provisionalOutsideKRW=null,unsettledKRW=0,usExplained=null,funding=null}){
    if(typeof account!=='string'||!account||!Number.isFinite(krCash))return [];
    const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);let prev=row?JSON.parse(row.payload):null;
    // Fills of orders missing from this reading (for example U.S. orders before the U.S. account loads) are kept as last seen.
    // The tracker's explained change since the previous reading; the reading keeps the last ledger event it covers.
    let usAdjust=0,usPretracking={},usEvent=prev?.usEvent??null;if(usExplained){try{const x=usExplained(prev?{afterId:prev.usEvent??null,since:prev.at,from:prev.at}:{afterId:Number.MAX_SAFE_INTEGER});if(prev){usAdjust=Number(x?.usd)||0;usPretracking=x?.pretracking??{};}if(Number.isFinite(x?.through))usEvent=x.through;}catch{usAdjust=0;}}
    const now={at:this.clock(),krCash,usCash:Number.isFinite(usCash)?usCash:null,basis:BASIS,provisionalKRW:Math.round(Number(provisionalKRW)||0),provOut:Math.round(Number.isFinite(provisionalOutsideKRW)?provisionalOutsideKRW:Number(provisionalKRW)||0),unsettledKRW:Math.round(Number(unsettledKRW)||0),fills:{...(prev?.fills??{}),...fillsOf(orders)},usEvent,...(funding?{funding:{KR:Number(funding.KR)||0,US:Number(funding.US)||0}}:{})};
    // Provisional changes and settlement evidence carry over between readings. (S4b-1: settlement-timing entries are no
    // longer kept; a stored one is dropped at this save.)
    const state={pending:{...(prev?.pending??{})},settled:(prev?.settled??[]).filter(s=>now.at-s.at<=EVIDENCE_MS)};
    // A change held since before parts were kept: when its later additions happened is unknown, so its one part spans
    // from before its first change to the last reading.
    for(const [m,q] of Object.entries(state.pending))if(q&&!Array.isArray(q.parts))state.pending[m]={...q,parts:[{id:randomUUID(),amount:q.amount,after:q.after??null,by:prev?.at??q.since}]};
    // A later change in a held market: added to it as a part of its own, in the window since the previous reading.
    // M-3.2: a change with no cash move in its market is only a fill being counted that the held change already holds (KIS
    // showed it first): it joins the last part, so the held change stays one flow with that part's window.
    const add=(held,m,amount)=>{held.amount=round(m,held.amount+amount);const cashMoved=m==='US'?now.usCash!==prev.usCash:now.krCash!==prev.krCash,last=held.parts[held.parts.length-1];
      if(!cashMoved&&last){held.parts=[...held.parts.slice(0,-1),{...last,amount:round(m,last.amount+amount)}];return;}
      held.parts=[...held.parts,{id:randomUUID(),amount:round(m,amount),after:prev.at??null,by:now.at}];};
    const save=()=>this.db.prepare('INSERT INTO flow_watch VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify({...now,...state}));
    // A Korean reading of another basis (for example before KRW committed to unsettled U.S. buys was netted out): start
    // again, dropping changes held on the old basis. A U.S. reading of another basis starts the U.S. comparison here,
    // as when the U.S. balance first loads; the Korean change is still compared.
    const was=basisOf(prev?.basis);
    if(!prev||was.KR!==BASIS.KR){state.pending={};save();return [];}
    if(was.US!==BASIS.US){prev={...prev,usCash:null};delete state.pending.US;}
    // The first reading with U.S. cash after one without it starts the U.S. comparison here (a U.S. fill since then could
    // not be judged without both readings, and waiting for one that will never come would stop detection), but the Korean
    // change is still compared. A U.S. order filled in between may have been funded from KRW, and a fall could be money
    // moved to the U.S. account before its balance was seen: the change is held like any other, marked so the user
    // investigates it rather than taking it for a withdrawal.
    const usStart=prev.usCash==null&&now.usCash!=null;
    // M-3.2: compared with orders open too; a change a fill not yet counted could explain is held (markFills).
    const compare=()=>usStart?unexplained(prev,{...now,usCash:null},orders.filter(o=>(o.market??'KR')!=='US')):unexplained(prev,{...now,usAdjust,usPretracking},orders);
    // When the amount of unknown funding changes (a U.S. buy or its settlement), either market's cash may move by money
    // whose source is not known: the two readings are not compared, and the next comparison starts here.
    // So does any change in the unsettled total while some funding is unknown: which part settled cannot be told.
    // When buys of unknown funding settle, the amount still to be paid is kept as settlement evidence: what settled with
    // unknown funding, less the Korean or U.S. cash that already fell in this reading. Only that outstanding amount can
    // later explain a fall in cash; nothing is kept when the payment was already seen or cannot be measured.
    const pf=prev.provisionalKRW??0;
    // P2 (multi-order, m1/p2-design.md): with a rate the readings are compared even when unattributed KRW changes; only the
    // falls its settlement can explain are taken out (below). Only that settlement case: any other change of it (a report
    // whose funding is unknown, which moves the Korean basis by the confirmed KRW) and a reading without a rate are, as
    // before, not compared.
    if((!(fx>0)||!(pf>now.provisionalKRW&&(prev.unsettledKRW??0)>now.unsettledKRW))&&(pf!==now.provisionalKRW||pf>0&&(prev.unsettledKRW??0)!==now.unsettledKRW)){
      const paidOff=pf-now.provisionalKRW;
      if(pf>0&&(prev.unsettledKRW??0)>now.unsettledKRW&&paidOff>0){const seen=compare();
        // A change that returns a held change to its earlier balance is that reversal (for example dollars from an
        // exchange spent at settlement), not part of the payment.
        if(seen)for(const m of ['KR','US']){const held=state.pending[m];if(held&&seen[m]&&Math.sign(seen[m])!==Math.sign(held.amount)&&!big(m,held.amount+seen[m],fx)){add(held,m,seen[m]);seen[m]=0;}}
        // At the first U.S. reading the U.S. side of the payment was not seen, so it cannot be measured: no evidence is kept.
        const usFall=usStart?Infinity:seen&&seen.US<0?(fx>0?-seen.US*fx:Infinity):0,outstanding=seen?Math.round(paidOff-Math.max(0,-seen.KR)-usFall):0;
        if(outstanding>=THRESHOLD_KRW)state.settled.push({at:now.at,krw:outstanding});}
      markFills(state,orders,now.at);const found=this.resolve(account,state,now,prev,fx);save();return found;}
    const u=compare();if(!u)return [];
    // P2: the provisional KRW that settled in this reading (p) explains falls up to it, USD first (KIS takes U.S. cash before
    // KRW): those parts leave the comparison, and the rest of p is kept as settlement evidence for a later fall. A rise is
    // never taken out (a deposit always shows), and nothing beyond p is (a larger withdrawal leaves its excess).
    {const p=Math.max(0,pf-now.provisionalKRW);
      if(p>0&&fx>0&&(prev.unsettledKRW??0)>now.unsettledKRW){
        // A change that returns a held change to its earlier balance is that reversal, not part of the payment (as before).
        for(const m of ['KR','US']){const held=state.pending[m];if(held&&u[m]&&Math.sign(u[m])!==Math.sign(held.amount)&&!big(m,held.amount+u[m],fx)){add(held,m,u[m]);u[m]=0;}}
        const pOut=Math.max(0,(prev.provOut??pf)-now.provOut),usPart=usStart?0:Math.min(Math.max(0,-(u.US??0))*fx,p,pOut);
        // A Korean fall offsetting a U.S. rise at the rate is the exchange paying the buys (a transfer between the markets, which
        // resolve pairs): left in the comparison, counted only toward what the settlement has been paid.
        const pair=(u.US??0)>0&&(u.KR??0)<0&&!big('KR',(u.KR??0)+(u.US??0)*fx,fx),krPaid=Math.min(Math.max(0,-(u.KR??0)),p-usPart),krPart=pair?0:krPaid;
        if(usPart>0)u.US=round('US',(u.US??0)+usPart/fx);if(krPart>0)u.KR=round('KR',(u.KR??0)+krPart);
        // At the first U.S. reading the U.S. side of the payment was not seen, so it cannot be measured: no evidence (as before).
        const outstanding=usStart?0:Math.round(p-usPart-krPaid),krOnly=Math.min(outstanding,Math.max(0,Math.round(p-pOut))),any=outstanding-krOnly;
        // The part inside the app's buys in flight (p − pOut) can be paid only by a Korean fall: the settlement tracker explains
        // their U.S. payment (seed 252: a withdrawal matched as it). Only the rest may match a U.S. fall.
        if(any>=THRESHOLD_KRW)state.settled.push({at:now.at,krw:any});if(krOnly>=THRESHOLD_KRW)state.settled.push({at:now.at,krw:krOnly,krOnly:true});}}
    // A change starts being held only when it is large; once held, every later change in that market adds to it, so the
    // threshold applies to the accumulated difference (a gradual return to the earlier balance cancels it). Each change
    // keeps its own amount and the window it happened in (fix review 2026-11-05, P1: the accumulated amount took the
    // first change's window, so a deposit after the day's baseline was counted as before it). since stays the first
    // change's time: the hold runs from it, and a later change does not restart the wait.
    // P2: a fall matching a settlement's evidence is its payment before it can join a change already held in that market
    // (a deposit held, then the settlement's Korean fall: they must not net into one flow).
    for(const market of ['KR','US']){const amount=u[market];if(!(amount<0)||!state.pending[market])continue;const krw=market==='US'?(fx>0?amount*fx:null):amount;if(krw==null)continue;
      const ev=state.settled.find(e=>!e.usedKR&&!e.usedUS&&!(market==='US'&&e.krOnly)&&near(Math.abs(krw),e.krw,THRESHOLD_KRW));if(!ev)continue;state.settled=state.settled.filter(e=>e!==ev);u[market]=0;
      try{this.onNote?.('Settlement matched',`${label(market)} cash fell by ${money(market,amount)}, matching the ₩${ev.krw.toLocaleString('en-US')} still to be paid for U.S. buys that settled; not a withdrawal.`);}catch{}}
    for(const market of ['KR','US']){const amount=u[market],held=state.pending[market];if(!amount||!held&&!big(market,amount,fx))continue;
      const mark=usStart&&market==='KR'?{usUnseen:true}:{};
      if(held){Object.assign(held,{funding:held.funding||u.usTraded,...mark});add(held,market,amount);}
      else state.pending[market]={amount:round(market,amount),since:now.at,after:prev.at??null,parts:[{id:randomUUID(),amount:round(market,amount),after:prev.at??null,by:now.at}],funding:u.usTraded,...mark};}
    markFills(state,orders,now.at);const found=this.resolve(account,state,now,prev,fx);save();return found;
  }
  // Money moved since the day's baseline for the loss checks: the recorded flows (PerformanceHistory.flowsSince) and,
  // at once, the changes still held here (independent accounting review of 162d7c9, P1: a deposit held for two hours
  // hid a loss). A held change is unresolved, like a detected flow, never a confirmed deposit or withdrawal, and is
  // placed against the baseline by each part's own window. A part already recorded as a flow (its id is in the flow's
  // pendingIds) is not counted again. A Korean or U.S. change that may be one leg of a transfer between the markets is
  // money moving for that market either way, so it counts the same.
  flowsSince(account,market,since){
    const recorded0=this.performance.flowsSince(account,market,since);const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);
    // (S4b-1: settlement-timing entries no longer widen the range; none is created.)
    const widen=(r,low,high)=>r?{...r,range:{low:round(market,(r.range?.low??0)+low),high:round(market,(r.range?.high??0)+high)}}:r;
    const recorded=recorded0;
    const q=row?JSON.parse(row.payload).pending?.[market]:null;if(!q||!recorded)return recorded;
    const done=new Set(this.performance.flows(account).flatMap(f=>f.pendingIds??[]));
    const parts=(Array.isArray(q.parts)&&q.parts.length?q.parts:[{amount:q.amount,after:q.after??null,by:q.since}]).filter(x=>!x.id||!done.has(x.id));
    const day=Number.isFinite(since)?null:seoulDate(this.clock());let after=0,unsure=0;
    for(const x of parts){if(day!=null){if(seoulDate(x.by)===day)after+=x.amount;continue;}
      if(x.by<=since)continue;if(Number.isFinite(x.after)&&x.after>=since)after+=x.amount;else unsure+=x.amount;}
    // Held parts after or straddling the baseline widen the range part by part.
    const counted=parts.filter(x=>day!=null?seoulDate(x.by)===day:x.by>since);
    return widen({...recorded,unresolved:(recorded.unresolved??0)+after,uncertain:{confirmed:recorded.uncertain?.confirmed??0,unresolved:(recorded.uncertain?.unresolved??0)+unsure},held:{after,uncertain:unsure,parts:parts.map(x=>x.id??null)}},counted.reduce((n,x)=>n+Math.min(0,x.amount),0),counted.reduce((n,x)=>n+Math.max(0,x.amount),0));
  }
  // Provisional changes held now, for the review context and the performance page.
  pending(account){
    const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);const p=row?JSON.parse(row.payload).pending??{}:{};
    return Object.entries(p).map(([market,q])=>({market,currency:market==='US'?'USD':'KRW',amount:q.amount,since:new Date(q.since).toISOString(),...(q.usUnseen?{usBalanceUnseen:true}:{})}));
  }
  resolve(account,state,now,prev,fx){
    const p=state.pending,out=[];const note=(title,message)=>{try{this.onNote?.(title,message);}catch{}};
    // Balances back where they were: nothing happened that needs recording.
    for(const m of ['KR','US'])if(p[m]&&!big(m,p[m].amount,fx)){note('Cash change reversed',`${label(m)} cash returned to its earlier level; nothing recorded.`);delete p[m];}
    // M-1c: a change you have already recorded yourself (a deposit or withdrawal of this market, the same direction, an
    // amount within the threshold, dated within the change's window and not yet explaining another change) is that
    // flow: it is not recorded again, and its held parts are marked as explained by it (a deposit the user
    // recorded while the change was held was otherwise detected again the next morning).
    for(const m of ['KR','US']){const q=p[m];if(!q)continue;const mine=this.recordedByYou(account,m,q,now.at,fx);if(!mine)continue;
      this.performance.explainHeld(account,mine.id,{pendingIds:idsOf(q.parts??[]),at:now.at});
      note('Recorded flow matched',`${label(m)} cash ${q.amount>0?'rose':'fell'} by ${money(m,q.amount)}, matching the ${mine.amount>0?'deposit':'withdrawal'} you recorded for ${mine.day}; it is not recorded again.`);delete p[m];}
    // Offsetting at the exchange rate: money moving between the markets.
    if(p.KR&&p.US&&!p.KR.couldBeFill&&!p.US.couldBeFill&&fx>0&&!big('KR',p.KR.amount+p.US.amount*fx,fx)){
      const kr=p.KR.amount,us=p.US.amount,day=seoulDate(Math.max(p.KR.since,p.US.since)),funding=p.KR.funding||p.US.funding;
      const settling=now.unsettledKRW>0||(prev.unsettledKRW??0)>0||state.settled.length>0;
      const window=spanOf([...p.KR.parts,...p.US.parts]);
      const prior=!funding&&settling?this.recordedTransfer(account,kr,us,now.at):null;
      if(prior){this.performance.markExchanged(account,prior.map(f=>f.id),{at:now.at,KRW:kr,USD:us});
        note('Currency exchange matched',`${money('KR',kr)} exchanged into ${money('US',us)} completes the transfer between markets recorded on ${prior[0].day}; it is not counted again.`);}
      else out.push(...[['KR',kr],['US',us]].map(([market,amount])=>this.performance.addFlow(account,{day,market,amount,transfer:true,...window,pendingIds:idsOf((market==='KR'?p.KR:p.US).parts??[]),...(funding?{awaitingExchange:true}:{source:'exchange'}),
        note:funding?`Transfer between markets: ${amount<0?'out of':'into'} the ${market==='US'?'U.S.':'Korean'} account (integrated-margin funding of a U.S. buy).`:`Transfer between markets: ${amount<0?'out of':'into'} the ${market==='US'?'U.S.':'Korean'} account (currency exchange).`})));
      delete p.KR;delete p.US;}
    // A fall in Korean or U.S. cash matching the outstanding payment for U.S. buys that settled while their funding was
    // unknown is that payment; the settlement record is used up. A fall that does not match stays held.
    for(const m of ['KR','US']){const q=p[m];if(!q||q.amount>=0)continue;const krw=m==='US'?(fx>0?q.amount*fx:null):q.amount;if(krw==null)continue;
      const s=state.settled.find(e=>!e.usedKR&&!e.usedUS&&!(m==='US'&&e.krOnly)&&near(Math.abs(krw),e.krw,THRESHOLD_KRW));if(!s)continue;state.settled=state.settled.filter(e=>e!==s);
      note('Settlement matched',`${label(m)} cash fell by ${money(m,q.amount)}, matching the ₩${s.krw.toLocaleString('en-US')} still to be paid for U.S. buys that settled; not a withdrawal.`);delete p[m];}
    // Nothing explains it after the hold: a detected flow for the user to confirm or remove.
    // M-3.2: a change an open order's fill not yet counted could explain waits for that order; once none can, its hold runs
    // from then (fillClearedAt), not from when it began.
    for(const m of ['KR','US']){const q=p[m];if(!q||q.couldBeFill)continue;const age=now.at-Math.max(q.since,q.fillClearedAt??-Infinity),krw=m==='US'?(fx>0?q.amount*fx:null):q.amount;
      const couldSettle=now.provisionalKRW>0&&(m==='KR'?q.amount<0:q.amount>0)&&(krw==null||Math.abs(krw)<=now.provisionalKRW*1.05+THRESHOLD_KRW);
      if(age<HOLD_MS||couldSettle&&age<MAX_HOLD_MS)continue;
      const unseen=q.usUnseen?' The U.S. balance could not be compared first, so a move to or from the U.S. account cannot be ruled out.':'';
      const pieces=piecesOf(m,q,fx);
      pieces.forEach((x,i)=>out.push(this.performance.addFlow(account,{day:seoulDate(x.occurredBy),market:m,amount:x.amount,detected:true,occurredAfter:x.occurredAfter,occurredBy:x.occurredBy,pendingIds:x.pendingIds,
        note:`Detected: ${label(m)} cash ${x.amount>0?'rose':'fell'} with no matching trade${pieces.length>1?` (${i+1} of ${pieces.length})`:x.mixed?' (net, in both directions)':''}.${unseen} Confirm or remove.`.slice(0,200)})));delete p[m];}
    return out;
  }
  // A deposit or withdrawal you recorded that explains a held change (M-1c): not detected, not a transfer, not already
  // explaining a change (no pendingIds), same market and sign, the amount within the detection threshold, and its date
  // between the Seoul day of the change's earliest possible time and today. The first such flow by recording time.
  recordedByYou(account,m,q,at,fx){if(typeof this.performance?.explainHeld!=='function'||typeof this.performance?.flows!=='function')return null;const starts=(q.parts??[]).map(x=>x.after).filter(Number.isFinite);const from=seoulDate(starts.length?Math.min(...starts):Number.isFinite(q.after)?q.after:q.since),to=seoulDate(at);
    return this.performance.flows(account).filter(f=>f.market===m&&!f.detected&&!f.transfer&&!(f.pendingIds?.length)&&Math.sign(f.amount)===Math.sign(q.amount)&&!big(m,f.amount-q.amount,fx)&&f.day>=from&&f.day<=to)
      .sort((a,b)=>(a.createdAt??0)-(b.createdAt??0))[0]??null;}
  // A transfer pair recorded in the last MATCH_DAYS days as funding awaiting its exchange (or by the user), not yet
  // completed, with the same direction and amounts within 3% (exchange rates differ between the two moments).
  recordedTransfer(account,kr,us,at){
    const since=seoulDate(at-MATCH_DAYS*86400000);const open=this.performance.flows(account).filter(f=>f.transfer&&!f.exchangedAt&&f.source!=='exchange'&&f.day>=since);
    for(const k of open.filter(f=>f.market==='KR'&&Math.sign(f.amount)===Math.sign(kr)&&near(f.amount,kr,THRESHOLD_KRW))){
      const u=open.find(f=>f.market==='US'&&f.day===k.day&&Math.abs(f.createdAt-k.createdAt)<=60000&&Math.sign(f.amount)===Math.sign(us)&&near(f.amount,us,10));if(u)return [k,u];}
    return null;
  }
}
module.exports={FlowDetector,unexplained,flowsFrom,cashEffect,THRESHOLD_KRW,HOLD_MS,MAX_HOLD_MS,BASIS};
