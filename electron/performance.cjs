const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
// Daily account value history, user-recorded deposits/withdrawals and benchmark closes.
// Returns are time-weighted: flows are applied at the start of their day, so deposits do not count as gains.
const INDEXES={KOSPI:{market:'KR',label:'KOSPI'},KOSDAQ:{market:'KR',label:'KOSDAQ'},KOSPI200:{market:'KR',label:'KOSPI 200'},SPX:{market:'US',label:'S&P 500'},COMP:{market:'US',label:'Nasdaq Composite'},NDX:{market:'US',label:'Nasdaq 100'},DJI:{market:'US',label:'Dow Jones'},SOX:{market:'US',label:'Philadelphia Semiconductor'},VIX:{market:'US',label:'VIX'}};
const PERIODS=[['1W',7],['1M',30],['3M',91],['YTD','ytd'],['1Y',365],['All',null]];
const isDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
const shift=(day,days)=>new Date(Date.parse(day+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
// The valuation behind a day's value (electron/valuation.cjs): both bounds, whether exact or complete, its scope,
// reasons, version and source times, and how far the uncertain range narrowed and widened during the day, per series
// (KRW: Korea, USD: the U.S., COMBINED: both, in KRW), measured between consecutive readings.
// Release review 2026-11-05, P1: the day's change in the headline cannot say how much of it was uncertainty resolving
// and how much market movement (a range resolving to its low end while prices rise looks like one resolving to its high
// end while prices fall). So nothing is inferred: a narrowing could account for anything from none to all of a rise in
// the headline, a widening for none to all of a fall, and those days' P/L is a range and provisional (series). A
// correction needs settlement or funding evidence and goes through valuation-corrections.cjs. resolvedKRW, written by
// the earlier rule, is ignored.
const SCOPES={KRW:v=>v.markets?.KR?.equity,USD:v=>v.markets?.US?.equity,COMBINED:v=>v.combined};
function bounds(valuation,prev){const c=valuation.combined;if(!c||c.low==null)return prev??null;
  const same=prev&&!prev.previousDay,range={};
  for(const [k,f] of Object.entries(SCOPES)){const e=f(valuation),width=e&&Number.isFinite(e.low)&&Number.isFinite(e.high)?e.high-e.low:null;const last=prev?.ranges?.[k]?.last??null;const before=same?prev.ranges?.[k]:null;
    const change=width!=null&&last!=null?width-last:0;range[k]={last:width,narrowed:(before?.narrowed??0)+(change<-1?-change:0),widened:(before?.widened??0)+(change>1?change:0)};}
  return {version:valuation.version,low:c.low,high:c.high,exact:c.exact,complete:c.complete,scope:c.scope,reasons:c.reasons.slice(0,6),at:{KR:valuation.markets.KR.at??null,US:valuation.markets.US.at??null,fx:valuation.fx?.at??null},ranges:range};}
class PerformanceHistory {
  constructor(db,clock=Date.now){
    this.db=db;this.clock=clock;
    db.exec('CREATE TABLE IF NOT EXISTS nav_history(account TEXT NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,day));CREATE TABLE IF NOT EXISTS cash_flows(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS benchmark_closes(idx TEXT NOT NULL,day TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(idx,day))');
  }
  // Keeps the latest valuation of each Seoul day; a market missing from this refresh keeps its earlier value for the day.
  // awaitingUS: the U.S. balance has not loaded yet (at startup). Korean equity is net of KRW committed to unsettled U.S.
  // buys, which comes from that balance, so nothing is recorded until it arrives.
  record(account,state,{awaitingUS=false}={}){
    if(typeof account!=='string'||!account||!state?.totals||awaitingUS&&state.totals.USD==null)return null;const {KRW,USD,equityKRW}=state.totals;if(KRW==null&&USD==null)return null;
    const day=seoulDate(this.clock()),existing=this.db.prepare('SELECT payload FROM nav_history WHERE account=? AND day=?').get(account,day);const prior=existing?JSON.parse(existing.payload):{};
    // Each market keeps the day's first, highest and lowest observed value and a snapshot of its holdings.
    const holdings=market=>(state.rows??[]).filter(r=>r.market===market&&Number.isFinite(r.quantity)&&Number.isFinite(r.price)).slice(0,80).map(r=>({symbol:r.symbol,name:r.name??r.symbol,quantity:r.quantity,value:r.quantity*r.price,cost:Number.isFinite(r.cost)?r.quantity*r.cost:null}));
    const band=(old,equity,cash,market)=>({equity,cash,open:old?.open??equity,high:Math.max(old?.high??equity,equity),low:Math.min(old?.low??equity,equity),positions:holdings(market)});
    const combined=equityKRW??prior.equityKRW??null;
    // Stage 3.2: the settlement tracker's uncertainty at this reading (settlement hook, set by main): last, this reading's
    // snapshot; seen, every uncertain piece of any reading that day (by id and amount); a failed read is kept as such.
    const settlement=this.settlement?(()=>{let snap=null,error=null;try{snap=this.settlement(account);if(!snap||!Array.isArray(snap.pieces))throw new Error('SNAPSHOT_INVALID');}catch(e){error=String(e?.message??e).slice(0,80);}
      const seen=[...(prior.settlement?.seen??[])];for(const p of snap?.pieces??[])if(!seen.some(s=>s.pid===p.pid&&s.usd===p.usd&&s.side===p.side))seen.push(p);
      // The most U.S. buy obligation open at any reading of the day (stage 3.4 review, CN5); unknown when a reading lacks it.
      const openMax=Math.max(prior.settlement?.openBuysMaxUSD??0,snap?.open?.buysUSD??0),openUnknown=Boolean(prior.settlement?.openUnknown||snap&&!snap.open);
      return {last:snap,seen,openBuysMaxUSD:openMax,...(openUnknown?{openUnknown:true}:{}),...(error||prior.settlement?.error?{error:error??prior.settlement.error}:{})};})():null;
    const row={day,at:this.clock(),...(state.valuation?{valuation:bounds(state.valuation,prior.valuation??this.lastValuation(account,day))}:{}),KRW:KRW==null?prior.KRW??null:band(prior.KRW,KRW,state.cash?.KRW??null,'KR'),USD:USD==null?prior.USD??null:band(prior.USD,USD,state.cash?.USD??null,'US'),fx:state.fx?.usdKRW??prior.fx??null,equityKRW:combined,
      equityKRWHigh:combined==null?null:Math.max(prior.equityKRWHigh??combined,combined),equityKRWLow:combined==null?null:Math.min(prior.equityKRWLow??combined,combined),...(settlement?{settlement}:{})};
    this.db.prepare('INSERT INTO nav_history VALUES(?,?,?) ON CONFLICT(account,day) DO UPDATE SET payload=excluded.payload').run(account,day,JSON.stringify(row));return row;
  }
  // The last valuation recorded before day (yesterday's last reading): where today's resolution is measured from.
  lastValuation(account,day){const r=this.db.prepare('SELECT payload FROM nav_history WHERE account=? AND day<? ORDER BY day DESC LIMIT 1').get(account,day);const v=r?JSON.parse(r.payload).valuation:null;return v?{ranges:v.ranges??{},previousDay:true}:null;}
  history(account){return this.db.prepare('SELECT payload FROM nav_history WHERE account=? ORDER BY day').all(account).map(row=>JSON.parse(row.payload));}
  flows(account){return this.db.prepare('SELECT payload FROM cash_flows WHERE account=?').all(account).map(row=>JSON.parse(row.payload)).sort((a,b)=>a.day.localeCompare(b.day)||a.createdAt-b.createdAt);}
  addFlow(account,value){
    const today=seoulDate(this.clock());
    if(typeof account!=='string'||!account||!value||!isDay(value.day)||value.day>today||!['KR','US'].includes(value.market)||!Number.isFinite(value.amount)||value.amount===0||Math.abs(value.amount)>1e12||typeof(value.note??'')!=='string'||String(value.note??'').length>200)throw new Error('INVALID_FLOW');
    const flow={id:randomUUID(),day:value.day,market:value.market,currency:value.market==='US'?'USD':'KRW',amount:value.market==='US'?Math.round(value.amount*100)/100:Math.round(value.amount),note:String(value.note??'').trim(),createdAt:this.clock(),...(value.detected?{detected:true}:{}),...(value.transfer?{transfer:true}:{}),
      ...(Array.isArray(value.pendingIds)&&value.pendingIds.length?{pendingIds:value.pendingIds.slice(0,40).map(String)}:{}),
      ...(value.transfer&&value.awaitingExchange?{awaitingExchange:true}:{}),...(value.transfer&&value.source==='exchange'?{source:'exchange'}:{}),
      // When the money moved, if known (release review 2026-11-05, P1): after one balance reading and by the next. A flow
      // entered by hand has only its date. createdAt and confirmedAt say when it was recorded, never when it happened.
      ...(Number.isFinite(value.occurredBy)?{occurredBy:value.occurredBy}:{}),...(Number.isFinite(value.occurredAfter)?{occurredAfter:value.occurredAfter}:{})};
    this.db.prepare('INSERT INTO cash_flows VALUES(?,?,?)').run(flow.id,account,JSON.stringify(flow));return flow;
  }
  // A recorded transfer whose currency exchange has now been seen: kept as it is, marked so it is not matched again.
  markExchanged(account,ids,exchange){for(const id of ids){const row=this.db.prepare('SELECT payload FROM cash_flows WHERE id=? AND account=?').get(id,account);if(!row)continue;
    this.db.prepare('UPDATE cash_flows SET payload=? WHERE id=? AND account=?').run(JSON.stringify({...JSON.parse(row.payload),exchangedAt:exchange.at,exchange:{KRW:exchange.KRW,USD:exchange.USD}}),id,account);}}
  removeFlow(account,id){this.db.prepare('DELETE FROM cash_flows WHERE id=? AND account=?').run(id,account);}
  // A detected flow the user confirmed keeps its amount and stops being flagged.
  confirmFlow(account,id){const row=this.db.prepare('SELECT payload FROM cash_flows WHERE id=? AND account=?').get(id,account);if(!row)throw new Error('INVALID_FLOW');
    const {detected,...flow}=JSON.parse(row.payload);this.db.prepare('UPDATE cash_flows SET payload=? WHERE id=? AND account=?').run(JSON.stringify({...flow,confirmedAt:this.clock()}),id,account);}
  // Money moved in one market since a time (the daily loss baseline's), split into confirmed (recorded or confirmed by
  // you) and unresolved (detected, awaiting you); without a time, that Seoul day's.
  // Release review 2026-11-05, P1: a flow belongs after the baseline by when the money moved, never by when it was
  // recorded or confirmed (a deposit from two days ago entered today is already in the baseline). With its window known,
  // it is after the baseline when it moved after it, before when it moved by it, and otherwise uncertain; with only its
  // date, after when the date is later than the baseline's Seoul date, before when earlier, uncertain on that date.
  // uncertain: the flows whose side of the baseline cannot be told, for the loss scenarios; ids: which flows were counted.
  flowsSince(account,market,since,day=seoulDate(this.clock())){const mine=this.flows(account).filter(f=>f.market===market);
    // range: the lowest and highest total of the uncertain items (each real or not), item by item so that changes in
    // both directions are not netted (stage 2b.4 review of f26d33f).
    const range=list=>({low:list.reduce((n,f)=>n+Math.min(0,f.amount),0),high:list.reduce((n,f)=>n+Math.max(0,f.amount),0)});
    if(!Number.isFinite(since)){const list=mine.filter(f=>f.day===day);return {confirmed:list.filter(f=>!f.detected).reduce((n,f)=>n+f.amount,0),unresolved:list.filter(f=>f.detected).reduce((n,f)=>n+f.amount,0),uncertain:{confirmed:0,unresolved:0},ids:list.map(f=>f.id),range:range(list.filter(f=>f.detected))};}
    const baseDay=seoulDate(since);const side=f=>Number.isFinite(f.occurredBy)?(f.occurredBy<=since?'before':Number.isFinite(f.occurredAfter)&&f.occurredAfter>=since?'after':'uncertain'):f.day<baseDay?'before':f.day>baseDay?'after':'uncertain';
    const sum=(list,detected)=>list.filter(f=>Boolean(f.detected)===detected).reduce((n,f)=>n+f.amount,0);const after=mine.filter(f=>side(f)==='after'),unsure=mine.filter(f=>side(f)==='uncertain');
    return {confirmed:sum(after,false),unresolved:sum(after,true),uncertain:{confirmed:sum(unsure,false),unresolved:sum(unsure,true)},ids:after.map(f=>f.id),uncertainIds:unsure.map(f=>f.id),range:range([...after.filter(f=>f.detected),...unsure])};}
  // Net deposits (positive) and withdrawals in one market's currency on one Seoul day.
  flowsOn(account,day,market){return this.flows(account).filter(f=>f.day===day&&f.market===market).reduce((sum,f)=>sum+f.amount,0);}
  saveCloses(index,rows){if(!INDEXES[index])throw new Error('INVALID_INDEX');const insert=this.db.prepare('INSERT INTO benchmark_closes VALUES(?,?,?) ON CONFLICT(idx,day) DO UPDATE SET close=excluded.close');for(const row of rows)if(isDay(row.day)&&Number.isFinite(row.close)&&row.close>0)insert.run(index,row.day,row.close);}
  closes(index){return this.db.prepare('SELECT day,close FROM benchmark_closes WHERE idx=? ORDER BY day').all(index).map(row=>({day:row.day,close:row.close}));}
  // Money movements by category (audit 2026-11-04, Stage 2): external (recorded or confirmed deposits and withdrawals),
  // transfer (between the Korean and U.S. accounts, including integrated-margin funding) and unresolved (detected,
  // awaiting you). Settlements and fees are explained from trades by the flow detector and are not recorded as flows.
  movements(account){return this.flows(account).map(f=>({...f,category:f.detected?'unresolved':f.transfer?'transfer':'external'}));}
  // series: 'KRW' (Korea account), 'USD' (U.S. account) or 'COMBINED' (KRW, U.S. flows converted at that day's rate).
  // unresolved: 'exclude' (the headline: a detected change awaiting you is not taken as a deposit or withdrawal, a
  // provisional scenario, not proof that none happened) or 'include' (the other scenario).
  // adjustments: versioned valuation corrections (electron/valuation-corrections.cjs), each {day, market, amount} in
  // its market's currency; the recorded values are never changed, the series is computed with them.
  // corrections (stage 3.1, electron/performance-corrections.cjs, set by main): each recorded day's accounting correction
  // in U.S. dollars (the settlement ledger's cash-free changes of the low basis). It is not investment P/L: P/L and the
  // daily return leave it out; a day whose correction depends on unknown payment timing has no return.
  series(account,kind,{unresolved='exclude',adjustments=this.adjustments?.(account)??[]}={}){
    // Transfers between the Korean and U.S. accounts move money within the account: they count in each market's series
    // and not in the combined one.
    const history=this.history(account),flows=this.flows(account).filter(f=>unresolved==='include'||!f.detected);let previous=null,index=1,lastFx=null;const points=[];
    // A correction read that fails is never taken as "no corrections" (stage 3.1 review, P2): every day of the U.S. and
    // combined series then has no return and no P/L, with the reason.
    let corrections=new Map(),failed=null;if(kind!=='KRW'&&this.corrections)try{corrections=this.corrections(account,history);if(!(corrections instanceof Map))throw new Error('CORRECTIONS_INVALID');}catch(e){corrections=new Map();failed=`settlement corrections could not be read (${String(e?.message??e).slice(0,80)})`;}
    for(const row of history){
      lastFx=row.fx??lastFx;const recorded=kind==='KRW'?row.KRW?.equity:kind==='USD'?row.USD?.equity:row.equityKRW;if(!Number.isFinite(recorded))continue;
      const historical=kind==='KRW'?0:(corrections.get(row.day)?.adjustmentUSD??0)*(kind==='COMBINED'?(lastFx??NaN):1);
      const adj=historical+adjustments.filter(a=>a.day===row.day&&(kind==='COMBINED'||a.currency===kind)).reduce((n,a)=>n+(kind==='COMBINED'&&a.currency==='USD'?(lastFx==null?NaN:a.amount*lastFx):a.amount),0);const value=recorded+adj;
      const flow=flows.filter(f=>f.day===row.day&&(kind==='COMBINED'?!f.transfer:f.currency===kind)).reduce((sum,f)=>sum+(kind==='COMBINED'&&f.currency==='USD'?(lastFx==null?NaN:f.amount*lastFx):f.amount),0);
      // Flows recorded on days without a valuation are folded into the next valued day.
      const skipped=previous?flows.filter(f=>f.day>previous.day&&f.day<row.day&&(kind==='COMBINED'?!f.transfer:f.currency===kind)).reduce((sum,f)=>sum+(kind==='COMBINED'&&f.currency==='USD'?(lastFx==null?NaN:f.amount*lastFx):f.amount),0):0;
      // The valuation range narrowing or widening that day (bounds above): P/L is a range, never an inferred flow.
      const range=row.valuation?.ranges?.[kind]??null,narrowed=range?.narrowed??0,widened=range?.widened??0;
      const netFlow=flow+skipped,base=previous?previous.value+netFlow:null;
      // The day's correction in the series' currency (U.S. dollars at the day's rate in the combined series), and what
      // could not be told: the possible corrections of unknown timing give the P/L a range, and the return is unavailable.
      const cx=previous?corrections.get(row.day):null,rate=kind==='COMBINED'?lastFx:1,conv=v=>v*(rate??NaN);
      const correction=cx?.items?.length?conv(cx.usd):0,unknownC=cx?.unknown?.length?cx.items.filter(i=>i.usd==null).map(i=>conv(i.possibleUSD??0)):[];const lost=Boolean(failed&&previous);
      // Stage 3.2: a day affected by an uncertain obligation or a misstatement window is unavailable (blocked); the one
      // bounded case is a range in the U.S. series and unavailable in the combined one (its funding route and FX exposure
      // are not bounded).
      const blocked=[...(previous?cx?.unavailable??[]:[])];let bounded=previous&&cx?.bounded&&!blocked.length&&!unknownC.length&&!lost?cx.bounded:null;
      if(bounded&&kind!=='USD'){blocked.push(`an uncertain U.S. buy obligation of $${Number(bounded.usd).toFixed(2)}: its funding route and FX exposure are not bounded in this series, so the return is unavailable`);bounded=null;}
      const states=bounded&&base>0&&Number.isFinite(base)?{real:(value-correction)/base-1,notReal:(value+bounded.usd-correction)/(base+bounded.usd)-1}:null;if(bounded&&!states){blocked.push('an uncertain U.S. buy obligation on a day with no base value');bounded=null;}
      const out=Boolean(unknownC.length||lost||blocked.length);
      const dailyReturn=out||bounded?null:base>0&&Number.isFinite(base)?(value-correction)/base-1:null;
      if(dailyReturn!=null)index*=1+dailyReturn;
      // Unrealized P/L and holdings: native for one market; the all-markets series converts U.S. values at the day's rate.
      const parts=kind==='COMBINED'?[[row.KRW,1],[row.USD,lastFx]]:[[kind==='KRW'?row.KRW:row.USD,1]];
      const positions=parts.every(([m,f])=>!m||m.positions&&Number.isFinite(f))?parts.flatMap(([m,f])=>(m?.positions??[]).map(p=>({...p,value:p.value*f,cost:p.cost==null?null:p.cost*f}))):null;
      const unrealized=positions&&positions.length&&positions.every(p=>p.cost!=null)?positions.reduce((sum,p)=>sum+p.value-p.cost,0):positions&&!positions.length?0:null;
      const cash=parts.reduce((sum,[m,f])=>sum==null||!m||m.cash==null||!Number.isFinite(f)?null:sum+m.cash*f,0);
      const high=kind==='COMBINED'?row.equityKRWHigh:(kind==='KRW'?row.KRW:row.USD)?.high,low=kind==='COMBINED'?row.equityKRWLow:(kind==='KRW'?row.KRW:row.USD)?.low;
      const known=previous?value-previous.value-netFlow-correction:null,pnl=unknownC.length||lost||blocked.length?null:known;
      const ranged=unknownC.length?{pnlRange:{low:known-unknownC.reduce((n,v)=>n+Math.max(0,v),0)-narrowed,high:known-unknownC.reduce((n,v)=>n+Math.min(0,v),0)+widened},provisional:'a settlement correction of unknown payment timing: P/L is shown as a range'}
        :pnl!=null&&(narrowed||widened)?{pnlRange:{low:pnl-narrowed,high:pnl+widened},provisional:'the valuation range changed this day; P/L is shown as a range'}:{};
      // Stage 3.4: how the settlement treatment touched the day (consumers label such days and never call them verified).
      // pending (stage 3.4 review, CN5): U.S. buys awaiting settlement evidence during the day; a payment made meanwhile is
      // counted twice until it is matched or reconciled, so the day's return is shown but not verified.
      const settlement=[...(previous&&cx?.pending?['pending']:[]),...(cx?.items?.length?['corrected']:[]),...(historical?['restated']:[]),...(unknownC.length||lost||blocked.length?['unavailable']:[]),...(bounded?['bounded']:[])];
      points.push({day:row.day,value,...(adj?{recorded,adjustment:adj}:{}),...(historical?{restated:historical}:{}),...(settlement.length?{settlement}:{}),...(previous&&cx?.pending?{pendingObligation:cx.pending}:{}),flow:netFlow,...(cx?.items?.length?{correction,correctionItems:cx.items,correctionLabel:'accounting correction, not investment return'}:{}),
        ...(unknownC.length||lost||blocked.length?{unavailable:[...(lost?[failed]:[]),...(cx?.unknown??[]),...blocked]}:{}),
        ...(bounded?{bounded:{pieceId:bounded.pieceId,usd:bounded.usd,states,returnRange:{low:Math.min(states.real,states.notReal),high:Math.max(states.real,states.notReal)},label:`one uncertain obligation of $${Number(bounded.usd).toFixed(2)}: the return is a range (real, or not real)`}}:{}),
        dailyReturn,index,pnl,...(lost||blocked.length?{}:ranged),high:Number.isFinite(high)?high:value,low:Number.isFinite(low)?low:value,cash,unrealized,positions});previous={day:row.day,value};
    }
    return points;
  }
  // Period returns, money gain after flows and the matching benchmark change, all from the same start and end days.
  // With unresolved movements in the history the summary is provisional: the headline leaves them out, and
  // provisional.included gives the period results with them counted (scenarios, not a guaranteed range).
  summary(account,kind,benchmark,{unresolved='exclude',adjustments}={}){
    const points=this.series(account,kind,{unresolved,...(adjustments?{adjustments}:{})});if(points.length<1)return {kind,points,periods:[],start:null,end:null,benchmark};
    const end=points.at(-1),closes=benchmark?this.closes(benchmark):[];const closeOn=day=>closes.filter(c=>c.day<=day).at(-1)??null;
    const periods=PERIODS.map(([label,days])=>{
      const target=days==null?points[0].day:days==='ytd'?end.day.slice(0,4)+'-01-01':shift(end.day,days);
      const start=[...points].reverse().find(p=>p.day<=target)??points[0];const partial=start.day>target&&days!=null;
      if(start.day===end.day)return {label,start:start.day,end:end.day,partial,twr:null,gain:null,flows:0,benchmark:null};
      const inside=points.filter(p=>p.day>start.day&&p.day<=end.day),flows=inside.reduce((sum,p)=>sum+p.flow,0),corrections=inside.reduce((sum,p)=>sum+(p.correction??0),0);
      const from=closeOn(start.day),to=closeOn(end.day),unavailable=inside.filter(p=>p.unavailable).map(p=>`${p.day}: ${p.unavailable.join('; ')}`);
      // Stage 3.2 (U3): bounded days chain each state separately, for one obligation only; two or more have no
      // consistent set of states, so the period is unavailable.
      const pieces=[...new Set(inside.filter(p=>p.bounded).map(p=>p.bounded.pieceId))];
      if(!unavailable.length&&pieces.length>1)unavailable.push(`${pieces.length} uncertain obligations in the period: no consistent range`);
      const chain=state=>inside.reduce((n,p)=>n*(1+(p.bounded?p.bounded.states[state]:p.dailyReturn??0)),1)-1;
      const twrRange=!unavailable.length&&pieces.length?(([a,b])=>({low:Math.min(a,b),high:Math.max(a,b)}))([chain('real'),chain('notReal')]):null;
      return {label,start:start.day,end:end.day,partial,twr:unavailable.length||pieces.length?null:end.index/start.index-1,gain:unavailable.length?null:end.value-start.value-flows-corrections,flows,
        ...(affected(inside)?{settlementAffected:affected(inside)}:{}),...(twrRange?{twrRange}:{}),...(corrections?{corrections}:{}),...(unavailable.length?{unavailable}:{}),benchmark:from&&to&&from.day!==to.day?to.close/from.close-1:null};
    });
    const analytics=Object.fromEntries(periods.map(p=>[p.label,analyze(points,p.start)]));
    const open=unresolved==='exclude'?this.movements(account).filter(f=>f.category==='unresolved'&&f.day>=points[0].day&&(kind==='COMBINED'||f.currency===kind)):[];
    const ranged=points.filter(p=>p.pnlRange).map(p=>({day:p.day,pnl:p.pnl,low:p.pnlRange.low,high:p.pnlRange.high}));
    const provisional=open.length||ranged.length?{...(open.length?{unresolved:open.map(f=>({day:f.day,market:f.market,currency:f.currency,amount:f.amount})),scenario:'headline leaves these out; included counts them as deposits or withdrawals',
      included:this.summary(account,kind,benchmark,{unresolved:'include',...(adjustments?{adjustments}:{})}).periods.map(({label,twr,gain})=>({label,twr,gain}))}:{}),...(ranged.length?{rangeChanges:ranged}:{})}:null;
    return {kind,benchmark,start:points[0].day,end:end.day,points:points.map(({positions,...p})=>p),periods,analytics,...(provisional?{provisional}:{})};
  }
}
// Stage 3.4: the days of a window the settlement treatment touched, by kind; null when none.
function affected(days){const n=k=>days.filter(p=>(p.settlement??[]).includes(k)).length;const out={pending:n('pending'),corrected:n('corrected'),restated:n('restated'),unavailable:n('unavailable'),bounded:n('bounded')};return Object.values(out).some(Boolean)?out:null;}
// Risk and attribution for the points from a start day: peak, trough, drawdowns, volatility, best and worst days,
// daily P/L and the change in each holding's unrealized P/L.
// Stage 3.4: an unavailable day (or a bounded one, which has no single return) breaks the time-weighted chain. The
// window's return, its drawdowns from that day on and its gain (when a day is unavailable) are then unavailable, never
// read from the flat index or the raw values. Day statistics use the days with a return and say how many lack one.
function analyze(points,from){
  const pts=points.filter(p=>p.day>=from);if(!pts.length)return null;const first=pts[0],last=pts.at(-1);
  const days=pts.slice(1);const rets=days.map(p=>p.dailyReturn).filter(Number.isFinite);
  const gaps=days.filter(p=>p.unavailable||p.bounded),blocked=days.filter(p=>p.unavailable),firstGap=gaps[0]?.day??null;
  let top=-Infinity,maxDd=0;const drawdown=pts.map(p=>{if(firstGap!=null&&p.day>=firstGap)return {day:p.day,drawdownPct:null};top=Math.max(top,p.index);const dd=p.index/top-1;maxDd=Math.min(maxDd,dd);return {day:p.day,drawdownPct:dd*100};});
  const by=(list,key,dir)=>list.reduce((best,p)=>best==null||dir*(p[key]-best[key])>0?p:best,null);
  const mean=rets.length?rets.reduce((a,b)=>a+b,0)/rets.length:null;const sd=rets.length>=5?Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1)):null;
  const peak=by(pts,'value',1),trough=by(pts,'value',-1),high=by(pts,'high',1),low=by(pts,'low',-1);
  const best=by(days.filter(p=>Number.isFinite(p.dailyReturn)),'dailyReturn',1),worst=by(days.filter(p=>Number.isFinite(p.dailyReturn)),'dailyReturn',-1);
  let contributions=null;
  if(first.positions&&last.positions){const map=new Map();const add=(list,key)=>{for(const p of list){if(p.cost==null)continue;const row=map.get(p.symbol)??{symbol:p.symbol,name:p.name,start:0,end:0,held:{}};row[key]=p.value-p.cost;row.held[key]=true;map.set(p.symbol,row);}};
    add(first.positions,'start');add(last.positions,'end');contributions=[...map.values()].map(r=>({symbol:r.symbol,name:r.name,startUnrealized:r.start,endUnrealized:r.end,change:r.end-r.start,status:r.held.start&&r.held.end?'held':r.held.end?'new':'closed'})).sort((a,b)=>b.change-a.change);}
  const r2=v=>v==null?null:Math.round(v*100)/100;
  const corrections=days.reduce((a,p)=>a+(p.correction??0),0);
  return {from:first.day,to:last.day,days:pts.length,startValue:first.value,endValue:last.value,twrPct:gaps.length?null:r2((last.index/first.index-1)*100),gain:blocked.length?null:last.value-first.value-days.reduce((a,p)=>a+p.flow,0)-corrections,
    ...(corrections?{corrections}:{}),...(affected(days)?{settlementAffected:affected(days)}:{}),returnDays:rets.length,unavailableDays:blocked.map(p=>({day:p.day,reasons:p.unavailable})),...(gaps.length?{chainBrokenFrom:firstGap}:{}),
    // Values on restated days include the approved overlay (stage 3.4 review): flagged, never called recorded values.
    peak:{value:peak.value,day:peak.day,...(peak.restated?{restated:peak.restated}:{})},trough:{value:trough.value,day:trough.day,...(trough.restated?{restated:trough.restated}:{})},intradayHigh:{value:high.high,day:high.day},intradayLow:{value:low.low,day:low.day},
    maxDrawdownPct:gaps.length?null:r2(maxDd*100),currentDrawdownPct:gaps.length?null:r2(drawdown.at(-1).drawdownPct),volatilityPct:sd==null?null:r2(sd*Math.sqrt(252)*100),
    bestDay:best?{day:best.day,returnPct:r2(best.dailyReturn*100),pnl:best.pnl}:null,worstDay:worst?{day:worst.day,returnPct:r2(worst.dailyReturn*100),pnl:worst.pnl}:null,
    positiveDaysPct:rets.length?r2(rets.filter(v=>v>0).length/rets.length*100):null,unrealized:last.unrealized,cashSharePct:last.cash!=null&&last.value>0?r2(last.cash/last.value*100):null,
    dailyPnl:days.map(p=>({day:p.day,pnl:p.pnl,returnPct:p.dailyReturn==null?null:r2(p.dailyReturn*100),...(p.pnlRange?{pnlRange:p.pnlRange}:{}),...(p.unavailable?{unavailable:p.unavailable}:{}),...(p.correction?{correction:p.correction}:{}),...(p.bounded?{returnRangePct:{low:r2(p.bounded.returnRange.low*100),high:r2(p.bounded.returnRange.high*100)}}:{})})),
    drawdown:drawdown.map(d=>({day:d.day,drawdownPct:r2(d.drawdownPct)})),contributions};
}
// The performance part of the AI review context (main's automation.performanceSummary), from one series' summary.
// Stage 3.4: a period without a return is listed with its reasons, never left out or given a number; accounting
// corrections and days without a return are listed apart.
function reviewSummary(s){return {since:s.start,currency:s.kind,benchmark:s.benchmark==='SPX'?'S&P 500':'KOSPI',timeWeightedReturns:s.periods.filter(p=>p.start!==p.end).map(p=>({period:p.label,from:p.start,partial:p.partial,returnPct:p.twr==null?null:+(p.twr*100).toFixed(2),...(p.twrRange?{returnRangePct:{low:+(p.twrRange.low*100).toFixed(2),high:+(p.twrRange.high*100).toFixed(2)}}:{}),...(p.unavailable?{unavailable:p.unavailable.slice(0,3).map(x=>String(x).slice(0,240))}:{}),...(p.corrections?{accountingCorrections:Math.round(p.corrections*100)/100}:{}),...(p.settlementAffected?{settlementAffected:p.settlementAffected}:{}),benchmarkPct:p.benchmark==null?null:+(p.benchmark*100).toFixed(2)})),...(()=>{const a=s.analytics?.['3M']??s.analytics?.All;if(!a)return {};const m1=s.analytics?.['1M'];const day=d=>d&&{day:d.day,returnPct:d.returnPct,pnl:Math.round(d.pnl)};const top=(a.contributions??[]).filter(c=>c.change!==0);
      return {risk:{window:`${a.from} to ${a.to}`,peak:{value:Math.round(a.peak.value),day:a.peak.day},trough:{value:Math.round(a.trough.value),day:a.trough.day},maxDrawdownPct:a.maxDrawdownPct,currentDrawdownPct:a.currentDrawdownPct,maxDrawdown1mPct:m1?.maxDrawdownPct??null,volatilityPct:a.volatilityPct,bestDay:day(a.bestDay),worstDay:day(a.worstDay),positiveDaysPct:a.positiveDaysPct,daysWithReturn:a.returnDays,daysWithoutReturn:a.unavailableDays.length,...(a.chainBrokenFrom?{returnChainBrokenFrom:a.chainBrokenFrom}:{})},
        recentDailyPnl:a.dailyPnl.slice(-5).map(p=>({day:p.day,pnl:p.pnl==null?null:Math.round(p.pnl),returnPct:p.returnPct,...(p.unavailable?{unavailable:true}:{}),...(p.correction?{accountingCorrection:Math.round(p.correction*100)/100}:{})})),
        settlement:(()=>{const pts=s.points.filter(p=>p.day>a.from);const corr=pts.filter(p=>p.correction).map(p=>({day:p.day,amount:Math.round(p.correction*100)/100}));const un=pts.filter(p=>p.unavailable).map(p=>({day:p.day,why:String(p.unavailable[0]).slice(0,200)}));const rest=pts.filter(p=>p.restated).length;
          return corr.length||un.length||rest?{accountingCorrections:corr.slice(-5),daysWithoutReturn:un.slice(-5),restatedDays:rest,label:'accounting corrections are not investment return; days without a return are unknown, not zero'}:undefined;})(),unrealizedPnl:a.unrealized==null?null:Math.round(a.unrealized),cashSharePct:a.cashSharePct,
        holdingContribution:top.length?{basis:'Change in unrealized P/L over the window',best:top.slice(0,3).map(c=>({symbol:c.symbol,change:Math.round(c.change),status:c.status})),worst:top.slice(-3).reverse().filter(c=>c.change<0).map(c=>({symbol:c.symbol,change:Math.round(c.change),status:c.status}))}:undefined};})()};}
