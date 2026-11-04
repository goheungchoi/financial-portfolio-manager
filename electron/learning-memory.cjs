const {createHash}=require('node:crypto');
const {evaluate,effectOf}=require('./outcome-evaluation.cjs');
const DAY=86400000;
// Evidence version 2 (audit 2026-11-04, Stage 4): a sale's evidence carries its position episode, the filled entries
// since the position was last flat (each with its review's rationale, thesis, invalidation, stop, fill and the quote it
// saw) and the exit itself, so a reflection never has to say the entry thesis is missing when the app has it.
const EVIDENCE_VERSION=2;
// A change of evidence is material when it can change what the sale teaches: another order, review, quantity, price,
// cost basis, tax status or eligibility, other entries, or a result whose sign changes, that moves by more than 0.5% of
// the sale (at least ₩1,000 or $1) or by more than a fifth of itself. Anything less (a small fee correction) updates the record but keeps its
// signature: an approval stands and no new paid reflection is queued. Before this, a fee correction requeued Kia's.
const FLOOR={KRW:1000,USD:1};
function materialChange(a,b){if(!a)return true;
  const facts=e=>JSON.stringify([e.outcomeId,e.reviewId,e.symbol,e.quantity,e.status,e.averagePrice,e.costBasis,e.taxStatus,e.assessment?.eligible??null]);if(facts(a)!==facts(b))return true;
  const entries=e=>JSON.stringify((e.episode?.entries??[]).map(x=>[x.orderId,x.filled,x.fillPrice]));if(a.episode&&entries(a)!==entries(b))return true;
  const tol=Math.max(Math.abs(b.gross??a.gross??0)*0.005,FLOOR[b.currency]??1);
  return ['gainAfterFees','gainAfterEstimatedTax'].some(k=>{const x=a[k],y=b[k];if((x==null)!==(y==null))return true;if(x==null)return false;return Math.sign(x)!==Math.sign(y)||Math.abs(x-y)>tol||Math.abs(x-y)>Math.abs(x)*0.2;});}
// The procedural lesson proposed from the Kia sale and re-entry (audit 2026-11-04, Stage 4): one draft per database,
// created once at start (proposeProcedural) and never again, not even after it is retired; it applies to thesis exits
// and re-entries in this account.
// It reaches reviews only once the user approves it; the first review period is 30 days.
const PROCEDURAL={id:'procedural:reversal-check',
  text:'Before exiting or re-entering a position, compare current evidence with the recorded entry thesis, invalidation conditions and most recent exit rationale. Explain what changed in fundamentals, price, size or horizon; a higher repurchase price requires an explicit after-cost case. Assess execution quality only with contemporaneous quotes and order/fill records. A single loss does not validate or invalidate a strategy. This reminder never delays a protective exit or a mandatory risk action.',
  applicability:'Thesis exits and re-entries in this account: a sale because the thesis changed, or a purchase after a recent exit of the same holding. Not stop-loss exits, risk-limit actions or other protective reductions.',
  support:'Low-confidence empirical support: one Kia sale and re-entry (November 2026). A procedural reminder, not a validated trading rule.'};
// The filled entries since the position was last flat before a sale, and the sale. outcomes: trade_outcomes rows.
function episode(outcomes,sale,reviewAt){const {view}=require('./position-memory.cjs');const eff=o=>o.effect??effectOf(o);
  const mine=outcomes.filter(o=>o.source===sale.source&&(o.accountKey??null)===(sale.accountKey??null)&&o.symbol===sale.symbol&&o.quantity>0&&o.status!=='Retracted'&&['OPEN_LONG','CLOSE_LONG'].includes(eff(o))).map(o=>({...o,effect:eff(o)})).sort((a,b)=>a.timestamp-b.timestamp||String(a.id).localeCompare(String(b.id)));
  const at=mine.findIndex(o=>o.id===sale.id);let held=0,since=0;for(let i=0;i<at;i++){held+=mine[i].effect==='OPEN_LONG'?mine[i].quantity:-mine[i].quantity;if(held<=0){held=0;since=i+1;}}
  const entries=(at<0?[]:mine.slice(since,at)).filter(o=>o.effect==='OPEN_LONG').slice(-3).map(o=>view(o,reviewAt));
  return {entries,exit:view({...sale,effect:'CLOSE_LONG'},reviewAt),...(entries.length?{}:{entriesUnavailable:'No filled entry is recorded for this sale (it may predate the app).'})};}
