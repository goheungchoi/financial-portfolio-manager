// Buy and Sell decisions made while their market was closed, kept as one pending reassessment per symbol and action.
// Nothing is executed from here: when the market opens, the review gate starts a review, which decides again on fresh
// prices, holdings, orders and risk checks through the usual proposal and approval path. A decision made while that
// market is open closes the pending one (carried out, or reassessed); an opposite decision revises it; passing on the
// symbol or the shares being gone cancels it.
// 2026-10-29: five Sell NASD:GOOGL decisions while the U.S. market was closed, none carried out.
const {randomUUID}=require('node:crypto');
const DAY=86400000;const marketOf=symbol=>/:/.test(symbol)?'US':'KR';
const trade=d=>(d?.action==='Buy'||d?.action==='Sell')&&Boolean(d.symbol);
class PendingDecisions {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS pending_decisions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,symbol TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');}
  save(p){this.db.prepare('INSERT INTO pending_decisions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(p.id,p.scope,p.symbol,p.status,JSON.stringify(p));return p;}
  // Pending ones of a scope; past their expiry they close as expired. Closed ones older than a week go.
  active(scope){const now=this.clock();const rows=this.db.prepare("SELECT payload FROM pending_decisions WHERE scope=? AND status='pending' ORDER BY rowid").all(scope).map(r=>JSON.parse(r.payload));
    this.db.prepare("DELETE FROM pending_decisions WHERE scope=? AND status!='pending' AND json_extract(payload,'$.closedAt')<?").run(scope,now-7*DAY);
    return rows.filter(p=>{if(p.expiresAt>now)return true;this.save({...p,status:'expired',closedAt:p.expiresAt});return false;});}
  // The pending decision a new one would repeat: same symbol and action, its market still closed.
  repeats(scope,decision,marketOpen){if(!trade(decision)||marketOpen(marketOf(decision.symbol)))return null;return this.active(scope).find(p=>p.symbol===decision.symbol&&p.action===decision.action)??null;}
  // After a successful decision. marketOpen(market): whether that market's session was open for it. orderId: the order
  // it placed, if any.
  record(scope,{decision,reviewId=null,proposalId=null,orderId=null,context={},marketOpen=()=>true}){const now=this.clock(),closed=[];
    const verdict=s=>(decision?.planVerdicts??[]).find(v=>v.symbol===s)?.verdict,held=s=>context.positions?.[s]?.quantity??0;
    for(const p of this.active(scope)){const close=(status,why)=>{closed.push(p.id);this.save({...p,status,closedAt:now,closedBy:why,closedReviewId:reviewId});};
      if(marketOpen(marketOf(p.symbol))){close(orderId&&decision.symbol===p.symbol&&decision.action===p.action?'carried-out':'reassessed','decided again with its market open');continue;}
      if(trade(decision)&&decision.symbol===p.symbol&&decision.action!==p.action){close('revised',`${decision.action} decided instead`);continue;}
      if(verdict(p.symbol)==='passed'){close('cancelled','passed on in a later review');continue;}
      if(p.action==='Sell'&&context.positions&&held(p.symbol)<1)close('cancelled','no shares held any more');}
    if(!trade(decision)||orderId||marketOpen(marketOf(decision.symbol)))return null;
    const prev=this.active(scope).find(p=>p.symbol===decision.symbol&&p.action===decision.action&&!closed.includes(p.id));
    const quote=(context.quotes??[]).find(q=>q.symbol===decision.symbol);
    return this.save({id:prev?.id??'PD-'+randomUUID().slice(0,8),scope,symbol:decision.symbol,status:'pending',action:decision.action,quantity:decision.quantity,
      rationale:String(decision.explanation??'').slice(0,400),invalidation:String(decision.plan?.invalidation??'').slice(0,240),
      evidence:{price:quote?.price??null,heldQuantity:held(decision.symbol)},proposalId:prev?.proposalId??proposalId,
      createdAt:prev?.createdAt??now,expiresAt:prev?.expiresAt??now+3*DAY,reviewId:prev?.reviewId??reviewId,lastReviewId:reviewId,reviews:(prev?.reviews??0)+1});}
  // What the trading review sees.
  context(scope){return this.active(scope).map(p=>({symbol:p.symbol,action:p.action,quantity:p.quantity,market:marketOf(p.symbol),since:new Date(p.createdAt).toISOString(),reviews:p.reviews,rationale:p.rationale,...(p.invalidation?{invalidation:p.invalidation}:{}),priceThen:p.evidence.price,...(p.proposalId?{proposalId:p.proposalId}:{})}));}
}
module.exports={PendingDecisions,marketOf};
