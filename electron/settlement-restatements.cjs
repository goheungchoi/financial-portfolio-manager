'use strict';
// Stage 3.3. Historical interpretations are overlays, never edits to nav_history.
// A candidate needs a payment interval wholly contained in one recorded day and
// a later reconciliation. Approval is bound to the evidence and the actual preview.
const {createHash,randomUUID}=require('node:crypto');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
function paymentDateInterval(day){
  const midnight=d=>{
    // 05:00 UTC is before either New York clock transition; noon is not.
    const offset=/GMT([+-]\d+)/.exec(new Date(d+'T05:00:00Z').toLocaleString('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}));
    const h=offset?Number(offset[1]):-5,zone=(h<0?'-':'+')+String(Math.abs(h)).padStart(2,'0')+':00';
    return Date.parse(d+'T00:00:00'+zone);
  };
  const next=new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  return [midnight(day),midnight(next)-1];
}
class SettlementRestatements {
  constructor(db,{inFlight,reconciliation,performance,corrections,clock=Date.now}){
    Object.assign(this,{db,inFlight,reconciliation,performance,corrections,clock});
    db.exec(`CREATE TABLE IF NOT EXISTS valuation_settlement_approvals(id TEXT PRIMARY KEY,account TEXT NOT NULL,requestId TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(account,requestId));
      CREATE TRIGGER IF NOT EXISTS valuation_settlement_approvals_no_update BEFORE UPDATE ON valuation_settlement_approvals BEGIN SELECT RAISE(ABORT,'historical approvals are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS valuation_settlement_approvals_no_delete BEFORE DELETE ON valuation_settlement_approvals BEGIN SELECT RAISE(ABORT,'historical approvals are append-only'); END;`);
    corrections.approvals=(account,rows)=>this.inForce(account,rows);
  }
  records(account){return this.db.prepare('SELECT payload FROM valuation_settlement_approvals WHERE account=? ORDER BY rowid').all(account).map(r=>JSON.parse(r.payload));}
  candidates(account,rows=this.performance.history(account)){
    const events=this.inFlight.evidence.events(account),timing=this.corrections.resolved(account),review=this.inFlight.evidence.underReview(account);
    const out=[];
    for(const r of this.reconciliation.active(account)){
      if(r.side!=='Buy'||r.explanation==='rounding')continue;
      const end=rows.findIndex(d=>d.at>=r.confirmedAt);if(end<1)continue;
      const flow=r.effects?.flows?.original,res=timing.filter(t=>t.candidate===r.id).at(-1);
      let interval=null,source=null;
      if(flow&&Number.isFinite(flow.occurredAfter)&&Number.isFinite(flow.occurredBy)){interval=[flow.occurredAfter,flow.occurredBy];source='reclassified flow';}
      else if(res?.paidHere&&Number.isFinite(res.entry?.after)&&Number.isFinite(res.entry?.by)){interval=[res.entry.after,res.entry.by];source='confirmed payment interval';}
      else if(r.settledOn){
        // Use the New York calendar date, including DST, rather than Seoul midnight.
        interval=paymentDateInterval(r.settledOn);source='audited settlement date';
      }
      if(!interval||!interval.every(Number.isFinite)||interval[0]>interval[1])continue;
      const start=rows.findIndex((d,i)=>i>0&&interval[0]>rows[i-1].at&&interval[1]<=d.at);
      if(start<1||start>=end||review.some(x=>String(x.orderId)===String(r.orderId)))continue;
      const opening=events.find(e=>e.kind==='piece-opened'&&e.pieceId===r.pieceId);
      if(!opening||opening.at>interval[0])continue;
      const days=rows.slice(start,end).map(d=>d.day),usd=r.cents/100;
      const core={reconciliationId:r.id,pieceId:r.pieceId,orderId:r.orderId,usd,days,paymentDay:rows[start].day,resolutionDay:rows[end].day,interval,source};
      // Later readings outside the historical window do not invalidate approval.
      // Changes to its source record, evidence, flows or recorded values do.
      const citations=this.inFlight.evidence.citations(account).filter(c=>String(c.orderId)===String(r.orderId));
      const groups=this.inFlight.evidence.kGroups(account).filter(g=>citations.some(c=>c.groupId===g.id)).map(({lastSeen,firstSeen,...g})=>g);
      const reviewEvents=events.filter(e=>e.kind==='review-changed'&&[...(e.before??[]),...(e.after??[])].some(x=>String(x.orderId)===String(r.orderId)));
      const fingerprint=hash({core,record:r,rows:rows.slice(start-1,end+1),citations,groups,reviewEvents});
      out.push({...core,id:r.id,fingerprint,label:'if approved',adjustments:days.map(day=>({day,market:'US',currency:'USD',amount:usd}))});
    }
    return out;
  }
  inForce(account,rows){const candidates=new Map(this.candidates(account,rows).map(c=>[c.id,c]));const seen=new Set();return this.records(account).filter(r=>{const c=candidates.get(r.candidate.id);if(!c||c.fingerprint!==r.candidate.fingerprint||seen.has(c.id))return false;seen.add(c.id);return true;}).map(r=>r.candidate);}
  insert(account,requestId,candidate,approval,binding,preview=null){const record={id:randomUUID(),version:this.records(account).length+1,account,requestId,candidate,approval,binding,preview,approvedAt:this.clock()};this.db.prepare('INSERT INTO valuation_settlement_approvals VALUES(?,?,?,?)').run(record.id,account,requestId,JSON.stringify(record));return record;}
  preview(account,candidateId){
    const candidate=this.candidates(account).find(c=>c.id===candidateId);if(!candidate)throw fail('HISTORICAL_TIMING_UNPROVEN');
    if(this.inForce(account).some(c=>c.id===candidateId))throw fail('HISTORICAL_ALREADY_APPROVED');
    const summarize=()=>Object.fromEntries(['USD','COMBINED','KRW'].map(k=>[k,this.performance.summary(account,k,null)]));
    const before=summarize();let after;
    this.db.exec('SAVEPOINT historical_preview');try{this.insert(account,'preview:'+randomUUID(),candidate,{by:'preview'},null);after=summarize();}
    finally{this.db.exec('ROLLBACK TO historical_preview');this.db.exec('RELEASE historical_preview');}
    const binding=hash({account,candidate,before,after,records:this.records(account),events:this.inFlight.evidence.events(account)});
    return {account,candidate,before,after,binding,label:'if approved',written:false};
  }
  approve({account,candidateId,requestId,binding,approval}){
    if(!requestId||typeof requestId!=='string'||!binding)throw fail('PREVIEW_REQUIRED');
    if(!approval||typeof approval.by!=='string'||!approval.by.trim()||typeof approval.note!=='string'||!approval.note.trim())throw fail('APPROVAL_REQUIRED');
    if(this.db.isTransaction)throw fail('HISTORICAL_TRANSACTION_ACTIVE');
    this.db.exec('BEGIN IMMEDIATE');try{
      const old=this.records(account).find(r=>r.requestId===requestId);
      if(old){if(old.candidate.id!==candidateId||old.binding!==binding||JSON.stringify(old.approval)!==JSON.stringify(approval))throw fail('REQUEST_REUSED');this.db.exec('COMMIT');return old;}
      const p=this.preview(account,candidateId);if(p.binding!==binding)throw fail('PREVIEW_MISMATCH');
      const record=this.insert(account,requestId,p.candidate,approval,binding,{before:p.before,after:p.after});this.db.exec('COMMIT');return record;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}
module.exports={SettlementRestatements,paymentDateInterval};
