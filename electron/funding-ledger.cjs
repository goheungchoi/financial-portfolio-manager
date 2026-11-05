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
const FX_FRESH_MS=2*60000,BALANCE_FRESH_MS=2*60000,BUFFER=0.02,FALLBACK_FEE=0.01;
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
  // Commitments of an account in each currency.
  commitments(account){const rows=this.rows(account).filter(c=>c.state!=='released');const sum=m=>rows.filter(c=>c.market===m).reduce((n,c)=>n+c.amount,0);
    return {usd:Math.round(sum('US')*100)/100,krw:Math.round(sum('KR')),overCommitted:rows.some(c=>c.overCommitted),rows};}
  // One at a time: fresh balances, the check and the durable reservation.
  lock(fn){const run=this.queue.then(fn,fn);this.queue=run.catch(()=>{});return run;}
  // The balances and rate a check needs, each fresh. own: the balance the engine just read for its market.
  async inputs(market,own){
    const now=this.clock();const fresh=async m=>m===market&&own?own:(this.fresh?await this.fresh(m):null);const kr=await fresh('KR'),us=await fresh('US');
    const t=b=>{const x=Date.parse(b?.timestamp??'');return Number.isFinite(x)?x:null;};
    if(!kr||!(now-(t(kr)??-Infinity)<=BALANCE_FRESH_MS))throw fail('FUNDING_BALANCE_STALE','a Korean balance read within two minutes is required');
    if(us&&!(now-(t(us)??-Infinity)<=BALANCE_FRESH_MS))throw fail('FUNDING_BALANCE_STALE','a U.S. balance read within two minutes is required');
    const kCash=Math.min(kr.cash,Number.isFinite(kr.settledCash)?kr.settledCash:kr.cash);if(!Number.isFinite(kCash))throw fail('FUNDING_BALANCE_STALE','Korean cash is unknown');
    const fxOf=v=>{const ts=typeof v?.timestamp==='number'?v.timestamp:Date.parse(v?.timestamp??'');return v?.usdKRW>0&&Number.isFinite(ts)&&now-ts<=FX_FRESH_MS?v.usdKRW:null;};
    const rate=fxOf(us?.fx)??fxOf(this.fxSource?.()??null);
    return {kCash,uCash:us&&Number.isFinite(us.cash)?us.cash:0,reportedKRW:Math.max(0,Number(us?.unsettled?.buyKRW)||0),rate,kr,us};
  }
  // Whether a buy costing cost (its currency) fits, and if it does, its durable reservation. Throws when it does not.
  async admit({order,market,cost,balance}){
    return this.lock(async()=>{
      const account=baseAccount(order.accountKey),c=this.commitments(account);if(c.overCommitted)throw fail('FUNDING_OVERCOMMITTED','a broker fill exceeded what was committed; review before new buys');
      const i=await this.inputs(market,balance);const check=this.check({market,cost,commitments:c,inputs:i});if(!check.fits)throw fail('INSUFFICIENT_CAPACITY',check.detail);
      const prev=this.row(order.id);const reserved={...FundingLedger.commitment({...order,status:'Submitting'},prev),state:'reserved',reason:'reserved before submission'};
      this.write(reserved);this.event(order.id,{kind:'commitment',from:prev?.state??null,to:'reserved',amount:reserved.amount,currency:reserved.currency,check});return check;});
  }
  // A revision raising the price of an open buy: the increase is checked and reserved under the lock before the
  // revision is sent. pendingRevision is the marker the engine then saves with the order.
  async admitRevision({order,market,price,balance}){
    return this.lock(async()=>{
      const account=baseAccount(order.accountKey),c=this.commitments(account);if(c.overCommitted)throw fail('FUNDING_OVERCOMMITTED','a broker fill exceeded what was committed; review before new buys');
      const prev=this.row(order.id),next=FundingLedger.commitment({...order,pendingRevision:{price}},prev);const delta=Math.max(0,(next?.amount??0)-(prev?.amount??0));
      if(delta>0){const i=await this.inputs(market,balance);const check=this.check({market,cost:delta,commitments:c,inputs:i});if(!check.fits)throw fail('INSUFFICIENT_CAPACITY',check.detail);}
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
  summary(account){const c=this.commitments(account);return {regime:this.regime(),commitments:{USD:c.usd,KRW:c.krw},overCommitted:c.overCommitted,rows:c.rows.map(({orderId,market,symbol,state,amount,currency,reason,pretracking})=>({orderId,market,symbol,state,amount,currency,reason,pretracking}))};}
}
module.exports={FundingLedger,FX_FRESH_MS,BALANCE_FRESH_MS,BUFFER,REGIMES};
