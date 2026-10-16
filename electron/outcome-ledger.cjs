const {createHash}=require('node:crypto');
const {evaluate}=require('./outcome-evaluation.cjs');
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
    const reviews=this.rows('reviews');
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
    for(const order of this.rows('live_intents')) {
      if(!(order.filled>0))continue;
      const costs=order.resultCosts;
      records.push({id:'broker:'+order.id,orderId:order.id,proposalId:order.id,accountKey:order.accountKey,source:'broker',environment:order.environment,market:order.market??'KR',currency:order.currency??'KRW',symbol:order.symbol,side:order.side,status:order.status,quantity:order.filled,requested:order.quantity,averagePrice:order.fillPrice??null,gross:costs?.gross??null,fees:costs?costs.commission+costs.transactionTax:null,netCash:costs?.netCash??null,gainAfterFees:costs?.gainAfterFees??null,gainAfterEstimatedTax:costs?.gainAfterEstimatedTax??null,costBasis:costs?'estimated':'unknown',taxStatus:order.market==='US'?(costs?.capitalGainsTaxKRW==null?'Unknown':'Estimated; annual tax'):'Estimated transaction tax',timestamp:order.reconciledAt??order.createdAt,evidence:{brokerOrderId:order.brokerOrderId,acquisitionCostPerShare:order.costPerShare??null,costSettings:order.costSettings??null,resultCosts:costs??null,observationTimeKnown:Boolean(order.reconciledAt)}});
    }
    const previous=new Map(this.rows('trade_outcomes').map(row=>[row.id,row]));
    for(const old of previous.values())if(!records.some(row=>row.id===old.id))records.push({...old,status:'Retracted',quantity:0,gross:null,fees:null,netCash:null,gainAfterFees:null,gainAfterEstimatedTax:null});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const record of records) {
        const review=reviews.find(r=>(r.orderId!=null&&r.orderId===record.orderId)||(r.proposalId!=null&&r.proposalId===record.proposalId));
        record.reviewId=review?.id??null;
        record.decision=review?.decision??null;
        record.reviewEvidence=review?.contextEvidence??null;
        record.evaluation=record.side==='Buy'?'Entry recorded; exit outcome pending':record.gainAfterFees==null?'Insufficient cost evidence':record.gainAfterFees<0?'Loss observed; cause unassessed':record.gainAfterFees>0?'Gain observed; cause unassessed':'Break-even after recorded costs';
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