class LearningMemory {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS lesson_evidence(id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lesson_lifecycle(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lesson_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,payload TEXT NOT NULL)');}
  lifecycle(id){const row=this.db.prepare('SELECT payload FROM lesson_lifecycle WHERE id=?').get(id);return row?JSON.parse(row.payload):null;}
  saveLifecycle(id,value){this.db.prepare('INSERT INTO lesson_lifecycle VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(value));}
  history(id,action,value){this.db.prepare('INSERT INTO lesson_history(id,payload) VALUES(?,?)').run(id,JSON.stringify({action,timestamp:Date.now(),...value}));}
  // The procedural draft, once (PROCEDURAL).
  proposeProcedural(){const p=PROCEDURAL;if(this.lifecycle(p.id))return;const now=Date.now(),signature=createHash('sha256').update(p.text).digest('hex');
    const evidence={kind:'procedural',source:'procedural',symbol:null,method:'Procedural reminder proposed by the 2026-11-04 audit; not derived from one outcome alone',support:p.support,confidence:'low',
      assessment:{eligible:true,confidence:'low',category:'Procedural',recommendation:'',gaps:['Supported by one outcome only','Not replay-validated']}};
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO lesson_evidence VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(p.id,signature,JSON.stringify(evidence));
      this.db.prepare('INSERT INTO lessons(id,text,approved) VALUES(?,?,0) ON CONFLICT(id) DO NOTHING').run(p.id,p.text);
      this.saveLifecycle(p.id,{kind:'procedural',status:'pending',signature,createdAt:now,updatedAt:now,expiresAt:null,approvedAt:null,applicability:p.applicability,note:p.text,reviewDays:30,changeReason:'Proposed procedural lesson (audit 2026-11-04). It reaches reviews only after you approve it.',validation:'Not replay-validated'});
      this.history(p.id,'created',{signature});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  sync(){
    const outcomes=this.db.prepare('SELECT payload FROM trade_outcomes').all().map(row=>JSON.parse(row.payload));
    const ids=[...new Set(outcomes.map(o=>o.reviewId).filter(Boolean))];const reviewAt=new Map(ids.length&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reviews'").get()?this.db.prepare(`SELECT id,json_extract(payload,'$.timestamp') AS t FROM reviews WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(r=>[r.id,r.t]):[]);
    for(const outcome of outcomes){
      // Lessons come from exits only: a short sale opens a position (audit 2026-11-04, Stage 3); an unknown credit identity is no evidence.
      if(outcome.side!=='Sell'||evaluate(outcome).effect!=='CLOSE_LONG')continue;
      const id='outcome:'+outcome.id;const assessment=outcome.assessment??evaluate(outcome);
      const evidence={evidenceVersion:EVIDENCE_VERSION,outcomeId:outcome.id,outcomeVersion:outcome.version??1,reviewId:outcome.reviewId,source:outcome.source,environment:outcome.environment,accountKey:outcome.accountKey??null,market:outcome.market,currency:outcome.currency,symbol:outcome.symbol,quantity:outcome.quantity,status:outcome.status,gross:outcome.gross??null,fees:outcome.fees??null,netCash:outcome.netCash??null,gainAfterFees:outcome.gainAfterFees,gainAfterEstimatedTax:outcome.gainAfterEstimatedTax,costBasis:outcome.costBasis,averagePrice:outcome.averagePrice,taxStatus:outcome.taxStatus,method:'Local outcome evaluation; no causal AI diagnosis',confidence:assessment.confidence,evaluation:outcome.evaluation,assessment,decisionContext:outcome.reviewEvidence?{guidelines:outcome.reviewEvidence.guidelines,environment:outcome.reviewEvidence.environment,marketSession:outcome.reviewEvidence.marketSession,quote:outcome.reviewEvidence.quote,position:outcome.reviewEvidence.position,emergency:outcome.reviewEvidence.emergency}:null,thesis:outcome.decision?.explanation??null,episode:episode(outcomes,outcome,reviewAt)};
      const previous=this.db.prepare('SELECT signature,payload FROM lesson_evidence WHERE id=?').get(id);const lifecycle=this.lifecycle(id);const before=previous?JSON.parse(previous.payload):null;
      if(before&&JSON.stringify(before)===JSON.stringify(evidence)){if(lifecycle?.status==='approved'&&lifecycle.expiresAt<=Date.now()){this.saveLifecycle(id,{...lifecycle,status:'expired'});this.db.prepare('UPDATE lessons SET approved=0 WHERE id=?').run(id);this.history(id,'expired',{signature:previous.signature});}continue;}
      const text=`${outcome.source==='paper'?'Simulation':'Broker '+outcome.environment} · ${outcome.symbol}: ${outcome.quantity} shares sold; after-fee result ${outcome.gainAfterFees??'unknown'} ${outcome.currency} (${outcome.costBasis} costs). ${assessment.recommendation} A gain or loss does not establish causation. This observation has not been replay-validated.`;
      const material=materialChange(before,evidence);
      // Not material: the record is updated (its earlier version kept in the history), the signature, status and approval stay.
      if(previous&&!material){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE lesson_evidence SET payload=? WHERE id=?').run(JSON.stringify(evidence),id);this.db.prepare('UPDATE lessons SET text=? WHERE id=?').run(text,id);
          this.history(id,'evidence-updated',{signature:previous.signature,material:false,outcomeVersion:outcome.version??1,previousEvidence:before});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}continue;}
      const signature=createHash('sha256').update(JSON.stringify({evidence,outcomeSignature:outcome.signature??null})).digest('hex');
      const now=Date.now(),status=lifecycle?.status==='retired'?'retired':previous?'needs-review':'pending';
      this.db.exec('BEGIN IMMEDIATE');try{
        this.db.prepare('INSERT INTO lesson_evidence VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature,payload=excluded.payload').run(id,signature,JSON.stringify(evidence));
        this.db.prepare('INSERT INTO lessons(id,text,approved) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET text=excluded.text,approved=0').run(id,text);
        this.saveLifecycle(id,{...lifecycle,status,signature,createdAt:lifecycle?.createdAt??now,updatedAt:now,expiresAt:null,approvedAt:null,applicability:lifecycle?.applicability??`Only comparable ${outcome.symbol} decisions in this ${outcome.environment} account.`,note:lifecycle?.note??'',changeReason:previous?'Trade evidence changed; previous approval is invalid.':'New sale outcome',validation:'Not replay-validated'});
        this.history(id,previous?'evidence-changed':'created',{signature,outcomeVersion:outcome.version??1,...(before?{previousEvidence:before}:{})});
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
  }
  describe(id){const row=this.db.prepare('SELECT payload FROM lesson_evidence WHERE id=?').get(id);if(!row)return null;const {accountKey,...evidence}=JSON.parse(row.payload);return evidence;}
  review(id,value){
    if(typeof id!=='string'||!value||Object.keys(value).some(k=>!['expectedSignature','action','note','applicability','days'].includes(k))||!['approve','retire','reopen'].includes(value.action))throw new Error('INVALID_LESSON_REVIEW');
    const state=this.lifecycle(id),evidence=this.describe(id);if(!state||!evidence)throw new Error('LESSON_NOT_FOUND');
    if(state.signature!==value.expectedSignature)throw new Error('LESSON_CHANGED');
    const note=value.note??state.note,applicability=value.applicability??state.applicability,days=value.days??state.reviewDays??90;
    if(typeof note!=='string'||note.length>2000||typeof applicability!=='string'||!applicability.trim()||applicability.length>1000||!Number.isInteger(days)||days<1||days>365)throw new Error('INVALID_LESSON_REVIEW');
    if(value.action==='approve'&&!evidence.assessment.eligible)throw new Error('OUTCOME_NOT_FINAL');
    if(value.action==='approve'&&evidence.kind==='procedural'&&!note.trim())throw new Error('INVALID_LESSON_REVIEW');
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
      // An approved procedural lesson applies to this account's live reviews, in the user's reviewed wording.
      if(evidence.kind==='procedural')return paper?[]:[{id:row.id,text:`Procedural reminder (${evidence.confidence} empirical support): ${state.note||row.text} Applicability: ${state.applicability} Review by ${new Date(state.expiresAt).toISOString().slice(0,10)}.`,score:20}];
      if(!(paper?evidence.source==='paper':evidence.source==='broker'&&accounts.includes(evidence.accountKey))||!symbols.includes(evidence.symbol))return [];
      const held=Boolean(context.positions?.[evidence.symbol]?.quantity);return [{id:row.id,text:`${row.text} Applicability: ${state.applicability}${state.note?' User-reviewed lesson: '+state.note:''} Review by ${new Date(state.expiresAt).toISOString().slice(0,10)}.`,score:(held?10:0)+(state.approvedAt??0)/1e15}];
    }).sort((a,b)=>b.score-a.score).slice(0,5).map(({id,text})=>({id,text}));
  }
}
module.exports={LearningMemory,materialChange,episode,EVIDENCE_VERSION,PROCEDURAL};
