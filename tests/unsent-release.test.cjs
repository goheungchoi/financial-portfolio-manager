// 2026-11-19 A(c) check (planner): endUnsent marks a refused, never-sent purchase Rejected by annotate, outside send's
// own rejection path. Nothing it leaves may stay reserved: a funding reservation made by admit is released when the
// intent becomes Rejected with nothing filled (the ledger's own rule), and a Rejected intent without a broker number is
// closed for reconcile and the ledger, never "may be at KIS".
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
test('a purchase reserved by admit and then refused before sending: Rejected by annotate leaves no open funding commitment',()=>{
  const db=new DatabaseSync(':memory:');const snap={accountKey:'acct',environment:'live',reportedTotal:1000000,cash:1000000,holdings:[]};
  const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot:snap}));const ledger=new FundingLedger(db,{fresh:async()=>snap});e.funding=ledger;
  const order={id:'P1',accountKey:'acct',market:'KR',symbol:'005930',side:'Buy',quantity:2,filled:0,status:'Ready',limitPrice:60000,notional:120000,createdAt:Date.now(),expiresAt:Date.now()+120000,costEstimate:{netCash:-120030}};
  e.writeOrder(order);
  // What admit leaves: a reservation for the submission under way (FundingLedger.commitment: Ready with prev 'reserved').
  ledger.write({orderId:'P1',account:'acct',market:'KR',currency:'KRW',symbol:'005930',state:'reserved',reason:'reserved before submission',committedQty:2,filledQty:0,remainderQty:2,amount:120030,updatedAt:Date.now()});
  assert.equal(ledger.row('P1').state,'reserved');
  e.annotate('P1',{status:'Rejected',reason:'INTEGRATED_MARGIN_AUTOMATION_BLOCKED',notSentAt:Date.now()});
  const c=ledger.row('P1');assert.equal(c.state,'released');assert.equal(c.amount,0);assert.equal(c.committedQty,0);
  assert.equal(e.orders().find(o=>o.id==='P1').brokerOrderId,undefined);});
test('every throw after admit releases the reservation first; a Rejected intent is never open or "may be at KIS"',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/live-engine.cjs'),'utf8');
  const send=src.slice(src.indexOf('  async send(id,confirmation,{automatic})'),src.indexOf("order={...order,status:'Submitting'"));
  const afterAdmit=send.slice(send.indexOf('await this.funding.admit('));
  const throws=[...afterAdmit.matchAll(/throw /g)].length,released=[...afterAdmit.matchAll(/this\.funding\?\.release\(order,/g)].length;
  assert.equal(throws,3,'three throw sites between admit and Submitting');assert.equal(released,4,'each releases first (and the approval hold too)');
  const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];assert.ok(!OPEN.includes('Rejected'));
  assert.equal(FundingLedger.commitment({id:'x',side:'Buy',status:'Rejected',filled:0,quantity:2,limitPrice:1,accountKey:'a'},{state:'reserved'}).state,'released');
  assert.equal(FundingLedger.commitment({id:'x',side:'Buy',status:'Submitting',filled:0,quantity:2,limitPrice:1,accountKey:'a'},null).state,'uncertain','only Submitting or Uncertain may be at KIS');});