// The review context's performance for one market (main's automation.performanceSummary, stage 3.5: one function for main
// and the stage 3 gate harness): the summary, the money changes not yet settled, and whether the returns measure market
// performance (cash movements not yet reconciled and settlement-affected days make them unreliable).
function reviewPerformance(s,{unconfirmed=[],checking=[],uncertainKRW=0}={}){
  const reliability=returnReliability({unconfirmed,checking,uncertainKRW,settlement:(s.analytics?.['3M']??s.analytics?.All)?.settlementAffected??null});
  return {...reviewSummary(s),...(unconfirmed.length?{unconfirmedFlows:unconfirmed}:{}),...(checking.length?{cashChangesBeingChecked:checking}:{}),returnReliability:reliability};}
// Each market's day for the daily digest (main's automation.performanceToday): its return, or why it has none, its
// accounting correction and its settlement treatment.
function todayFigures(perf,account,day){return [['KR','KRW','Korea'],['US','USD','U.S.']].flatMap(([market,currency,label])=>{const p=perf.series(account,currency).find(x=>x.day===day);
  return p?[{market,currency,label,dailyReturn:p.dailyReturn,pnl:p.pnl??null,correction:p.correction??0,unavailable:p.unavailable??null,returnRange:p.bounded?.returnRange??null,settlement:p.settlement??[]}]:[];});}
