// The settlement evidence ledger (stage 2b.2; design v2 §2, v3 §2-3, v3.1 §2, v3.3). Durable and append-only where it
// matters, so evidence is used once and every change is on record:
// - settlement_events: append-only (triggers refuse updates and deletes): every piece, evidence, allocation, flag,
//   correction, conflict and citation change of the U.S. settlement tracker (electron/valuation.cjs InFlight);
// - settlement_evidence: one row per evidence version. Aggregates (U.S. cash, KIS's reported unsettled totals) are
//   identified by {account, environment, market, reading A, reading B, side, field}: they never name a fill. KIS settled
//   trade rows (K, CTOS4001R) by a content key {account, environment, market, ticker, side, trade date, quantity}, which
//   is only a matching aid (no field is assumed uncorrectable, v3.1 §2);
// - settlement_allocations: evidence consumed by a piece, checked against what is left of both in the same
//   transaction, so no remainder is used twice;
// - settlement_k_groups: K rows by content key. A group's count is the largest number of rows seen in any single
//   complete history window, never a sum across windows. A later complete window with one row where there was one and
//   different correctable fields (settlement date, price, amounts, rate, fees) is a new version; several rows, or a
//   count that changed, make the group correction-ambiguous; a key missing from a later complete window covering its
//   date is marked missing; a new key appearing for the same ticker while another went missing is a possible
//   correction, never independent evidence;
// - settlement_citations: coverage that relies on a K row (an audited reconciliation, stage 2b.3; A1 once U6 is
//   verified). A citation whose row is missing, changed key, became ambiguous, was superseded for less, or sits in a
//   trade-history gap is under review: its amount counts as unresolved again until it is re-confirmed;
// - settlement_standby: evidence that agrees with a piece already resolved, kept as standby coverage and not consumed.
// K is supporting evidence only (D2): nothing here resolves a piece from K. A1 stays disabled until U6 is verified.
const crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,24);
const cents=v=>Math.round(Number(v)*100);
const FIELDS=['settlementDate','price','grossUSD','settlementUSD','settlementKRW','feesUSD','exchangeRate'];
const correctable=r=>Object.fromEntries(FIELDS.map(k=>[k,r[k]??null]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=code=>Object.assign(new Error(code),{code});
// The U.S. trade date of an app order, as the tax ledger takes it (TradingCosts.matchedFills): the New York date of the
// order time, unless that is more than two days from the order's day.
const nyDate=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
const usTradeDate=o=>{if(Number.isFinite(o.createdAt)&&o.createdAt>0){const d=nyDate(o.createdAt);if(Math.abs(Date.parse(d)-Date.parse(o.day))<=2*86400000)return d;}return o.day;};
class SettlementEvidence{
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;
    db.exec(`CREATE TABLE IF NOT EXISTS settlement_events(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS settlement_events_no_update BEFORE UPDATE ON settlement_events BEGIN SELECT RAISE(ABORT,'settlement_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS settlement_events_no_delete BEFORE DELETE ON settlement_events BEGIN SELECT RAISE(ABORT,'settlement_events is append-only'); END;
      CREATE TABLE IF NOT EXISTS settlement_evidence(id TEXT PRIMARY KEY,evidenceId TEXT NOT NULL,version INTEGER NOT NULL,account TEXT NOT NULL,source TEXT NOT NULL,amountCents INTEGER NOT NULL,currency TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_allocations(id TEXT PRIMARY KEY,account TEXT NOT NULL,evidenceId TEXT NOT NULL,version INTEGER NOT NULL,pieceId TEXT NOT NULL,orderId TEXT,cents INTEGER NOT NULL,rule TEXT,at INTEGER NOT NULL,reversedBy TEXT);
      CREATE TABLE IF NOT EXISTS settlement_k_groups(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_citations(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_standby(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL)`);}
  // One transaction for fn: BEGIN IMMEDIATE (so another connection cannot interleave), or a savepoint inside one
  // already open. Everything fn writes commits together, or nothing does.
  tx(fn){const own=!this.db.isTransaction;this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT settlement_evidence');
    try{const r=fn();this.db.exec(own?'COMMIT':'RELEASE settlement_evidence');return r;}
    catch(error){if(own)this.db.exec('ROLLBACK');else{this.db.exec('ROLLBACK TO settlement_evidence');this.db.exec('RELEASE settlement_evidence');}throw error;}}
  event(account,kind,payload={}){this.db.prepare('INSERT INTO settlement_events(account,at,kind,payload) VALUES(?,?,?,?)').run(account,this.clock(),kind,JSON.stringify(payload));}
  events(account){return this.db.prepare('SELECT id,at,kind,payload FROM settlement_events WHERE account=? ORDER BY id').all(account).map(r=>({id:r.id,at:r.at,kind:r.kind,...JSON.parse(r.payload)}));}
  version(evidenceId,version){const r=this.db.prepare('SELECT payload,amountCents FROM settlement_evidence WHERE id=?').get(`${evidenceId}:${version}`);return r?{...JSON.parse(r.payload),amountCents:r.amountCents}:null;}
  // An aggregate (cash or a reported total) between two readings. Recorded once per identity: a second record of the
  // same movement (the fast path's remainder, say) is the same evidence, so allocations from both draw on one amount.
  aggregate({account,environment=null,market='US',readingA,readingB,side,field,amountCents,currency='USD',...detail}){
    const identity={account,environment,market,readingA:readingA??null,readingB:readingB??null,side,field},evidenceId='A'+hash(identity);
    if(!this.version(evidenceId,1)){this.db.prepare('INSERT INTO settlement_evidence VALUES(?,?,?,?,?,?,?,?)').run(`${evidenceId}:1`,evidenceId,1,account,field,amountCents,currency,JSON.stringify({identity,...detail}));this.event(account,'evidence',{evidenceId,identity,amountCents,...detail});}
    return evidenceId;}
  // A manual reconciliation's evidence (stage 2b.3): one version, the confirmed amount, allocated to its piece like any
  // other evidence. Reversing the reconciliation reverses its allocations and voids the evidence, so nothing (a
  // conflict's restoration included) can allocate from it again.
  manual({account,evidenceId,amountCents,...detail}){this.db.prepare('INSERT INTO settlement_evidence VALUES(?,?,?,?,?,?,?,?)').run(`${evidenceId}:1`,evidenceId,1,account,'M',amountCents,'USD',JSON.stringify({manual:true,...detail}));this.event(account,'evidence',{evidenceId,source:'M',amountCents,...detail});return evidenceId;}
  reverseEvidence(account,evidenceId,by){const rows=this.db.prepare('SELECT * FROM settlement_allocations WHERE evidenceId=? AND reversedBy IS NULL ORDER BY rowid').all(evidenceId);
    for(const a of rows){this.db.prepare('UPDATE settlement_allocations SET reversedBy=? WHERE id=?').run(by,a.id);this.event(account,'allocation-reversed',{allocationId:a.id,evidenceId,pieceId:a.pieceId,orderId:a.orderId,cents:a.cents,by});}
    for(const r of this.db.prepare('SELECT id,payload FROM settlement_evidence WHERE evidenceId=?').all(evidenceId))this.db.prepare('UPDATE settlement_evidence SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(r.payload),reversedBy:by}),r.id);
    return rows.map(a=>({allocationId:a.id,pieceId:a.pieceId,orderId:a.orderId,cents:a.cents}));}
  allocated(evidenceId,version){return this.db.prepare('SELECT COALESCE(SUM(cents),0) n FROM settlement_allocations WHERE evidenceId=? AND version=? AND reversedBy IS NULL').get(evidenceId,version).n;}
  allocatedToPiece(pieceId){return this.db.prepare('SELECT COALESCE(SUM(cents),0) n FROM settlement_allocations WHERE pieceId=? AND reversedBy IS NULL').get(pieceId).n;}
  allocatedToOrder(account,orderId){return this.db.prepare('SELECT COALESCE(SUM(cents),0) n FROM settlement_allocations WHERE account=? AND orderId=? AND reversedBy IS NULL').get(account,String(orderId)).n;}
  // Consumes cents of an evidence version for a piece of pieceCents in all. What is left of both is re-read inside the
  // transaction; more than either refuses the whole allocation (design v2 §2.2).
  allocate({account,evidenceId,version=1,pieceId,orderId=null,cents:c,pieceCents,rule=null}){
    return this.tx(()=>{const ev=this.version(evidenceId,version);if(!ev)throw fail('EVIDENCE_UNKNOWN');if(ev.reversedBy)throw fail('EVIDENCE_REVERSED');if(!Number.isInteger(c)||c<=0)throw fail('ALLOCATION_INVALID');
      if(this.allocated(evidenceId,version)+c>ev.amountCents)throw fail('ALLOCATION_EXCEEDS_EVIDENCE');
      if(Number.isInteger(pieceCents)&&this.allocatedToPiece(pieceId)+c>pieceCents)throw fail('ALLOCATION_EXCEEDS_PIECE');
      const id='L'+hash([evidenceId,version,pieceId,this.allocated(evidenceId,version),this.clock()]);
      this.db.prepare('INSERT INTO settlement_allocations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id,account,evidenceId,version,pieceId,orderId==null?null:String(orderId),c,rule,this.clock());
      this.event(account,'allocation',{allocationId:id,evidenceId,version,pieceId,orderId,cents:c,rule});return id;});}
  // K rows of one complete history window (start..end), from TradingCosts.importHistory. Incomplete windows never
  // arrive here: they change nothing (stage 2a).
  importK({account,environment='live',market='US'},{start,end},rows,now=this.clock()){
    return this.tx(()=>{const byKey=new Map();
      for(const r of rows??[]){const key={account,environment,market,ticker:r.ticker,side:r.side,tradeDate:r.tradeDate,quantity:r.quantity},id='K'+hash(key);
        if(!byKey.has(id))byKey.set(id,{key,rows:[]});byKey.get(id).rows.push(correctable(r));}
      // Only rows of this import's own scope: an import of another environment or market says nothing about them
      // (review of 4b534c1, P2: an empty mock import marked a live row missing).
      const groups=this.kGroups(account).filter(g=>g.key.environment===environment&&g.key.market===market),inWindow=g=>g.key.tradeDate>=start&&g.key.tradeDate<=end;const missingNow=[];
      // Keys missing from this complete window that covers their date.
      for(const g of groups)if(inWindow(g)&&!byKey.has(g.id)&&g.missingSince==null){g.missingSince=now;missingNow.push(g);this.putGroup(g);this.event(account,'k-missing',{groupId:g.id,key:g.key});}
      for(const [id,{key,rows:list}] of byKey){let g=groups.find(x=>x.id===id);const n=list.length;
        if(!g){g={id,key,count:n,state:n===1?'single':'uncertain',versions:[],members:list,firstSeen:now};
          // A possible correction of any row of the same ticker still missing, whenever it went missing (review of
          // 4b534c1, P1: a replacement arriving an import after the row disappeared became independent evidence).
          const replaces=groups.filter(m=>m.missingSince!=null&&m.key.ticker===key.ticker);if(replaces.length){g.state='possible correction';g.possibleCorrectionOf=replaces.map(m=>m.id);}
          if(n===1)this.addVersion(g,list[0]);this.putGroup(g);this.event(account,'k-group',{groupId:id,key,count:n,state:g.state,...(g.possibleCorrectionOf?{possibleCorrectionOf:g.possibleCorrectionOf}:{})});continue;}
        const was=g.state;if(g.missingSince!=null){this.event(account,'k-seen-again',{groupId:id});delete g.missingSince;}
        if(n!==g.count||n>1||g.state==='uncertain'){if(g.state==='single'&&(n!==g.count||n>1))g.state='correction-ambiguous';g.count=Math.max(g.count,n);g.members=list;}
        else if(g.state==='single'&&!same(g.versions.at(-1).fields,list[0]))this.addVersion(g,list[0]);
        g.lastSeen=now;this.putGroup(g);if(g.state!==was)this.event(account,'k-state',{groupId:id,from:was,to:g.state});}
      return {groups:byKey.size,missing:missingNow.length};});}
  // Reduces the active allocations of an order by cents, latest first: each is marked reversed, and replaced by one for
  // what is left of it. Returns what was released, per evidence version and piece, so it can be restored.
  reduceAllocations(account,orderId,c,reason){const out=[];let left=c;
    for(const a of this.db.prepare('SELECT * FROM settlement_allocations WHERE account=? AND orderId=? AND reversedBy IS NULL ORDER BY at DESC,rowid DESC').all(account,String(orderId))){if(left<=0)break;
      const take=Math.min(a.cents,left);left-=take;const by='R'+hash([a.id,take,this.clock()]);this.db.prepare('UPDATE settlement_allocations SET reversedBy=? WHERE id=?').run(by,a.id);
      if(take<a.cents)this.db.prepare('INSERT INTO settlement_allocations VALUES(?,?,?,?,?,?,?,?,?,NULL)').run('L'+hash([a.id,'rest',take,this.clock()]),account,a.evidenceId,a.version,a.pieceId,a.orderId,a.cents-take,a.rule,this.clock());
      this.event(account,'allocation-reduced',{allocationId:a.id,orderId:String(orderId),evidenceId:a.evidenceId,version:a.version,pieceId:a.pieceId,cents:take,reason});out.push({evidenceId:a.evidenceId,version:a.version,pieceId:a.pieceId,cents:take});}
    return out;}
  addVersion(g,fields){const v=g.versions.length+1,prev=g.versions.at(-1);if(prev)prev.supersededBy=v;g.versions.push({version:v,fields,at:this.clock()});
    this.db.prepare('INSERT INTO settlement_evidence VALUES(?,?,?,?,?,?,?,?)').run(`${g.id}:${v}`,g.id,v,g.key.account,'K',cents(fields.settlementUSD??fields.grossUSD??0),'USD',JSON.stringify({key:g.key,fields}));
    this.event(g.key.account,v===1?'k-row':'k-version',{groupId:g.id,version:v,fields});}
  putGroup(g){this.db.prepare('INSERT INTO settlement_k_groups VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(g.id,g.key.account,JSON.stringify(g));}
  kGroups(account){return this.db.prepare('SELECT payload FROM settlement_k_groups WHERE account=?').all(account).map(r=>JSON.parse(r.payload));}
  // Whether a group is independent evidence now: one row in every complete window, not missing, not ambiguous, not a
  // possible correction, and its date not in a trade-history gap (stage 2a).
  independent(g){return g&&g.state==='single'&&g.count===1&&g.missingSince==null&&!this.inGap(g);}
  inGap(g){const {HistoryGaps}=require('./trade-history.cjs'),{ownerAccount}=require('./tax-profile.cjs');return new HistoryGaps(this.db).list(ownerAccount(g.key.account)).some(x=>x.start<=g.key.tradeDate&&x.end>=g.key.tradeDate);}
  // K rows matched to the app's U.S. orders (live, filled): linked only when exactly one app order and exactly one K
  // row share the content key, and that row is independent evidence; otherwise uncertain, with the reason. A link is
  // supporting evidence only: it is shown, and it resolves nothing (A1 off).
  links(account,orders){const groups=this.kGroups(account),out=new Map(),key=o=>JSON.stringify([String(o.symbol).split(':').pop(),o.side,usTradeDate(o),o.filled]);
    const live=orders.filter(o=>o.environment!=='mock'&&o.filled>0&&['Buy','Sell'].includes(o.side)),counts=new Map();for(const o of live)counts.set(key(o),(counts.get(key(o))??0)+1);
    // Only rows of the order's own environment and market (scope, design v2 §2.1).
    for(const o of live){const g=groups.find(x=>x.key.environment===(o.environment??'live')&&x.key.market==='US'&&JSON.stringify([x.key.ticker,x.key.side,x.key.tradeDate,x.key.quantity])===key(o));
      out.set(String(o.id),!g?{state:'none'}:counts.get(key(o))>1?{state:'uncertain',groupId:g.id,reason:'several app orders share the KIS row\'s ticker, side, date and quantity'}:!this.independent(g)?{state:'uncertain',groupId:g.id,reason:this.why(g)}:{state:'linked',groupId:g.id,version:g.versions.at(-1).version,fields:g.versions.at(-1).fields});}
    return out;}
  why(g){return g.missingSince!=null?'the row is missing from a later complete history window':g.state==='possible correction'?'a possible correction of a row that disappeared':g.state==='correction-ambiguous'?'its rows changed in a way that cannot be linked with certainty':g.count>1?`${g.count} identical rows in one window`:this.inGap(g)?'its date is in a trade-history gap':'not independent';}
  // Coverage relying on a K row (stage 2b.3 records; A1 later). Tests and the reconciliation call this.
  // Citations of one row together never exceed what it says (CITATION_EXCEEDS_ROW).
  cite({account,groupId,version,orderId,side,cents:c,rule}){const id='C'+hash([account,groupId,version,orderId,c,this.clock()]);const row={id,account,groupId,version,orderId:String(orderId),side,cents:c,rule,at:this.clock()};
    return this.tx(()=>{const v=this.version(groupId,version);if(!v)throw fail('CITATION_TARGET_UNKNOWN');
      if(this.citations(account).filter(x=>x.groupId===groupId).reduce((n,x)=>n+x.cents,0)+c>v.amountCents)throw fail('CITATION_EXCEEDS_ROW');this.db.prepare('INSERT INTO settlement_citations VALUES(?,?,?)').run(id,account,JSON.stringify(row));this.event(account,'citation',row);return id;});}
  // Active citations (a reversed reconciliation's citation no longer covers anything); all: every one, for the record.
  citations(account,{all=false}={}){return this.db.prepare('SELECT payload FROM settlement_citations WHERE account=?').all(account).map(r=>JSON.parse(r.payload)).filter(c=>all||!c.reversedBy);}
  reverseCitation(account,id,by){const r=this.db.prepare('SELECT payload FROM settlement_citations WHERE id=?').get(id);if(!r)return;this.db.prepare('UPDATE settlement_citations SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(r.payload),reversedBy:by}),id);this.event(account,'citation-reversed',{id,by});}
  // Re-confirms a citation against the group's current version (or another group), after review. Confirming against a
  // possible correction is the manual link that makes it a row of its own (v3.1 §2); an ambiguous group or one with
  // several rows cannot be confirmed.
  confirm(id,{groupId,version}){return this.tx(()=>{const r=this.db.prepare('SELECT account,payload FROM settlement_citations WHERE id=?').get(id);if(!r)throw fail('CITATION_UNKNOWN');
    const g=this.kGroups(r.account).find(x=>x.id===groupId);if(!g||!g.versions.some(v=>v.version===version))throw fail('CITATION_TARGET_UNKNOWN');if(g.state==='correction-ambiguous'||g.state==='uncertain'||g.count!==1)throw fail('CITATION_TARGET_AMBIGUOUS');
    if(g.state==='possible correction'){g.state='single';g.linkedManually={citationId:id,at:this.clock()};this.putGroup(g);this.event(r.account,'k-linked-manually',{groupId,citationId:id});}
    const row={...JSON.parse(r.payload),groupId,version,confirmedAt:this.clock()};this.db.prepare('UPDATE settlement_citations SET payload=? WHERE id=?').run(JSON.stringify(row),id);this.event(r.account,'citation-confirmed',{id,groupId,version});return row;});}
  // Citations whose K row no longer holds: the amount not covered counts as unresolved again. All citations of one row
  // are checked together against its current version (review of 4b534c1, P1: $60 and $40 each compared with a row
  // corrected to $97 stayed covered): the shortfall goes under review, newest citations first. A row that is not
  // independent evidence puts every citation of it under review.
  underReview(account){const out=[];const groups=new Map(this.kGroups(account).map(g=>[g.id,g])),byRow=new Map();
    for(const c of this.citations(account)){if(!byRow.has(c.groupId))byRow.set(c.groupId,[]);byRow.get(c.groupId).push(c);}
    for(const [groupId,list] of byRow){const g=groups.get(groupId),total=list.reduce((n,c)=>n+c.cents,0);let reason=null,short=0;
      if(!g){reason='the cited row is unknown';short=total;}else if(!this.independent(g)){reason=this.why(g);short=total;}
      else{const amount=cents(g.versions.at(-1).fields.settlementUSD??g.versions.at(-1).fields.grossUSD??0);if(total>amount){short=total-amount;reason=`the cited row was corrected to $${(amount/100).toFixed(2)}; its citations total $${(total/100).toFixed(2)}`;}}
      for(const c of [...list].sort((a,b)=>b.at-a.at||(a.id<b.id?1:-1))){if(short<=0)break;const part=Math.min(short,c.cents);short-=part;out.push({citationId:c.id,orderId:c.orderId,side:c.side,usd:part/100,reason});}}
    return out;}
  // Evidence that agrees with a piece another record already resolved: kept, not consumed (design v3 §6).
  standby({account,evidenceId,version,pieceId,cents:c}){const id='S'+hash([evidenceId,version,pieceId]);const row={id,account,evidenceId,version,pieceId,cents:c,at:this.clock()};
    return this.tx(()=>{if(this.db.prepare('SELECT id FROM settlement_standby WHERE id=?').get(id))return id;this.db.prepare('INSERT INTO settlement_standby VALUES(?,?,?)').run(id,account,JSON.stringify(row));this.event(account,'standby',row);return id;});}
  standbyFor(pieceId){return this.db.prepare('SELECT payload FROM settlement_standby').all().map(r=>JSON.parse(r.payload)).filter(s=>s.pieceId===pieceId).map(s=>({...s,promotedCents:(s.promoted??[]).reduce((n,p)=>n+p.cents,0)}));}
  // Standby coverage consumed when the record it agreed with is reversed (design v3 §6): the part promoted, and by which
  // reversal. A standby is promoted at most up to its amount.
  promote(account,id,c,by){const r=this.db.prepare('SELECT payload FROM settlement_standby WHERE id=?').get(id);const s=JSON.parse(r.payload);s.promoted=[...(s.promoted??[]),{cents:c,by,at:this.clock()}];
    this.db.prepare('UPDATE settlement_standby SET payload=? WHERE id=?').run(JSON.stringify(s),id);this.event(account,'standby-promoted',{id,pieceId:s.pieceId,evidenceId:s.evidenceId,version:s.version,cents:c,by});}
}
module.exports={SettlementEvidence,usTradeDate};
