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
// Item 9 (artifacts/reviews/2026-11-17-deposit-detection/design-note.md, cleared): a rise is recorded after SHORT_MS
// instead of HOLD_MS when nothing else the detector knows can explain it at that reading (shortReason is null): no open
// order could fill it, it came with no U.S. buy, no settlement of any kind is in progress, the U.S. balance was compared,
// the other market shows no held change, and the other market's balance has been read OTHER_READS times since the
// change's last part (readAt, the snapshots' times; without them nothing is recorded early). Falls keep HOLD_MS.
// R1: while such a record is unconfirmed and under HOLD_MS old, any new unexplained part in its market or a change in
// the other market takes it back into pending with its parts, and resolve runs as it would have under HOLD_MS.
const SHORT_MS=10*60000,OTHER_READS=2;
// An outside fill's stored effect is kept while its order day is within 110 days (fills of 100 days are compared).
const metaKept=(k,t)=>{const m=/^kis:(\d{4})(\d{2})(\d{2}):/.exec(k);return !m||Date.parse(m[1]+'-'+m[2]+'-'+m[3]+'T00:00:00+09:00')>=t-110*86400000;};
// Orders made outside the app (outside-fills.cjs): the history older than this keeps a Korean rise on the long hold, and
// a question about a deposit or withdrawal you confirmed that such an order explains is shown for at most ASK_MS.
const ORDERS_STALE_MS=3*60000,ASK_MS=7*86400000;
// Whether a recorded flow's window holds a fill at t (the only reader of a recorded window here: an outside order's fill
// is matched to the detected flow its cash went into; KIS moves cash at the fill or a little after, 10 minutes of slack).
const holdsFill=(x,t,slack=10*60000)=>Number.isFinite(x.occurredBy)?t<=x.occurredBy&&(!Number.isFinite(x.occurredAfter)||t>=x.occurredAfter-slack):x.day===seoulDate(t);
const {describe}=require('./outside-fills.cjs');
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
  // readAt {KR, US}: when each market's balance was read (item 9; the short hold counts the other market's reads).
  // krwUnpaid: the route's KRW for U.S. buys not yet seen leaving Korean cash (item 9: any settlement keeps the long hold).
  // outside: Korean fills KIS lists that the app did not send (outside-fills.cjs), counted like the app's own fills (found
  // in live use: a sale made in the KIS app was recorded as a deposit). ordersThrough: the time up to which the day's KIS
  // order history is known to be complete (null: not read); a Korean rise is recorded early only once the history was
  // read after it. Both are left out by callers that do not track orders made outside the app.
  // One reading is one transaction: a flow it settles or records and the saved reading are written together, so an error
  // between them leaves neither.
  // Its notes are sent once the reading is saved, so a reading rolled back sends none.
  observe(account,options){const send=this.onNote,notes=[];this.onNote=(title,message)=>notes.push([title,message]);this.db.exec('SAVEPOINT flow_observe');
    try{const found=this.observeReading(account,options??{});this.db.exec('RELEASE flow_observe');this.onNote=send;for(const [t,m] of notes)try{send?.(t,m);}catch{}return found;}
    catch(error){this.onNote=send;try{this.db.exec('ROLLBACK TO flow_observe');this.db.exec('RELEASE flow_observe');}catch{}throw error;}}
  // Your Remove of a detected flow (main.cjs performance:remove-flow): remembered as yours, so an order made outside the app
  // that later explains it is not counted again (recordedForFill). The app's own removals never mark it.
  noteRemoved(account,id){const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);if(!row)return;const w=JSON.parse(row.payload);
    if(!(w.recorded??[]).some(x=>x.id===id))return;w.recorded=w.recorded.map(x=>x.id===id?{...x,removedBy:'you'}:x);this.db.prepare('UPDATE flow_watch SET payload=? WHERE account=?').run(JSON.stringify(w),account);}
  observeReading(account,{krCash,usCash=null,fx=null,orders=[],provisionalKRW=0,provisionalOutsideKRW=null,unsettledKRW=0,usExplained=null,funding=null,readAt=null,krwUnpaid=0,outside=null,ordersThrough=undefined}){
    if(typeof account!=='string'||!account||!Number.isFinite(krCash))return [];
    const tracked=Array.isArray(outside);
    // A large fill waiting for KIS's fee figure is not counted yet; while one waits, a Korean rise keeps the long hold.
    const awaiting=tracked&&outside.some(f=>f.awaitingCharge);if(tracked)outside=outside.filter(f=>!f.awaitingCharge);
    const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);let prev=row?JSON.parse(row.payload):null;
    // An order made outside the app keeps the cash effect it was first counted with (a later estimate, from a changed cost
    // profile, never moves it); only KIS's figure replaces an estimate, once, and a fill that grows is counted anew.
    if(tracked){const meta=prev?.outsideMeta??{};outside=outside.map(f=>{const k=orderKey(f),m=meta[k],was=prev?.fills?.[k];if(!m||!Number.isFinite(was))return f;
        const grew=m.filled!==f.filled,reported=m.basis!=='broker'&&f.resultCosts?.basis==='broker';return grew||reported?f:{...f,resultCosts:{...f.resultCosts,netCash:was,basis:m.basis}};});
      orders=[...orders,...outside];}
    // Fills of orders missing from this reading (for example U.S. orders before the U.S. account loads) are kept as last seen.
    // The tracker's explained change since the previous reading; the reading keeps the last ledger event it covers.
    let usAdjust=0,usPretracking={},usEvent=prev?.usEvent??null;if(usExplained){try{const x=usExplained(prev?{afterId:prev.usEvent??null,since:prev.at,from:prev.at}:{afterId:Number.MAX_SAFE_INTEGER});if(prev){usAdjust=Number(x?.usd)||0;usPretracking=x?.pretracking??{};}if(Number.isFinite(x?.through))usEvent=x.through;}catch{usAdjust=0;}}
    const now={at:this.clock(),krCash,usCash:Number.isFinite(usCash)?usCash:null,basis:BASIS,provisionalKRW:Math.round(Number(provisionalKRW)||0),provOut:Math.round(Number.isFinite(provisionalOutsideKRW)?provisionalOutsideKRW:Number(provisionalKRW)||0),unsettledKRW:Math.round(Number(unsettledKRW)||0),fills:{...Object.fromEntries(Object.entries(prev?.fills??{}).filter(([k])=>metaKept(k,this.clock()))),...fillsOf(orders)},usEvent,...(funding?{funding:{KR:Number(funding.KR)||0,US:Number(funding.US)||0}}:{}),
      // Item 9: the snapshots' read times, unpaid KRW of the route, and whether a U.S. balance was ever read for this account.
      ...(readAt&&typeof readAt==='object'?{readAt:{KR:Number.isFinite(readAt.KR)?readAt.KR:null,US:Number.isFinite(readAt.US)?readAt.US:null}}:{}),krwUnpaid:Math.round(Number(krwUnpaid)||0),
      usEver:Boolean(prev?.usEver||prev?.usCash!=null||Number.isFinite(usCash)),
      ...(tracked||prev?.outsideSeen?{outsideSeen:true}:{}),...(awaiting?{awaitingCharge:true}:{}),...(ordersThrough!==undefined?{ordersThrough:Number.isFinite(ordersThrough)?ordersThrough:null}:{}),
      // Kept for the fills' whole 100 days, so a fill missing from one reading keeps the effect it was counted with.
      ...(tracked||prev?.outsideMeta?{outsideMeta:{...Object.fromEntries(Object.entries(prev?.outsideMeta??{}).filter(([k])=>metaKept(k,this.clock()))),...(tracked?Object.fromEntries(outside.map(f=>[orderKey(f),{basis:f.resultCosts?.basis??null,filled:f.filled}])):{})}}:{})};
    // Provisional changes and settlement evidence carry over between readings. (S4b-1: settlement-timing entries are no
    // longer kept; a stored one is dropped at this save.)
    const state={pending:{...(prev?.pending??{})},settled:(prev?.settled??[]).filter(s=>now.at-s.at<=EVIDENCE_MS),
      // A deposit or withdrawal you confirmed that an order made outside the app explains: asked about on Home, never removed.
      ...(prev?.asks?.length?{asks:prev.asks.filter(a=>now.at-a.at<ASK_MS)}:{}),...(prev?.recorded?.length?{recorded:prev.recorded.filter(x=>now.at-x.at<MATCH_DAYS*86400000)}:{}),...(prev?.askDone?.length?{askDone:prev.askDone.slice(-40)}:{}),
      // Item 9: short-hold records that may still be taken back (R1), and your act on one (R2), each for HOLD_MS.
      ...(prev?.recent?{recent:{...prev.recent}}:{}),...(prev?.acted?{acted:Object.fromEntries(Object.entries(prev.acted).filter(([,a])=>now.at-a.at<HOLD_MS))}:{})};
    // A change held since before parts were kept: when its later additions happened is unknown, so its one part spans
    // from before its first change to the last reading.
    for(const [m,q] of Object.entries(state.pending))if(q&&!Array.isArray(q.parts))state.pending[m]={...q,parts:[{id:randomUUID(),amount:q.amount,after:q.after??null,by:prev?.at??q.since}]};
    // A later change in a held market: added to it as a part of its own, in the window since the previous reading.
    // M-3.2: a change with no cash move in its market is only a fill being counted that the held change already holds (KIS
    // showed it first): it joins the last part, so the held change stays one flow with that part's window.
    // Item 9: a new part restarts the count of the other market's reads (they must come after the change's last part).
    const add=(held,m,amount)=>{held.amount=round(m,held.amount+amount);held.otherReads=0;const cashMoved=m==='US'?now.usCash!==prev.usCash:now.krCash!==prev.krCash,last=held.parts[held.parts.length-1];
      if(!cashMoved&&last){held.parts=[...held.parts.slice(0,-1),{...last,amount:round(m,last.amount+amount)}];return;}
      held.parts=[...held.parts,{id:randomUUID(),amount:round(m,amount),after:prev.at??null,by:now.at}];};
    const save=()=>this.db.prepare('INSERT INTO flow_watch VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify({...now,...state}));
    // A Korean reading of another basis (for example before KRW committed to unsettled U.S. buys was netted out): start
    // again, dropping changes held on the old basis. A U.S. reading of another basis starts the U.S. comparison here,
    // as when the U.S. balance first loads; the Korean change is still compared.
    const was=basisOf(prev?.basis);
    if(!prev||was.KR!==BASIS.KR){state.pending={};save();return [];}
    if(was.US!==BASIS.US){prev={...prev,usCash:null};delete state.pending.US;}
    // Orders made outside the app. The first reading that has them (an upgrade): fills made before the previous reading are
    // already in its cash, so they count as seen, and a detected flow they explain is settled (settleRecorded). Later, a
    // fill first seen now settles a flow already recorded only when the flow holds exactly its amount (one fill, or the
    // fills first seen together), its cash did not move in this reading, and the history read before this one, taken
    // after the flow, did not list it (then it came after the flow). Any other is counted here like an app fill.
    // The sign of the Korean change held before this reading (its object is changed in place below).
    const heldSign=Math.sign(prev.pending?.KR?.amount??0),moved=now.krCash-prev.krCash;
    const heldHolds=(f,e)=>{const q=prev.pending?.KR;return Boolean(q&&Math.sign(q.amount)===Math.sign(e)&&(q.parts??[]).some(p=>(p.by??q.since)>=f.createdAt&&!big('KR',p.amount-e)));};
    const fresh=[];if(tracked){const seeding=!prev.outsideSeen,fills={...(prev.fills??{})};
      for(const f of outside){const key=orderKey(f),e=Math.round(cashEffect(f)*100)/100;if(Object.hasOwn(fills,key)||!e)continue;
        // A fill a held change of its sign may hold (the change came at or after the order) is not seeded: it is counted, so it
        // explains that change (a sale made while the app was closed, held by the reading before the history was read).
        if(seeding&&f.createdAt<=prev.at&&!heldHolds(f,e)){fills[key]=e;fresh.push({f,key,e,seeded:true});continue;}fresh.push({f,key,e});}
      const held=state.pending.KR;
      for(const sign of [1,-1]){const group=fresh.filter(x=>Math.sign(x.e)===sign&&!x.settled);if(!group.length)continue;
        const tries=[...group.map(x=>[x]),...(group.length>1?[group]:[])];
        for(const set of tries){if(set.some(x=>x.settled))continue;const e=round('KR',set.reduce((n,x)=>n+x.e,0)),live=!set.every(x=>x.seeded);
          if(!big('KR',e,fx))continue;// Not when a held change may be these fills (a part of about their amount, made at or after the order), nor when their
          // cash moved in this reading.
          if(live&&(heldHolds({createdAt:Math.min(...set.map(x=>x.f.createdAt))},e)||!big('KR',moved-e,fx)))continue;
          const flow=this.recordedForFill(account,state,prev,set,e);if(!flow)continue;this.settleRecorded(account,state,flow,set,e);for(const x of set){fills[x.key]=x.e;x.settled=true;}}}
      if(prev.fills||fresh.some(x=>x.seeded||x.settled))prev={...prev,fills};}
    // A fill counted in this comparison: said in Activity, and kept on a change it joins, for the words if it explains it.
    // compared false: the readings were not compared (a U.S. settlement in between); the fill is taken as seen, unsaid.
    // waiting: the change is that fill waiting for its cash (the hold's reason); it ends when Korean cash moves. before stays
    // for the words when the change is explained.
    // When the cash moves, the part the fill made while waiting joins the part of that move: it was the fill counted ahead
    // of its cash, not a change of its own, so a deposit in the same reading is recorded whole, at the move's time.
    const counted=(compared=true)=>{if(!compared)return;const q=state.pending.KR;
      if(q?.outside?.some(x=>x.waiting)&&now.krCash!==prev.krCash){const ids=new Set(q.outside.filter(x=>x.waiting&&x.partId).map(x=>x.partId)),last=q.parts.at(-1);
        if(last&&!ids.has(last.id)){const moved=q.parts.filter(p=>ids.has(p.id));if(moved.length){q.parts=q.parts.filter(p=>!ids.has(p.id)).map(p=>p===last?{...p,amount:round('KR',p.amount+moved.reduce((n,x)=>n+x.amount,0))}:p);}}
        q.outside=q.outside.map(x=>x.waiting?{...x,waiting:false}:x);}
      for(const x of fresh){if(x.seeded||x.settled)continue;
      // before: KIS listed the fill while the cash had not moved yet (its balance lags the fill by minutes) and nothing else
      // was held: the held change is that fill waiting for its cash, never recorded early.
      if(q&&q.parts?.length)q.outside=[...(q.outside??[]),{words:describe(x.f),amount:x.e,...(now.krCash===prev.krCash&&heldSign===0?{before:true,waiting:true,partId:q.parts.at(-1)?.id??null}:{})}].slice(-10);
      try{this.onNote?.('Order outside the app',`Korean cash: ${describe(x.f)}, ${money('KR',x.e)} ${x.e>0?'in':'out'}, is counted as a trade, not as a deposit or withdrawal.${x.f.resultCosts?.basis==='estimate-unread'?" Its fees are estimated: KIS's figure for the order could not be read.":''}`);}catch{}}};
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
      if(pf>0&&(prev.unsettledKRW??0)>now.unsettledKRW&&paidOff>0){const seen=compare();if(seen)this.takeBack(account,state,now,fx,seen);
        // A change that returns a held change to its earlier balance is that reversal (for example dollars from an
        // exchange spent at settlement), not part of the payment.
        if(seen)for(const m of ['KR','US']){const held=state.pending[m];if(held&&seen[m]&&Math.sign(seen[m])!==Math.sign(held.amount)&&!big(m,held.amount+seen[m],fx)){add(held,m,seen[m]);seen[m]=0;}}
        // At the first U.S. reading the U.S. side of the payment was not seen, so it cannot be measured: no evidence is kept.
        const usFall=usStart?Infinity:seen&&seen.US<0?(fx>0?-seen.US*fx:Infinity):0,outstanding=seen?Math.round(paidOff-Math.max(0,-seen.KR)-usFall):0;
        if(outstanding>=THRESHOLD_KRW)state.settled.push({at:now.at,krw:outstanding});}
      counted(false);markFills(state,orders,now.at);const found=this.resolve(account,state,now,prev,fx);save();return found;}
    // Not judged now: the reading does not advance, but a flow settled or fills seen above are kept.
    const u=compare();if(!u){if(fresh.some(x=>x.seeded||x.settled))this.db.prepare('INSERT INTO flow_watch VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify({...prev,...state,outsideSeen:true}));return [];}this.takeBack(account,state,now,fx,u);
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
      // R2: a change that begins after you confirmed or removed an early record carries it, so its note names that record.
      else{const acted=Object.entries(state.acted??{})[0];state.pending[market]={amount:round(market,amount),since:now.at,after:prev.at??null,parts:[{id:randomUUID(),amount:round(market,amount),after:prev.at??null,by:now.at}],funding:u.usTraded,...mark,
        ...(acted?{earlier:{market:acted[0],amount:acted[1].amount,act:acted[1].act}}:{})};if(acted)delete state.acted[acted[0]];}}
    counted();markFills(state,orders,now.at);const found=this.resolve(account,state,now,prev,fx);save();return found;
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
  // Item 9, R1: a short-hold record still unconfirmed and under HOLD_MS old goes back into pending, with its parts, when a
  // new unexplained part arrives in its market (u) or the other market shows a change (u, or one held); resolve then runs
  // as under HOLD_MS (a reversal, net change, exchange pair or the 2 h record). R2: once you confirmed or removed it, your
  // act stands: the record is dropped from this list and kept as `acted` so a later change's note can name it.
  takeBack(account,state,now,fx,u){const note=(title,message)=>{try{this.onNote?.(title,message);}catch{}};
    for(const m of ['KR','US']){const r=state.recent?.[m];if(!r)continue;const o=m==='KR'?'US':'KR';
      // The age as the hold counts it: from when no open order could fill it, if later than the change (planner, minor).
      if(now.at-Math.max(r.q.since,r.q.fillClearedAt??-Infinity)>=HOLD_MS){delete state.recent[m];continue;}
      const flows=this.performance.flows(account),live=r.ids.map(id=>flows.find(f=>f.id===id));
      // Your act: confirmed, removed, or replaced by a flow you recorded yourself (performance.addFlow keeps replaced.id).
      if(live.some(f=>!f||!f.detected)){const yours=flows.some(f=>r.ids.includes(f.replaced?.id));state.acted={...(state.acted??{}),[m]:{at:now.at,amount:r.q.amount,act:yours?'recorded':live.some(f=>!f)?'removed':'confirmed',seen:r.q.since}};delete state.recent[m];continue;}
      // F2 (planner): only a move over the threshold in its own market takes it back (as for the other market); a smaller
      // one is dropped, as it is whenever nothing is held, so a record is not removed and made again for a won.
      const mine=u&&Number.isFinite(u[m])&&big(m,u[m],fx),other=u&&Number.isFinite(u[o])&&big(o,u[o],fx)||Boolean(state.pending[o]);if(!mine&&!other)continue;
      for(const id of r.ids)this.performance.removeFlow(account,id);
      // Taken back, it keeps the 2 h hold ("as today"): no second early record, no second notice for the same money.
      const q=state.pending[m];state.pending[m]=q?{...r.q,amount:round(m,r.q.amount+q.amount),parts:[...r.q.parts,...(q.parts??[])],otherReads:0,takenBack:true}:{...r.q,otherReads:0,takenBack:true};delete state.recent[m];
      note('Detected change reviewed',`${label(m)} cash ${mine?'moved again':`changed with the ${label(o)} account`} within 2 hours of the ${money(m,r.q.amount)} ${r.q.amount>0?'rise':'fall'} recorded early; it is checked again as one change.`);}
    if(state.recent&&!Object.keys(state.recent).length)delete state.recent;}
  // Item 9: counts, for each held change, the other market's reads after its last part: a new snapshot time whose cash
  // was compared in this reading (compared: {KR, US}). F1 (planner): a U.S. snapshot not compared (its cash withheld, for
  // example while it is provisional) is no read.
  countReads(state,now,compared){for(const [m,q] of Object.entries(state.pending)){if(!q)continue;const o=m==='KR'?'US':'KR',t=now.readAt?.[o],lastBy=q.parts?.at(-1)?.by??q.since;
    if(compared[o]&&Number.isFinite(t)&&t>lastBy&&t!==q.otherReadAt){q.otherReads=(q.otherReads??0)+1;q.otherReadAt=t;}}}
  // Item 9: why a held rise cannot be recorded after SHORT_MS now (null: it can). R3: the reasons that keep the long hold
  // are shown on Home and in the note; 'waiting' (the other market not yet read twice) is not one of them.
  shortReason(m,q,state,now,fx){if(!(q.amount>0))return 'fall';if(q.takenBack)return 'it changed again after an early record';if(q.couldBeFill)return 'an open order could fill it';if(q.funding)return 'a U.S. buy filled with it';
    if(q.usUnseen)return 'the U.S. balance was not compared';if(m==='KR'&&now.awaitingCharge)return "an order made outside the app waits for KIS's fee figure";if(q.outside?.some(x=>x.waiting))return 'an order made outside the app is waiting for its cash';if(now.provisionalKRW>0||now.unsettledKRW>0||state.settled.length||now.krwUnpaid>0)return 'U.S. buys are settling';
    if(m==='US'&&!(fx>0))return 'no exchange rate';const o=m==='KR'?'US':'KR';if(state.pending[o])return `the ${label(o)} account changed too`;
    // A Korean rise is recorded early only once KIS's order history was read after it, so an order made outside the app
    // is seen first; a history not read for more than 3 minutes keeps the long hold with its reason.
    if(m==='KR'&&Object.hasOwn(now,'ordersThrough')){const t=now.ordersThrough,lastBy=q.parts?.at(-1)?.by??q.since;
      if(!(Number.isFinite(t)&&t>=lastBy))return !Number.isFinite(t)||now.at-t>ORDERS_STALE_MS?"the day's KIS orders were not read":'waiting';}
    if(!now.readAt)return 'waiting';if((o==='KR'||now.usEver)&&(q.otherReads??0)<OTHER_READS)return 'waiting';return null;}
  // Item 9 section 4 (A; design-note §4a): each held part, for the headline series (PerformanceHistory.held). It counts
  // as a deposit or withdrawal on the Seoul day of its `by` (where its detected flow will fall) unless something else may
  // explain it: an open order's fill (couldBeFill), a U.S. buy filled with it (funding), or U.S. buys of unknown funding
  // settling (provisionalKRW, in the direction a settlement moves cash). Those are named only (counted: false).
  // A part a recorded flow already carries (its pendingIds, as flowsSince's `done`) is never counted again.
  heldParts(account){const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);if(!row)return [];const w=JSON.parse(row.payload),out=[];
    const done=new Set(this.performance.flows(account).flatMap(f=>f.pendingIds??[]));
    for(const [m,q] of Object.entries(w.pending??{})){if(!q)continue;const settling=(w.provisionalKRW??0)>0&&(m==='KR'?q.amount<0:q.amount>0);
      const reason=q.couldBeFill?'an open order may explain it':q.funding?'a U.S. buy filled with it':settling?'U.S. buys are settling':null;
      for(const x of (Array.isArray(q.parts)&&q.parts.length?q.parts:[{amount:q.amount,by:q.since}]))if(!(x.id&&done.has(x.id)))out.push({market:m,amount:x.amount,by:x.by,since:q.since,counted:!reason,...(reason?{reason}:{})});}
    return out;}
  // When the last reading was saved (the days the app did not read start on its day).
  lastAt(account){const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);if(!row)return null;const at=JSON.parse(row.payload).at;return Number.isFinite(at)?at:null;}
  // Provisional changes held now, for the review context and the performance page.
  pending(account){
    const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);const p=row?JSON.parse(row.payload).pending??{}:{};
    return Object.entries(p).map(([market,q])=>({market,currency:market==='US'?'USD':'KRW',amount:q.amount,since:new Date(q.since).toISOString(),...(q.usUnseen?{usBalanceUnseen:true}:{}),...(q.holdReason?{holdReason:q.holdReason}:{}),...(q.couldBeFill?{couldBeFill:true}:{})}));
  }
  resolve(account,state,now,prev,fx){
    const p=state.pending,out=[];const note=(title,message)=>{try{this.onNote?.(title,message);}catch{}};this.countReads(state,now,{KR:Number.isFinite(now.krCash),US:now.usCash!=null&&prev?.usCash!=null});
    // Balances back where they were: nothing happened that needs recording.
    // A change an order made outside the app explains (its fill was counted after the cash moved) says so.
    for(const m of ['KR','US'])if(p[m]&&!big(m,p[m].amount,fx)){const by=p[m].outside??[],sum=by.reduce((n,x)=>n+x.amount,0);
      if(by.length&&by.every(x=>x.before))note('Cash change explained',`${by.map(x=>x.words).join('; ')}: KIS listed it before its cash reached the balance, and the cash has now arrived; nothing recorded.`);
      else if(by.length)note('Cash change explained',`${label(m)} cash ${sum>0?'rose':'fell'} by ${money(m,sum)}: ${by.map(x=>x.words).join('; ')} explains it; nothing recorded.`);
      else note('Cash change reversed',`${label(m)} cash returned to its earlier level; nothing recorded.`);delete p[m];}
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
      // Item 9: a rise nothing else can explain is recorded after SHORT_MS; otherwise the long hold, with its reason kept (R3).
      const why=this.shortReason(m,q,state,now,fx);if(q.amount>0){if(why&&why!=='waiting')q.holdReason=why;else delete q.holdReason;}
      const early=!why&&!couldSettle&&age>=SHORT_MS&&age<HOLD_MS;
      if(!early&&(age<HOLD_MS||couldSettle&&age<MAX_HOLD_MS))continue;
      const unseen=q.usUnseen?' The U.S. balance could not be compared first, so a move to or from the U.S. account cannot be ruled out.':'';
      // R2: your earlier act on a record taken early stands; a change after it says so.
      const earlier=q.earlier?q.earlier.act==='recorded'?` The earlier ${money(q.earlier.market,q.earlier.amount)} change you recorded yourself stands.`:` The earlier ${money(q.earlier.market,q.earlier.amount)} record you ${q.earlier.act} stands.`:'';
      const pieces=piecesOf(m,q,fx),added=[];
      pieces.forEach((x,i)=>{const flow=this.performance.addFlow(account,{day:seoulDate(x.occurredBy),market:m,amount:x.amount,detected:true,occurredAfter:x.occurredAfter,occurredBy:x.occurredBy,pendingIds:x.pendingIds,
        note:`Detected: ${label(m)} cash ${x.amount>0?'rose':'fell'} with no matching trade${pieces.length>1?` (${i+1} of ${pieces.length})`:x.mixed?' (net, in both directions)':''}.${unseen}${earlier}${!early&&x.amount>0&&q.holdReason?` Held 2 h: ${q.holdReason}.`:''} Confirm or remove.`.slice(0,200)});added.push(flow);out.push(flow);
        // Remembered for MATCH_DAYS, so a fill that explains it is not counted again if you remove it (recordedForFill).
        state.recorded=[...(state.recorded??[]),{id:flow.id,market:m,day:flow.day,amount:flow.amount,occurredAfter:flow.occurredAfter??null,occurredBy:flow.occurredBy??null,at:now.at}].slice(-60);});
      if(early){state.recent={...(state.recent??{}),[m]:{ids:added.map(f=>f.id),q:JSON.parse(JSON.stringify(q)),at:now.at}};
        note('Cash change recorded',`${label(m)} cash rose by ${money(m,q.amount)} and nothing else could explain it; recorded after 10 minutes. Confirm or remove it on the Performance page.`);}
      delete p[m];}
    return out;
  }
  // A deposit or withdrawal you recorded that explains a held change (M-1c): not detected, not a transfer, not already
  // explaining a change (no pendingIds), same market and sign, the amount within the detection threshold, and its date
  // between the Seoul day of the change's earliest possible time and today. The first such flow by recording time.
  recordedByYou(account,m,q,at,fx){if(typeof this.performance?.explainHeld!=='function'||typeof this.performance?.flows!=='function')return null;const starts=(q.parts??[]).map(x=>x.after).filter(Number.isFinite);const from=seoulDate(starts.length?Math.min(...starts):Number.isFinite(q.after)?q.after:q.since),to=seoulDate(at);
    return this.performance.flows(account).filter(f=>f.market===m&&!f.detected&&!f.transfer&&!(f.pendingIds?.length)&&Math.sign(f.amount)===Math.sign(q.amount)&&!big(m,f.amount-q.amount,fx)&&f.day>=from&&f.day<=to)
      .sort((a,b)=>(a.createdAt??0)-(b.createdAt??0))[0]??null;}
  // A Korean detected flow (still detected, one you confirmed, or one you removed) that orders made outside the app explain,
  // their fills first seen after the flow was recorded: same sign, the amount within the threshold of theirs (a larger flow
  // is never matched on its window alone), recorded in the last MATCH_DAYS days, not yet asked about, and its window holding
  // the orders (holdsFill: KIS gives the order's time, never later than its fill). Not when the history read before this
  // reading came after the flow: the fills were not listed then, so they came after it. A flow you removed is remembered
  // (state.recorded), so its fill is not counted again elsewhere. The closest amount.
  recordedForFill(account,state,prev,set,e){if(typeof this.performance?.flows!=='function')return null;const t=Math.max(...set.map(x=>x.f.createdAt)),since=this.clock()-MATCH_DAYS*86400000;
    const asked=new Set([...(state.asks??[]).map(a=>a.flowId),...(state.askDone??[])]),seenAfter=x=>Number.isFinite(prev.ordersThrough)&&Number.isFinite(x.occurredBy)&&prev.ordersThrough>=x.occurredBy;
    const fits=x=>x.market==='KR'&&!x.transfer&&!asked.has(x.id)&&(x.createdAt??x.at??0)>=since&&Math.sign(x.amount)===Math.sign(e)&&!big('KR',x.amount-e)&&holdsFill(x,t)&&!seenAfter(x);
    const flows=this.performance.flows(account),ids=new Set(flows.map(x=>x.id));
    const live=flows.filter(x=>(x.detected||Number.isFinite(x.confirmedAt)&&/^Detected/.test(x.note??''))&&fits(x));
    // Removed by you (noteRemoved, from your Remove), never inferred from a flow's absence; a flow you replaced with your own
    // record: that record is asked about, as one you confirmed.
    const gone=(state.recorded??[]).filter(x=>x.removedBy==='you'&&!ids.has(x.id)&&fits({...x,market:x.market??'KR'})).map(x=>({...x,removed:true}));
    const yours=flows.filter(x=>!x.detected&&x.replaced?.id&&(state.recorded??[]).some(r=>r.id===x.replaced.id)&&fits(x));
    // More than one fits (the old release could record a sale's cash and, minutes later, a genuine deposit of about the same
    // amount): the one whose window holds the order without the slack is taken only when exactly one does; otherwise none is
    // withdrawn and you are asked about each still there. One that fits only through the slack while a flow of about this
    // amount that you removed is remembered: asked about, never withdrawn.
    const all=[...live,...yours,...gone];if(!all.length)return null;
    const strict=x=>holdsFill(x,t,0);
    const removedLike=(state.recorded??[]).some(x=>x.removedBy==='you'&&!ids.has(x.id)&&!big('KR',x.amount-e));
    if(all.length===1)return strict(all[0])||!removedLike||all[0].removed?all[0]:{ask:all.filter(x=>!x.removed)};
    const exact=all.filter(strict);if(exact.length===1)return exact[0];
    return {ask:all.filter(x=>!x.removed)};}
  // Settles a recorded flow orders made outside the app explain. Still detected: removed, with a note (never silently).
  // One you confirmed stays; you are asked on Home. One you removed: nothing to change; the fills are not counted again.
  settleRecorded(account,state,flow,set,e){const note=(title,message)=>{try{this.onNote?.(title,message);}catch{}};
    const words=set.map(x=>describe(x.f)).join('; ');
    // Several flows may hold these fills: none is changed; each still there is asked about (the fills count as seen).
    if(flow.ask){if(!flow.ask.length)return;for(const x of flow.ask){if((state.asks??[]).some(a=>a.flowId===x.id))continue;state.asks=[...(state.asks??[]),{flowId:x.id,day:x.day,amount:x.amount,explained:round('KR',e),words,full:true,confirmed:!x.detected,at:this.clock()}];}
      note('Detected change may be a trade',`${words} may explain one of ${flow.ask.length} recorded changes of about its amount; none is removed. Check them on the Performance page.`);return;}
    const kind=flow.amount>0?'deposit':'withdrawal';
    // The app's removal is not your act: an early record it settles leaves the take-back list (R2 would call it yours).
    if(state.recent?.KR?.ids?.includes(flow.id)){state.recent.KR.ids=state.recent.KR.ids.filter(id=>id!==flow.id);if(!state.recent.KR.ids.length){delete state.recent.KR;if(!Object.keys(state.recent).length)delete state.recent;}}
    state.recorded=(state.recorded??[]).filter(x=>x.id!==flow.id);
    if(flow.removed){note('Order outside the app',`${words} matches the ${money('KR',flow.amount)} change detected for ${flow.day} that you removed; it is not counted again.`);return;}
    if(flow.detected){this.performance.removeFlow(account,flow.id);note('Detected change withdrawn',`The ${money('KR',flow.amount)} ${kind} detected for ${flow.day} is ${words}, not a ${kind}; it is removed.`);return;}
    state.asks=[...(state.asks??[]),{flowId:flow.id,day:flow.day,amount:flow.amount,explained:round('KR',e),words,full:true,confirmed:true,at:this.clock()}];
    note('Confirmed deposit may be a trade',`You ${flow.replaced?'recorded':'confirmed'} ${money('KR',flow.amount)} as a ${kind} for ${flow.day}; ${words} explains it. If it was not a ${kind}, remove it on the Performance page.`);}
  // The questions about flows you confirmed (settleRecorded), while the flow is still there, for Home.
  asks(account){const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);if(!row)return [];const w=JSON.parse(row.payload);
    const ids=new Set(typeof this.performance?.flows==='function'?this.performance.flows(account).map(f=>f.id):[]);
    return (w.asks??[]).filter(a=>ids.has(a.flowId)&&this.clock()-a.at<ASK_MS);}
  // You answered a question (kept it, or removed the flow): it is not asked again.
  dismissAsk(account,flowId){const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);if(!row)return;const w=JSON.parse(row.payload);
    w.asks=(w.asks??[]).filter(a=>a.flowId!==flowId);w.askDone=[...(w.askDone??[]),String(flowId)].slice(-40);
    this.db.prepare('UPDATE flow_watch SET payload=? WHERE account=?').run(JSON.stringify(w),account);}
  // A transfer pair recorded in the last MATCH_DAYS days as funding awaiting its exchange (or by the user), not yet
  // completed, with the same direction and amounts within 3% (exchange rates differ between the two moments).
  recordedTransfer(account,kr,us,at){
    const since=seoulDate(at-MATCH_DAYS*86400000);const open=this.performance.flows(account).filter(f=>f.transfer&&!f.exchangedAt&&f.source!=='exchange'&&f.day>=since);
    for(const k of open.filter(f=>f.market==='KR'&&Math.sign(f.amount)===Math.sign(kr)&&near(f.amount,kr,THRESHOLD_KRW))){
      const u=open.find(f=>f.market==='US'&&f.day===k.day&&Math.abs(f.createdAt-k.createdAt)<=60000&&Math.sign(f.amount)===Math.sign(us)&&near(f.amount,us,10));if(u)return [k,u];}
    return null;
  }
}
module.exports={FlowDetector,unexplained,flowsFrom,cashEffect,THRESHOLD_KRW,HOLD_MS,MAX_HOLD_MS,SHORT_MS,OTHER_READS,BASIS};
