// Short selling B3d-3 part 2: a covered short's realized result, with its costs (short-result.cjs, the outcome ledger,
// the evaluation). Made-up codes, prices and figures.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {shortResult,interestDays}=require('../electron/short-result.cjs');
const costs=(commission,transactionTax,basis='estimate')=>({commission,transactionTax,basis,capitalGainsTaxKRW:0});
const SHORT={id:'S1',accountKey:'acct',symbol:'990010',side:'Sell',credit:{kind:'short'},filled:10,quantity:10,fillPrice:1000,day:'2026-09-01',lotLoanDate:'2026-09-03',borrowFeePct:5,resultCosts:costs(15,20),status:'Filled',createdAt:1};
const COVER={id:'C1',accountKey:'acct',symbol:'990010',side:'Buy',credit:{kind:'cover',loanDate:'2026-09-03'},filled:10,quantity:10,fillPrice:900,day:'2026-09-11',resultCosts:costs(14,0),status:'Filled',createdAt:2};
test('realized = proceeds - buy-back - sale fees and tax - cover fees - borrow interest (estimated at the short\'s own rate)',()=>{
  const r=shortResult(COVER,[SHORT,COVER]);
  // 10 days at 5% on 10,000: 13.7, rounded 14.
  assert.deepEqual(r.interest,{amount:14,basis:'estimate',pct:5,days:10});
  assert.deepEqual([r.shortProceeds,r.buyBack,r.saleCharges,r.coverCharges,r.beforeCharges,r.realized,r.costBasis],[10000,9000,35,14,1000,10000-9000-35-14-14,'estimated']);
  assert.deepEqual(r.gaps,[]);
  assert.equal(interestDays('2026-09-01','2026-09-01'),1,'a same-day cover: one day');assert.equal(interestDays('2026-09-01','2026-09-02'),1);assert.equal(interestDays('2026-09-01','2026-09-04'),3);
});
test('two covers of one lot: each its share of the proceeds and the sale\'s charges, in order; together the whole',()=>{
  const a={...COVER,id:'C1',filled:4,quantity:4,createdAt:2},b={...COVER,id:'C2',filled:6,quantity:6,createdAt:3,fillPrice:950};
  const ra=shortResult(a,[SHORT,a,b]),rb=shortResult(b,[SHORT,a,b]);
  assert.deepEqual([ra.shortProceeds,ra.saleCharges,rb.shortProceeds,rb.saleCharges],[4000,14,6000,21]);
  assert.equal(ra.shortProceeds+rb.shortProceeds,10000);
  // Two short sales in one lot: the average price.
  const s2={...SHORT,id:'S2',filled:10,fillPrice:1100,createdAt:0};const r=shortResult(COVER,[SHORT,s2,COVER]);assert.equal(r.entryPrice,1050);assert.equal(r.shortProceeds,10500);
});
test('KIS\'s interest figure replaces the estimate; with KIS\'s fees too the result is the broker\'s',()=>{
  const c={...COVER,borrowInterest:{amount:19,source:'KIS order history'},resultCosts:costs(14,0,'broker')};
  const r=shortResult(c,[{...SHORT,resultCosts:costs(15,20,'broker')},c]);assert.deepEqual(r.interest,{amount:19,basis:'broker',source:'KIS order history'});assert.equal(r.realized,10000-9000-35-14-19);assert.equal(r.costBasis,'broker');
  assert.equal(shortResult(c,[SHORT,c]).costBasis,'estimated','the sale\'s fees estimated');
});
test('no guess: a lot the app did not sell short, a lot with more covered than the app sold, missing charges or rate',()=>{
  assert.deepEqual(shortResult(COVER,[COVER]).gaps,['Short-sale proceeds of the covered lot unavailable']);
  assert.deepEqual(shortResult(COVER,[{...SHORT,lotLoanDate:'2026-09-04'},COVER]).gaps,['Short-sale proceeds of the covered lot unavailable'],'another lot');
  assert.deepEqual(shortResult(COVER,[{...SHORT,accountKey:'other'},COVER]).gaps,['Short-sale proceeds of the covered lot unavailable'],'another account');
  const more={...COVER,filled:12,quantity:12};assert.deepEqual(shortResult(more,[SHORT,more]).gaps,['The covered lot holds shares the app did not sell short']);
  const late={...COVER,id:'C3',filled:4,createdAt:9};assert.deepEqual(shortResult(late,[SHORT,COVER,late]).gaps,['The covered lot holds shares the app did not sell short'],'after the lot was covered whole');
  let r=shortResult(COVER,[{...SHORT,resultCosts:null},COVER]);assert.equal(r.realized,null);assert.deepEqual(r.gaps,['Short-sale charges unavailable']);
  r=shortResult(COVER,[{...SHORT,borrowFeePct:undefined},COVER]);assert.equal(r.realized,null);assert.deepEqual(r.gaps,['Borrow fee rate unavailable']);
  r=shortResult({...COVER,resultCosts:null},[SHORT,{...COVER,resultCosts:null}]);assert.deepEqual(r.gaps,['Cover charges unavailable']);
  assert.deepEqual(shortResult({...COVER,credit:{kind:'cover'}},[SHORT]).gaps,['Credit lot identity unknown']);
  assert.equal(shortResult(SHORT,[SHORT]),null,'a short sale is not a cover');
});
function ledger(intents){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');for(const o of intents)db.prepare('INSERT INTO live_intents VALUES(?,?)').run(o.id,JSON.stringify({environment:'live',market:'KR',...o}));
  const {OutcomeLedger}=require('../electron/outcome-ledger.cjs');const l=new OutcomeLedger(db);l.sync();return Object.fromEntries(l.list().map(r=>[r.orderId,r]));}
