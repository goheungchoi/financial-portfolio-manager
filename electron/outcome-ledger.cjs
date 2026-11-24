const {createHash}=require('node:crypto');
const {evaluate}=require('./outcome-evaluation.cjs');
const clip=(t,n)=>{const s=String(t??'').trim().replace(/\s+/g,' ');return s.length>n?s.slice(0,n-1)+'…':s;};
const num=v=>Number.isFinite(Number(v))&&v!==null&&v!==''?Number(v):null;
const CHAIN_MAX=5;
// The conditional order that placed an outcome's order (matched by its order, else its proposal), or null. Only
// replaces links are followed (oldest last, at most CHAIN_MAX): nothing is inferred across an expired order or by
// symbol and time, so a plan stop that expired is not named.
function triggerOf(conditionals,record,reviews){
  const id=v=>v==null?null:String(v);
  const c=conditionals.find(o=>record.orderId!=null&&id(o.orderId)===id(record.orderId))??conditionals.find(o=>record.proposalId!=null&&id(o.proposalId)===id(record.proposalId));if(!c)return null;
  const byId=new Map(conditionals.map(o=>[o.id,o]));const chain=[];let at=c;
  while(at?.replaces&&chain.length<CHAIN_MAX){const prev=byId.get(at.replaces);if(!prev||chain.includes(prev.id)||prev.id===c.id)break;chain.push(prev.id);at=prev;}
  const oldest=chain.length?byId.get(chain.at(-1)):c;const t=c.trail??null;
  const level=num(t?.level)??num(c.conditions?.[0]?.value);
  const trigger={kind:'conditional',orderId:c.id,purpose:c.purpose??null,reason:clip(c.reason,300)||null,level,levelKind:t?'trailing':'fixed',
    ...(t?{trail:{kind:t.kind??null,...(t.kind==='atr'?{atrMultiple:num(t.atrMultiple),atr:num(t.atr),distance:num(t.distance)}:{pct:num(t.pct)}),high:num(t.high),highAt:num(t.highAt),floor:num(t.floor)}}:{}),
    armedAt:num(c.createdAt),armedByReviewId:c.reviewId??null,firedAt:num(c.closedAt),
    ...(chain.length?{replaces:chain,chainStartsAt:oldest.id,firstArmedByReviewId:oldest.reviewId??null}:{})};
  const arming=c.reviewId?reviews.find(r=>r.id===c.reviewId)?.decision??null:null;
  const armingDecision=arming?{explanation:clip(arming.explanation,500)||null,...(arming.plan?{plan:arming.plan}:{})}:null;
  return {trigger,armingDecision};}
