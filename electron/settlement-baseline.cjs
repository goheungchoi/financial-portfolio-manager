'use strict';
// The U.S. daily-loss baseline and settlement corrections (stage 2b.4; design v2 §7.2, v3 §5.3, v3.1 decisions and §6,
// v3.3; executable rules B1-B8 in artifacts/reviews/2026-11-05-accounting/stage2b-spec.md). A reconciliation, a late
// pre-tracking fill or a KIS record correction changes the tracker's in-flight amounts with no money moving; the loss
// check must see such a change on both sides (baseline and value) or on neither, so a real loss stays visible and no
// breach is invented.
// - B1 When the U.S. engine takes a day's baseline, the tracker's open pieces (basis_p, in cents, by piece), the orders it
//   knows and its coverage under review are saved with it (settlement_baselines, one per account and day).
// - B2 A reconciliation after the baseline whose misstatement predates it (its payment before the baseline: a
//   reclassified flow that moved by the baseline, a settlement date before the baseline's day, or a rounding record)
//   moves the baseline by x = min(a, basis_p - adjusted_p), cumulative per piece: a buy raises the low bound, a sale
//   lowers the high bound. One whose payment came after the baseline moves nothing (the value already fell with it).
// - B3 Unknown timing (no flow window or date that settles it, or the settlement date is the baseline's day): both
//   scenarios are kept, adjusted ("paid before the baseline") and not adjusted ("paid after it"). When they disagree on a
//   breach the check is ambiguous: new exposure is restricted, protective reductions stay available (LiveEngine.lossOf).
// - B4 A reversal of a record made after the baseline removes that record's adjustment (the replay leaves it out). A
//   reversal of a record made before the baseline reopens an obligation the baseline never counted: the baseline moves
//   by the reopened amount the other way, and the piece's basis grows by it, so a re-resolution that day moves it back
//   by at most that much.
// - B5 A pre-tracking fill first opened after the baseline (order history arriving late) is a basis change predating
//   it: the baseline moves with it, and the piece's basis is its amount.
// - B6 A conflict piece (a KIS record above what was allocated) for an order known at the baseline is a correction
//   predating it: the baseline moves with it, and back as the conflict is reduced. Reduced coverage (a KIS record below
//   the allocation) changes no value, so it moves no baseline (E8 as amended; replaces v3 T26).
// - B7 Coverage under review changed since the baseline is a correction of the same kind: the baseline follows it.
// - B8 No snapshot for the day (the baseline was taken before this was installed): every adjustment is of unknown
//   timing (B3), with no cap.
// Amounts are USD; the Korean check never includes U.S. pieces.
const cents=v=>Math.round(Number(v)*100);
class SettlementBaseline{
  constructor(db,{inFlight,clock=Date.now}={}){if(!inFlight)throw new Error('BASELINE_NEEDS_TRACKER');this.db=db;this.inFlight=inFlight;this.ledger=inFlight.evidence;this.clock=clock;
    db.exec('CREATE TABLE IF NOT EXISTS settlement_baselines(account TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,day))');}
  get(account,day){const r=this.db.prepare('SELECT at,payload FROM settlement_baselines WHERE account=? AND day=?').get(account,day);return r?{...JSON.parse(r.payload),at:r.at}:null;}
  // B1: the tracker as the baseline saw it. The first snapshot of a day stands.
  take(account,day,at){if(typeof account!=='string'||!account||typeof day!=='string'||!Number.isFinite(at))return null;const was=this.get(account,day);if(was)return was;
    const st=this.inFlight.state(account),t=this.inFlight.current(account);
    const pieces=Object.fromEntries((st.open??[]).filter(f=>f.pid).map(f=>[f.pid,{side:f.side,cents:cents(f.usd),orderId:f.id}]));
    // The last ledger event and the records existing now: what comes after is after the baseline, whatever its time.
    const lastEventId=this.ledger.events(account).reduce((n,e)=>Math.max(n,e.seq),0),recordIds=this.records(account).map(r=>r.id);
    const payload={pieces,orders:Object.keys(st.seen??{}),review:{buysUSD:t.review?.buysUSD??0,sellsUSD:t.review?.sellsUSD??0},lastEventId,recordIds};
    this.db.prepare('INSERT INTO settlement_baselines VALUES(?,?,?,?) ON CONFLICT(account,day) DO NOTHING').run(account,day,at,JSON.stringify(payload));return {...payload,at};}
  records(account){try{return this.db.prepare('SELECT payload FROM settlement_reconciliations WHERE account=? ORDER BY at,rowid').all(account).map(r=>JSON.parse(r.payload));}catch{return [];}}
  // B2/B3: when a record's payment happened relative to the baseline.
  static timing(rec,at,day){if(rec.explanation==='rounding')return 'before';const fl=rec.effects?.flows?.original;
    if(fl){if(Number.isFinite(fl.occurredBy)&&fl.occurredBy<=at)return 'before';if(Number.isFinite(fl.occurredAfter)&&fl.occurredAfter>=at)return 'after';
      if(!Number.isFinite(fl.occurredBy)&&!Number.isFinite(fl.occurredAfter)&&typeof fl.day==='string')return fl.day<day?'before':fl.day>day?'after':'unknown';return 'unknown';}
    if(typeof rec.settledOn==='string')return rec.settledOn<day?'before':rec.settledOn>day?'after':'unknown';return 'unknown';}
  // The day's adjustments to a U.S. baseline (policy: the engine's, with day and baselineAt). certain: applied in every
  // scenario; withUnknown: also applying those of unknown timing (B3), or null when there are none. USD; items explain.
  adjustments(account,policy){const day=policy?.day,snap=day?this.get(account,day):null,at=snap?.at??policy?.baselineAt;if(!day||!Number.isFinite(at))return null;
    const items=[],certain={low:0,high:0},unsure={low:0,high:0},basis=new Map(Object.entries(snap?.pieces??{}).map(([pid,p])=>[pid,p.cents])),known=new Set(snap?.orders??[]);
    // dir +1: an obligation removed (a resolution); -1: an obligation added. Buys move the low bound, sales the high.
    const move=(b,side,c,dir)=>{if(side==='Sell')b.high-=dir*c;else b.low+=dir*c;};
    const side=new Map(),conflict=new Map();const recs=this.records(account),byId=new Map(recs.map(r=>[r.id,r])),reversed=new Set(recs.filter(r=>r.kind==='reversal').map(r=>r.target));
    // After the baseline: by ledger event id and record ids when the snapshot kept them, by time otherwise.
    const before=new Set(snap?.recordIds??[]),eventAfter=e=>Number.isFinite(snap?.lastEventId)?e.seq>snap.lastEventId:e.at>at,recordAfter=r=>snap?.recordIds?!before.has(r.id):r.confirmedAt>at;
    for(const e of this.ledger.events(account)){if(e.kind==='piece-opened')side.set(e.pieceId,e.side);if(!eventAfter(e))continue;const s=side.get(e.pieceId);
      // B5: a pre-tracking fill opened after the baseline.
      if(e.kind==='piece-opened'&&e.pretracking){const c=cents(e.usd);basis.set(e.pieceId,(basis.get(e.pieceId)??0)+c);const b=snap?certain:unsure;move(b,s,c,-1);items.push({kind:'pre-tracking fill opened',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:c/100,timing:snap?'before':'unknown'});}
      // B6: conflicts for orders the baseline knew.
      else if(e.kind==='piece-opened'&&e.why==='conflict'){if(snap&&!known.has(String(e.orderId)))continue;const c=cents(e.usd);conflict.set(e.pieceId,(conflict.get(e.pieceId)??0)+c);basis.set(e.pieceId,(basis.get(e.pieceId)??0)+c);move(snap?certain:unsure,s,c,-1);items.push({kind:'KIS record above the allocation',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:c/100,timing:snap?'before':'unknown'});}
      else if(e.kind==='conflict-reduced'&&conflict.has(e.pieceId)){const c=Math.min(e.cents,conflict.get(e.pieceId));conflict.set(e.pieceId,conflict.get(e.pieceId)-c);basis.set(e.pieceId,Math.max(0,(basis.get(e.pieceId)??0)-c));move(snap?certain:unsure,s,c,1);items.push({kind:'KIS record lowered again',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:c/100,timing:snap?'before':'unknown'});}
      // B4: a reversal of a record made before the baseline.
      else if(e.kind==='piece-reopened'){const rev=byId.get(e.by),t=rev?byId.get(rev.target):null;if(!t||recordAfter(t))continue;basis.set(e.pieceId,(basis.get(e.pieceId)??0)+e.cents);move(certain,s,e.cents,-1);items.push({kind:'reversal of an earlier reconciliation',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:e.cents/100,timing:'before',reversalId:e.by});}}
    // B7: coverage under review since the baseline.
    if(snap?.review){const r=this.inFlight.current(account).review??{buysUSD:0,sellsUSD:0},db=cents(r.buysUSD)-cents(snap.review.buysUSD),ds=cents(r.sellsUSD)-cents(snap.review.sellsUSD);
      if(db){move(certain,'Buy',db,-1);items.push({kind:'coverage under review',side:'Buy',usd:db/100,timing:'before'});}if(ds){move(certain,'Sell',ds,-1);items.push({kind:'coverage under review',side:'Sell',usd:ds/100,timing:'before'});}}
    // B2/B3: reconciliations after the baseline, in force, replayed in order; cumulative per piece.
    const pass=withUnknown=>{const b={low:0,high:0},adjusted=new Map(),out=[];
      for(const r of recs){if(r.kind!=='reconciliation'||!recordAfter(r)||reversed.has(r.id))continue;const timing=snap?SettlementBaseline.timing(r,at,day):'unknown';
        const cap=snap?(basis.get(r.pieceId)??0):Infinity,x=Math.max(0,Math.min(r.cents,cap-(adjusted.get(r.pieceId)??0)));
        const applies=timing==='before'||timing==='unknown'&&withUnknown;if(applies&&x){adjusted.set(r.pieceId,(adjusted.get(r.pieceId)??0)+x);move(b,r.side,x,1);}
        out.push({kind:'reconciliation',reconciliationId:r.id,pieceId:r.pieceId,orderId:r.orderId,side:r.side,usd:r.cents/100,timing,adjustsUSD:(timing==='after'?0:x)/100});}
      return {b,out};};
    const sure=pass(false),all=pass(true);items.push(...all.out);
    const total=(a,b)=>({low:(a.low+b.low)/100,high:(a.high+b.high)/100});
    const c=total(certain,sure.b),w=total({low:certain.low+unsure.low,high:certain.high+unsure.high},all.b);
    return {day,at,snapshot:Boolean(snap),certain:c,withUnknown:w.low!==c.low||w.high!==c.high?w:null,items};}
}
module.exports={SettlementBaseline};