test('the outcome ledger: the short sale realizes nothing; the cover carries the result, its costs apart, judged against the proceeds',()=>{
  // A long holding's cost on the short sale's record must not make a gain (an older record).
  const rows=ledger([{...SHORT,resultCosts:{...costs(15,20),gross:10000,netCash:9965,gainAfterFees:965,gainAfterEstimatedTax:965}},COVER]);
  assert.deepEqual([rows.S1.gainAfterFees,rows.S1.gainAfterEstimatedTax,rows.S1.evaluation,rows.S1.assessment.category],[null,null,'Entry recorded; exit outcome pending','entry']);
  const c=rows.C1;assert.equal(c.gainAfterFees,937);assert.equal(c.gainAfterEstimatedTax,937,'a listed stock sold short by a minority holder: no income tax');assert.equal(c.shortProceeds,10000);
  assert.deepEqual(c.shortCosts,{saleCharges:35,coverCharges:14,interest:{amount:14,basis:'estimate',pct:5,days:10},beforeCharges:1000});
  assert.equal(c.costBasis,'estimated');assert.equal(c.evaluation,'Gain observed; cause unassessed');
  assert.deepEqual([c.assessment.category,c.assessment.exit,c.assessment.eligible,c.assessment.basis,Math.round(c.assessment.netReturnPct*100)/100],['gain',true,false,10000,9.37]);
  assert.deepEqual(c.assessment.gaps,['Borrow interest estimated']);
  // A rise: a loss. A small fall eaten by the costs: cost drag.
  assert.equal(ledger([SHORT,{...COVER,fillPrice:1100}]).C1.assessment.category,'loss');
  const drag=ledger([SHORT,{...COVER,fillPrice:999}]).C1;assert.equal(drag.shortCosts.beforeCharges,10);assert.ok(drag.gainAfterFees<0);assert.equal(drag.assessment.category,'cost-drag');
  // No result: a data gap with its cause, as before.
  const hand=ledger([COVER]).C1;assert.equal(hand.gainAfterFees,null);assert.equal(hand.assessment.category,'data-gap');assert.deepEqual(hand.assessment.gaps,['Short-sale proceeds of the covered lot unavailable']);
  const norate=ledger([{...SHORT,borrowFeePct:null},COVER]).C1;assert.equal(norate.gainAfterFees,null);assert.equal(norate.shortProceeds,10000);assert.deepEqual(norate.assessment.gaps,['Borrow fee rate unavailable']);assert.equal(norate.assessment.category,'data-gap');
});
test('the ledger is unchanged for orders that are neither a short nor a cover',()=>{
  const buy={id:'B1',accountKey:'acct',symbol:'990020',side:'Buy',filled:2,quantity:2,fillPrice:500,resultCosts:{...costs(1,0),gross:1000,netCash:-1001,gainAfterFees:null,gainAfterEstimatedTax:null},status:'Filled',createdAt:1};
  const sell={...buy,id:'B2',side:'Sell',resultCosts:{...costs(1,2),gross:1100,netCash:1097,gainAfterFees:96,gainAfterEstimatedTax:96}};
  const r=ledger([buy,sell]);assert.equal(r.B1.evaluation,'Entry recorded; exit outcome pending');assert.equal(r.B2.gainAfterFees,96);assert.equal(r.B2.evaluation,'Gain observed; cause unassessed');
  for(const x of [r.B1,r.B2])for(const k of ['shortProceeds','shortCosts','shortGaps'])assert.equal(k in x,false,k);
});
test('the engine: a short sale has no acquisition cost even with a long holding; the borrow fee rate is kept on it',async()=>{
  const CP=require('../electron/credit-paths.cjs');const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const real=CP.pathStatus;
  CP.pathStatus=(kind,o)=>['short','cover'].includes(kind)?{executable:true,automatic:false}:real(kind,o);
  try{const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'live',reportedTotal:10_000_000,cash:10_000_000,holdings:[{symbol:'990010',quantity:5,cost:900}],shorts:[]};
    const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot}));e.exposure=new Exposure(db);e.exposure.savePolicy('acct',{short:{enabled:true,auto:true,maxGrossPctOfEquity:20,feePct:6}});e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
    e.instrumentOf=()=>({market:'KOSPI',type:'stock'});e.shortSession=()=>'regular';e.netEquityOf=()=>({low:10_000_000,high:10_000_000});
    const o=e.propose({symbol:'990010',side:'Sell',quantity:2,limitPrice:1001,credit:{kind:'short'}});assert.equal(o.costPerShare,null);assert.equal(o.borrowFeePct,6);
  }finally{CP.pathStatus=real;}
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.match(src,/const costPerShare=order\.credit\?\.kind==='short'\?null:prepared\.balance/,'at the send too');
});
test('the parts of a lot sum to the whole: proceeds and the sale\'s charges over random lots (the last cover takes the remainder)',()=>{
  let seed=7;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  for(let k=0;k<3000;k++){
    const shorts=Array.from({length:1+rnd(3)},(_,i)=>({...SHORT,id:'S'+i,filled:1+rnd(40),fillPrice:1000+rnd(900)+(rnd(2)?0.5:0),resultCosts:costs(rnd(50),rnd(90)),createdAt:i}));
    const sold=shorts.reduce((n,o)=>n+o.filled,0);const covers=[];let left=sold;
    while(left>0){const q=Math.min(left,1+rnd(Math.max(1,Math.ceil(sold/2))));covers.push({...COVER,id:'C'+covers.length,filled:q,quantity:q,createdAt:10+covers.length});left-=q;}
    const all=[...shorts,...covers],rs=covers.map(c=>shortResult(c,all));
    const gross=shorts.reduce((n,o)=>n+o.filled*o.fillPrice,0),fees=shorts.reduce((n,o)=>n+o.resultCosts.commission+o.resultCosts.transactionTax,0);
    assert.equal(rs.reduce((n,r)=>n+r.shortProceeds,0),Math.round(gross),'proceeds, lot '+k);assert.equal(rs.reduce((n,r)=>n+r.saleCharges,0),Math.round(fees),'charges, lot '+k);
  }
  // The reviewer's case: two sales, three covers.
  const s=[{...SHORT,id:'A',filled:3,fillPrice:1011.5,createdAt:0},{...SHORT,id:'B',filled:7,fillPrice:1012,createdAt:1}];const c=[4,3,3].map((q,i)=>({...COVER,id:'K'+i,filled:q,quantity:q,createdAt:5+i}));
  assert.equal(c.map(x=>shortResult(x,[...s,...c]).shortProceeds).reduce((a,b)=>a+b,0),Math.round(3*1011.5+7*1012));
});
test('a gap, not a number: a cover dated before its short; a negative or unreadable KIS interest; a rate outside the setting\'s range',()=>{
  let r=shortResult({...COVER,day:'2026-08-31'},[SHORT,{...COVER,day:'2026-08-31'}]);assert.equal(r.realized,null);assert.equal(r.interest,null);assert.deepEqual(r.gaps,['Cover dated before its short sale']);
  for(const amount of [-5,NaN,'19']){const c={...COVER,borrowInterest:{amount,source:'KIS'}};r=shortResult(c,[SHORT,c]);assert.equal(r.realized,null,String(amount));assert.equal(r.interest,null,'not silently the estimate');assert.deepEqual(r.gaps,['KIS borrow interest figure is negative or unreadable']);}
  for(const p of [0.05,31,100,0]){r=shortResult(COVER,[{...SHORT,borrowFeePct:p},COVER]);assert.equal(r.realized,null,String(p));assert.deepEqual(r.gaps,["Borrow fee rate outside the setting's range"]);}
  for(const p of [0.1,30])assert.deepEqual(shortResult(COVER,[{...SHORT,borrowFeePct:p},COVER]).gaps,[],'at the bounds: '+p);
  assert.deepEqual(require('../electron/short-result.cjs').FEE_RANGE,[0.1,30]);assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','src','ShortLeverage.tsx'),'utf8'),/\['feePct','[^']*','number',0\.1,30\]/,'the setting\'s own range');
});
