// Typed position effects and credit paths (audit 2026-11-04, Stage 3).
const test=require('node:test');const assert=require('node:assert/strict');const C=require('../electron/credit-paths.cjs');
// One symbol held three ways: 4 cash shares, margin loans of 3 (2026-10-01) and 2 (2026-10-15); and two shorts of another.
const balance={holdings:[{symbol:'005930',quantity:9,availableQuantity:9,loans:[{quantity:3,loanDate:'2026-10-01',availableQuantity:3,source:'self'},{quantity:2,loanDate:'2026-10-15',availableQuantity:2,source:'distribution'}]}],
  shorts:[{symbol:'000660',quantity:5,loanDate:'2026-10-02',availableQuantity:5,source:'self'},{symbol:'000660',quantity:1,loanDate:'2026-10-20',availableQuantity:1,source:'self'}]};
test('every order has one position effect; a side its credit kind does not have is refused',()=>{
  assert.deepEqual(C.effectOf({side:'Buy'}),{effect:'OPEN_LONG',kind:'none',funding:'CASH',opening:true});assert.equal(C.effectOf({side:'Sell'}).effect,'CLOSE_LONG');
  assert.equal(C.effectOf({side:'Buy',credit:{kind:'margin-buy'}}).funding,'MARGIN');assert.equal(C.effectOf({side:'Sell',credit:'margin-sell'}).effect,'CLOSE_LONG');
  assert.deepEqual(C.effectOf({side:'Sell',credit:{kind:'short'}}),{effect:'OPEN_SHORT',kind:'short',funding:'SHORT',opening:true});assert.equal(C.effectOf({side:'Buy',credit:{kind:'cover'}}).opening,false);
  for(const [side,kind] of [['Buy','short'],['Sell','cover'],['Sell','margin-buy'],['Buy','margin-sell'],['Buy','other']])assert.throws(()=>C.effectOf({side,credit:{kind}}),/INVALID_ORDER/,`${side} ${kind}`);
});
test('lots are kept apart: cash shares, each margin loan and each short by its loan date',()=>{
  const l=C.lots(balance,'005930');assert.deepEqual(l.cash,{quantity:4,available:4});assert.deepEqual(l.margin.map(m=>[m.loanDate,m.quantity]),[['2026-10-01',3],['2026-10-15',2]]);
  assert.deepEqual(C.lots(balance,'000660').short.map(s=>[s.loanDate,s.quantity]),[['2026-10-02',5],['2026-10-20',1]]);assert.deepEqual(C.lots(balance,'035420'),{cash:{quantity:0,available:0},margin:[],short:[]});
});
test('a closing order takes only what remains in its own lot after orders already waiting on it: never a flip',()=>{
  assert.equal(C.check(balance,{symbol:'005930',side:'Sell',quantity:4}).available,4);assert.throws(()=>C.check(balance,{symbol:'005930',side:'Sell',quantity:5}),/EXCEEDS_LOT/,'a cash sale cannot take loan shares');
  assert.equal(C.check(balance,{symbol:'005930',side:'Sell',quantity:3,credit:{kind:'margin-sell',loanDate:'2026-10-01'}}).lot.loanDate,'2026-10-01');
  assert.throws(()=>C.check(balance,{symbol:'005930',side:'Sell',quantity:3,credit:{kind:'margin-sell',loanDate:'2026-10-15'}}),/EXCEEDS_LOT/,'that loan has 2');
  assert.throws(()=>C.check(balance,{symbol:'005930',side:'Sell',quantity:1,credit:{kind:'margin-sell',loanDate:'2026-09-01'}}),/NO_SUCH_LOT/);
  assert.throws(()=>C.check(balance,{symbol:'000660',side:'Buy',quantity:6,credit:{kind:'cover',loanDate:'2026-10-02'}}),/EXCEEDS_LOT/,'a cover cannot buy past its short into a long');
  // Reservations: a sale of 3 cash shares waiting (1 filled) leaves 2; a waiting margin repayment reserves only its lot.
  const orders=[{symbol:'005930',side:'Sell',quantity:3,filled:1,status:'Partially filled'},{symbol:'005930',side:'Sell',quantity:1,status:'Accepted',credit:{kind:'margin-sell',loanDate:'2026-10-01'}},{symbol:'005930',side:'Sell',quantity:9,status:'Filled'},{symbol:'005930',side:'Buy',quantity:9,status:'Accepted'}];
  const r=C.remaining(balance,{symbol:'005930',side:'Sell'},orders);assert.deepEqual([r.available,r.reserved],[2,2]);
  assert.equal(C.remaining(balance,{symbol:'005930',side:'Sell',credit:{kind:'margin-sell',loanDate:'2026-10-01'}},orders).available,2);assert.equal(C.remaining(balance,{symbol:'005930',side:'Buy'},orders),null,'an opening has no lot');
  // Partial fills: KIS's balance already shows the shares sold; only the unfilled part of a waiting order is reserved.
  const after={...balance,holdings:[{...balance.holdings[0],quantity:8,availableQuantity:8}]};assert.equal(C.remaining(after,{symbol:'005930',side:'Sell'},[{symbol:'005930',side:'Sell',quantity:3,filled:1,status:'Partially filled'}]).available,1);
});
test('credit paths: unconfirmed execution fields block submission even with approval; openings are never automatic',()=>{
  assert.deepEqual(C.pathStatus('none'),{executable:true,automatic:true});
  const repay=C.pathStatus('margin-sell');assert.equal(repay.executable,true);assert.equal(repay.automatic,false,'before the user approves Stage 3');assert.equal(repay.label,C.PROTECTION_LABEL);
  assert.equal(C.pathStatus('margin-sell',{approved:true}).automatic,true);assert.equal(C.pathStatus('margin-sell',{approved:true}).label,undefined);
  for(const kind of ['short','cover','margin-buy']){const s=C.pathStatus(kind,{approved:true});assert.equal(s.executable,false,kind);assert.equal(s.automatic,false);assert.ok(s.reason,kind);}
  assert.equal(C.pathStatus('short').label,C.OPENINGS_LABEL);assert.equal(C.pathStatus('cover').label,C.PROTECTION_LABEL);assert.match(C.pathStatus('cover').reason,/U2/);assert.match(C.pathStatus('short').reason,/U1.*U3/);
  assert.equal(C.stopSide('OPEN_SHORT'),'above');assert.equal(C.stopSide('OPEN_LONG'),'below');
});
test('a proposal never sent stops reserving shares once it has expired',()=>{
  const b={holdings:[{symbol:'005930',quantity:3,availableQuantity:3}]};const waiting={symbol:'005930',side:'Sell',quantity:3,status:'Ready',expiresAt:Date.now()+60000};
  assert.equal(C.remaining(b,{symbol:'005930',side:'Sell'},[waiting]).available,0);assert.equal(C.remaining(b,{symbol:'005930',side:'Sell'},[{...waiting,expiresAt:Date.now()-1}]).available,3);
});
// The three cover defects the audit reproduced (Stage 0 repro: cover-needs-buy-plan, cover-plan-arms-sell-stop,
// cover-blocked-by-loss-halt), and an opening short's own plan rules.
test('a cover needs no long-entry plan; a short sale needs the full plan; a margin repayment is a plain sale',()=>{
  const {validateDecision}=require('../electron/ai-client.cjs');const d=(x)=>validateDecision({symbol:'005930',quantity:1,explanation:'x',loanDate:'',...x},['005930'],{requirePlan:true});
  assert.equal(d({action:'Buy',credit:'cover',loanDate:'2026-10-01'}).action,'Buy','a minimal cover is kept');
  const short=d({action:'Sell',credit:'short'});assert.equal(short.action,'Hold');assert.match(short.explanation,/held back a short sale/);
  assert.equal(d({action:'Sell',credit:'margin-sell',loanDate:'2026-09-01'}).action,'Sell');assert.equal(d({action:'Buy',credit:'none'}).action,'Hold','a cash Buy still needs its plan');
});
test('reviews: a cover is not blocked by the loss limit and arms no Sell stop; unconfirmed credit paths are drafts',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.match(src,/if\(opening&&lossBreached&&this\.config\.lossAction!=='review'\)/,'the loss block tests an opening, not action Buy');
  assert.match(src,/result\.decision\.action==='Buy'&&\(result\.decision\.credit\?\?'none'\)==='none'&&result\.decision\.plan&&context\.env/,'only a cash long entry arms a plan stop');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const armed=[];a.desk.setOrder=(...x)=>{armed.push(x);return {status:'armed'};};a.config.conditionalOrders=true;
  a.followPlan('kis:a',{action:'Buy',symbol:'005930',quantity:1,credit:'none',plan:{thesis:'t',invalidation:'i',stopPrice:90,horizonDays:5,confidence:'low'}},'R');assert.equal(armed.at(-1)[1].side,'Sell');
});
test('outcomes keep credit identity: a short opening is an entry, a cover needs its lot, an unknown lot is no evidence',()=>{
  const {OutcomeLedger}=require('../electron/outcome-ledger.cjs');const {evaluate}=require('../electron/outcome-evaluation.cjs');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL)');const put=(id,x)=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(id,'acct',JSON.stringify({id,accountKey:'acct',environment:'live',market:'KR',currency:'KRW',symbol:'005930',status:'Filled',quantity:1,filled:1,fillPrice:60000,resultCosts:{gross:60000,commission:9,transactionTax:120,netCash:59871,gainAfterFees:500,basis:'broker'},...x}));
  put('S1',{side:'Sell',credit:{kind:'short',type:'22',loanDate:'2026-10-01'}});put('C1',{side:'Buy',credit:{kind:'cover',type:'28',loanDate:'2026-10-01'}});put('M1',{side:'Sell',credit:{kind:'margin-sell',type:'27'}});put('P1',{side:'Sell'});
  new OutcomeLedger(db).sync();const out=id=>JSON.parse(db.prepare('SELECT payload FROM trade_outcomes WHERE id=?').get('broker:'+id).payload);
  const s=out('S1');assert.deepEqual(s.credit,{kind:'short',type:'22',loanDate:'2026-10-01'});assert.equal(s.effect,'OPEN_SHORT');assert.equal(s.assessment.category,'entry');assert.equal(s.assessment.eligible,false,'no opening-sale reflection');
  const c=out('C1');assert.equal(c.assessment.effect,'CLOSE_SHORT');assert.equal(c.assessment.category,'data-gap');assert.match(c.assessment.gaps[0],/proceeds of the covered lot/);
  assert.equal(out('M1').effect,'unknown','a repayment without its loan date is not guessed');assert.match(out('M1').assessment.gaps[0],/identity unknown/);
  const p=out('P1');assert.equal(p.effect,'CLOSE_LONG');assert.equal(p.assessment.eligible,true);assert.equal(evaluate({side:'Sell',status:'Filled',quantity:1,netCash:100,gainAfterFees:10,fees:1,averagePrice:1,reviewId:'r'}).effect,'CLOSE_LONG','older cash records stay sales');
  db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER)');const {LearningMemory}=require('../electron/learning-memory.cjs');const m=new LearningMemory(db);m.sync();const ids=db.prepare('SELECT id FROM lesson_evidence').all().map(r=>r.id);
  assert.ok(ids.includes('outcome:broker:P1'));assert.ok(!ids.includes('outcome:broker:S1'),'a short opening never becomes lesson evidence');assert.ok(!ids.includes('outcome:broker:M1'));
});
