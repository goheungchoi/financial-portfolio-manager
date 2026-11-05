// One account valuation (audit 2026-11-04, Stage 2): every consumer reads net equity from here, per currency before FX:
//   net equity = cash assets + long market value + receivables - settlement payables - margin principal
//                - current short liability - accrued financing
// Each component is counted once, says whether it was observed (a broker figure), derived (from the app's own fill
// records or other observed figures) or unknown, and names its source. Unknown is never zero: it makes the value
// incomplete or a range.
// - Korean cash is KIS projected settled cash (prvs_rcdl_excc_amt), which already nets Korean trades awaiting
//   settlement; nothing is added or subtracted for them again. Without it, deposit cash is used and the value is
//   incomplete while Korean trades may be unsettled.
// - U.S. buys paid through integrated margin: KIS keeps their KRW in the Korean deposit until settlement and reports the
//   amount (ustl_buy_amt_smtl), not how it is paid. The part known to be KRW-funded is subtracted in both bounds; the
//   rest is subtracted in the low bound only (it may already have left U.S. cash).
// - U.S. buys filled but in no broker figure yet (inFlight; 2026-10-30: an RDDT buy paid from unsettled sale proceeds
//   was in neither currency until settlement): the fills the tracker holds open, subtracted in the low bound only; which
//   fills KIS's figures cover is decided by the tracker's evidence, never by subtracting KIS's aggregate. U.S. sales
//   filled but not yet in the pending proceeds raise the high bound.
// - Credit accounts (margin loans, short sales) take KIS net assets (nass_amt), which already deduct loans and short
//   obligations, so nothing is deducted twice; the app's own sum is kept beside it as a bridge. Until the field
//   meanings are verified (Stage 3) such a value is marked unverified, not exact; without net assets it is incomplete.
// The headline is the low bound: an estimate whenever the bounds differ, never presented as reconciled.
// 2026-11-05: in-flight U.S. fills are no longer netted against KIS's aggregates (fix review of 34474f7).
const VERSION='net-equity 2026-11-05';
const STALE_MS=15*60000;
const sum=(rows,f)=>rows.reduce((n,r)=>n+f(r),0);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const at=s=>{const t=Date.parse(s?.timestamp??'');return Number.isFinite(t)?t:null;};
// A component: amount as it enters net equity (liabilities negative); low/high when it is a range.
const part=(name,amount,basis,source,extra={})=>({name,amount,low:extra.low??amount,high:extra.high??amount,basis,source,...(extra.note?{note:extra.note}:{})});
function equityOf(components){return {low:sum(components,c=>c.low),high:sum(components,c=>c.high)};}

