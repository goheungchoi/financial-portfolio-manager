'use strict';
// Shared funding protection (Stage 1 of the 2026-11-05 settlement design, v3.3; the executable rules are listed in
// artifacts/reviews/2026-11-05-accounting/stage1-funding-spec.md). Korean and U.S. buys can draw on one KRW pool through
// integrated margin, so every buy's funding is a durable commitment in one ledger shared by both engines, checked
// under one process-wide lock against fresh balances before anything is sent.
// - A commitment is written before submission and changes only with the order record, in the same transaction
//   (LiveEngine.save). Nothing is released on time, on a later balance or on an empty order listing: only a
//   confirmed rejection with no shares filled releases a buy. Filled shares stay committed as filled-but-unpaid, and
//   an unfilled remainder stays committed until its cancellation and fills are final, which needs verified broker
//   semantics (U8) that Stage 1 does not have. Orders recorded before the ledger existed enter it the same way.
// - The funding route of a U.S. buy is not verified (U9), and that integrated margin is off is never inferred (equal
//   integrated and foreign buying-power figures can just mean no KRW is available). Unless a verified regime is set,
//   every U.S. commitment may be paid entirely in KRW: both checks run on the KRW pool, with every U.S. amount
//   revalued at the fresh rate plus the buffer on each check.
// - KIS's reported unsettled U.S. buy total enters the U.S. commitments once (it may include purchases outside the
//   app; Stage 1 attributes none of it to the app's own fills, so those count twice, conservatively).
// - A broker fill beyond what was committed marks the account over-committed: new buys are refused and an alert is
//   raised; sales are never checked here.
const FX_FRESH_MS=2*60000,BALANCE_FRESH_MS=2*60000,BUFFER=0.02,FALLBACK_FEE=0.01,ALIGNMENT_MAX_CENTS=1;
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
const REGIMES=['unknown','integrated-usd-first','separate'];
const fail=(code,detail)=>Object.assign(new Error(code),{detail});
const baseAccount=key=>String(key??'').replace(/:US$/,'');
const marketOf=o=>o.market==='US'||String(o.accountKey??'').endsWith(':US')?'US':'KR';
class FundingLedger {
  // fresh(market): a fresh balance for that market (null when that market has no account); fx(): {usdKRW, timestamp};
  // regime: a verified funding regime, or null (unknown); alert(title, message).
  constructor(db,{clock=Date.now,fresh=null,fx=null,regime=null,buffer=BUFFER,alert=null}={}){
    this.db=db;this.clock=clock;this.fresh=fresh;this.fxSource=fx;this.verifiedRegime=REGIMES.includes(regime)&&regime!=='unknown'?regime:null;this.buffer=buffer;this.alert=alert;this.queue=Promise.resolve();
    db.exec('CREATE TABLE IF NOT EXISTS funding_commitments(orderId TEXT PRIMARY KEY,account TEXT NOT NULL,market TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS funding_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,orderId TEXT,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS funding_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    // Stage 2b.3: what audited reconciliations released of a buy's filled part (positive) or reinstated on reversal
    // (negative). Append-only; a commitment counts its amount less the net released, never below its unfilled part.
    // A release that relied on a KIS row carries the citation, so the restriction returns while that row is under review.
    db.exec(`CREATE TABLE IF NOT EXISTS funding_releases(id TEXT PRIMARY KEY,orderId TEXT NOT NULL,account TEXT NOT NULL,cents INTEGER NOT NULL,route TEXT,reconciliationId TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT,citationId TEXT);
      CREATE TRIGGER IF NOT EXISTS funding_releases_no_update BEFORE UPDATE ON funding_releases BEGIN SELECT RAISE(ABORT,'funding_releases is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS funding_releases_no_delete BEFORE DELETE ON funding_releases BEGIN SELECT RAISE(ABORT,'funding_releases is append-only'); END;`);
    if(!db.prepare('PRAGMA table_info(funding_releases)').all().some(c=>c.name==='citationId'))db.exec('ALTER TABLE funding_releases ADD COLUMN citationId TEXT');
  }
  regime(){return this.verifiedRegime??'unknown';}
  row(orderId){const r=this.db.prepare('SELECT payload FROM funding_commitments WHERE orderId=?').get(orderId);return r?JSON.parse(r.payload):null;}
  rows(account){return this.db.prepare('SELECT payload FROM funding_commitments WHERE account=?').all(baseAccount(account)).map(r=>JSON.parse(r.payload));}
  event(orderId,payload){this.db.prepare('INSERT INTO funding_events(at,orderId,payload) VALUES(?,?,?)').run(this.clock(),orderId,JSON.stringify(payload));}
  write(c){this.db.prepare('INSERT INTO funding_commitments VALUES(?,?,?,?) ON CONFLICT(orderId) DO UPDATE SET payload=excluded.payload').run(c.orderId,c.account,c.market,JSON.stringify(c));}
  // The cost per share of a buy in its currency: the estimate's net cash (fees included) per share, at the highest
  // price the order may carry (its limit, a confirmed revision, or one sent but not confirmed).
  static feeFactor(o){const est=o.costEstimate;return Math.max(1,est&&Number.isFinite(est.netCash)&&o.quantity>0&&o.limitPrice>0?-est.netCash/(o.quantity*o.limitPrice):1+FALLBACK_FEE);}
  static perShare(o){return Math.max(o.limitPrice??0,o.currentPrice??0,o.pendingRevision?.price??0,o.unconfirmed?.price??0)*FundingLedger.feeFactor(o);}
  // What an order commits now, from its record and the previous commitment. Stage 1 releases only a buy rejected with
  // no shares filled (KIS refused it at submission, the listing marks it rejected, or it was stopped before sending);
  // everything else committed stays committed.
  static commitment(o,prev=null,{pretracking=false}={}){
    if(o.side!=='Buy'||o.credit?.kind==='margin-buy')return null;
    // A Ready order commits nothing, unless the ledger reserved it for a submission under way.
    if(o.status==='Ready'&&prev?.state!=='reserved')return prev??null;
    const filled=Math.max(0,o.filled??0),quantity=Math.max(o.quantity??0,filled),per=FundingLedger.perShare(o);
    // Filled shares at the larger of KIS's net cash and the fill price with the estimated fees.
    const filledAmount=filled>0?Math.max(Number.isFinite(o.resultCosts?.netCash)?Math.abs(o.resultCosts.netCash):0,filled*(o.fillPrice??per)*FundingLedger.feeFactor(o)):0;
    let state,remainder=quantity-filled,reason;
    if(o.status==='Ready'){state='reserved';reason='reserved before submission';}
    else if(o.status==='Rejected'&&filled===0){state='released';remainder=0;reason='rejected with no shares filled';}
    else if(o.status==='Filled'){state='filled-unpaid';remainder=0;reason='filled; payment not yet evidenced';}
    else if(['Canceled','Rejected'].includes(o.status)){state=filled?'filled-unpaid':'cancel-reported';reason=`${o.status==='Canceled'?'cancellation':'rejection'} reported; final fills not verified (U8), so the unfilled ${remainder} stay committed`;}
    else if(['Submitting','Uncertain'].includes(o.status)){state='uncertain';reason='the order may have reached KIS';}
    else if(o.status==='Cancellation uncertain'){state='uncertain';reason='cancellation not confirmed';}
    else{state='open';reason='open at KIS';}
    // Committed shares never fall except by a conclusive rejection; more fills than were committed is over-commitment.
    const committedQty=state==='released'?0:Math.max(quantity,prev?.committedQty??0);
    const overCommitted=Boolean(prev?.overCommitted)||filled>Math.max(o.quantity??0,prev?.committedQty??0);
    const amount=state==='released'?0:Math.max(filledAmount+Math.max(0,committedQty-filled)*per,overCommitted?filledAmount:0);
    return {orderId:o.id,account:baseAccount(o.accountKey),market:marketOf(o),currency:marketOf(o)==='US'?'USD':'KRW',symbol:o.symbol,state,reason,committedQty,filledQty:filled,remainderQty:Math.max(0,committedQty-filled),
      perShare:Math.round(per*1e6)/1e6,amount:Math.round(amount*100)/100,overCommitted,pretracking:Boolean(prev?.pretracking||pretracking),status:o.status,updatedAt:Date.now()};
  }
  // Called by LiveEngine.save inside the order's own transaction.
  track(order,options={}){const prev=this.row(order.id);const next=FundingLedger.commitment(order,prev,options);if(!next)return null;
    if(prev&&JSON.stringify({...prev,updatedAt:0})===JSON.stringify({...next,updatedAt:0}))return prev;this.write(next);
    if(!prev||prev.state!==next.state||prev.amount!==next.amount)this.event(order.id,{kind:'commitment',from:prev?.state??null,to:next.state,amount:next.amount,currency:next.currency,reason:next.reason});
    if(next.overCommitted&&!prev?.overCommitted){this.event(order.id,{kind:'over-committed',filled:next.filledQty,committed:prev?.committedQty??null});try{this.alert?.('Funding over-committed',`${next.symbol}: KIS reports ${next.filledQty} shares filled, more than the ${prev?.committedQty??order.quantity} committed. New buys are refused until this is reviewed; sales are not affected.`);}catch{}}
    return next;}
  // First start: every order already recorded enters the ledger by the same rules, marked pre-tracking; a buy
  // reserved but never sent (Ready) is released, since it provably never reached KIS. Repeating it changes nothing.
  init(){
    const done=this.db.prepare("SELECT value FROM funding_meta WHERE key='bootstrapped'").get();
    let rows=[];try{rows=this.db.prepare('SELECT payload FROM live_intents').all().map(r=>JSON.parse(r.payload));}catch{}
    this.db.exec('BEGIN IMMEDIATE');try{
      if(!done){for(const o of rows)if(o.status!=='Ready')this.track(o,{pretracking:true});this.db.prepare("INSERT INTO funding_meta VALUES('bootstrapped',?)").run(String(this.clock()));this.event(null,{kind:'bootstrap',orders:rows.length});}
      const byId=new Map(rows.map(o=>[o.id,o]));
      for(const c of this.db.prepare('SELECT payload FROM funding_commitments').all().map(r=>JSON.parse(r.payload)))if(c.state==='reserved'&&(byId.get(c.orderId)?.status??'Ready')==='Ready'){this.write({...c,state:'released',amount:0,remainderQty:0,reason:'reserved but never sent (restart before submission)'});this.event(c.orderId,{kind:'commitment',from:'reserved',to:'released',reason:'never sent'});}
      this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // The filled part of a commitment in cents (its unfilled remainder excluded), and what reconciliations released of it.
  static filledCents(c){return c&&c.state!=='released'?Math.max(0,Math.round((c.amount-(c.remainderQty??0)*(c.perShare??0))*100)):0;}
  releasedCents(orderId){return this.db.prepare('SELECT COALESCE(SUM(cents),0) n FROM funding_releases WHERE orderId=?').get(String(orderId)).n;}
  // A commitment as it counts now: less what audited reconciliations released of its filled part, except what is
  // suspended because the KIS row a release relied on is under review.
  effective(c,suspended=0){const net=Math.min(Math.max(0,this.releasedCents(c.orderId)-suspended),FundingLedger.filledCents(c));
    return net||suspended?{...c,amount:Math.round(c.amount*100-net)/100,...(net?{releasedUSD:net/100}:{}),...(suspended?{underReviewUSD:suspended/100}:{})}:c;}
  // Releases relying on a KIS row (a reconciliation citing it) count only while that coverage holds (review of 8b929ea,
  // P1: a cited row disappeared, valuation reopened $100, and funding stayed released). For each such release still in
  // effect, the citation's shortfall under review is committed again (the whole release when the whole citation is
  // under review). Recomputed from the ledger at every check, so restarts, partial shortfalls and re-confirmation follow.
  suspendedCents(account){const out=new Map();const rows=this.db.prepare('SELECT orderId,MAX(citationId) citationId,SUM(cents) n FROM funding_releases WHERE account=? GROUP BY reconciliationId').all(baseAccount(account)).filter(r=>r.citationId&&r.n>0);
    if(!rows.length)return out;const ev=this.settlement??=new (require('./settlement-evidence.cjs').SettlementEvidence)(this.db,this.clock);
    const short=new Map();for(const x of ev.underReview(baseAccount(account)))short.set(x.citationId,(short.get(x.citationId)??0)+Math.round(x.usd*100));
    const cited=new Map(ev.citations(baseAccount(account)).map(c=>[c.id,c.cents]));
    for(const r of rows){const s=short.get(r.citationId)??0;if(!s)continue;const part=s>=(cited.get(r.citationId)??Infinity)?r.n:Math.min(r.n,s);out.set(r.orderId,(out.get(r.orderId)??0)+part);}
    return out;}
  // Stage 2b.3 (design v3 §4.3): a manual reconciliation naming the route (USD or KRW) releases that buy's filled part,
  // up to the reconciled amount; "route unknown" releases nothing (it is never called then). whole: every part of the
  // order's obligation is reconciled with a named route, so a rounding difference of the funding estimate (at most
  // ALIGNMENT_MAX_CENTS) is released with it and recorded as an alignment; a larger excess of the estimate over the
  // reconciled amount stays committed and is reported (review of 8b929ea: not silently treated as rounding). Called
  // inside the reconciliation's transaction. citationId: the KIS row the reconciliation cited, if any. Returns what was
  // released.
  releaseFor({orderId,cents:c,route,reconciliationId,whole=false,citationId=null}){const row=this.row(String(orderId));const filled=FundingLedger.filledCents(row),left=Math.max(0,filled-this.releasedCents(orderId));
    const exact=Math.min(left,c),extra=whole?left-exact:0,alignment=extra<=ALIGNMENT_MAX_CENTS?extra:0,unreleased=extra-alignment,take=exact+alignment;
    if(take>0){this.db.prepare('INSERT INTO funding_releases(id,orderId,account,cents,route,reconciliationId,at,reason,citationId) VALUES(?,?,?,?,?,?,?,?,?)').run(`${reconciliationId}:release`,String(orderId),row.account,take,route,reconciliationId,this.clock(),whole?'reconciled whole':'reconciled',citationId);
      this.event(String(orderId),{kind:'released by reconciliation',reconciliationId,route,cents:take,...(alignment?{alignmentCents:alignment}:{}),...(citationId?{citationId}:{})});}
    return {cents:take,alignmentCents:alignment,unreleasedCents:unreleased,...(unreleased?{reason:`the funding estimate exceeds the reconciled amount by $${(unreleased/100).toFixed(2)}; it stays committed (only a rounding difference of up to ${ALIGNMENT_MAX_CENTS} cent is aligned)`}:{}),committed:Boolean(row&&row.state!=='released'),filledCents:filled};}
  // Settlement simplification S1a: a buy whose U.S. fill settled, by KIS evidence or by age (InFlight onSettled),
  // releases the filled part not yet released. Recorded like a reconciliation's release (funding_releases is append-only;
  // its reconciliationId is 'age:<orderId>' or 'evidence:<orderId>', never a real reconciliation's), with event
  // 'released by age' or 'released by evidence'. The unfilled remainder of a live or cancelled order is not covered (U8).
  // Nothing left to release (already released, a sale, no commitment) does nothing, so a repeat is harmless.
  releaseSettled({orderId,why='age',at=this.clock()}){if(!['age','evidence'].includes(why))throw new Error('INVALID_RELEASE');const row=this.row(String(orderId));if(!row||row.state==='released')return {cents:0};
    const left=Math.max(0,FundingLedger.filledCents(row)-this.releasedCents(orderId));if(!(left>0))return {cents:0};
    const reconciliationId=`${why}:${orderId}`,n=this.db.prepare('SELECT COUNT(*) n FROM funding_releases WHERE reconciliationId=?').get(reconciliationId).n;
    this.db.prepare('INSERT INTO funding_releases(id,orderId,account,cents,route,reconciliationId,at,reason,citationId) VALUES(?,?,?,?,?,?,?,?,?)').run(`${reconciliationId}:release${n?':'+(n+1):''}`,String(orderId),row.account,left,null,reconciliationId,at,why==='age'?'settled by age':'settled by evidence',null);
    this.event(String(orderId),{kind:why==='age'?'released by age':'released by evidence',cents:left});return {cents:left};}
  // Settlement simplification S1b: a Korean buy has no tracker piece, so its filled part is released by age here, at each
  // balance reading: 3 Korean business days after its order's trade day (the Seoul date the engine records; else the
  // Seoul date of acceptance or creation), from the KIS calendar (kr_calendar) with weekdays where it has no answer.
  // The unfilled remainder stays committed (U8). One savepoint: all of a reading's releases or none. Returns them.
  releaseAgedKR(account,{now=this.clock(),krOpen=null}={}){const B=require('./business-days.cjs');
    let open=krOpen;if(!open){let cal=new Map();try{cal=new Map(this.db.prepare('SELECT day,open FROM kr_calendar').all().map(r=>[r.day,Boolean(r.open)]));}catch{}open=d=>cal.has(d)?cal.get(d):null;}
    let orders=new Map();try{orders=new Map(this.db.prepare('SELECT payload FROM live_intents').all().map(r=>JSON.parse(r.payload)).map(o=>[String(o.id),o]));}catch{}
    const due=[];for(const c of this.rows(account)){if(c.market!=='KR'||c.state==='released')continue;if(!(FundingLedger.filledCents(c)-this.releasedCents(c.orderId)>0))continue;
      const o=orders.get(String(c.orderId)),at=Number.isFinite(o?.acceptedAt)?o.acceptedAt:o?.createdAt,tradeDay=/^\d{4}-\d{2}-\d{2}$/.test(o?.day??'')?o.day:Number.isFinite(at)?B.dateIn('KR',at):null;
      if(tradeDay&&B.agedOut('KR',{tradeDay,now,krOpen:open}).aged)due.push({orderId:String(c.orderId),tradeDay});}
    if(!due.length)return [];const out=[];this.db.exec('SAVEPOINT funding_kr_age');
    try{for(const d of due){const r=this.releaseSettled({orderId:d.orderId,why:'age',at:now});if(r.cents)out.push({...d,cents:r.cents});}this.db.exec('RELEASE funding_kr_age');}
    catch(e){this.db.exec('ROLLBACK TO funding_kr_age');this.db.exec('RELEASE funding_kr_age');throw e;}
    return out;}
  // A reversed reconciliation: what it released counts again.
  reinstate({reconciliationId,by}){const rows=this.db.prepare('SELECT * FROM funding_releases WHERE reconciliationId=?').all(reconciliationId),net=rows.reduce((n,r)=>n+r.cents,0);if(!(net>0))return 0;const r=rows[0];
    this.db.prepare('INSERT INTO funding_releases(id,orderId,account,cents,route,reconciliationId,at,reason,citationId) VALUES(?,?,?,?,?,?,?,?,?)').run(`${reconciliationId}:reinstate`,r.orderId,r.account,-net,r.route,reconciliationId,this.clock(),`reversed by ${by}`,r.citationId??null);this.event(r.orderId,{kind:'reinstated by reversal',reconciliationId,by,cents:net});return net;}
  // Commitments of an account in each currency.
  commitments(account){const s=this.suspendedCents(account);const rows=this.rows(account).filter(c=>c.state!=='released').map(c=>this.effective(c,s.get(String(c.orderId))??0));const sum=m=>rows.filter(c=>c.market===m).reduce((n,c)=>n+c.amount,0);
    return {usd:Math.round(sum('US')*100)/100,krw:Math.round(sum('KR')),overCommitted:rows.some(c=>c.overCommitted),rows};}
  // One at a time: fresh balances, the check and the durable reservation.
  lock(fn){const run=this.queue.then(fn,fn);this.queue=run.catch(()=>{});return run;}
  // The balances and rate a check needs, each fresh and each of the order's own account and environment (stage 1
  // review, P1: a fresh balance of another account funded a submission). own: the balance the engine just read.
  // account: the order's account (Korean key; the U.S. one is it with ':US'); environment: live or mock.
  async inputs(market,own,{account=null,environment=null}={}){
    // Ages are measured after every read has finished, just before the check (stage 1 review, P2: a slow read let
    // inputs older than the limit pass, measured from before the reads); the check follows with no further wait.
    const fresh=async m=>m===market&&own?own:(this.fresh?await this.fresh(m):null);const kr=await fresh('KR'),us=await fresh('US');const appRate=this.fxSource?.()??null;const now=this.clock();
    const env=environment??own?.environment??null;
    for(const [b,key,label] of [[kr,account,'Korean'],[us,account?account+':US':null,'U.S.']])if(b&&(key&&b.accountKey!==key||env&&b.environment!==env))throw fail('ACCOUNT_CHANGED',`the ${label} balance read for this check is of another account or environment`);
    const t=b=>{const x=Date.parse(b?.timestamp??'');return Number.isFinite(x)?x:null;};
    if(!kr||!(now-(t(kr)??-Infinity)<=BALANCE_FRESH_MS))throw fail('FUNDING_BALANCE_STALE','a Korean balance read within two minutes is required');
    if(us&&!(now-(t(us)??-Infinity)<=BALANCE_FRESH_MS))throw fail('FUNDING_BALANCE_STALE','a U.S. balance read within two minutes is required');
    const kCash=Math.min(kr.cash,Number.isFinite(kr.settledCash)?kr.settledCash:kr.cash);if(!Number.isFinite(kCash))throw fail('FUNDING_BALANCE_STALE','Korean cash is unknown');
    const fxOf=v=>{const ts=typeof v?.timestamp==='number'?v.timestamp:Date.parse(v?.timestamp??'');return v?.usdKRW>0&&Number.isFinite(ts)&&now-ts<=FX_FRESH_MS?v.usdKRW:null;};
    const rate=fxOf(us?.fx)??fxOf(appRate);
    return {kCash,uCash:us&&Number.isFinite(us.cash)?us.cash:0,reportedKRW:Math.max(0,Number(us?.unsettled?.buyKRW)||0),rate,kr,us};
  }
  // Whether a buy costing cost (its currency) fits, and if it does, its durable reservation. Throws when it does not.
  // The balances are read first; the commitments are read after them, and the check and the reservation follow with
  // no wait in between, so nothing that changed during the reads is missed (stage 1 review, P1).
  async admit({order,market,cost,balance,environment=null}){
    return this.lock(async()=>{
      const account=baseAccount(order.accountKey);const i=await this.inputs(market,balance,{account,environment});
      const c=this.commitments(account);if(c.overCommitted)throw fail('FUNDING_OVERCOMMITTED','a broker fill exceeded what was committed; review before new buys');
      const check=this.check({market,cost,commitments:c,inputs:i});if(!check.fits)throw fail('INSUFFICIENT_CAPACITY',check.detail);
      const prev=this.row(order.id);const reserved={...FundingLedger.commitment({...order,status:'Submitting'},prev),state:'reserved',reason:'reserved before submission'};
      this.write(reserved);this.event(order.id,{kind:'commitment',from:prev?.state??null,to:'reserved',amount:reserved.amount,currency:reserved.currency,check});return check;});
  }
  // A reservation whose order provably never left (a check failed between admission and sending): released.
  release(order,reason){const prev=this.row(order.id);if(!prev||prev.state!=='reserved')return prev;const next={...prev,state:'released',amount:0,remainderQty:0,reason};this.write(next);this.event(order.id,{kind:'commitment',from:'reserved',to:'released',reason});return next;}
  // A revision raising the price of an open buy: the increase is checked and reserved under the lock before the
  // revision is sent. pendingRevision is the marker the engine then saves with the order.
  async admitRevision({order,market,price,balance,environment=null}){
    return this.lock(async()=>{
      const account=baseAccount(order.accountKey);const i=await this.inputs(market,balance,{account,environment});
      const c=this.commitments(account);if(c.overCommitted)throw fail('FUNDING_OVERCOMMITTED','a broker fill exceeded what was committed; review before new buys');
      const prev=this.row(order.id),next=FundingLedger.commitment({...order,pendingRevision:{price}},prev);const delta=Math.max(0,(next?.amount??0)-(prev?.amount??0));
      if(delta>0){const check=this.check({market,cost:delta,commitments:c,inputs:i});if(!check.fits)throw fail('INSUFFICIENT_CAPACITY',check.detail);}
      if(next){this.write(next);this.event(order.id,{kind:'commitment',from:prev?.state??null,to:next.state,amount:next.amount,currency:next.currency,reason:'revision sent; the higher of the old and new prices stays committed until KIS confirms it'});}
      return {delta};});
  }
  // The capacity rule for the regime (spec F-rules). commitments: {usd, krw}; inputs: fresh balances and rate.
  check({market,cost,commitments,inputs}){
    const regime=this.regime(),{kCash,uCash,reportedKRW,rate}=inputs;const cUS=commitments.usd,cKR=commitments.krw;
    const needsRate=regime!=='separate'&&(market==='US'||cUS>0||reportedKRW>0);if(needsRate&&!(rate>0))throw fail('FX_STALE','a USD/KRW rate read within two minutes is required');
    const rho=rate>0?rate*(1+this.buffer):null,reportedUSD=rho?reportedKRW/rate:0,us=cUS+reportedUSD;
    let need,have;
    if(regime==='separate'){if(market==='US'){need=cUS+cost;have=uCash;}else{need=cKR+cost;have=kCash;}}
    else if(regime==='integrated-usd-first'){const usdShort=Math.max(0,us+(market==='US'?cost:0)-uCash);need=cKR+(market==='KR'?cost:0)+usdShort*rho;have=kCash;}
    else{need=cKR+(market==='KR'?cost:0)+(us+(market==='US'?cost:0))*rho;have=kCash;}
    const round=v=>Math.round(v*100)/100;
    return {fits:need<=have+1e-6,regime,need:round(need),have:round(have),rate,rho,commitmentsUSD:round(us),commitmentsKRW:round(cKR),detail:`needs ${round(need)} against ${round(have)} (${regime} regime)`};
  }
  // Remaining capacity for a new buy in a market, for display and tests (same rule, solved for the cost).
  capacity({account,market,inputs}){const c=this.commitments(account);const z=this.check({market,cost:0,commitments:c,inputs});const r=this.regime();
    if(r==='separate'||market==='KR')return Math.max(0,z.have-z.need);
    // U.S.: the largest d the rule admits. Unknown: (kCash − C_KR − C_US·ρ)/ρ. USD first: USD left plus KRW left at ρ.
    if(z.have<z.commitmentsKRW)return 0;
    if(r==='integrated-usd-first')return Math.max(0,inputs.uCash-z.commitmentsUSD+(z.have-z.commitmentsKRW)/z.rho);
    return Math.max(0,(z.have-z.need)/z.rho);}
  summary(account){const c=this.commitments(account);return {regime:this.regime(),commitments:{USD:c.usd,KRW:c.krw},overCommitted:c.overCommitted,rows:c.rows.map(({orderId,market,symbol,state,amount,currency,reason,pretracking,releasedUSD,underReviewUSD})=>({orderId,market,symbol,state,amount,currency,reason,pretracking,...(releasedUSD?{releasedUSD}:{}),...(underReviewUSD?{underReviewUSD}:{})}))};}
}
module.exports={FundingLedger,FX_FRESH_MS,BALANCE_FRESH_MS,BUFFER,REGIMES,ALIGNMENT_MAX_CENTS};
