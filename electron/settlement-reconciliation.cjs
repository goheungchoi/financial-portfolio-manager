'use strict';
// Audited manual reconciliation of U.S. settlement pieces (stage 2b.3; design v2 §9, v3 §4.3 and §6, v3.1 §6-7,
// v3.2 §2, v3.3; executable rules R1-R10 in artifacts/reviews/2026-11-05-accounting/stage2b-spec.md). Backend only: the
// panel and Home summary are step 2b.5, the loss-baseline adjustments step 2b.4, the performance treatment stage 3.
// - R1 Required: a request id, the piece, the amount (partial allowed), the explanation (settled, or rounding for a
//   remainder under $1 that it closes), the KIS reference and a note; for a buy settled, the funding route (USD, KRW
//   or unknown). Optional: the settlement date, a detected U.S. flow to reclassify (with its split), a K row to cite.
// - R2 An amount above what is left of the piece is refused before any preview (AMOUNT_EXCEEDS_REMAINING).
// - R3 A preview is the reconciliation applied in a transaction that is then rolled back, so its before and after are
//   computed by the same code every consumer uses and equal the effect a confirmation applies. It carries the state
//   version (the ledger's last event, the tracker state, funding, flows, the flow detector's last reading and the
//   records) and a binding: a hash of the normalized request, that state version, the inputs it was computed with
//   (balances, FX, capacity inputs) and the values and effects it shows. Confirming re-reads the state (STATE_CHANGED,
//   with the refreshed preview attached) and recomputes the binding in the transaction; any difference in the request,
//   the inputs or the result applies nothing (PREVIEW_MISMATCH). Reversals are bound the same way.
// - R4 Applying is one transaction: the record, its evidence (one manual version for the amount), the allocation to
//   the piece (checked against what is left of both), the piece change, the citation, the funding release, any flow
//   reclassification and the events. Records are append-only (triggers refuse updates and deletes).
// - R5 Repeats: the same request id, or the same binding with the same request, returns the existing record and
//   changes nothing. A request id reused for other content is refused.
// - R6 Partial: each record allocates its own amount; the piece closes when nothing is left.
// - R7 Reversal is a new record that undoes that record's effect only: its allocations are reversed and its evidence
//   voided; standby coverage of the piece is promoted first (re-checked as existing, unconsumed and, for a K row,
//   independent, current and usable: U6, A1); the piece reopens only for what no promoted evidence covers; its funding
//   release is reinstated, its citation withdrawn, and its flow reclassification undone for what is still its own: the
//   reversed settlement entry and the entries it added that are still flows; an added entry a later record reconciled
//   (or that was removed since) keeps that later transformation. Later records and evidence keep their effect. A
//   reversal of a reversal, or a second reversal, is refused.
// - R8 Flow reclassification: a detected U.S. flow selected as the payment is removed from flows in the same
//   transaction. Its split must sum to the flow exactly, to the cent, with exactly one settlement entry equal to the
//   reconciled amount (signed: a buy's payment negative, a sale's proceeds positive); other entries become a deposit or
//   withdrawal (recorded with the KIS reference) or an explicit unexplained entry (a detected flow again: shown, held,
//   still a loss scenario). Without a split the flow must equal the settlement exactly.
// - R9 Funding: only a buy settled with a named route (USD or KRW) releases its funding commitment's filled part, up to
//   the amount (FundingLedger.releaseFor); "route unknown" releases nothing and the commitment stays for capacity.
//   When every part of the order is reconciled with named routes (or a closing rounding record), a rounding difference
//   of the funding estimate (at most 1 cent) is released with it as an alignment, shown in the preview; a larger excess
//   stays committed and is reported. A release relying on a cited KIS row is suspended for the citation's shortfall
//   while that row is under review (FundingLedger.suspendedCents), so the uncertain amount is not spendable.
// - R10 The accounting effect E is recorded (obligation change less the settlement cash reclassified from a tracked
//   flow) for step 2b.4 and stage 3; nothing here changes the loss baseline or returns.
// K rows stay supporting evidence (A1 off): corroborate() records standby coverage from them only when U6 is verified
// (u6Verified, a test switch until then).
const crypto=require('node:crypto'),os=require('node:os');
const {FundingLedger}=require('./funding-ledger.cjs');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,24);
const cents=v=>Math.round(Number(v)*100);
const fail=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
const SESSION=crypto.randomUUID();
const ROUTES=['USD','KRW','unknown'],EXPLANATIONS=['settled','rounding'],ENTRIES=['settlement','deposit','withdrawal','unexplained'];
const ROUNDING_MAX_CENTS=100,MAX_SPLIT=8;
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.trim().length<=max?v.trim():null;
const osUser=()=>{try{return os.userInfo().username;}catch{return null;}};
const round2=v=>Number.isFinite(v)?Math.round(v*100)/100:null;
class Reconciliation{
  // inFlight: the U.S. settlement tracker (electron/valuation.cjs InFlight); funding: the funding ledger; performance:
  // PerformanceHistory (flows); who: {user, session} recorded as confirmedBy.
  constructor(db,{inFlight,funding=null,performance=null,clock=Date.now,who=null,u6Verified=false}={}){
    if(!inFlight)throw new Error('RECONCILIATION_NEEDS_TRACKER');
    this.db=db;this.inFlight=inFlight;this.ledger=inFlight.evidence;this.funding=funding??new FundingLedger(db,{clock});this.performance=performance;this.clock=clock;this.u6=Boolean(u6Verified);this.who=who??{user:osUser(),session:SESSION};
    db.exec(`CREATE TABLE IF NOT EXISTS settlement_reconciliations(id TEXT PRIMARY KEY,account TEXT NOT NULL,requestId TEXT NOT NULL UNIQUE,contentHash TEXT NOT NULL,kind TEXT NOT NULL,target TEXT,at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS settlement_reconciliations_content ON settlement_reconciliations(account,contentHash);
      CREATE TRIGGER IF NOT EXISTS settlement_reconciliations_no_update BEFORE UPDATE ON settlement_reconciliations BEGIN SELECT RAISE(ABORT,'settlement_reconciliations is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS settlement_reconciliations_no_delete BEFORE DELETE ON settlement_reconciliations BEGIN SELECT RAISE(ABORT,'settlement_reconciliations is append-only'); END;`);
  }
  records(account){return this.db.prepare('SELECT payload FROM settlement_reconciliations WHERE account=? ORDER BY at,rowid').all(account).map(r=>JSON.parse(r.payload));}
  record(id){const r=this.db.prepare('SELECT payload FROM settlement_reconciliations WHERE id=?').get(id);return r?JSON.parse(r.payload):null;}
  reversalOf(id){const r=this.db.prepare("SELECT payload FROM settlement_reconciliations WHERE target=? AND kind='reversal'").get(id);return r?JSON.parse(r.payload):null;}
  // Reconciliations in effect (not reversed).
  active(account){const reversed=new Set(this.records(account).filter(x=>x.kind==='reversal').map(x=>x.target));return this.records(account).filter(x=>x.kind==='reconciliation'&&!reversed.has(x.id));}
  // What a preview is bound to (R3).
  stateVersion(account){const one=(sql,...a)=>{try{return this.db.prepare(sql).get(...a)??null;}catch{return null;}},all=(sql,...a)=>{try{return this.db.prepare(sql).all(...a);}catch{return null;}};
    const st=this.inFlight.state(account);
    const parts={events:one('SELECT COALESCE(MAX(id),0) n FROM settlement_events WHERE account=?',account)?.n??0,tracker:hash(one('SELECT payload FROM inflight_settlement WHERE account=?',account)?.payload??null),
      funding:one('SELECT COALESCE(MAX(id),0) n FROM funding_events')?.n??0,releases:one('SELECT count(*) n FROM funding_releases')?.n??0,records:one('SELECT count(*) n FROM settlement_reconciliations WHERE account=?',account)?.n??0,
      flows:hash(all('SELECT id,payload FROM cash_flows WHERE account=? ORDER BY id',account)),watch:hash(one('SELECT payload FROM flow_watch WHERE account=?',account)?.payload??null),usReading:st.readAt!=null?`${st.readAt}@${st.lastAt}`:null};
    return {id:hash(parts),...parts};}
  // The values a preview shows before and after, from the consumers' own functions: the tracker's totals (what
  // valuation reads), funding commitments and, given fresh inputs, capacity; U.S. flows; and, given balances, the U.S.
  // and combined equity bounds (electron/valuation.cjs value).
  values(account,{balances=null,inputs=null}={}){const t=this.inFlight.current(account);
    const tracker={buysUSD:t.buysUSD,sellsUSD:t.sellsUSD,unresolved:t.unresolved,overdue:t.overdue,pretracking:t.pretracking,open:t.open.map(f=>({pieceId:f.pid??null,orderId:f.id,side:f.side,usd:f.usd,why:f.unresolved?.why??null}))};
    const c=this.funding.commitments(account);let capacity;
    if(inputs){try{capacity={KR:round2(this.funding.capacity({account,market:'KR',inputs})),US:round2(this.funding.capacity({account,market:'US',inputs}))};}catch(e){capacity={error:e.message};}}
    const flows=this.performance?this.performance.flows(account).filter(x=>x.market==='US').map(x=>({day:x.day,amount:x.amount,detected:Boolean(x.detected)})):null;
    let valuation;if(balances){const v=require('./valuation.cjs').value({korea:balances.korea??null,us:balances.us??null,fx:balances.fx??null,inFlight:t,now:balances.now??this.clock()});valuation={US:v.markets.US.equity??null,combined:{low:v.combined.low,high:v.combined.high,exact:v.combined.exact}};}
    return {tracker,funding:{USD:c.usd,KRW:c.krw,...(capacity?{capacity}:{})},flows,...(valuation?{valuation}:{})};}
  // R1: the request's own fields, normalized; no state is read.
  fields(req){if(!req||typeof req!=='object')throw fail('REQUEST_INVALID');
    const requestId=text(req.requestId,100);if(!requestId)throw fail('REQUEST_ID_REQUIRED');const account=text(req.account,200);if(!account)throw fail('ACCOUNT_REQUIRED');
    const pieceId=text(req.pieceId,200);if(!pieceId)throw fail('PIECE_REQUIRED');
    const c=Number.isInteger(req.cents)?req.cents:Number.isFinite(req.usd)?cents(req.usd):null;if(!(c>0))throw fail('AMOUNT_REQUIRED');
    const explanation=EXPLANATIONS.includes(req.explanation)?req.explanation:null;if(!explanation)throw fail('EXPLANATION_REQUIRED');
    const kisReference=text(req.kisReference,120);if(!kisReference)throw fail('KIS_REFERENCE_REQUIRED');const note=text(req.note,500);if(!note)throw fail('NOTE_REQUIRED');
    if(req.route!=null&&!ROUTES.includes(req.route))throw fail('ROUTE_INVALID');
    let settledOn=null;if(req.settledOn!=null){if(typeof req.settledOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(req.settledOn)||Number.isNaN(Date.parse(req.settledOn+'T00:00:00Z')))throw fail('SETTLED_ON_INVALID');settledOn=req.settledOn;}
    const flowId=req.flowId==null?null:text(req.flowId,100);if(req.flowId!=null&&!flowId)throw fail('FLOW_UNKNOWN');if(req.split!=null&&!flowId)throw fail('FLOW_REQUIRED');if(flowId&&explanation!=='settled')throw fail('FLOW_NEEDS_SETTLEMENT');
    let split=null;if(req.split!=null){if(!Array.isArray(req.split)||!req.split.length||req.split.length>MAX_SPLIT)throw fail('FLOW_SPLIT_INVALID');
      split=req.split.map(e=>{const kind=ENTRIES.includes(e?.kind)?e.kind:null,v=Number.isInteger(e?.cents)?e.cents:Number.isFinite(e?.usd)?cents(e.usd):null;if(!kind||!v)throw fail('FLOW_SPLIT_INVALID');
        if(kind==='deposit'&&v<0||kind==='withdrawal'&&v>0)throw fail('FLOW_SPLIT_SIGN',{kind});const n=text(e.note,200),ref=text(e.kisReference,120);return {kind,cents:v,...(n?{note:n}:{}),...(ref?{kisReference:ref}:{})};});}
    let citation=null;if(req.citation!=null){const g=text(req.citation?.groupId,100),v=Number.isInteger(req.citation?.version)?req.citation.version:null;if(!g||!(v>0))throw fail('CITATION_INVALID');citation={groupId:g,version:v};}
    return {requestId,account,pieceId,cents:c,explanation,route:req.route??null,kisReference,note,settledOn,flowId,split,citation};}
  // R1, R2, R8: the request against the current state. Returns the piece and the flow it names.
  against(r){const st=this.inFlight.state(r.account),piece=(st.open??[]).find(f=>f.pid===r.pieceId);
    if(!piece)throw fail(r.pieceId.startsWith('review:')?'PIECE_UNDER_REVIEW':'PIECE_NOT_OPEN');
    const remaining=cents(piece.usd);if(r.cents>remaining)throw fail('AMOUNT_EXCEEDS_REMAINING',{remainingCents:remaining});
    if(r.explanation==='settled'&&piece.side==='Buy'&&!r.route)throw fail('ROUTE_REQUIRED');
    if(r.explanation==='rounding'&&(r.cents!==remaining||r.cents>=ROUNDING_MAX_CENTS))throw fail('ROUNDING_NOT_REMAINDER',{remainingCents:remaining});
    if(r.citation&&!this.ledger.version(r.citation.groupId,r.citation.version))throw fail('CITATION_TARGET_UNKNOWN');
    let flow=null,split=null;
    if(r.flowId){if(!this.performance)throw fail('FLOWS_UNAVAILABLE');
      flow=this.performance.flows(r.account).find(x=>x.id===r.flowId);if(!flow)throw fail('FLOW_UNKNOWN');if(flow.market!=='US'||!flow.detected)throw fail('FLOW_NOT_DETECTED');
      const signed=piece.side==='Buy'?-r.cents:r.cents,total=cents(flow.amount);
      if(!r.split){if(total!==signed)throw fail('FLOW_SPLIT_REQUIRED',{flowCents:total,settlementCents:signed});split=[{kind:'settlement',cents:signed}];}
      else{const s=r.split.filter(e=>e.kind==='settlement');if(s.length!==1||s[0].cents!==signed)throw fail('FLOW_SETTLEMENT_MISMATCH',{settlementCents:signed});
        const sum=r.split.reduce((n,e)=>n+e.cents,0);if(sum!==total)throw fail('FLOW_SPLIT_MISMATCH',{flowCents:total,splitCents:sum,differenceCents:total-sum});split=r.split;}}
    return {st,piece,flow,split};}
  // A preview (R3): the reconciliation applied and rolled back. Its binding is a hash of the normalized request, the
  // state version, the inputs it was computed with (balances, FX, capacity inputs) and the values and effects it shows,
  // the funding alignment included. A confirmation carries it back; the confirming transaction computes it again and
  // applies only if it is the same (review of 8b929ea, P1: a $40 preview confirmed $100, and changed capacity inputs
  // were accepted).
  preview(req,ctx={}){const r=this.fields(req);const sv=this.stateVersion(r.account);const rec=this.dry(()=>this.apply(r,sv,ctx));return Reconciliation.shown(r,sv,rec);}
  static shown(r,sv,rec){const f=rec.effects.funding;return {kind:'preview',request:Reconciliation.content(r),stateVersion:sv.id,binding:rec.contentHash,before:rec.preview.before,after:rec.preview.after,effects:rec.effects,
    ...(f?{funding:{releasedCents:f.cents,alignmentCents:f.alignmentCents??0,unreleasedEstimateCents:f.unreleasedCents??0,reason:f.reason??null}}:{})};}
  // Confirms a previewed request (R3-R5): req.stateVersion and req.binding are the preview's; ctx must be the inputs the
  // preview was computed with.
  confirm(req,ctx={}){const r=this.fields(req);const b=Reconciliation.bound(req);
    try{return this.ledger.tx(()=>{const prior=this.repeat(r,b.binding);if(prior)return prior;const sv=this.stateVersion(r.account);if(sv.id!==b.stateVersion)throw fail('STATE_CHANGED');return this.apply(r,sv,ctx,b.binding);});}
    catch(e){if(e.code==='STATE_CHANGED')try{e.preview=this.preview(req,ctx);}catch(p){e.previewError=p.code??p.message;}throw e;}}
  static bound(req){if(typeof req.stateVersion!=='string')throw fail('STATE_VERSION_REQUIRED');if(typeof req.binding!=='string')throw fail('PREVIEW_REQUIRED');return {stateVersion:req.stateVersion,binding:req.binding};}
  static content(r){const {requestId,...rest}=r;return rest;}
  // The binding (R3): everything the preview showed and was computed from; generated ids and times are left out.
  static binding(r,sv,ctx,{before,after,effects}){return hash({request:Reconciliation.content(r),stateVersion:sv.id,context:{balances:ctx.balances??null,inputs:ctx.inputs??null},before,after,effects:Reconciliation.boundEffects(effects)});}
  static boundEffects(e){const fl=e.flows;return e.reversedCents!=null?{reversedCents:e.reversedCents,promoted:e.promoted.map(p=>[p.evidenceId,p.cents]),reopenedCents:e.reopenedCents,fundingReinstatedCents:e.fundingReinstatedCents,flows:fl?{restoredCents:fl.restoredCents,removed:fl.removed.length,kept:fl.kept.map(k=>[k.cents,k.by])}:null,citation:Boolean(e.citationWithdrawn),effect:e.effect}
    :{leftCents:e.leftCents,closed:e.closed,citation:Boolean(e.citationId),funding:{cents:e.funding.cents,alignmentCents:e.funding.alignmentCents??0,unreleasedCents:e.funding.unreleasedCents??0},flows:fl?{settlementCents:fl.settlementCents,added:fl.added.map(a=>[a.kind,a.cents])}:null,effect:e.effect};}
  // Repeats (R5): the same request id, or the same binding, with the same request returns the record.
  repeat(r,binding){const requestHash=hash(Reconciliation.content(r));const byId=this.db.prepare('SELECT payload FROM settlement_reconciliations WHERE requestId=?').get(r.requestId);
    if(byId){const p=JSON.parse(byId.payload);if(p.contentHash!==binding||p.requestHash!==requestHash||p.account!==r.account)throw fail('REQUEST_ID_REUSED');return {...p,repeat:true};}
    const same=this.db.prepare('SELECT payload FROM settlement_reconciliations WHERE account=? AND contentHash=?').get(r.account,binding);if(!same)return null;
    const p=JSON.parse(same.payload);if(p.requestHash!==requestHash)throw fail('PREVIEW_MISMATCH');return {...p,repeat:true};}
  dry(fn){const own=!this.db.isTransaction;this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT reconciliation_preview');
    try{return fn();}finally{if(own)this.db.exec('ROLLBACK');else{this.db.exec('ROLLBACK TO reconciliation_preview');this.db.exec('RELEASE reconciliation_preview');}}}
  // R4: inside the caller's transaction.
  apply(r,sv,ctx={},expected=null){
    const {st,piece:f,flow,split}=this.against(r),{account}=r,ledger=this.ledger,now=this.clock(),id='M'+hash([account,r.requestId]);
    const before=this.values(account,ctx);
    const snapshot=JSON.parse(JSON.stringify(f)),seen=st.seen?.[f.id]??null,related=(st.evidence??[]).filter(e=>JSON.stringify(e).includes(JSON.stringify(f.id))).slice(-10);
    ledger.manual({account,evidenceId:id,amountCents:r.cents,pieceId:f.pid,orderId:f.id,kisReference:r.kisReference,explanation:r.explanation,route:r.route});
    const allocationId=ledger.allocate({account,evidenceId:id,pieceId:f.pid,orderId:f.id,cents:r.cents,pieceCents:f.cents0,rule:`manual: ${r.explanation}`});
    const left=cents(f.usd)-r.cents;
    if(left>0){f.usd=left/100;ledger.event(account,'piece-reconciled',{pieceId:f.pid,orderId:f.id,cents:r.cents,leftCents:left,reconciliationId:id});}
    else{st.open=st.open.filter(p=>p!==f);ledger.event(account,'piece-closed',{pieceId:f.pid,orderId:f.id,by:id});}
    this.inFlight.save(account,st);
    const citationId=r.citation?ledger.cite({account,groupId:r.citation.groupId,version:r.citation.version,orderId:f.id,side:f.side,cents:r.cents,rule:`manual reconciliation ${id}`}):null;
    // R9: only a named route releases funding.
    const named=r.explanation==='settled'&&(r.route==='USD'||r.route==='KRW');let funding;
    if(f.side!=='Buy')funding={cents:0,reason:'a sale commits no funding'};
    else if(!named&&r.explanation==='settled')funding={cents:0,reason:'route unknown: nothing is released; the commitment stays for capacity until the route is established'};
    else{const whole=left<=0&&!st.open.some(p=>p.id===f.id)&&this.wholeByNamedRoutes(account,f.id,st,r);
      funding=named||whole?this.funding.releaseFor({orderId:f.id,cents:r.cents,route:named?r.route:'rounding',reconciliationId:id,whole,citationId}):{cents:0,reason:'rounding: no payment, nothing released'};}
    // R8: the flow reclassified, exactly.
    let flows=null;
    if(flow){this.performance.removeFlow(account,flow.id);const added=[];
      for(const e of split)if(e.kind!=='settlement'){const x=this.performance.addFlow(account,{day:flow.day,market:'US',amount:e.cents/100,...(e.kind==='unexplained'?{detected:true}:{}),...(Number.isFinite(flow.occurredAfter)?{occurredAfter:flow.occurredAfter}:{}),...(Number.isFinite(flow.occurredBy)?{occurredBy:flow.occurredBy}:{}),...(flow.pendingIds?{pendingIds:flow.pendingIds}:{}),
        note:e.kind==='unexplained'?`Unexplained part of a reconciled U.S. cash change (${id}). Confirm or remove.`:`${e.kind==='deposit'?'Deposit':'Withdrawal'} split from a detected U.S. cash change by reconciliation ${id} (KIS ${e.kisReference??r.kisReference}).`});added.push({id:x.id,kind:e.kind,cents:e.cents});}
      flows={original:flow,added,settlementCents:split.find(e=>e.kind==='settlement').cents};
      ledger.event(account,'flow-reclassified',{reconciliationId:id,flowId:flow.id,flowCents:cents(flow.amount),split,added:added.map(a=>a.id)});}
    // R10: what the reconciliation changes in accounting terms, for step 2b.4 and stage 3.
    const reclassified=flows?Math.abs(flows.settlementCents):0;
    const effect={side:f.side,obligationCents:r.cents,reclassifiedCashCents:reclassified,correctionCents:r.cents-reclassified,basis:r.explanation==='rounding'?'rounding':reclassified?'settlement in a tracked pair':f.pretracking?'basis change':'correction'};
    const after=this.values(account,ctx);
    const effects={evidenceId:id,allocationId,leftCents:Math.max(0,left),closed:left<=0,citationId,funding,flows,effect},contentHash=Reconciliation.binding(r,sv,ctx,{before,after,effects});
    if(expected!=null&&contentHash!==expected)throw fail('PREVIEW_MISMATCH');
    const payload={id,kind:'reconciliation',account,requestId:r.requestId,contentHash,requestHash:hash(Reconciliation.content(r)),pieceId:f.pid,orderId:f.id,side:f.side,cents:r.cents,explanation:r.explanation,route:r.route,kisReference:r.kisReference,note:r.note,settledOn:r.settledOn,flowId:r.flowId,
      confirmedAt:now,confirmedBy:this.who,stateVersion:sv,context:{balances:ctx.balances??null,inputs:ctx.inputs??null},evidence:{piece:snapshot,seen,related,standby:ledger.standbyFor(f.pid),citation:r.citation,flow:flow??null},effects,preview:{before,after}};
    this.db.prepare('INSERT INTO settlement_reconciliations VALUES(?,?,?,?,?,?,?,?)').run(id,account,r.requestId,contentHash,'reconciliation',null,now,JSON.stringify(payload));
    ledger.event(account,'reconciliation',{id,pieceId:f.pid,orderId:f.id,cents:r.cents,explanation:r.explanation,route:r.route,kisReference:r.kisReference});
    return payload;}
  // Whether every part of the order is reconciled, by records with a named route or a closing rounding record, with no
  // automatic evidence allocated to it: then its whole filled commitment can be released (R9).
  wholeByNamedRoutes(account,orderId,st,r){const recs=this.active(account).filter(x=>x.orderId===orderId);
    if(![...recs,r].every(x=>x.explanation==='rounding'||x.route==='USD'||x.route==='KRW'))return false;
    const manual=recs.reduce((n,x)=>n+x.cents,0)+r.cents,allocated=this.ledger.allocatedToOrder(account,orderId);return manual===allocated&&st.seen?.[orderId]?.cents===allocated;}
  // R7: reversals.
  reversalFields(req){if(!req||typeof req!=='object')throw fail('REQUEST_INVALID');const requestId=text(req.requestId,100);if(!requestId)throw fail('REQUEST_ID_REQUIRED');const account=text(req.account,200);if(!account)throw fail('ACCOUNT_REQUIRED');
    const reconciliationId=text(req.reconciliationId,100);if(!reconciliationId)throw fail('RECONCILIATION_REQUIRED');const note=text(req.note,500);if(!note)throw fail('NOTE_REQUIRED');const kisReference=req.kisReference==null?null:text(req.kisReference,120);
    return {requestId,account,reconciliationId,note,kisReference};}
  target(r){const t=this.record(r.reconciliationId);if(!t||t.account!==r.account)throw fail('RECONCILIATION_UNKNOWN');if(t.kind==='reversal')throw fail('REVERSAL_OF_REVERSAL');const done=this.reversalOf(t.id);if(done)throw fail('ALREADY_REVERSED',{reversalId:done.id});return t;}
  previewReversal(req,ctx={}){const r=this.reversalFields(req);const sv=this.stateVersion(r.account);const rec=this.dry(()=>this.applyReversal(r,sv,ctx));return Reconciliation.shown(r,sv,rec);}
  // Bound like a confirmation (R3, R7).
  reverse(req,ctx={}){const r=this.reversalFields(req);const b=Reconciliation.bound(req);
    try{return this.ledger.tx(()=>{const prior=this.repeat(r,b.binding);if(prior)return prior;const sv=this.stateVersion(r.account);if(sv.id!==b.stateVersion)throw fail('STATE_CHANGED');return this.applyReversal(r,sv,ctx,b.binding);});}
    catch(e){if(e.code==='STATE_CHANGED')try{e.preview=this.previewReversal(req,ctx);}catch(p){e.previewError=p.code??p.message;}throw e;}}
  applyReversal(r,sv,ctx={},expected=null){
    const t=this.target(r),{account}=r,ledger=this.ledger,now=this.clock(),id='V'+hash([account,r.requestId]);
    const before=this.values(account,ctx);
    // Its allocations reversed (a part a KIS record already reduced is not reversed twice) and its evidence voided.
    const reversed=ledger.reverseEvidence(account,t.effects.evidenceId,id),reversedCents=reversed.reduce((n,a)=>n+a.cents,0);
    // Standby coverage of the piece, promoted for what it agreed with, if still valid (design v3 §6).
    let need=reversedCents;const promoted=[];
    for(const s of ledger.standbyFor(t.pieceId).sort((a,b)=>a.at-b.at)){if(need<=0)break;const avail=s.cents-s.promotedCents;if(avail<=0)continue;
      const v=this.standbyValid(account,s);const take=v.ok?Math.min(need,avail,v.free):0;
      if(!(take>0)){promoted.push({standbyId:s.id,evidenceId:s.evidenceId,version:s.version,cents:0,reason:v.ok?'its evidence is consumed elsewhere':v.reason});continue;}
      const allocationId=ledger.allocate({account,evidenceId:s.evidenceId,version:s.version,pieceId:t.pieceId,orderId:t.orderId,cents:take,rule:'promoted standby'});ledger.promote(account,s.id,take,id);need-=take;promoted.push({standbyId:s.id,evidenceId:s.evidenceId,version:s.version,cents:take,allocationId});}
    // The piece reopens only for what no promoted evidence covers.
    const reopen=need;if(reopen>0){const st=this.inFlight.state(account);const f=st.open.find(p=>p.pid===t.pieceId);
      if(f)f.usd=(cents(f.usd)+reopen)/100;else{st.open.push({...t.evidence.piece,usd:reopen/100,reopened:{by:id,at:now}});if(t.evidence.seen&&!st.seen?.[t.orderId]){st.seen??={};st.seen[t.orderId]=t.evidence.seen;}}
      this.inFlight.save(account,st);ledger.event(account,'piece-reopened',{pieceId:t.pieceId,orderId:t.orderId,cents:reopen,by:id});}
    const reinstated=this.funding.reinstate({reconciliationId:t.id,by:id});
    // The flow it reclassified comes back only for what is still this record's (review of 8b929ea, P1: reversing a split
    // restored all of the original although a later record had reconciled its unexplained part): the reversed settlement
    // entry, plus each entry it added that is still a flow (removed again). An added entry a later record reconciled, or
    // that was removed since, keeps that later transformation and is not restored.
    let flows=null;if(t.effects.flows){const fl=t.effects.flows,present=new Map(this.performance.flows(account).map(x=>[x.id,x])),removed=[],kept=[];let restore=fl.settlementCents;
      const later=this.active(account).filter(x=>x.id!==t.id);
      for(const a of fl.added){const x=present.get(a.id);if(x){this.performance.removeFlow(account,a.id);removed.push(a.id);restore+=cents(x.amount);continue;}
        const by=later.find(x=>x.flowId===a.id);kept.push({id:a.id,cents:a.cents,by:by?.id??null,reason:by?'reconciled by a later record':'removed since'});}
      const whole=restore===cents(fl.original.amount)&&!kept.length;
      if(restore!==0&&!present.has(fl.original.id)){const back=whole?fl.original:{...fl.original,amount:restore/100,note:`${fl.original.note} (restored in part by reversal ${id}: ${kept.map(k=>`${(k.cents/100).toFixed(2)} ${k.reason}`).join('; ')})`.slice(0,200)};
        this.db.prepare('INSERT INTO cash_flows VALUES(?,?,?)').run(fl.original.id,account,JSON.stringify(back));}
      flows={restored:fl.original.id,restoredCents:restore,whole,removed,kept};ledger.event(account,'flow-restored',{reversalId:id,flowId:fl.original.id,restoredCents:restore,removed,kept});}
    if(t.effects.citationId)ledger.reverseCitation(account,t.effects.citationId,id);
    const after=this.values(account,ctx);
    const effects={reversedCents,reversed,promoted,reopenedCents:reopen,fundingReinstatedCents:reinstated,flows,citationWithdrawn:t.effects.citationId??null,effect:{side:t.side,obligationCents:-reopen,promotedCents:reversedCents-reopen}},contentHash=Reconciliation.binding(r,sv,ctx,{before,after,effects});
    if(expected!=null&&expected!==contentHash)throw fail('PREVIEW_MISMATCH');
    const payload={id,kind:'reversal',target:t.id,account,requestId:r.requestId,contentHash,requestHash:hash(Reconciliation.content(r)),pieceId:t.pieceId,orderId:t.orderId,side:t.side,note:r.note,kisReference:r.kisReference,confirmedAt:now,confirmedBy:this.who,stateVersion:sv,
      context:{balances:ctx.balances??null,inputs:ctx.inputs??null},effects,preview:{before,after}};
    this.db.prepare('INSERT INTO settlement_reconciliations VALUES(?,?,?,?,?,?,?,?)').run(id,account,r.requestId,contentHash,'reversal',t.id,now,JSON.stringify(payload));
    ledger.event(account,'reconciliation-reversed',{id,target:t.id,pieceId:t.pieceId,reversedCents,reopenedCents:reopen});
    return payload;}
  // Whether standby coverage can still be consumed: its evidence exists, is not voided, has something left and, for a
  // KIS settled-trade row, is independent, current and usable (U6 verified; A1).
  standbyValid(account,s){const ev=this.ledger.version(s.evidenceId,s.version);if(!ev||ev.reversedBy)return {ok:false,reason:'its evidence no longer stands'};
    const free=Math.max(0,ev.amountCents-this.ledger.allocated(s.evidenceId,s.version));
    if(ev.key){if(!this.u6)return {ok:false,reason:'a KIS settled-trade row is supporting evidence only until U6 is verified (A1 off)'};
      const g=this.ledger.kGroups(account).find(x=>x.id===s.evidenceId);if(!g||!this.ledger.independent(g))return {ok:false,reason:g?this.ledger.why(g):'the row is unknown'};
      if(g.versions.at(-1).version!==s.version)return {ok:false,reason:'the row has a later version'};}
    return {ok:true,free};}
  // Corroboration (design v3 §6): a K row linked with certainty to an order resolved by reconciliations, agreeing to the
  // cent with what is allocated, is kept as standby coverage of each reconciled piece, not consumed. Only when U6 is
  // verified (a test switch until then): before that, K is not valid evidence and nothing is recorded.
  corroborate(account,orders){if(!this.u6)return [];
    return this.ledger.tx(()=>{const out=[],links=this.ledger.links(account,orders),recs=this.active(account);
      for(const [orderId,l] of links){if(l.state!=='linked')continue;const mine=recs.filter(x=>x.orderId===orderId);if(!mine.length)continue;
        const k=cents(l.fields.settlementUSD??l.fields.grossUSD??0);if(Math.abs(k-this.ledger.allocatedToOrder(account,orderId))>1)continue;
        const byPiece=new Map();for(const x of mine)byPiece.set(x.pieceId,(byPiece.get(x.pieceId)??0)+x.cents);
        for(const [pieceId,c] of byPiece)out.push(this.ledger.standby({account,evidenceId:l.groupId,version:l.version,pieceId,cents:c}));}
      return out;});}
}
module.exports={Reconciliation,ROUTES,EXPLANATIONS,ROUNDING_MAX_CENTS};
