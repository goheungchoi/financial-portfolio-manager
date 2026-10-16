const {createHash}=require('node:crypto');
const {evaluate}=require('./outcome-evaluation.cjs');
const DAY=86400000;
class LearningMemory {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS lesson_evidence(id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lesson_lifecycle(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lesson_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,payload TEXT NOT NULL)');}
  lifecycle(id){const row=this.db.prepare('SELECT payload FROM lesson_lifecycle WHERE id=?').get(id);return row?JSON.parse(row.payload):null;}
  saveLifecycle(id,value){this.db.prepare('INSERT INTO lesson_lifecycle VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(value));}
  history(id,action,value){this.db.prepare('INSERT INTO lesson_history(id,payload) VALUES(?,?)').run(id,JSON.stringify({action,timestamp:Date.now(),...value}));}
  sync(){
    for(const row of this.db.prepare('SELECT payload FROM trade_outcomes').all()){
      const outcome=JSON.parse(row.payload);if(outcome.side!=='Sell')continue;
      const id='outcome:'+outcome.id;const assessment=outcome.assessment??evaluate(outcome);
      const evidence={outcomeId:outcome.id,outcomeVersion:outcome.version??1,reviewId:outcome.reviewId,source:outcome.source,environment:outcome.environment,accountKey:outcome.accountKey??null,market:outcome.market,currency:outcome.currency,symbol:outcome.symbol,quantity:outcome.quantity,status:outcome.status,gross:outcome.gross??null,fees:outcome.fees??null,netCash:outcome.netCash??null,gainAfterFees:outcome.gainAfterFees,gainAfterEstimatedTax:outcome.gainAfterEstimatedTax,costBasis:outcome.costBasis,averagePrice:outcome.averagePrice,taxStatus:outcome.taxStatus,method:'Local outcome evaluation; no causal AI diagnosis',confidence:assessment.confidence,evaluation:outcome.evaluation,assessment,decisionContext:outcome.reviewEvidence?{guidelines:outcome.reviewEvidence.guidelines,environment:outcome.reviewEvidence.environment,marketSession:outcome.reviewEvidence.marketSession,quote:outcome.reviewEvidence.quote,position:outcome.reviewEvidence.position,emergency:outcome.reviewEvidence.emergency}:null,thesis:outcome.decision?.explanation??null};
      const signature=createHash('sha256').update(JSON.stringify({evidence,outcomeSignature:outcome.signature??null})).digest('hex');
      const previous=this.db.prepare('SELECT signature FROM lesson_evidence WHERE id=?').get(id);const lifecycle=this.lifecycle(id);
      if(previous?.signature===signature){if(lifecycle?.status==='approved'&&lifecycle.expiresAt<=Date.now()){this.saveLifecycle(id,{...lifecycle,status:'expired'});this.db.prepare('UPDATE lessons SET approved=0 WHERE id=?').run(id);this.history(id,'expired',{signature});}continue;}
      const text=`${outcome.source==='paper'?'Simulation':'Broker '+outcome.environment} · ${outcome.symbol}: ${outcome.quantity} shares sold; after-fee result ${outcome.gainAfterFees??'unknown'} ${outcome.currency} (${outcome.costBasis} costs). ${assessment.recommendation} A gain or loss does not establish causation. This observation has not been replay-validated.`;
      const now=Date.now(),status=lifecycle?.status==='retired'?'retired':previous?'needs-review':'pending';
      this.db.exec('BEGIN IMMEDIATE');try{
        this.db.prepare('INSERT INTO lesson_evidence VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature,payload=excluded.payload').run(id,signature,JSON.stringify(evidence));
        this.db.prepare('INSERT INTO lessons(id,text,approved) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET text=excluded.text,approved=0').run(id,text);
        this.saveLifecycle(id,{...lifecycle,status,signature,createdAt:lifecycle?.createdAt??now,updatedAt:now,expiresAt:null,approvedAt:null,applicability:lifecycle?.applicability??`Only comparable ${outcome.symbol} decisions in this ${outcome.environment} account.`,note:lifecycle?.note??'',changeReason:previous?'Trade evidence changed; previous approval is invalid.':'New sale outcome',validation:'Not replay-validated'});
        this.history(id,previous?'evidence-changed':'created',{signature,outcomeVersion:outcome.version??1});
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
  }
  describe(id){const row=this.db.prepare('SELECT payload FROM lesson_evidence WHERE id=?').get(id);if(!row)return null;const {accountKey,...evidence}=JSON.parse(row.payload);return evidence;}
  review(id,value){
    if(typeof id!=='string'||!value||Object.keys(value).some(k=>!['expectedSignature','action','note','applicability','days'].includes(k))||!['approve','retire','reopen'].includes(value.action))throw new Error('INVALID_LESSON_REVIEW');
    const state=this.lifecycle(id),evidence=this.describe(id);if(!state||!evidence)throw new Error('LESSON_NOT_FOUND');
    if(state.signature!==value.expectedSignature)throw new Error('LESSON_CHANGED');
    const note=value.note??state.note,applicability=value.applicability??state.applicability,days=value.days??90;
    if(typeof note!=='string'||note.length>2000||typeof applicability!=='string'||!applicability.trim()||applicability.length>1000||!Number.isInteger(days)||days<1||days>365)throw new Error('INVALID_LESSON_REVIEW');
    if(value.action==='approve'&&!evidence.assessment.eligible)throw new Error('OUTCOME_NOT_FINAL');
    const now=Date.now(),status=value.action==='approve'?'approved':value.action==='retire'?'retired':'pending';
    this.db.exec('BEGIN IMMEDIATE');try{this.saveLifecycle(id,{...state,status,note,applicability,approvedAt:status==='approved'?now:null,expiresAt:status==='approved'?now+days*DAY:null,updatedAt:now,changeReason:status==='approved'?'Approved for context; not a validated strategy.':status==='retired'?'Retired by user':'Reopened for review'});this.db.prepare('UPDATE lessons SET approved=? WHERE id=?').run(status==='approved'?1:0,id);this.history(id,value.action,{signature:state.signature,note,applicability,days});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list(){return this.db.prepare('SELECT * FROM lessons ORDER BY rowid DESC LIMIT 100').all().map(row=>({...row,evidence:this.describe(row.id),lifecycle:this.lifecycle(row.id)}));}
  summary(){const records=this.db.prepare('SELECT payload FROM lesson_lifecycle').all().map(r=>JSON.parse(r.payload));return {total:records.length,pending:records.filter(r=>['pending','needs-review'].includes(r.status)).length,approved:records.filter(r=>r.status==='approved'&&r.expiresAt>Date.now()).length,retired:records.filter(r=>r.status==='retired').length,expired:records.filter(r=>r.status==='expired'||r.status==='approved'&&r.expiresAt<=Date.now()).length,method:'Local evidence evaluation · no API calls',validation:'Paper replay not implemented; AI reflection requires review'};}
  relevant(context,accounts=[]){return this.relevantLessons(context,accounts).map(row=>row.text);}
  relevantLessons(context,accounts=[]){
    const paper=context.environment==='local-paper';const symbols=context.universe.map(row=>row.symbol);
    return this.db.prepare('SELECT lessons.id,lessons.text,lesson_evidence.payload FROM lessons LEFT JOIN lesson_evidence ON lessons.id=lesson_evidence.id WHERE approved=1 ORDER BY lessons.rowid DESC').all().flatMap(row=>{
      if(!row.payload)return paper?[{id:row.id,text:row.text,score:0}]:[];
      const evidence=JSON.parse(row.payload),state=this.lifecycle(row.id);
      if(!state||state.status!=='approved'||!(state.expiresAt>Date.now()))return [];
      if(!(paper?evidence.source==='paper':evidence.source==='broker'&&accounts.includes(evidence.accountKey))||!symbols.includes(evidence.symbol))return [];
      const held=Boolean(context.positions?.[evidence.symbol]?.quantity);return [{id:row.id,text:`${row.text} Applicability: ${state.applicability}${state.note?' User-reviewed lesson: '+state.note:''} Review by ${new Date(state.expiresAt).toISOString().slice(0,10)}.`,score:(held?10:0)+(state.approvedAt??0)/1e15}];
    }).sort((a,b)=>b.score-a.score).slice(0,5).map(({id,text})=>({id,text}));
  }
}
module.exports={LearningMemory};