// Derived, durable evidence. Cumulative broker reports replace a row; they are never summed.
class OutcomeLedger {
  constructor(db) {
    this.db=db;
    db.exec('CREATE TABLE IF NOT EXISTS trade_outcomes(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS outcome_versions(outcomeId TEXT NOT NULL,version INTEGER NOT NULL,signature TEXT NOT NULL,payload TEXT NOT NULL,recordedAt INTEGER NOT NULL,PRIMARY KEY(outcomeId,version))');
  }
  rows(table) {
    if(!this.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table))return [];
    return this.db.prepare(`SELECT payload FROM ${table}`).all().map(row=>JSON.parse(row.payload));
  }
  sync() {
    const reviews=this.rows('reviews');const conditionals=this.rows('conditional_orders');
    const paperOrders=this.rows('paper_orders');
    const fills=this.rows('paper_fills');
    const save=this.db.prepare('INSERT INTO trade_outcomes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE trade_outcomes.payload<>excluded.payload');
    const records=[];
    for(const order of paperOrders) {
      const executions=fills.filter(fill=>fill.orderId===order.id);
      if(!executions.length)continue;
      const quantity=executions.reduce((n,f)=>n+f.quantity,0);
      const gross=executions.reduce((n,f)=>n+f.quantity*f.price,0);
      const fees=executions.reduce((n,f)=>n+f.fee,0);
      records.push({id:'paper:'+order.id,orderId:order.id,proposalId:order.proposalId,source:'paper',environment:'simulation',market:'KR',currency:'KRW',symbol:order.symbol,side:order.side,status:order.status,quantity,requested:order.quantity,averagePrice:gross/quantity,gross,fees,netCash:order.side==='Sell'?gross-fees:-gross-fees,gainAfterFees:order.side==='Sell'?executions.reduce((n,f)=>n+f.realized,0):null,gainAfterEstimatedTax:null,costBasis:'simulated',taxStatus:'Not modeled',timestamp:Math.max(...executions.map(f=>f.timestamp)),evidence:{fillIds:executions.map(f=>f.id)}});
    }
    const intents=this.rows('live_intents');
    for(const order of intents) {
      if(!(order.filled>0))continue;
      const costs=order.resultCosts;
      // The credit identity and position effect travel with the outcome (audit 2026-11-04, Stage 3): a short sale opens a
      // position and a cover closes it; a repayment whose lot is not recorded has an unknown identity, never a guessed one.
      const credit=order.credit?{kind:order.credit.kind,type:order.credit.type??null,loanDate:order.credit.loanDate??null}:null;const effect=require('./outcome-evaluation.cjs').effectOf({side:order.side,credit});
      records.push({id:'broker:'+order.id,orderId:order.id,proposalId:order.id,accountKey:order.accountKey,source:'broker',environment:order.environment,market:order.market??'KR',currency:order.currency??'KRW',symbol:order.symbol,side:order.side,credit,effect,status:order.status,quantity:order.filled,requested:order.quantity,averagePrice:order.fillPrice??null,gross:costs?.gross??null,fees:costs?costs.commission+costs.transactionTax:null,netCash:costs?.netCash??null,gainAfterFees:costs?.gainAfterFees??null,gainAfterEstimatedTax:costs?.gainAfterEstimatedTax??null,costBasis:costs?(costs.basis==='broker'?'broker':'estimated'):'unknown',taxStatus:order.market==='US'?(costs?.capitalGainsTaxKRW==null?'Unknown':'Estimated; annual tax'):'Estimated transaction tax',timestamp:order.reconciledAt??order.createdAt,evidence:{brokerOrderId:order.brokerOrderId,acquisitionCostPerShare:order.costPerShare??null,costSettings:order.costSettings??null,resultCosts:costs??null,observationTimeKnown:Boolean(order.reconciledAt)}});
      // A short sale realizes nothing (its result comes at the cover); a cover realizes against its own lot (B3d-3 part 2,
      // short-result.cjs), with its costs kept apart. Only short and cover records change.
      const rec=records.at(-1);
      if(effect==='OPEN_SHORT'){rec.gainAfterFees=null;rec.gainAfterEstimatedTax=null;}
      if(effect==='CLOSE_SHORT'){const r=require('./short-result.cjs').shortResult(order,intents);rec.gainAfterFees=r?.realized??null;rec.shortGaps=r?.gaps??[];
        if(r?.shortProceeds!=null){const exempt=intents.filter(o=>r.shortOrderIds?.includes(o.id)).every(o=>o.resultCosts?.capitalGainsTaxKRW===0);
          Object.assign(rec,{shortProceeds:r.shortProceeds,shortEntryPrice:r.entryPrice,shortCosts:{saleCharges:r.saleCharges,coverCharges:r.coverCharges,interest:r.interest,beforeCharges:r.beforeCharges},gainAfterEstimatedTax:r.realized!=null&&exempt?r.realized:null,costBasis:r.realized==null?rec.costBasis:r.costBasis});}
        else rec.gainAfterEstimatedTax=null;}
    }
    const previous=new Map(this.rows('trade_outcomes').map(row=>[row.id,row]));
    for(const old of previous.values())if(!records.some(row=>row.id===old.id))records.push({...old,status:'Retracted',quantity:0,gross:null,fees:null,netCash:null,gainAfterFees:null,gainAfterEstimatedTax:null});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const record of records) {
        // M-6 part 3: a further order of a review is matched too, and its outcome gets that order's own decision (its fields
        // and plan), so position and learning memory see each fill's own rationale.
        const ROE=require('./review-orders.cjs');const match=ROE.reviewOfOrder(reviews,{orderId:record.orderId,proposalId:record.proposalId});
        const review=match?.review??null,further=match?.order?ROE.furtherEvidence(review,match.order):null;
        record.reviewId=review?.id??null;
        record.decision=further?further.decision:review?.decision??null;
        record.reviewEvidence=further?further.evidence:review?.contextEvidence??null;
        // A sale or purchase no review placed may have been made by a conditional order (stop, take profit; 2026-11-18,
        // artifacts/reviews/2026-11-18-stop-exit-record): its record names that order, and armingDecision is the decision
        // of the review that armed it, kept apart from decision (nothing decided this order at the time it was made).
        // Added only on a match, so an outcome with none is unchanged (same signature, no new version).
        if(!review){const t=triggerOf(conditionals,record,reviews);if(t){record.trigger=t.trigger;if(t.armingDecision)record.armingDecision=t.armingDecision;}}
        record.evaluation=record.effect==='OPEN_SHORT'||record.side==='Buy'&&record.effect!=='CLOSE_SHORT'?'Entry recorded; exit outcome pending':record.gainAfterFees==null?'Insufficient cost evidence':record.gainAfterFees<0?'Loss observed; cause unassessed':record.gainAfterFees>0?'Gain observed; cause unassessed':'Break-even after recorded costs';
        record.assessment=evaluate(record);
        const economic={...record};for(const key of ['timestamp','version','signature','firstObservedAt','updatedAt'])delete economic[key];
        const signature=createHash('sha256').update(JSON.stringify(economic)).digest('hex');const old=previous.get(record.id);
        // Older builds can rebuild the current row without its version while history survives.
        // Allocate from durable history, never from the replaceable current-row counter alone.
        const latest=this.db.prepare('SELECT version,signature,payload FROM outcome_versions WHERE outcomeId=? ORDER BY version DESC LIMIT 1').get(record.id);
        const unchanged=latest?.signature===signature;
        const priorVersion=Number.isSafeInteger(old?.version)&&old.version>0?old.version:0;
        record.signature=signature;record.version=unchanged?latest.version:Math.max(latest?.version??0,priorVersion)+1;
        const historical=unchanged?JSON.parse(latest.payload):null;
        record.firstObservedAt=old?.firstObservedAt??historical?.firstObservedAt??Date.now();record.updatedAt=unchanged?historical.updatedAt:Date.now();
        if(unchanged)record.timestamp=historical.timestamp;
        if(!unchanged)this.db.prepare('INSERT INTO outcome_versions(outcomeId,version,signature,payload,recordedAt) VALUES(?,?,?,?,?)').run(record.id,record.version,signature,JSON.stringify(record),Date.now());
        save.run(record.id,JSON.stringify(record));
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  history(id){if(typeof id!=='string'||id.length>200)throw new Error('INVALID_REQUEST');return this.db.prepare('SELECT payload FROM outcome_versions WHERE outcomeId=? ORDER BY version DESC LIMIT 20').all(id).map(row=>{const {accountKey,evidence,reviewEvidence,...summary}=JSON.parse(row.payload);return summary;});}
  list() {
    // Account identity and cost settings remain local evidence, outside renderer/model summaries.
    return this.db.prepare('SELECT payload FROM trade_outcomes ORDER BY json_extract(payload,\'$.timestamp\') DESC LIMIT 100').all().map(row=>{
      const {accountKey,evidence,reviewEvidence,...summary}=JSON.parse(row.payload);
      return summary;
    });
  }
}
module.exports={OutcomeLedger};
