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
  // Bootstrap B1 (stage 2b): fills from before tracking started stay in flight until evidence or a reconciliation.
  const pre=inFlight?.pretracking?.count??0;if(pre)reasons.push(`${pre} pre-tracking U.S. fill${pre>1?'s':''} awaiting verification: the value is provisional`);
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
//   - a movement that matches no set of open fills (an unrelated deposit or withdrawal) settles nothing;
//   - strict uniqueness (stage 2b, A5): evidence settles fills only when exactly one set of open fills of its side
//     matches it; when several sets fit (equal amounts on different fills, or different combinations), or more than
//     BOUND fills could be candidates, nothing is applied and the candidate sets are recorded;
//   - exact amounts (stage 2b): the evidence amount is allocated to the set's fills oldest first, each up to its own
//     amount, in cents; a fill not fully covered keeps its remainder in flight, unresolved ("evidence short"), and
//     nothing is written off; evidence beyond the set stays unallocated;
// - a reading older than the last one is ignored;
// - the first reading (bootstrap B1, stage 2b; replaces the five-day rule of a7d075a): every fill listed then, or
//   filled before tracking started and listed later, stays in flight, unresolved and awaiting verification, whatever its
//   age. Neither its order or fill time nor a KIS settled-trade record (U6 not verified) makes it history. Those KIS's
//   reported total could cover are marked as possibly reported; evidence resolves them like any other fill;
// - a fill with no evidence after MAX_DAYS is marked overdue, noted once, and stays in flight, unresolved: time alone
//   never removes an obligation, raises equity or frees buying capacity (same review, P1: a fill was dropped as settled).
// The state (open fills, cumulative amounts, the last reading, the evidence) survives restarts (inflight_settlement).
// Stage 2b.2: each reading is one transaction, and its evidence, allocations and every piece change are also written to
// the settlement evidence ledger (electron/settlement-evidence.cjs): evidence is identified by its reading pair, side
// and field, every allocation is checked there against what is left of the evidence and of the piece, and the events
// are append-only. KIS settled-trade rows linked with certainty to an order are supporting evidence only (A1 off): they
// resolve nothing, but one more than a cent from what was allocated reopens the difference (a conflict). Coverage that
// relies on a K row that no longer holds counts as unresolved again (under review).
// orders: the U.S. engine's.
const MAX_DAYS=7,PAIR_DAYS=4,TOLERANCE=0.95,BOUND=12,EVIDENCE_KEPT=60,DAY=86400000;
// When an order filled: when the app saw it filled, or failing that when it was placed.
const fillTime=o=>Number.isFinite(o.filledObservedAt)?o.filledObservedAt:Number.isFinite(o.createdAt)?o.createdAt:Date.parse(o.createdAt??'');
// Why a fill may already be covered by what KIS reports awaiting settlement.
const REPORTED=['reported before seen','reported total moved by an unmatched amount'];
const cents=v=>Math.round(v*100);
const nyDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
class InFlight {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS inflight_settlement(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');this.evidence=new (require('./settlement-evidence.cjs').SettlementEvidence)(db,clock);}
  save(account,st){this.db.prepare('INSERT INTO inflight_settlement VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(st));}
  state(account){const r=this.db.prepare('SELECT payload FROM inflight_settlement WHERE account=?').get(account);return r?JSON.parse(r.payload):{basis:null,seen:{},open:[],evidence:[]};}
  // An order's cumulative execution amount in cents and its basis: KIS net cash when known (fees included), otherwise gross.
  static amountOf(o){const net=o.resultCosts?.netCash;return Number.isFinite(net)?{cents:Math.abs(cents(net)),basis:'net'}:{cents:cents(o.filled*o.fillPrice),basis:'gross'};}
  // A fill from before tracking started: an open piece awaiting verification, whatever its age (bootstrap B1).
  static early(o,id,a,now){const t=fillTime(o);
    return {id,side:o.side,usd:a.cents/100,basis:a.basis,at:now,filledAt:Number.isFinite(t)?t:null,pretracking:true,unresolved:{why:'awaiting verification',at:now}};}
  // Every distinct set of the given fills whose total an amount matches within the tolerance either way (fills with equal
  // amounts are different sets), each oldest first; over: more than BOUND fills, so none is considered.
  static sets(open,amount){if(!(amount>0)||!open.length)return {sets:[],over:false};if(open.length>BOUND)return {sets:[],over:true};
    const fits=t=>amount>=TOLERANCE*t&&amount<=t/TOLERANCE,out=[];
    for(let m=1;m<1<<open.length;m++){let t=0;const s=[];for(let i=0;i<open.length;i++)if(m&1<<i){t+=cents(open[i].usd);s.push(open[i]);}if(fits(t/100))out.push(s);}
    return {sets:out,over:false};}
  // The one set that fits, or none when no set or several fit, or there are too many fills to tell (strict A5).
  static match(open,amount){const {sets,over}=InFlight.sets(open,amount);return !over&&sets.length===1?sets[0]:[];}
  // Every fill in any fitting set (all of them over the bound), for marks that resolve nothing.
  static candidates(open,amount){const {sets,over}=InFlight.sets(open,amount);return over?[...open]:[...new Set(sets.flat())];}
  // us: the U.S. balance just read (cash, pendingSaleProceeds, unsettled, timestamp); fx: USD/KRW. Returns {buysUSD,
  // sellsUSD, unresolved: the part of each marked unresolved, open, notes}.
  // One transaction per reading: the state, the evidence, the allocations and the events commit together, or nothing.
  observe(account,input){return this.evidence.tx(()=>this.read(account,input));}
  read(account,{us,orders=[],fx=null}){
    if(typeof account!=='string'||!account||!us)return {...InFlight.totals({open:[]}),notes:[]};
    const now=this.clock(),st=this.state(account),notes=[];const basis=(Number(us.cash)||0)+(Number(us.pendingSaleProceeds)||0),readAt=at(us);
    const save=()=>this.save(account,st);
    const reported={buys:fx>0?Math.max(0,Number(us.unsettled?.buyKRW)||0)/fx:0,sells:fx>0?Math.max(0,Number(us.unsettled?.sellKRW)||0)/fx:0};
    const filled=o=>o.filled>0&&o.fillPrice>0&&['Buy','Sell'].includes(o.side);
    // Every piece has its own id and the amount it opened with, which allocations are checked against; pieces saved
    // before ids were kept get them now. An opened piece is an event.
    const ledger=this.evidence,mint=p=>{p.pid??=`${p.id}#${st.pseq=(st.pseq??0)+1}`;p.cents0??=cents(p.usd);return p;};for(const f of st.open)mint(f);
    const opened=p=>{mint(p);ledger.event(account,'piece-opened',{pieceId:p.pid,orderId:p.id,side:p.side,usd:p.usd,basis:p.basis,why:p.unresolved?.why??null,...(p.pretracking?{pretracking:true}:{})});return p;};
    // The first reading starts tracking. Every fill listed then stays in flight, awaiting verification (bootstrap B1),
    // and those KIS's reported total could cover are marked so; recorded as evidence.
    if(st.basis==null){Object.assign(st,{basis,observed:reported,readAt,startedAt:now,lastAt:now,evidence:[],seq:0});const early=[];
      for(const o of orders)if(filled(o)){const id=String(o.id),a=InFlight.amountOf(o);st.seen[id]={filled:o.filled,...a};early.push(InFlight.early(o,id,a,now));}
      const log=e=>st.evidence.push({id:`e${st.seq=(st.seq??0)+1}`,at:now,channel:'first reading',open:[],allocated:[],...e});
      for(const [side,key] of [['Buy','buys'],['Sell','sells']]){const mine=early.filter(f=>f.side===side);if(!mine.length)continue;
        const covered=InFlight.candidates(mine,reported[key]);for(const f of covered)f.unresolved={why:'reported before seen',at:now};
        log({side,amount:mine.reduce((n,f)=>n+cents(f.usd),0)/100,kind:'first reading',flagged:mine.map(f=>f.id),possiblyReported:covered.map(f=>f.id)});}
      st.open.push(...early.map(opened));save();
      return {...this.withReview(account,st),notes:['tracking of U.S. fills awaiting settlement starts with this reading',...(early.length?[`${early.length} fill(s) from before tracking stay in flight, awaiting verification, until KIS evidence or a reconciliation resolves them`]:[])]};}
    if(readAt!=null&&st.readAt!=null&&readAt<st.readAt)return {...this.withReview(account,st),notes:['a U.S. balance reading older than the last one was ignored']};
    // State saved before readings were kept: its reported baseline may hold an old unmatched total, so no reported change
    // is evidence at this first reading.
    if(!st.observed){st.observed=reported;delete st.reported;}st.evidence??=[];
    const moved=basis-st.basis;
    // A changed amount without new shares corrects the order's open pieces, latest first; when none is open, KIS's own
    // figures already carry it.
    const adjust=(id,side,delta,basisNow)=>{const mine=st.open.filter(f=>f.id===id);for(const f of mine)f.basis=basisNow;if(!delta)return;
      if(!mine.length){notes.push(`${side} ${id}: execution amount changed by $${(delta/100).toFixed(2)}; none of it is in flight`);return;}
      let left=delta;for(const f of mine.reverse()){const c=Math.max(0,cents(f.usd)+left);left-=c-cents(f.usd);f.cents0+=c-cents(f.usd);ledger.event(account,'piece-corrected',{pieceId:f.pid,orderId:id,fromUSD:f.usd,toUSD:c/100});f.usd=c/100;f.corrected=now;if(!left)break;}
      st.open=st.open.filter(f=>f.usd>0);notes.push(`${side} ${id}: execution amount ${delta>0?'rose':'fell'} by $${Math.abs(delta/100).toFixed(2)}${basisNow==='net'?', fees included':''}; the amount in flight is corrected`);};
    // New fill amounts since the last reading: the cumulative amount less the last one.
    const fresh=[];for(const o of orders){if(!filled(o))continue;const id=String(o.id),a=InFlight.amountOf(o);let was=st.seen[id];
      // An order first listed after tracking started that filled before it (order history arriving after the balance):
      // the same rule as at the first reading, not a new fill this reading can explain.
      if(!was&&Number.isFinite(st.startedAt)&&fillTime(o)<st.startedAt){st.seen[id]={filled:o.filled,...a};st.open.push(opened(InFlight.early(o,id,a,now)));notes.push(`${o.side} ${id}: filled before tracking started; it stays in flight, awaiting verification`);continue;}
      // Saved before cumulative amounts were kept: only the quantity, so the earlier amount is taken at the current average.
      if(typeof was==='number')was={filled:was,cents:Math.round(a.cents*Math.min(was,o.filled)/o.filled),basis:a.basis};
      if(was&&o.filled<was.filled)continue;st.seen[id]={filled:o.filled,...a};const delta=a.cents-(was?.cents??0);
      if(o.filled>(was?.filled??0)&&delta>0)fresh.push({id,side:o.side,usd:delta/100,basis:a.basis,at:now});else if(delta||was&&was.basis!==a.basis)adjust(id,o.side,delta,a.basis);}
    let movement=moved;const KEY={Buy:'buys',Sell:'sells'},delta=side=>reported[KEY[side]]-st.observed[KEY[side]];
    const settled=new Set(),live=side=>st.open.filter(f=>f.side===side&&!settled.has(f));
    // Fills cash or a reported total may settle: not one marked paid before it was seen, which only a reconciliation (or
    // A1 once U6 is verified) resolves, since the earlier movement may have been its payment (design v1 A2).
    const payable=side=>live(side).filter(f=>f.unresolved?.why!=='paid before seen');
    // Exact amounts: the run's fills, oldest first, each take what is left of the evidence up to their own amount; a fill
    // not fully covered keeps its remainder in flight, unresolved, with the shortfall (nothing is written off).
    // Each allocation is also written to the ledger (src: its evidence), which refuses more than is left of either.
    const take=(run,amountCents,evidence,src=null)=>{let left=amountCents;const out=[];
      for(const f of run){const c=cents(f.usd),a=Math.max(0,Math.min(c,left));left-=a;
        if(a){if(src)ledger.allocate({account,evidenceId:src.evidenceId,pieceId:f.pid,orderId:f.id,cents:a,pieceCents:f.cents0,rule:src.rule});out.push({id:f.id,pid:f.pid,usd:a/100});}if(a===c){settled.add(f);continue;}
        f.usd=(c-a)/100;f.unresolved={why:'evidence short',shortUSD:(c-a)/100,evidence,at:now};notes.push(`${f.side} ${f.id}: evidence covered $${(a/100).toFixed(2)}; $${f.usd.toFixed(2)} stays in flight, unresolved (evidence short)`);}
      return {allocated:out,left};};
    // Ledger evidence for this reading pair: U.S. cash, or the reported total of a side, each its whole movement in the
    // pair, so every allocation drawn from that movement (a fast-path remainder included) shares one amount.
    const pairOf={readingA:`${st.readAt??''}@${st.lastAt??''}`,readingB:`${readAt??''}@${now}`},field=(cash,side)=>cash?'cash':side==='Buy'?'ustl_buy_amt_smtl':'ustl_sll_amt_smtl';
    const source=(cash,side,extra={})=>ledger.aggregate({account,environment:us.environment??null,market:'US',...pairOf,side,field:field(cash,side),amountCents:Math.abs(cents(cash?moved:delta(side))),...extra});
    const record=(e,run=[],flagged=[],extra={})=>{const id=`e${st.seq=(st.seq??0)+1}`,open=live(e.side).map(f=>f.id);
      // A record about an earlier reading's movement (paid before seen) is a flag only, not evidence of this pair.
      const src=e.earlierReading?null:{evidenceId:source(e.channel==='cash',e.side,extra.krw?{krw:extra.krw,rate:extra.rate}:{}),rule:e.kind},t=take(run,run.length?cents(e.amount):0,id,src);
      const v={id,at:now,...e,...(src?{evidenceId:src.evidenceId}:{}),amount:cents(e.amount)/100,open,allocated:t.allocated,...(run.length&&t.left?{unallocated:t.left/100}:{}),...(flagged.length?{flagged:flagged.map(f=>f.id)}:{}),...extra};
      st.evidence.push(v);return v;};
    const flag=(run,why,extra={})=>{for(const f of run)f.unresolved={why,at:now,...extra};if(run.length)ledger.event(account,'flag',{pieces:run.map(f=>f.pid),why,...extra});};
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
      const one=paid?InFlight.match(live(side).filter(f=>f.unresolved?.why==='possibly one purchase'&&!covered.includes(f)),-paid):[];
      let left=-d/TOLERANCE;for(const e of st.evidence)if(e.pairable&&!e.pairedWith&&e.channel==='reported'&&e.side===side&&e.amount<=left){e.pairedWith='settled';left-=e.amount;}
      if(covered.length||one.length||paid){const v=record({channel:paid?'cash and reported':'reported',side,amount:-d,kind:'reported settlement'},covered);
        if(one.length){const t=take(one,cents(-paid),v.id,{evidenceId:source(true,side),rule:'reported settlement: its payment'});v.allocated.push(...t.allocated);if(t.left)v.unallocatedPaid=t.left/100;}}}
    // 2. New pieces the reading already moved by (buys down, sales up), all together, within the tolerance either way: a
    // cash allocation like any other, recorded and paired. Paired with an earlier reported allocation, the cash may be
    // that purchase's, so the new pieces stay in flight, marked unresolved.
    const want=fresh.reduce((n,f)=>n+(f.side==='Buy'?-f.usd:f.usd),0),sides=new Set(fresh.map(f=>f.side));
    // Strict and exact (stage 2b): the new fills must be of one side, and the movement must fit them as the only fitting
    // set among them and the side's open fills. New buys and sales together are never reflected at once: their net cash
    // cannot be divided, and an exact net match is no unique allocation (an older open fill may fit as well; review of
    // 2d297f9, P1), so they stay in flight. Nor while fills of the other side are still in flight: the movement is then
    // a net of both sides too.
    let reflected=false;const other=s=>s==='Buy'?'Sell':'Buy';
    if(sides.size===1&&!live(other([...sides][0])).length&&Math.abs(want)>0&&Math.sign(movement)===Math.sign(want)){
      const run=InFlight.match([...payable([...sides][0]),...fresh],Math.abs(movement));reflected=run.length===fresh.length&&run.every(f=>fresh.includes(f));}
    if(reflected){const side=want<0?'Buy':'Sell',p=partner('cash',side,Math.abs(movement));st.open.push(...fresh.map(opened));
      if(p){flag(fresh,'possibly one purchase',{with:p.id});pair(record({channel:'cash',side,amount:Math.abs(movement),kind:'ambiguous'},[],fresh),p);
        notes.push(`${side} ${fresh.map(f=>f.id).join(', ')}: U.S. cash moved by this fill, as the reported settlement total did for an earlier one; whether they are one purchase is unresolved, so it stays in flight`);movement=0;}
      else{const v=record({channel:'cash',side,amount:Math.abs(movement),kind:'reflected at once'},fresh);v.pairable=true;movement=Math.sign(movement)*(v.unallocated??0);}}
    else{st.open.push(...fresh.map(opened));
      // The order list one reading behind the balance: a cash movement in the reading just before, that matched no fill
      // then, may have been their payment, or a withdrawal of the same amount. They stay in flight, marked unresolved;
      // a later settlement of theirs clears them as usual.
      for(const side of ['Buy','Sell']){const mine=fresh.filter(f=>f.side===side);if(!mine.length)continue;
        const e=st.evidence.find(x=>x.channel==='cash'&&x.kind==='unmatched'&&x.side===side&&x.at===st.lastAt&&!x.usedBy);if(!e)continue;const run=InFlight.candidates(mine,e.amount);if(!run.length)continue;
        const p=partner('cash',side,e.amount);
        flag(run,'paid before seen',{evidence:e.id});record({channel:'cash',side,amount:e.amount,kind:'possibly paid before seen',earlierReading:e.id},[],run);e.usedBy=st.evidence.at(-1).id;
        notes.push(`${side} ${run.map(f=>f.id).join(', ')}: U.S. cash moved by this amount a reading before the fill was seen (a payment, or a withdrawal); it stays in flight, unresolved`);}}
    // 3. New fills an earlier unmatched rise could be: KIS may have reported them before the app saw them fill, which
    // nothing here can verify, so they stay in flight, marked unresolved.
    for(const e of st.evidence.filter(e=>e.kind==='unmatched'&&e.channel==='reported'&&!e.flagged&&!e.pairedWith&&now-e.at<=MAX_DAYS*86400000)){
      const run=InFlight.candidates(fresh.filter(f=>f.side===e.side&&st.open.includes(f)&&!f.unresolved),e.amount);if(!run.length)continue;
      flag(run,'reported before seen',{evidence:e.id});e.flagged=run.map(f=>f.id);
      notes.push(`${e.side} ${e.flagged.join(', ')}: KIS reported $${e.amount.toFixed(2)} awaiting settlement before the app saw this fill; whether it is this fill is unresolved, so it stays in flight`);}
    // 4. Evidence through one channel: it settles the oldest open fills of its side it matches, unless it pairs with an
    // allocation through the other channel; then the fills it would match stay in flight, marked unresolved.
    const allocate=(channel,side,amount,extra={})=>{const p=partner(channel,side,amount);
      if(p){const run=InFlight.candidates(live(side).filter(f=>!f.unresolved),amount);flag(run,'possibly one purchase',{with:p.id});pair(record({channel,side,amount,kind:run.length?'ambiguous':'paired'},[],run),p);
        if(run.length)notes.push(`${side} ${run.map(f=>f.id).join(', ')}: U.S. cash and the reported settlement total each moved by this amount; whether they are one purchase is unresolved, so it stays in flight`);return;}
      // Strict A5: applied only when exactly one set of the side's open fills fits; otherwise the candidates are kept.
      const pool=payable(side),{sets,over}=InFlight.sets(pool,amount),run=!over&&sets.length===1?sets[0]:[],several=over||sets.length>1;
      const v=record({channel,side,amount,kind:run.length?'settled':several?'ambiguous fit':'unmatched'},run,[],{...extra,...(several?(over?{overBound:pool.length}:{ambiguousCandidates:sets.map(s=>s.map(f=>f.id))}):{})});v.pairable=run.length>0;
      // Several fits of a cash movement: each candidate may be the one paid, so it is marked (a reported total's
      // candidates are marked below, as possibly reported, so that its settling can resolve them).
      if(several&&channel==='cash'){const marked=[];for(const f of over?pool:new Set(sets.flat()))if(!f.unresolved){f.unresolved={why:'ambiguous evidence',evidence:v.id,at:now};marked.push(f.pid);}if(marked.length)ledger.event(account,'flag',{pieces:marked,why:'ambiguous evidence',evidence:v.id});}
      if(several)notes.push(`${side}: ${channel==='cash'?'U.S. cash':'the reported settlement total'} moved by $${(cents(amount)/100).toFixed(2)}, which ${over?`more than ${BOUND} open fills could explain`:`${sets.length} different sets of open fills fit`}; nothing is settled`);
      // A reported rise matching no open fill while fills of its side are open may cover part of them: they stay in
      // flight, marked unresolved.
      if(!run.length&&channel==='reported'){const rest=live(side).filter(f=>!f.unresolved);if(rest.length){flag(rest,'reported total moved by an unmatched amount',{evidence:v.id});v.flagged=rest.map(f=>f.id);}}};
    // What KIS reports awaiting settlement: a rise is evidence for open fills of its side.
    // KRW evidence: converted at this reading's rate; the KRW amount and the rate are recorded with it.
    for(const side of ['Buy','Sell']){const d=delta(side);if(d>0.005)allocate('reported',side,d,{krw:Math.round(d*fx),rate:fx});}
    // The cash movement, while only one side is open (buys and sales together net, so it cannot be divided). Every fill
    // still in flight counts, the new ones too (review of 2d297f9, P1: new buys and sales left out of this check let a
    // movement their net did not match be allocated to one side).
    const openSide=s=>st.open.some(f=>f.side===s&&!settled.has(f));
    if(Math.abs(movement)>0.005&&!(openSide('Buy')&&openSide('Sell')))allocate('cash',movement<0?'Buy':'Sell',Math.abs(movement));
    st.open=st.open.filter(f=>!settled.has(f));for(const f of settled)ledger.event(account,'piece-closed',{pieceId:f.pid,orderId:f.id});
    // A KIS settled-trade row linked with certainty to an order whose pieces evidence resolved contradicts the allocation
    // when it is more than a cent away (design v3 §3, T13). Every version is reconciled against what the conflict already
    // holds, in both directions, kept apart (review of 4b534c1, P1):
    // - the row says more than was allocated (an increased obligation): what evidence an earlier, lower version released
    //   is restored first, if still unused; the rest is an open conflict piece of the order, raised or lowered to it;
    // - the row says less (reduced coverage): no conflict piece stays, and the allocations above it are released back
    //   to their evidence and reported as coverage no longer explained by KIS's record (no obligation is created).
    // Compared only once the order's own amount is net of fees, and while no other piece of the order is open.
    const links=ledger.links(account,orders);st.conflicts??={};
    for(const o of orders){const id=String(o.id),l=links.get(id);if(l?.state!=='linked'||!(l.fields.exchangeRate>0)||!(l.fields.settlementUSD>0)||InFlight.amountOf(o).basis!=='net'||st.open.some(f=>f.id===id&&!f.conflict))continue;
      let base=ledger.allocatedToOrder(account,id);const c0=st.conflicts[id],k=cents(l.fields.settlementUSD);if(!c0&&(!base||Math.abs(k-base)<=1))continue;
      const c=st.conflicts[id]??={released:[]};const was={kCents:c.kCents,version:c.version};Object.assign(c,{groupId:l.groupId,version:l.version,kCents:k});
      const pieces=()=>st.open.filter(f=>f.id===id&&f.conflict),held=()=>pieces().reduce((n,f)=>n+cents(f.usd),0);
      // Restoration is exact (review of 790c852, P2): each released part restores at most what the order still lacks and
      // what is still unused in its evidence version; a part another piece has since used is no longer released (it is
      // that piece's now). Allocation errors are not swallowed. Evidence voided by a reversed reconciliation (stage 2b.3)
      // has nothing unused: what was released from it belonged to that record.
      if(k>base+1){for(const r of [...c.released].reverse()){if(base>=k)break;const ev=ledger.version(r.evidenceId,r.version),free=ev&&!ev.reversedBy?Math.max(0,ev.amountCents-ledger.allocated(r.evidenceId,r.version)):0,take=Math.min(r.cents,k-base,free);
          if(take>0){ledger.allocate({account,evidenceId:r.evidenceId,version:r.version,pieceId:r.pieceId,orderId:id,cents:take,rule:'restored: KIS record raised'});r.cents-=take;base+=take;ledger.event(account,'coverage-restored',{orderId:id,evidenceId:r.evidenceId,cents:take});}
          const gone=Math.max(0,r.cents-(free-take));if(gone>0&&base<k){r.cents-=gone;ledger.event(account,'release-used-elsewhere',{orderId:id,evidenceId:r.evidenceId,cents:gone});}}
        c.released=c.released.filter(r=>r.cents>0);}
      const target=k>base+1?k-base:0,have=held();
      if(target>have){st.open.push(opened({id,side:o.side,usd:(target-have)/100,basis:'net',at:now,filledAt:now,conflict:true,unresolved:{why:'conflict',evidence:l.groupId,version:l.version,kUSD:k/100,allocatedUSD:base/100}}));
        notes.push(`${o.side} ${id}: KIS's settled record says $${(k/100).toFixed(2)} where $${(base/100).toFixed(2)} was allocated; $${(target/100).toFixed(2)} is unresolved (conflict)`);}
      else if(target<have){let left=have-target;for(const f of pieces().reverse()){const x=Math.min(cents(f.usd),left);left-=x;f.usd=(cents(f.usd)-x)/100;f.cents0-=x;ledger.event(account,'conflict-reduced',{pieceId:f.pid,orderId:id,cents:x});if(!left)break;}
        st.open=st.open.filter(f=>!(f.conflict&&f.usd<=0));notes.push(`${o.side} ${id}: KIS's settled record now says $${(k/100).toFixed(2)}; the conflict is ${target?`$${(target/100).toFixed(2)}`:'closed'}`);}
      if(k<base-1){const rel=ledger.reduceAllocations(account,id,base-k,'KIS record below the allocation');c.released.push(...rel);
        notes.push(`${o.side} ${id}: KIS's settled record says $${(k/100).toFixed(2)} where $${(base/100).toFixed(2)} was allocated; $${((base-k)/100).toFixed(2)} of that evidence is no longer explained by it (reduced coverage)`);}
      if(was.kCents!==k||was.version!==l.version)ledger.event(account,'conflict',{orderId:id,groupId:l.groupId,version:l.version,kCents:k,allocatedCents:ledger.allocatedToOrder(account,id),conflictCents:held(),releasedCents:c.released.reduce((n,r)=>n+r.cents,0)});
      if(!held()&&!c.released.length&&Math.abs(k-ledger.allocatedToOrder(account,id))<=1)c.settled=now;}
    // Overdue is noted once (overdueAt is kept); newlyOverdue lists the pieces that became overdue in this reading, for the one
    // app notification (stage 2b.5).
    const newlyOverdue=[];
    for(const f of st.open)if(!f.overdueAt&&now-(f.filledAt??f.at)>MAX_DAYS*DAY){f.overdueAt=now;f.unresolved??={why:'overdue',at:now};ledger.event(account,'overdue',{pieceId:f.pid,orderId:f.id,usd:f.usd});newlyOverdue.push({pieceId:f.pid,orderId:f.id,side:f.side,usd:f.usd});
      notes.push(`${f.side} ${f.id} ($${f.usd}): no settlement evidence after ${MAX_DAYS} days; it stays in flight, unresolved, until KIS shows it or it is reconciled`);}
    Object.assign(st,{basis,observed:reported,readAt:readAt??st.readAt,lastAt:now,evidence:st.evidence.slice(-EVIDENCE_KEPT)});
    // Orders no longer listed are forgotten, so the record stays bounded.
    const listed=new Set(orders.map(o=>String(o.id)));for(const id of Object.keys(st.seen))if(!listed.has(id)&&!st.open.some(f=>f.id===id))delete st.seen[id];
    save();return {...this.withReview(account,st),notes,newlyOverdue};
  }
  // The tracker's totals with coverage under review (electron/settlement-evidence.cjs underReview): unresolved again,
  // beside the open pieces, never matched by evidence here.
  withReview(account,st){const review=this.evidence.underReview(account).map(r=>({id:r.orderId,pid:'review:'+r.citationId,side:r.side,usd:r.usd,unresolved:{why:'under review',reason:r.reason}}));
    return InFlight.totals(review.length?{...st,open:[...st.open,...review]}:st);}
  static totals(st){const sum=(side,only=()=>true)=>st.open.filter(f=>f.side===side&&only(f)).reduce((n,f)=>n+cents(f.usd),0)/100;
    return {buysUSD:sum('Buy'),sellsUSD:sum('Sell'),unresolved:{buysUSD:sum('Buy',f=>f.unresolved),sellsUSD:sum('Sell',f=>f.unresolved)},overdue:{buysUSD:sum('Buy',f=>f.overdueAt),sellsUSD:sum('Sell',f=>f.overdueAt)},
      // Evidence released by KIS records lower than what was allocated: reported, not an obligation.
      reducedCoverage:Object.entries(st.conflicts??{}).filter(([,c])=>c.released?.length).map(([orderId,c])=>({orderId,usd:c.released.reduce((n,r)=>n+r.cents,0)/100,groupId:c.groupId,version:c.version})),
      pretracking:{count:st.open.filter(f=>f.pretracking).length,buysUSD:sum('Buy',f=>f.pretracking),sellsUSD:sum('Sell',f=>f.pretracking)},
      review:{buysUSD:sum('Buy',f=>String(f.pid??'').startsWith('review:')),sellsUSD:sum('Sell',f=>String(f.pid??'').startsWith('review:'))},open:st.open};}
  current(account){return this.withReview(account,this.state(account));}
  // Stage 2b.4: how much the tracker moved the flow detector's U.S. cash basis (cash + pending - buys + sales in flight)
  // after since without any cash movement or fill (design v1 §8.1, CN2, CN5, CN25): fills from before tracking opened,
  // conflict pieces opened or reduced, reconciliations resolving pieces and reversals reopening them. These are
  // explained changes for the flow detector, never deposits or withdrawals. Fills and cash evidence are already
  // explained by the detector's own fill records. Coverage under review is passed apart (totals().review), as it
  // changes without an event. In USD, positive when the basis rose. Counted after a ledger event id (afterId: the last one
  // a reading accounted for), so a change in the same millisecond as a reading is neither missed nor counted twice; a
  // time (since) only when no id was kept. through: the last event id now.
  // pretracking: the part from pre-tracking fills, by order, which the flow detector leaves out for an order whose fill it
  // explains itself in the same comparison (the order first listed then), so nothing is explained twice.
  // A reconciliation is a change without cash in the interval only when its payment is known to be outside it (review of
  // 06a0b95, P1: a payment and its reconciliation in one interval left the basis unchanged, and explaining the
  // reconciliation as well made a false withdrawal): a rounding record (no payment), a reclassified flow (its cash was
  // recorded in an earlier interval), or a settlement date before the interval's first U.S. day (from: its start).
  // Otherwise it is a candidate (candidates: usd and ids), which the flow detector weighs against the observed change.
  explained(account,{afterId=null,since=null,from=null}={}){const side=new Map(),pre={},cand=[];let c=0,through=0;const start=Number.isFinite(from??since)?nyDay(from??since):null;
    for(const e of this.evidence.events(account)){through=Math.max(through,e.seq);if(e.kind==='piece-opened')side.set(e.pieceId,e.side);if(afterId!=null?!(e.seq>afterId):!(e.at>since))continue;const s=side.get(e.pieceId)==='Sell'?1:-1;
      if(e.kind==='piece-opened'&&(e.pretracking||e.why==='conflict')){c+=s*cents(e.usd);if(e.pretracking&&e.why!=='conflict')pre[String(e.orderId)]=(pre[String(e.orderId)]??0)+s*cents(e.usd);}
      else if(e.kind==='reconciliation'){const outside=e.explanation==='rounding'||e.reclassified||typeof e.settledOn==='string'&&start!=null&&e.settledOn<start;if(outside)c-=s*e.cents;else cand.push({id:e.id,usd:-s*e.cents/100,settledOn:e.settledOn??null});}
      else if(e.kind==='piece-reopened')c+=s*e.cents;else if(e.kind==='conflict-reduced')c-=s*e.cents;}
    return {usd:c/100,through,pretracking:Object.fromEntries(Object.entries(pre).map(([k,v])=>[k,v/100])),candidates:{usd:Math.round(cand.reduce((n,x)=>n+x.usd,0)*100)/100,ids:cand.map(x=>x.id),items:cand.map(x=>({id:x.id,usd:x.usd}))}};}
  explainedSince(account,since){return this.explained(account,{since}).usd;}
}
module.exports={value,VERSION,STALE_MS,InFlight,MAX_DAYS,BOUND};
