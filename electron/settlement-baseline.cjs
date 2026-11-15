'use strict';
// The U.S. daily-loss baseline and the settlement tracker (settlement clean-up S3b, artifacts/reviews/
// 2026-11-14-settlement-cleanup/s3/design.md; it replaces the rules of stage 2b.4). The loss check must see a change of
// the tracker's in-flight amounts that moves no money on both sides (baseline and value) or on neither, so a real loss
// stays visible and no breach is invented.
//
// The snapshot: when the U.S. engine takes a day's baseline, the tracker's open pieces (cents, by piece), and the orders it
// knows are saved with it (settlement_baselines, one per account and day; the first stands; S5: older snapshots' review
// field, always zero, is not read). What comes after the baseline is decided by the ledger event id the snapshot kept, not by the clock.
//
// The one rule: a cash-free change of the tracker's basis after the day's baseline predates it, so the baseline moves
// with the value by the same amount. A buy moves the low bound, a sale the high bound. The changes are the ledger events
// InFlight.explained classifies the same way:
// - a pre-tracking fill opened after the baseline (order history arriving late): the obligation is added (-), and the
//   piece's basis is its amount;
// - a KIS record above what was allocated (a conflict piece), only for an order the snapshot knew (one the baseline did
//   not know moves nothing): added (-); reduced again: removed (+), at most what it added;
// - a piece settled by age, or the fee difference of one closed with its evidence: removed (+), cumulative per piece and
//   at most the piece's basis (what the baseline counted of it, or what opened after it).
// A close alone is zero P/L; a real loss on the day of a close is measured in full.
// No snapshot for the day: the corrections cannot be placed against the baseline, so they are unavailable, with the
// reason (the loss check then reports itself unavailable; ruling R1). A snapshot that could not be saved is already
// unavailable in LiveEngine.settlement.
// Amounts are USD; the Korean check never includes U.S. pieces.
const cents=v=>Math.round(Number(v)*100);
class SettlementBaseline{
  constructor(db,{inFlight,clock=Date.now}={}){if(!inFlight)throw new Error('BASELINE_NEEDS_TRACKER');this.db=db;this.inFlight=inFlight;this.ledger=inFlight.evidence;this.clock=clock;
    db.exec('CREATE TABLE IF NOT EXISTS settlement_baselines(account TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,day))');}
  get(account,day){const r=this.db.prepare('SELECT at,payload FROM settlement_baselines WHERE account=? AND day=?').get(account,day);return r?{...JSON.parse(r.payload),at:r.at}:null;}
  // The snapshot: the tracker as the baseline saw it. The first snapshot of a day stands. (S4b-2: recordIds, the
  // reconciliation records then, is no longer written; older snapshots keep it, unread.)
  take(account,day,at){if(typeof account!=='string'||!account||typeof day!=='string'||!Number.isFinite(at))return null;const was=this.get(account,day);if(was)return was;
    const st=this.inFlight.state(account);
    const pieces=Object.fromEntries((st.open??[]).filter(f=>f.pid).map(f=>[f.pid,{side:f.side,cents:cents(f.usd),orderId:f.id,...(f.conflict?{conflict:true}:{})}]));
    const lastEventId=this.ledger.events(account).reduce((n,e)=>Math.max(n,e.seq),0);
    const payload={pieces,orders:Object.keys(st.seen??{}),lastEventId};
    this.db.prepare('INSERT INTO settlement_baselines VALUES(?,?,?,?) ON CONFLICT(account,day) DO NOTHING').run(account,day,at,JSON.stringify(payload));return {...payload,at};}
  // The day's adjustment to a U.S. baseline (policy: the engine's, with day and baselineAt): {certain:{low,high}, items}
  // in USD, items saying what makes it; {unavailable: reason} with no snapshot; null without a day or a baseline time.
  adjustments(account,policy){const day=policy?.day,snap=day?this.get(account,day):null,at=snap?.at??policy?.baselineAt;if(!day||!Number.isFinite(at))return null;
    if(!snap)return {unavailable:'the day\'s baseline has no settlement snapshot, so settlement changes since it cannot be placed'};
    const items=[],b={low:0,high:0},basis=new Map(Object.entries(snap.pieces??{}).map(([pid,p])=>[pid,p.cents])),known=new Set(snap.orders??[]);
    // dir +1: an obligation removed; -1: an obligation added. Buys move the low bound, sales the high.
    const move=(side,c,dir)=>{if(side==='Sell')b.high-=dir*c;else b.low+=dir*c;};
    // Conflict pieces the baseline already counted, at what was left of them then (review of 06a0b95, P1).
    const conflict=new Map(Object.entries(snap.pieces??{}).filter(([,p])=>p.conflict).map(([pid,p])=>[pid,p.cents])),side=new Map(),closed=new Map();
    const after=e=>Number.isFinite(snap.lastEventId)?e.seq>snap.lastEventId:e.at>at;
    for(const e of this.ledger.events(account)){if(e.kind==='piece-opened')side.set(e.pieceId,e.side);if(!after(e))continue;const s=e.side??side.get(e.pieceId);
      if(e.kind==='piece-opened'&&(e.pretracking||e.why==='conflict')){if(e.why==='conflict'&&!known.has(String(e.orderId)))continue;const c=cents(e.usd);
        basis.set(e.pieceId,(basis.get(e.pieceId)??0)+c);if(e.why==='conflict')conflict.set(e.pieceId,(conflict.get(e.pieceId)??0)+c);move(s,c,-1);
        items.push({kind:e.why==='conflict'?'KIS record above the allocation':'pre-tracking fill opened',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:c/100});}
      else if(e.kind==='conflict-reduced'&&conflict.has(e.pieceId)){const c=Math.min(e.cents,conflict.get(e.pieceId));conflict.set(e.pieceId,conflict.get(e.pieceId)-c);basis.set(e.pieceId,Math.max(0,(basis.get(e.pieceId)??0)-c));move(s,c,1);
        items.push({kind:'KIS record lowered again',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:c/100});}
      else if(e.kind==='piece-closed'&&(e.why==='age'&&Number.isFinite(e.usd)||Number.isFinite(e.feeUSD))){const x=Math.max(0,Math.min(cents(e.why==='age'?e.usd:e.feeUSD),(basis.get(e.pieceId)??0)-(closed.get(e.pieceId)??0)));if(!x)continue;
        closed.set(e.pieceId,(closed.get(e.pieceId)??0)+x);move(s,x,1);items.push({kind:e.why==='age'?'settled by age':'fee difference',pieceId:e.pieceId,orderId:e.orderId,side:s,usd:x/100});}}
    return {day,at,snapshot:true,certain:{low:b.low/100,high:b.high/100},items};}
}
module.exports={SettlementBaseline};