function benchmarkFor(kind){return kind==='USD'?'SPX':'KOSPI';}
// When a market's session for a trading day is over and its index readings are closes: 15:40 Seoul for Korean indexes,
// 16:20 New York for U.S. ones (after the closing auctions and the VIX settle). An index row fetched before then is an
// intraday reading and is not stored as that day's close.
const nyOffset=day=>{const name=new Date(day+'T12:00:00Z').toLocaleString('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'});const m=/GMT([+-]\d+)/.exec(name);const h=m?Number(m[1]):-5;return (h<0?'-':'+')+String(Math.abs(h)).padStart(2,'0')+':00';};
const sessionEnd=(market,day)=>market==='US'?Date.parse(`${day}T16:20:00${nyOffset(day)}`):Date.parse(`${day}T15:40:00+09:00`);
const finishedRows=(index,rows,now=Date.now())=>(rows??[]).filter(r=>isDay(r?.day)&&sessionEnd(INDEXES[index]?.market??'KR',r.day)<=now);
// Whether a Korean or U.S. session ended after `since` (and by `now`): index closes should be refreshed then.
function closedSince(since,now=Date.now()){
  for(let back=0;back<=3;back++){const day=new Date(now+9*3600000-back*86400000).toISOString().slice(0,10);
    for(const market of ['KR','US']){const end=sessionEnd(market,day);if(end>since&&end<=now)return true;}}
  return false;
}
// Whether a market's returns measure market performance, apart from whether its balance is reliable: unconfirmed
// detected flows, cash changes not yet explained, and unknown funding of unsettled U.S. buys (Korean value) are inside them.
// settlement (stage 3.4): the window's settlement-affected days (analyze().settlementAffected): days without a return,
// accounting corrections and restated days all make the returns unverified.
function returnReliability({unconfirmed=[],checking=[],uncertainKRW=0,settlement=null}){
  const money=(amount,currency)=>currency==='USD'?`$${Math.abs(amount).toFixed(2)}`:`₩${Math.abs(Math.round(amount)).toLocaleString('en-US')}`;
  const reasons=[...unconfirmed.map(f=>`a detected ${f.amount>0?'deposit':'withdrawal'} of ${money(f.amount,f.currency)} on ${f.day} is not confirmed; returns treat it as one`),
    ...checking.map(f=>`a cash change of ${f.amount>0?'+':'−'}${money(f.amount,f.currency)} since ${String(f.since).slice(0,16).replace('T',' ')} UTC is not yet explained; returns count it as gain or loss`),
    ...(uncertainKRW>0?[`funding of ₩${Math.round(uncertainKRW).toLocaleString('en-US')} of unsettled U.S. buys is not yet known, so Korean value may be understated`]:[]),
    ...(settlement?.unavailable?[`${settlement.unavailable} recorded day${settlement.unavailable>1?'s have':' has'} no return (a U.S. settlement obligation that may not have been real, or a payment that may have been counted twice); returns spanning ${settlement.unavailable>1?'them':'it'} are unavailable, not zero`]:[]),
    ...(settlement?.bounded?[`${settlement.bounded} day${settlement.bounded>1?'s have':' has'} only a return range (one uncertain U.S. obligation)`]:[]),
    ...(settlement?.pending?[`${settlement.pending} day${settlement.pending>1?'s':''} had U.S. buys awaiting settlement evidence: a payment made then is counted twice until it is matched or reconciled, so ${settlement.pending>1?'those returns are':'that return is'} not verified`]:[]),
    ...(settlement?.corrected?[`${settlement.corrected} day${settlement.corrected>1?'s include':' includes'} accounting corrections, kept out of returns`]:[]),
    ...(settlement?.restated?[`${settlement.restated} day${settlement.restated>1?'s are':' is'} restated by a historical correction you approved`]:[])];
  return reasons.length?{reliable:false,reasons}:{reliable:true};
}
module.exports={PerformanceHistory,INDEXES,benchmarkFor,analyze,reviewSummary,reviewPerformance,todayFigures,finishedRows,closedSince,sessionEnd,returnReliability};