function korea(k,{us,now}){
  if(!k)return {currency:'KRW',available:false,reasons:['Korean balance not loaded']};
  const reasons=[],components=[];const long=k.holdings??[];
  const settled=finite(k.settledCash)?k.settledCash:null;
  if(settled!=null)components.push(part('cash',settled,'observed','KIS projected settled cash (prvs_rcdl_excc_amt), Korean settlements netted'));
  else{components.push(part('cash',k.cash,'observed','KIS deposit cash (dnca_tot_amt); Korean trades awaiting settlement are not netted'));reasons.push('projected settled cash was not reported, so Korean trades awaiting settlement are not netted');}
  components.push(part('long',sum(long,h=>h.quantity*h.price),'observed','Korean holdings at their latest prices'));
  // U.S. buys awaiting settlement through integrated margin (electron/integrated-settlement.cjs).
  const {unsettledKRW:total,confirmedKRW:known}=require('./integrated-settlement.cjs').settlement(us);
  if(total>0)components.push(part('usBuyFunding',-total,known===total?'observed':'derived','U.S. buys awaiting settlement (ustl_buy_amt_smtl)',{low:-total,high:-known,note:known===total?'paid in KRW':`${Math.round(total-known)} of it may have been paid in USD`}));
  const credit=Boolean(k.loanTotal||k.shortProceeds||(k.shorts??[]).length);let brokerNet=null;
  if(credit){
    const shortLiability=sum(k.shorts??[],s=>s.quantity*s.price);
    const computed=sum(components,c=>c.amount)+(k.shortProceeds??0)-(k.loanTotal??0)-shortLiability;
    brokerNet=finite(k.netAssets)?k.netAssets:null;
    if(brokerNet==null)reasons.push('margin or short positions are open and KIS net assets were not reported');
    // Net assets already deduct loans and short obligations; the U.S. funding adjustment still applies.
    const funding=components.filter(c=>c.name==='usBuyFunding');components.length=0;
    // Stage 3 (U4 unresolved): KIS does not say whether net assets deduct short obligations and interest, nor whether
    // short-sale proceeds are already in projected cash. The value is the range over those readings, the lowest the
    // headline, so an unconfirmed field never becomes trusted equity or a risk input on its own.
    const inCash=computed-(k.shortProceeds??0),readings=[brokerNet,computed,inCash].filter(finite);const lo=Math.min(...readings),hi=Math.max(...readings);
    components.push(part('netAssets',lo,brokerNet!=null?'observed':'derived','KIS net assets (nass_amt), and the app sum with short proceeds counted apart from or inside projected cash',{low:lo,high:hi,note:'credit field meanings unconfirmed (U4)'}),...funding);
    reasons.push('credit field meanings are not yet verified against the KIS contract (Stage 3), and accrued financing is not reported');
    return finish('KRW',k,components,reasons,{credit:{loanTotal:k.loanTotal??null,shortProceeds:k.shortProceeds??null,shortLiability,computedNet:computed,brokerNet},unverified:true},now,{reportedTotal:k.reportedTotal,grossTotal:k.grossTotal??null});
  }
  return finish('KRW',k,components,reasons,{},now,{reportedTotal:k.reportedTotal,bridge:bridge(k,components)});
}
// The Korean value against KIS's own total (tot_evlu_amt, projected cash plus holdings at the broker price), part by
// part: holdings at the latest prices against the broker's prices, the cash in the broker's total against projected
// settled cash, and the U.S. buy funding KIS's total does not net. A nonzero cash difference means the two cash
// figures do not mean the same thing and is reported, not hidden. Null without the broker's figures.
function bridge(k,components){
  const r=k.raw??{};const total=finite(r.tot_evlu_amt)?r.tot_evlu_amt:null,brokerLong=finite(r.scts_evlu_amt)?r.scts_evlu_amt:null;if(total==null||brokerLong==null)return null;
  const get=n=>components.find(c=>c.name===n);const cash=get('cash').amount,long=get('long').amount,funding=get('usBuyFunding');
  const items=[{name:'prices',amount:long-brokerLong,note:'holdings at the latest prices against the broker price'},{name:'cashBasis',amount:cash-(total-brokerLong),note:'projected settled cash against the cash in the KIS total'},...(funding?[{name:'usBuyFunding',amount:funding.low,high:funding.high,note:'U.S. buys awaiting settlement, not netted in the KIS total'}]:[])];
  return {brokerTotal:total,field:'tot_evlu_amt',items,explained:Math.abs(items.find(i=>i.name==='cashBasis').amount)<1};
}
function unitedStates(u,{inFlight,now}){
  if(!u)return {currency:'USD',available:false,reasons:['U.S. balance not loaded']};
  const reasons=[],components=[];
  components.push(part('cash',u.cash,'observed','KIS U.S. deposit (frcr_dncl_amt_2)'));
  const pending=finite(u.pendingSaleProceeds)?Math.max(0,u.pendingSaleProceeds):0;
  // Sales the tracker holds in flight (InFlight below) may be missing from the pending proceeds: they raise the high
  // bound only. Which sales KIS's total covers is the tracker's evidence, never KIS's total less the app's.
  const sells=Math.max(0,inFlight?.sellsUSD??0);
  if(pending>0||sells>0)components.push(part('receivable',pending,'observed','U.S. sale proceeds awaiting settlement (frcr_sll_amt_smtl)',{low:pending,high:pending+sells,...(sells>0?{note:`${sells.toFixed(2)} of filled sales not yet reported by KIS`}:{})}));
  components.push(part('long',sum(u.holdings??[],h=>h.quantity*h.price),'observed','U.S. holdings at their latest prices'));
  // Buys the tracker holds in flight: every open fill, subtracted in the low bound only. Fix review of 34474f7, P1: the
  // amount KIS reports awaiting settlement was subtracted from them, so an older reported purchase cancelled a newer
  // unreported one and a purchase raised equity, labelled exact. Coverage is the tracker's: a fill it matched to KIS
  // evidence is no longer open; one it could not tell apart (unresolved) stays in the low bound, where both obligations
  // count, and out of the high bound, where it may already be counted, and the value says so.
  const buys=Math.max(0,inFlight?.buysUSD??0);
  if(buys>0.005)components.push(part('inFlightBuys',-buys,'derived','U.S. buys the app saw fill that no KIS evidence covers yet (fill records)',{low:-buys,high:0,note:'paid from U.S. cash or proceeds at settlement, or already deducted'}));
  for(const [k,what] of [['buysUSD','buys'],['sellsUSD','sales']]){const u=inFlight?.unresolved?.[k]??0,o=inFlight?.overdue?.[k]??0;if(u>0.005)reasons.push(`$${u.toFixed(2)} of U.S. ${what} in flight may already be in KIS figures: unresolved, so the value is a range`);
    if(o>0.005)reasons.push(`$${o.toFixed(2)} of U.S. ${what} in flight are overdue: no settlement evidence after ${MAX_DAYS} days; reconcile them with KIS`);}
  return finish('USD',u,components,reasons,{},now,{reportedTotal:u.reportedTotal});
}
function finish(currency,s,components,reasons,extra,now,broker){
  const t=at(s);const stale=t==null||now-t>STALE_MS;if(stale)reasons.push(t==null?'balance time unknown':`balance is ${Math.round((now-t)/60000)} minutes old`);
  const missing=components.filter(c=>!finite(c.low)||!finite(c.high));if(missing.length)reasons.push(`not a number: ${missing.map(c=>c.name).join(', ')}`);
  const equity=missing.length?{low:null,high:null}:equityOf(components);
  const complete=!missing.length&&!reasons.some(r=>/not reported|not netted|not a number/.test(r));
  return {currency,available:true,at:t,stale,complete,exact:complete&&!extra.unverified&&equity.high-equity.low<0.005,components,equity,broker,reasons,...extra};
}
// korea, us: the broker snapshots as the app holds them (holdings priced at the latest quotes); fx: {usdKRW, source,
// timestamp}; inFlight: {buysUSD, sellsUSD} from fills KIS may not report yet. Returns both markets and the combined
// value in KRW: low (the headline), high, whether it is exact, complete, which markets it covers and why not.
function value({korea:k=null,us=null,fx=null,inFlight=null,now=Date.now()}={}){
  const rate=fx?.usdKRW>0&&Number.isFinite(fx.usdKRW)?fx.usdKRW:null;
  const KR=korea(k,{us,now}),US=unitedStates(us,{inFlight,now});
  const reasons=[...(KR.available?[]:['Korean balance not loaded']),...(US.available?[]:['U.S. balance not loaded'])];
  const usLow=US.equity?.low,usHigh=US.equity?.high;const usZero=US.available&&usLow===0&&usHigh===0;
  if(US.available&&rate==null&&!usZero)reasons.push('no USD/KRW rate');
  const scope=[...(KR.available?['KR']:[]),...(US.available&&(rate!=null||usZero)?['US']:[])];
  const conv=v=>v==null?null:v*(rate??0);
  const low=scope.length&&scope.every(m=>(m==='KR'?KR:US).equity.low!=null)?(scope.includes('KR')?KR.equity.low:0)+(scope.includes('US')?conv(usLow):0):null;
  const high=low==null?null:(scope.includes('KR')?KR.equity.high:0)+(scope.includes('US')?conv(usHigh):0);
  const complete=scope.length===2&&KR.complete&&US.complete;
  for(const [m,v] of [['Korea',KR],['U.S.',US]])if(v.available)for(const r of v.reasons)reasons.push(`${m}: ${r}`);
  return {version:VERSION,at:now,fx:rate?{usdKRW:rate,source:fx.source??null,at:at(fx)}:null,markets:{KR,US},
    combined:{low,high,headline:low,exact:complete&&KR.exact&&US.exact&&high-low<0.5,complete,scope,stale:[KR,US].some(v=>v.available&&v.stale),reasons}};
}
// U.S. fills KIS may not reflect yet (value's inFlight), decided by evidence at each U.S. balance reading:
// - each order's fills are kept as its cumulative execution amount (KIS net cash when known, otherwise gross) and
//   quantity. A reading adds the new cumulative amount less the last one (fix review 2026-11-05, P2: the new quantity
//   at the new average misstated a partial fill whose average moved), so an order's pieces sum to its final amount to
//   the cent. A changed amount at the same quantity (a price correction, or fees becoming known) corrects the order's
//   open pieces; each piece says whether its amount is net of fees or gross;
// - new pieces are compared with the previous reading: if U.S. cash plus pending proceeds already moved by their
//   amount, KIS reflects them; otherwise they are in flight;
// - fills in flight leave on evidence. Each piece of evidence is a change first seen at one reading, recorded with its
//   time, the fills open then and what it was allocated to, and used at most once (fix review 2026-11-05, P1):
//   - a rise since the previous reading in what KIS reports awaiting settlement for a side (ustl_buy_amt_smtl / sales)
//     settles the oldest open fills of that side whose total it matches within the tolerance either way. A rise that
//     matches none is recorded as unmatched and is not carried forward: a fill seen later stays open, marked
//     unresolved, because KIS may have reported it before the app saw it fill;
//   - a cash movement settles fills of a side while only that side is open (buys and sales together net, so it cannot
//     be divided). A fall in reported buys (with the fall in U.S. cash that comes with it) is a reported buy settling:
//     it settles only fills marked unresolved for having been reported before they were seen, which it resolves;
//   - cash and the reported total are not independent: one purchase may show in both, in one reading or apart (fix
//     review of 34474f7, P1). Every allocation through one channel, new fills reflected at once included, is recorded
//     and paired with a later (or same-reading) allocation of the same amount and side through the other channel within
//     PAIR_DAYS; the fills the second would clear stay open, marked unresolved, instead of being cleared twice. A
//     reported trade settling with a cash payment resolves them: cash has then gone out for both, whichever was which;
//   - a reported rise matching no open fill while fills of its side are open may cover part of them: they are marked
//     unresolved;
//   - a movement that matches no run of open fills (an unrelated deposit or withdrawal) settles nothing;
// - a reading older than the last one is ignored;
// - the first reading: a fill listed then (or filled before tracking started and listed later) is history only when its
//   settlement date has certainly passed (SETTLED_AFTER_DAYS calendar days after it filled: T+1 with a weekend and a
//   holiday). Any other stays in flight, unresolved: no earlier reading is no evidence that KIS reflects it
//   (independent accounting review of 162d7c9, P1). Those KIS's reported total could cover are marked as possibly
//   reported; evidence resolves them like any other fill;
// - a fill with no evidence after MAX_DAYS is marked overdue, noted once, and stays in flight, unresolved: time alone
//   never removes an obligation, raises equity or frees buying capacity (same review, P1: a fill was dropped as settled).
// The state (open fills, cumulative amounts, the last reading, the evidence) survives restarts (inflight_settlement).
// orders: the U.S. engine's.
const MAX_DAYS=7,PAIR_DAYS=4,SETTLED_AFTER_DAYS=5,TOLERANCE=0.95,EVIDENCE_KEPT=60,DAY=86400000;
// When an order filled: when the app saw it filled, or failing that when it was placed.
const fillTime=o=>Number.isFinite(o.filledObservedAt)?o.filledObservedAt:Number.isFinite(o.createdAt)?o.createdAt:Date.parse(o.createdAt??'');
// Why a fill may already be covered by what KIS reports awaiting settlement.
const REPORTED=['reported before seen','reported total moved by an unmatched amount'];
const cents=v=>Math.round(v*100);
class InFlight {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS inflight_settlement(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  state(account){const r=this.db.prepare('SELECT payload FROM inflight_settlement WHERE account=?').get(account);return r?JSON.parse(r.payload):{basis:null,seen:{},open:[],evidence:[]};}
  // An order's cumulative execution amount in cents and its basis: KIS net cash when known (fees included), otherwise gross.
  static amountOf(o){const net=o.resultCosts?.netCash;return Number.isFinite(net)?{cents:Math.abs(cents(net)),basis:'net'}:{cents:cents(o.filled*o.fillPrice),basis:'gross'};}
  // A fill from before tracking started: history (null) when its settlement date has certainly passed, else an open piece.
  static early(o,id,a,now){const t=fillTime(o);if(Number.isFinite(t)&&now-t>=SETTLED_AFTER_DAYS*DAY)return null;
    return {id,side:o.side,usd:a.cents/100,basis:a.basis,at:now,filledAt:Number.isFinite(t)?t:null,unresolved:{why:'present before tracking started',at:now}};}
  // The oldest open fills of a side whose total matches an amount within the tolerance either way; failing that, the
  // oldest single fill that matches it alone; or none.
  static match(open,amount){if(!(amount>0))return [];const fits=t=>amount>=TOLERANCE*t&&amount<=t/TOLERANCE;let total=0;const run=[];
    for(const f of open){total+=f.usd;run.push(f);if(fits(total))return [...run];if(total>amount/TOLERANCE)break;}const one=open.find(f=>fits(f.usd));return one?[one]:[];}
  // us: the U.S. balance just read (cash, pendingSaleProceeds, unsettled, timestamp); fx: USD/KRW. Returns {buysUSD,
  // sellsUSD, unresolved: the part of each marked unresolved, open, notes}.
  observe(account,{us,orders=[],fx=null}){
    if(typeof account!=='string'||!account||!us)return {...InFlight.totals({open:[]}),notes:[]};
    const now=this.clock(),st=this.state(account),notes=[];const basis=(Number(us.cash)||0)+(Number(us.pendingSaleProceeds)||0),readAt=at(us);
    const save=()=>this.db.prepare('INSERT INTO inflight_settlement VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(st));
    const reported={buys:fx>0?Math.max(0,Number(us.unsettled?.buyKRW)||0)/fx:0,sells:fx>0?Math.max(0,Number(us.unsettled?.sellKRW)||0)/fx:0};
    const filled=o=>o.filled>0&&o.fillPrice>0&&['Buy','Sell'].includes(o.side);
    // The first reading starts tracking. Fills past their settlement date are history; the others stay in flight,
    // unresolved, and those KIS's reported total could cover are marked so. Both are recorded as evidence.
    if(st.basis==null){Object.assign(st,{basis,observed:reported,readAt,startedAt:now,lastAt:now,evidence:[],seq:0});const early=[],history=[];
      for(const o of orders)if(filled(o)){const id=String(o.id),a=InFlight.amountOf(o);st.seen[id]={filled:o.filled,...a};const p=InFlight.early(o,id,a,now);if(p)early.push(p);else history.push(id);}
      const log=e=>st.evidence.push({id:`e${st.seq=(st.seq??0)+1}`,at:now,channel:'first reading',open:[],allocated:[],...e});
      if(history.length)log({side:null,amount:0,kind:'history',settledBySchedule:history});
      for(const [side,key] of [['Buy','buys'],['Sell','sells']]){const mine=early.filter(f=>f.side===side);if(!mine.length)continue;
        const covered=InFlight.match(mine,reported[key]);for(const f of covered)f.unresolved={why:'reported before seen',at:now};
        log({side,amount:mine.reduce((n,f)=>n+cents(f.usd),0)/100,kind:'first reading',flagged:mine.map(f=>f.id),possiblyReported:covered.map(f=>f.id)});}
      st.open.push(...early);save();
      return {...InFlight.totals(st),notes:['tracking of U.S. fills awaiting settlement starts with this reading',...(early.length?[`${early.length} fill(s) within their settlement period stay in flight, unresolved, until KIS shows them`]:[])]};}
    if(readAt!=null&&st.readAt!=null&&readAt<st.readAt)return {...InFlight.totals(st),notes:['a U.S. balance reading older than the last one was ignored']};
    // State saved before readings were kept: its reported baseline may hold an old unmatched total, so no reported change
    // is evidence at this first reading.
    if(!st.observed){st.observed=reported;delete st.reported;}st.evidence??=[];
    const moved=basis-st.basis;
    // A changed amount without new shares corrects the order's open pieces, latest first; when none is open, KIS's own
    // figures already carry it.
    const adjust=(id,side,delta,basisNow)=>{const mine=st.open.filter(f=>f.id===id);for(const f of mine)f.basis=basisNow;if(!delta)return;
      if(!mine.length){notes.push(`${side} ${id}: execution amount changed by $${(delta/100).toFixed(2)}; none of it is in flight`);return;}
      let left=delta;for(const f of mine.reverse()){const c=Math.max(0,cents(f.usd)+left);left-=c-cents(f.usd);f.usd=c/100;f.corrected=now;if(!left)break;}
      st.open=st.open.filter(f=>f.usd>0);notes.push(`${side} ${id}: execution amount ${delta>0?'rose':'fell'} by $${Math.abs(delta/100).toFixed(2)}${basisNow==='net'?', fees included':''}; the amount in flight is corrected`);};
    // New fill amounts since the last reading: the cumulative amount less the last one.
    const fresh=[];for(const o of orders){if(!filled(o))continue;const id=String(o.id),a=InFlight.amountOf(o);let was=st.seen[id];
      // An order first listed after tracking started that filled before it (order history arriving after the balance):
      // the same rule as at the first reading, not a new fill this reading can explain.
      if(!was&&Number.isFinite(st.startedAt)&&fillTime(o)<st.startedAt){st.seen[id]={filled:o.filled,...a};const p=InFlight.early(o,id,a,now);if(p){st.open.push(p);notes.push(`${o.side} ${id}: filled before tracking started and within its settlement period; it stays in flight, unresolved`);}continue;}
      // Saved before cumulative amounts were kept: only the quantity, so the earlier amount is taken at the current average.
      if(typeof was==='number')was={filled:was,cents:Math.round(a.cents*Math.min(was,o.filled)/o.filled),basis:a.basis};
      if(was&&o.filled<was.filled)continue;st.seen[id]={filled:o.filled,...a};const delta=a.cents-(was?.cents??0);
      if(o.filled>(was?.filled??0)&&delta>0)fresh.push({id,side:o.side,usd:delta/100,basis:a.basis,at:now});else if(delta||was&&was.basis!==a.basis)adjust(id,o.side,delta,a.basis);}
    let movement=moved;const KEY={Buy:'buys',Sell:'sells'},delta=side=>reported[KEY[side]]-st.observed[KEY[side]];
    const settled=new Set(),live=side=>st.open.filter(f=>f.side===side&&!settled.has(f));
    const record=(e,run=[],flagged=[])=>{const v={id:`e${st.seq=(st.seq??0)+1}`,at:now,...e,amount:cents(e.amount)/100,open:live(e.side).map(f=>f.id),allocated:run.map(f=>({id:f.id,usd:f.usd})),...(flagged.length?{flagged:flagged.map(f=>f.id)}:{})};
      st.evidence.push(v);for(const f of run)settled.add(f);return v;};
    const flag=(run,why,extra={})=>{for(const f of run)f.unresolved={why,at:now,...extra};};
    // An allocation through one channel (cash, or the reported total) not yet paired with one through the other: the two
    // may be one purchase shown both ways, however far apart they were seen (fix review 2026-11-05, P1), so a later
    // allocation of the other channel for the same amount on the same side is paired with it rather than taken as a
    // second event. Pairing lasts PAIR_DAYS; a reported trade settling ends it for the reported side.
    const partner=(channel,side,amount)=>st.evidence.find(e=>e.pairable&&!e.pairedWith&&e.channel!==channel&&e.side===side&&now-e.at<=PAIR_DAYS*86400000&&amount>=TOLERANCE*e.amount&&amount<=e.amount/TOLERANCE);
    const pair=(v,p)=>{v.pairedWith=p.id;p.pairedWith=v.id;};
    // 1. A fall in reported buys or sales is a reported trade settling, with the fall in U.S. cash that comes with it for
    // buys. It resolves fills marked as possibly covered by the reported total, and, when cash fell with it, fills marked
    // as possibly one purchase with an earlier allocation: whether the earlier cash was theirs or the reported trade's,
    // cash has now gone out for both.
    for(const side of ['Buy','Sell']){const d=delta(side);if(!(d<-0.005))continue;let paid=0;if(side==='Buy'&&movement<-0.005){paid=Math.max(movement,d);movement-=paid;}
      const covered=InFlight.match(live(side).filter(f=>REPORTED.includes(f.unresolved?.why)),-d);
      const run=[...covered,...(paid?InFlight.match(live(side).filter(f=>f.unresolved?.why==='possibly one purchase'&&!covered.includes(f)),-paid):[])];
      let left=-d/TOLERANCE;for(const e of st.evidence)if(e.pairable&&!e.pairedWith&&e.channel==='reported'&&e.side===side&&e.amount<=left){e.pairedWith='settled';left-=e.amount;}
      if(run.length||paid)record({channel:paid?'cash and reported':'reported',side,amount:-d,kind:'reported settlement'},run);}
    // 2. New pieces the reading already moved by (buys down, sales up), all together, within the tolerance either way: a
    // cash allocation like any other, recorded and paired. Paired with an earlier reported allocation, the cash may be
    // that purchase's, so the new pieces stay in flight, marked unresolved.
    const want=fresh.reduce((n,f)=>n+(f.side==='Buy'?-f.usd:f.usd),0),sides=new Set(fresh.map(f=>f.side));
    const reflected=fresh.length&&Math.abs(want)>0&&Math.sign(movement)===Math.sign(want)&&Math.abs(movement)>=TOLERANCE*Math.abs(want)&&Math.abs(movement)<=Math.abs(want)/TOLERANCE;
    if(reflected){const side=want<0?'Buy':'Sell',p=sides.size===1?partner('cash',side,Math.abs(movement)):null;
      if(p){st.open.push(...fresh);flag(fresh,'possibly one purchase',{with:p.id});pair(record({channel:'cash',side,amount:Math.abs(movement),kind:'ambiguous'},[],fresh),p);
        notes.push(`${side} ${fresh.map(f=>f.id).join(', ')}: U.S. cash moved by this fill, as the reported settlement total did for an earlier one; whether they are one purchase is unresolved, so it stays in flight`);}
      else{const v=record({channel:'cash',side,amount:Math.abs(movement),kind:'reflected at once'},fresh);v.pairable=sides.size===1;}
      movement=0;}
    else{st.open.push(...fresh);
      // The order list one reading behind the balance: a cash movement in the reading just before, that matched no fill
      // then, may have been their payment, or a withdrawal of the same amount. They stay in flight, marked unresolved;
      // a later settlement of theirs clears them as usual.
      for(const side of ['Buy','Sell']){const mine=fresh.filter(f=>f.side===side);if(!mine.length)continue;
        const e=st.evidence.find(x=>x.channel==='cash'&&x.kind==='unmatched'&&x.side===side&&x.at===st.lastAt&&!x.usedBy);if(!e)continue;const run=InFlight.match(mine,e.amount);if(!run.length)continue;
        const p=partner('cash',side,e.amount);
        flag(run,'paid before seen',{evidence:e.id});record({channel:'cash',side,amount:e.amount,kind:'possibly paid before seen',earlierReading:e.id},[],run);e.usedBy=st.evidence.at(-1).id;
        notes.push(`${side} ${run.map(f=>f.id).join(', ')}: U.S. cash moved by this amount a reading before the fill was seen (a payment, or a withdrawal); it stays in flight, unresolved`);}}
    // 3. New fills an earlier unmatched rise could be: KIS may have reported them before the app saw them fill, which
    // nothing here can verify, so they stay in flight, marked unresolved.
    for(const e of st.evidence.filter(e=>e.kind==='unmatched'&&e.channel==='reported'&&!e.flagged&&!e.pairedWith&&now-e.at<=MAX_DAYS*86400000)){
      const run=InFlight.match(fresh.filter(f=>f.side===e.side&&st.open.includes(f)&&!f.unresolved),e.amount);if(!run.length)continue;
      flag(run,'reported before seen',{evidence:e.id});e.flagged=run.map(f=>f.id);
      notes.push(`${e.side} ${e.flagged.join(', ')}: KIS reported $${e.amount.toFixed(2)} awaiting settlement before the app saw this fill; whether it is this fill is unresolved, so it stays in flight`);}
    // 4. Evidence through one channel: it settles the oldest open fills of its side it matches, unless it pairs with an
    // allocation through the other channel; then the fills it would match stay in flight, marked unresolved.
    const allocate=(channel,side,amount)=>{const p=partner(channel,side,amount);
      if(p){const run=InFlight.match(live(side).filter(f=>!f.unresolved),amount);flag(run,'possibly one purchase',{with:p.id});pair(record({channel,side,amount,kind:run.length?'ambiguous':'paired'},[],run),p);
        if(run.length)notes.push(`${side} ${run.map(f=>f.id).join(', ')}: U.S. cash and the reported settlement total each moved by this amount; whether they are one purchase is unresolved, so it stays in flight`);return;}
      const run=InFlight.match(live(side),amount),v=record({channel,side,amount,kind:run.length?'settled':'unmatched'},run);v.pairable=run.length>0;
      // A reported rise matching no open fill while fills of its side are open may cover part of them: they stay in
      // flight, marked unresolved.
      if(!run.length&&channel==='reported'){const rest=live(side).filter(f=>!f.unresolved);if(rest.length){flag(rest,'reported total moved by an unmatched amount',{evidence:v.id});v.flagged=rest.map(f=>f.id);}}};
    // What KIS reports awaiting settlement: a rise is evidence for open fills of its side.
    for(const side of ['Buy','Sell']){const d=delta(side);if(d>0.005)allocate('reported',side,d);}
    // The cash movement, while only one side is open (buys and sales together net, so it cannot be divided).
    const openSide=s=>st.open.some(f=>f.side===s&&!settled.has(f)&&!fresh.includes(f));
    if(Math.abs(movement)>0.005&&!(openSide('Buy')&&openSide('Sell')))allocate('cash',movement<0?'Buy':'Sell',Math.abs(movement));
    st.open=st.open.filter(f=>!settled.has(f));
    for(const f of st.open)if(!f.overdueAt&&now-(f.filledAt??f.at)>MAX_DAYS*DAY){f.overdueAt=now;f.unresolved??={why:'overdue',at:now};
      notes.push(`${f.side} ${f.id} ($${f.usd}): no settlement evidence after ${MAX_DAYS} days; it stays in flight, unresolved, until KIS shows it or it is reconciled`);}
    Object.assign(st,{basis,observed:reported,readAt:readAt??st.readAt,lastAt:now,evidence:st.evidence.slice(-EVIDENCE_KEPT)});
    // Orders no longer listed are forgotten, so the record stays bounded.
    const listed=new Set(orders.map(o=>String(o.id)));for(const id of Object.keys(st.seen))if(!listed.has(id)&&!st.open.some(f=>f.id===id))delete st.seen[id];
    save();return {...InFlight.totals(st),notes};
  }
  static totals(st){const sum=(side,only=()=>true)=>st.open.filter(f=>f.side===side&&only(f)).reduce((n,f)=>n+cents(f.usd),0)/100;
    return {buysUSD:sum('Buy'),sellsUSD:sum('Sell'),unresolved:{buysUSD:sum('Buy',f=>f.unresolved),sellsUSD:sum('Sell',f=>f.unresolved)},overdue:{buysUSD:sum('Buy',f=>f.overdueAt),sellsUSD:sum('Sell',f=>f.overdueAt)},open:st.open};}
  current(account){return InFlight.totals(this.state(account));}
}
module.exports={value,VERSION,STALE_MS,InFlight,MAX_DAYS,SETTLED_AFTER_DAYS};
