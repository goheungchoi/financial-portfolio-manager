// S3a-2 (settlement clean-up, s3/s3a-f1.md, review conditions 1-6): the daily-loss check of both engines on U.S. buys
// funded in KRW, end to end. KIS readings go through the path main.cjs wires (U.S. hold, settlement tracker, funding
// tracker, the recorder, the flow detector) and, at every reading, the real valuation (valuation.cjs marketValue, as the
// engines' netEquityOf) and the real LiveEngine.lossOf are checked against a baseline taken at every earlier reading (a
// U.S. one never at a held or provisional reading, S3a G2). Prices and the rate are fixed: the right answer is no loss
// and no gain anywhere.
// drift: the change in the loss value since the baseline less the money counted as moved after it. 0 when right;
// positive a false gain (it can hide a real loss), negative a false loss. lossStatus floors a loss at 0, so only the
// drift shows a false gain.
// Run directly: `node tests/loss-funding-e2e.test.cjs summary` (counts), `... detail` (every reading), `... fixture`
// (writes the values .low/.high of the code at hand to tests/fixtures/loss-funding-values.json; written before S3a-2).
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {InFlight,marketValue,value}=require('../electron/valuation.cjs');const {FundingTracker,settlement}=require('../electron/integrated-settlement.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const {UsBalanceHold}=require('../electron/settlement-check.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const {LiveEngine}=require('../electron/live-engine.cjs');
const A='acct',K=s=>Date.parse(s+'+09:00'),r2=v=>Math.round(v*100)/100;
// The U.S. loss value's range (high - low) by cause: in-flight buys (the tracker, from the valuation's component), sales
// in flight, and anything else (other: the rest of the range, which funding would make; the open funding route is not in
// the loss value's range since S3a-2, valuation.cjs marketValue).
const widths=(v,loss)=>{const w=n=>{const c=v.components.find(x=>x.name===n);return c?r2((c.high??c.amount)-(c.low??c.amount)):0;};const inFlight=w('inFlightBuys'),receivable=w('receivable');
  return {inFlight,receivable,other:r2(loss.high-loss.low-inFlight-receivable)};};
function e2e(readings,{limit=1}={}){const db=new DatabaseSync(':memory:');let t=readings[0].at;const clock=()=>t;
  const perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock),ft=new FundingTracker(db,clock),hold=new UsBalanceHold({clock});
  const notes=[];const f=new InFlight(db,clock),rec=new FundingTransfers(db,{performance:perf,clock,log:(title,body)=>notes.push({title,body})});
  let used=null,lastKR=null;const bases=[],out=[];
  const engine=market=>new LiveEngine(db,{request:async()=>{throw new Error('no broker');}},()=>({status:'connected',snapshot:{accountKey:market==='US'?A+':US':A}}),market==='US'?{market:'US'}:{});
  const engines={KR:engine('KR'),US:engine('US')};
  for(const r of readings){t=r.at;const ts=new Date(t).toISOString();
    const raw={accountKey:A+':US',environment:'live',timestamp:ts,cash:r.us.cash,...(r.us.pending?{pendingSaleProceeds:r.us.pending}:{}),fx:{usdKRW:r.fx,timestamp:ts},holdings:r.us.holdings,unsettled:{buyKRW:r.us.buyKRW??0,sellKRW:r.us.sellKRW??0},raw:{}};
    const h=hold.accept(raw);if(!h.held&&!h.provisional){ft.annotate(raw,r.fx);used=raw;}
    const korea={accountKey:A,environment:'live',timestamp:ts,cash:r.kr.settled,settledCash:r.kr.settled,holdings:r.kr.holdings??[]};
    if(!h.held){f.observe(A,{us:used,orders:r.orders,fx:r.fx,krwGroups:rec.current(A).krwRouteGroups});if(!h.provisional){const tr=f.current(A);rec.observeUS(A,{us:used,orders:r.orders,fx:r.fx,openOrderIds:new Set(tr.open.filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:tr.buysUSD,reportedOpenIds:require('../electron/valuation.cjs').reportedOpenIds(tr)});}}
    if(!lastKR||lastKR.settled!==r.kr.settled||r.krRead!==false){lastKR=r.kr;rec.observeKR(A,{korea,orders:[]});}
    const route=rec.current(A),tr=f.current(A);
    // The detector's Korean cash as main.cjs nets it: the KRW of K1 groups not yet seen leaving Korean cash (S3a-2), or
    // the shown KRW before it.
    fd.observe(A,{krCash:korea.settledCash-(route.krwUnpaidKRW??route.krwKRW),usCash:used.cash+(used.pendingSaleProceeds??0)-Math.max(0,(tr.buysUSD??0)-require('../electron/valuation.cjs').coveredInFlight(tr,route,r.fx))+(tr.sellsUSD??0)-(route.usUSD??0),fx:r.fx,orders:r.orders,provisionalKRW:route.provisionalKRW,unsettledKRW:settlement(used).unsettledKRW,usExplained:x=>f.explained(A,x),funding:route.explained});
    const input={korea,us:used,fx:used.fx,inFlight:tr,funding:route,now:t},mv={KR:marketValue('KR',input),US:marketValue('US',input)};
    const row={at:t,note:r.note,loss:{KR:mv.KR.loss,US:mv.US.loss},value:{KR:{low:mv.KR.low,high:mv.KR.high},US:{low:mv.US.low,high:mv.US.high}},width:widths(value(input).markets.US,mv.US.loss),checks:[]};
    for(const b of bases)for(const m of b.markets){const e=engines[m];const {at,loss}=b;
      const policy={day:e.day(),baseline:loss[m].low,baselineHigh:loss[m].high,baselineAt:at,valuation:mv[m].version,dayPeakEquity:loss[m].low,lossLimit:{mode:'amount',value:limit}};
      e.netEquityOf=()=>mv[m];e.flowsSince=p=>fd.flowsSince(A,m,p.baselineAt);
      const l=e.lossOf(policy,{accountKey:m==='US'?A+':US':A,reportedTotal:0});const s=fd.flowsSince(A,m,at);const unc=(s.uncertain?.confirmed??0)+(s.uncertain?.unresolved??0)+(s.unresolved??0);
      const dl=r2(mv[m].loss.low-loss[m].low-s.confirmed),dh=r2(mv[m].loss.high-loss[m].high-s.confirmed);
      row.checks.push({market:m,from:b.note,fromWidth:b.width,loss:l.loss,breached:l.breached,ambiguous:l.ambiguous,scenarios:(l.scenarios??[{name:'low bounds',loss:l.loss}]).map(x=>[x.name,x.loss]),drift:{low:dl,high:dh,withUncertain:r2(dl-unc)},uncertain:unc});}
    bases.push({at:t,note:r.note,loss:row.loss,width:row.width,markets:h.held||h.provisional?['KR']:['KR','US']});out.push(row);}
  return {out,notes,flows:()=>perf.flows(A),rec,db};}
// The sequences: no exchange cost (the Korean fall equals what KIS reported), prices and the rate fixed.
const buy=(id,usd,at)=>({id,market:'US',symbol:'NYSE:'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:-usd},createdAt:at,filledObservedAt:at});
const sell=(id,usd,at)=>({id,market:'US',symbol:'NYSE:'+id,side:'Sell',status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:usd},createdAt:at,filledObservedAt:at});
const FX=1340,X={symbol:'NYSE:X',quantity:1,price:100};
const at=(s,note,kr,us,orders,extra={})=>({at:K(s),note,fx:FX,kr:{settled:kr,holdings:[]},us,orders,...extra});
// K1: U.S. cash 0, a $100 buy reported as 134,000, settled by exchanging 134,000 (the debit reading held). order at
// settlement: 'same' (KIS's report gone and the Korean fall in one reading), 'kr-first' (the Korean fall while the U.S.
// reading is still held), 'us-first' (the U.S. reading consistent again before the Korean fall).
function k1(days,order='same'){const o=buy('X',100,K('2026-11-09T23:40:00')),[d1,d2]=days==='one'?['2026-11-10','2026-11-10']:['2026-11-10','2026-11-11'];
  const [r,s1,s2]=days==='one'?[`${d1}T09:00:00`,`${d2}T20:24:00`,`${d2}T20:25:00`]:[`${d1}T09:00:00`,`${d2}T08:24:00`,`${d2}T08:25:00`];
  const s3=s2.replace(/:25:00$/,':26:00');
  const settle=order==='same'?[at(s2,'exchange',2866000,{cash:0,holdings:[X],buyKRW:0},[o])]
    :order==='kr-first'?[at(s2,'Korean fall',2866000,{cash:-100,holdings:[X],buyKRW:0},[o]),at(s3,'U.S. consistent',2866000,{cash:0,holdings:[X],buyKRW:0},[o])]
    :[at(s2,'U.S. consistent',3000000,{cash:0,holdings:[X],buyKRW:0},[o]),at(s3,'Korean fall',2866000,{cash:0,holdings:[X],buyKRW:0},[o])];
  return [at('2026-11-09T23:00:00','before',3000000,{cash:0,holdings:[]},[]),at('2026-11-09T23:45:00','fill',3000000,{cash:0,holdings:[X]},[o]),at(`${d1}T08:59:00`,'before report',3000000,{cash:0,holdings:[X]},[o]),
    at(r,'report (K1)',3000000,{cash:0,holdings:[X],buyKRW:134000},[o]),at(`${d1}T12:00:00`,'after report',3000000,{cash:0,holdings:[X],buyKRW:134000},[o]),
    ...(days==='one'?[]:[at(`${d2}T00:01:00`,'next Korean day',3000000,{cash:0,holdings:[X],buyKRW:134000},[o])]),
    at(s1,'debit (held)',3000000,{cash:-100,holdings:[X],buyKRW:0},[o]),...settle,at(`${d2}T23:00:00`,'end',2866000,{cash:0,holdings:[X],buyKRW:0},[o])];}
// K2: U.S. cash 50 carries the buy; KIS takes the 50 and exchanges the $50 shortfall (67,000).
function k2(){const o=buy('X',100,K('2026-11-09T23:40:00'));
  return [at('2026-11-09T23:00:00','before',3000000,{cash:50,holdings:[]},[]),at('2026-11-09T23:45:00','fill',3000000,{cash:50,holdings:[X]},[o]),at('2026-11-10T08:59:00','before report',3000000,{cash:50,holdings:[X]},[o]),
    at('2026-11-10T09:00:00','report (us)',3000000,{cash:50,holdings:[X],buyKRW:134000},[o]),at('2026-11-11T00:01:00','next Korean day',3000000,{cash:50,holdings:[X],buyKRW:134000},[o]),
    at('2026-11-11T08:24:00','debit (held)',3000000,{cash:-50,holdings:[X],buyKRW:0},[o]),at('2026-11-11T08:25:00','exchange (K2)',2933000,{cash:0,holdings:[X],buyKRW:0},[o]),at('2026-11-11T23:00:00','end',2933000,{cash:0,holdings:[X],buyKRW:0},[o])];}
// Reversals: K1 at the report; a holding Z is sold and its proceeds settle; KIS then pays the buy all in USD (full) or
// $60 in USD and exchanges the rest, 53,600 (partial).
function reversal(kind){const o=buy('X',100,K('2026-11-09T23:40:00')),Z={symbol:'NYSE:Z',quantity:1,price:kind==='full'?110:60},z=sell('Z',Z.price,K('2026-11-10T23:40:00')),cashIn=Z.price,o2=[o,z];
  const after=kind==='full'?{kr:3000000,cash:cashIn-100}:{kr:3000000-53600,cash:0};
  return [at('2026-11-09T23:00:00','before',3000000,{cash:0,holdings:[Z]},[]),at('2026-11-09T23:45:00','fill',3000000,{cash:0,holdings:[Z,X]},[o]),at('2026-11-10T08:59:00','before report',3000000,{cash:0,holdings:[Z,X]},[o]),
    at('2026-11-10T09:00:00','report (K1)',3000000,{cash:0,holdings:[Z,X],buyKRW:134000},[o]),at('2026-11-10T23:45:00','sale',3000000,{cash:0,pending:cashIn,holdings:[X],buyKRW:134000},o2),
    at('2026-11-11T08:00:00','proceeds settled',3000000,{cash:cashIn,holdings:[X],buyKRW:134000},o2),
    at('2026-11-11T08:24:00','settlement (USD)',3000000,{cash:kind==='full'?cashIn-100:0,holdings:[X],buyKRW:0},o2),...(kind==='full'?[]:[at('2026-11-11T08:25:00','exchange',after.kr,{cash:0,holdings:[X],buyKRW:0},o2)]),
    at('2026-11-11T23:00:00','end',after.kr,{cash:after.cash,holdings:[X],buyKRW:0},o2)];}
// Control: the same buy paid in USD from U.S. cash 500 (no funding at all): what the in-flight range does alone.
function usdControl(){const o=buy('X',100,K('2026-11-09T23:40:00'));
  return [at('2026-11-09T23:00:00','before',3000000,{cash:500,holdings:[]},[]),at('2026-11-09T23:45:00','fill',3000000,{cash:500,holdings:[X]},[o]),at('2026-11-10T08:59:00','before report',3000000,{cash:500,holdings:[X]},[o]),
    at('2026-11-10T09:00:00','report',3000000,{cash:500,holdings:[X],buyKRW:134000},[o]),at('2026-11-11T08:25:00','settled in USD',3000000,{cash:400,holdings:[X],buyKRW:0},[o]),at('2026-11-11T23:00:00','end',3000000,{cash:400,holdings:[X],buyKRW:0},[o])];}
// The Korean payment read while KIS keeps reporting the buy, up to and past the U.S. age limit (3 U.S. business days
// from the 11-09 fill: from 11-12 New York, 14:00 KST): the kr-paid group's age close (S3a-3).
function krPaidStays(){const o=buy('X',100,K('2026-11-09T23:40:00')),rep={cash:0,holdings:[X],buyKRW:134000};
  return [at('2026-11-09T23:00:00','before',3000000,{cash:0,holdings:[]},[]),at('2026-11-09T23:45:00','fill',3000000,{cash:0,holdings:[X]},[o]),at('2026-11-10T08:59:00','before report',3000000,{cash:0,holdings:[X]},[o]),
    at('2026-11-10T09:00:00','report (K1)',3000000,rep,[o]),at('2026-11-11T08:25:00','Korean fall (kr-paid)',2866000,rep,[o]),at('2026-11-12T12:00:00','report still there',2866000,rep,[o]),
    at('2026-11-20T15:00:00','past the age limit',2866000,rep,[o]),at('2026-11-20T23:00:00','end',2866000,rep,[o])];}
const FUNDED={'K1, Korean paid, KIS keeps reporting':krPaidStays(),'K1, one Korean day':k1('one'),'K1, across a Korean day':k1('two'),'K1, Korean fall first':k1('two','kr-first'),'K1, U.S. reading first':k1('two','us-first'),K2:k2(),'full reversal':reversal('full'),'partial reversal':reversal('partial')};
const SEQUENCES={...FUNDED,'USD control (no funding)':usdControl()};
const TOL={KR:1,US:0.01};
// Every check that is not right: a loss, breach or ambiguity in any scenario, or a drift (a false gain or loss).
const bad=c=>c.loss>TOL[c.market]||c.breached||c.ambiguous||c.scenarios.some(([,l])=>l>TOL[c.market])||Math.abs(c.drift.low)>TOL[c.market]||Math.abs(c.drift.high)>TOL[c.market];
function wrong(run){return run.out.flatMap(r=>r.checks.filter(bad).map(c=>({at:r.note,from:c.from,market:c.market,loss:c.loss,ambiguous:c.ambiguous,drift:c.drift,cause:cause(c,r)})));}
// What a U.S. check's high-bound drift comes from: the change in each cause's range between the baseline and now (the
// high drift less the low drift is the change of the whole range).
function cause(c,r){if(c.market!=='US')return null;const d=k=>r2(r.width[k]-c.fromWidth[k]);return {inFlight:d('inFlight'),receivable:d('receivable'),other:d('other')};}
const kind=x=>x.market==='KR'?'KR':Math.abs(x.drift.low)>TOL.US?'US low':'US high only';
module.exports={e2e,SEQUENCES,FUNDED,wrong};
const FIXTURE=path.join(__dirname,'fixtures','loss-funding-values.json');
const valuesOf=run=>run.out.map(r=>({note:r.note,value:r.value}));

// node --test runs this file as the main module too, so the command-line uses are chosen by their argument.
// Required by another test file (M-1.6d's random test uses e2e): register nothing.
const mode=require.main!==module?'lib':['summary','detail','fixture'].includes(process.argv[2])?process.argv[2]:null;
if(mode==='lib'){}
else if(mode){
  if(mode==='fixture'){fs.writeFileSync(FIXTURE,JSON.stringify(Object.fromEntries(Object.entries(SEQUENCES).map(([n,s])=>[n,valuesOf(e2e(s))])),null,1)+'\n');console.log('written',FIXTURE);}
  else for(const [name,seq] of Object.entries(SEQUENCES)){const run=e2e(seq),w=wrong(run);const by={};for(const x of w)by[kind(x)]=(by[kind(x)]??0)+1;
    console.log(`\n## ${name}: ${JSON.stringify(by)}`);
    if(mode==='detail'){for(const r of run.out)console.log(`  ${new Date(r.at+9*3600e3).toISOString().slice(5,16)} ${r.note.padEnd(18)} KR loss ${Math.round(r.loss.KR.low)}/${Math.round(r.loss.KR.high)}  US loss ${r.loss.US.low.toFixed(2)}/${r.loss.US.high.toFixed(2)}  US range ${JSON.stringify(r.width)}`);
      console.log('  flows: '+run.flows().map(f=>`${f.id.replace('funding:','')} ${f.market} ${f.amount}`).join('; '));if(run.notes.length)console.log('  notes: '+run.notes.map(n=>n.title+': '+n.body).join(' | '));}
    for(const x of w)console.log(`    ${x.market} at "${x.at}" from "${x.from}": loss ${x.loss}${x.ambiguous?' ambiguous':''} drift ${JSON.stringify(x.drift)}${x.cause?' range change '+JSON.stringify(x.cause):''}`);}}
else{
  for(const [name,seq] of Object.entries(FUNDED))test(`${name}: both engines, every baseline and reading: no loss, breach or ambiguity in any scenario and no false gain, except the U.S. in-flight range`,()=>{
    const w=wrong(e2e(seq));
    assert.deepEqual(w.filter(x=>x.market==='KR'),[],'the Korean check');
    assert.deepEqual(w.filter(x=>x.market==='US'&&Math.abs(x.drift.low)>TOL.US),[],'the U.S. low bound (the value)');
    // Condition 4: a U.S. check left is the high bound alone, and its drift is the change of the in-flight buys' range
    // (the tracker, as in the no-funding control), with no part from anything else (other: what funding would add).
    for(const x of w.filter(x=>x.market==='US'))assert.ok(Math.abs(x.drift.high-x.cause.inFlight)<=TOL.US&&Math.abs(x.cause.other)<=TOL.US&&Math.abs(x.cause.receivable)<=TOL.US,`${name}: U.S. at "${x.at}" from "${x.from}": high drift ${x.drift.high}, range change ${JSON.stringify(x.cause)}`);});
  test('condition 4: the U.S. high-bound checks of the funded sequences are those of the no-funding control, baseline for baseline, by amount and cause',()=>{
    const control=wrong(e2e(SEQUENCES['USD control (no funding)'])).map(x=>[x.from,x.at,x.drift.high,x.cause.inFlight]);
    assert.ok(control.length>0&&control.every(([, , h,i])=>Math.abs(h-i)<=TOL.US),'the control\'s are all the in-flight range');
    // For the readings the control shares (before, fill, before report, report): the same checks with the same amounts.
    const isReport=n=>n==='report'||/^report \(/.test(n),shared=new Set(['before','fill','before report']),pick=list=>list.filter(([from,at])=>shared.has(from)&&(shared.has(at)||isReport(at))).map(([from,at,h,i])=>[from,isReport(at)?'report':at,h,i]);
    for(const [name,seq] of Object.entries(FUNDED))assert.deepEqual(pick(wrong(e2e(seq)).filter(x=>x.market==='US').map(x=>[x.from,x.at,x.drift.high,x.cause.inFlight])),pick(control),name);});
  // The recorder alone (conditions 1 to 3), as funding-transfers.test.cjs drives it. A fill at 23:40 KST on 11-09 is New
  // York 11-09: its U.S. settlement date (one U.S. business day on) is 11-10, from 14:00 KST 11-10.
  const lone=(start=K('2026-11-09T23:40:00'))=>{const db=new DatabaseSync(':memory:');let t=start;const notes=[];const perf=new PerformanceHistory(db,()=>t);
    const f=new FundingTransfers(db,{performance:perf,clock:()=>t,log:(title,body)=>notes.push({title,body})});
    const b=(id,usd)=>({id,side:'Buy',filled:1,fillPrice:usd,market:'US',accountKey:'A:US',createdAt:t,filledObservedAt:t,resultCosts:{netCash:-usd}});
    return {db,f,perf,b,notes,to:s=>{t=K(s);},us:(cash,buyKRW,orders,x={})=>f.observeUS('A',{us:{cash,unsettled:{buyKRW,sellKRW:0}},orders,fx:FX,openOrderIds:new Set(x.open??[]),openBuysUSD:x.openUSD??0}),
      kr:settled=>f.observeKR('A',{korea:{cash:settled,settledCash:settled}}),row:k=>f.rows('A').find(r=>r.key===k),flows:()=>perf.flows('A').map(x=>x.id)};};
  const k1=(w,id,usd,krw,{reportAt='2026-11-10T09:00:00'}={})=>{const o=w.b(id,usd);w.to('2026-11-09T23:41:00');w.us(0,0,[o],{open:[id],openUSD:usd});w.to(reportAt);return o;};
  test('condition 1: a K1 group whose Korean payment is never seen ends unmatched with its reason and one System line; nothing is booked for it',()=>{
    const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const o=k1(w,'o1',100,134000);w.us(0,134000,[o]);assert.equal(w.row('o1').state,'krw');
    w.to('2026-11-11T08:25:00');w.us(0,0,[o]);assert.equal(w.row('o1').state,'awaiting-kr');assert.equal(w.f.current('A').krwUnpaidKRW,134000,'still deducted');
    // Korean readings with no fall in the band, past one Korean business day.
    for(const s of ['2026-11-11T12:00:00','2026-11-12T09:00:00','2026-11-12T12:00:00','2026-11-20T09:00:00']){w.to(s);w.kr(3000000-(s.endsWith('12:00:00')?1000:0));}
    const r=w.row('o1');assert.equal(r.state,'unmatched');assert.match(r.reason,/no Korean cash fall paying it/);assert.equal(w.f.current('A').krwUnpaidKRW,0);
    assert.equal(w.notes.length,1,'one System line');assert.match(w.notes[0].body,/o1/);assert.match(w.notes[0].body,/134,000/);
    assert.deepEqual(w.flows(),['funding:o1:out','funding:o1:in'],'no reversal, no other booking');
    // A K2 exchange never seen: the same.
    const v=lone();v.to('2026-11-16T23:00:00');v.us(50,0,[]);v.kr(3000000);const p=k1(v,'p1',100,134000);v.us(50,134000,[p]);v.to('2026-11-18T08:25:00');v.us(0,0,[p]);assert.equal(v.row('p1').state,'awaiting-krw');
    for(const s of ['2026-11-19T09:00:00','2026-11-20T09:00:00']){v.to(s);v.kr(3000000);}assert.equal(v.row('p1').state,'unmatched');assert.equal(v.notes.length,1);assert.deepEqual(v.flows(),[]);
  });
  test('condition 2: a krw row written by 1.5.59 (no fill time) is guarded by its report time and paid by its Korean fall, in either order',()=>{
    for(const order of ['us-first','kr-first']){const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const o=k1(w,'o1',100,134000);w.us(0,134000,[o]);
      // As 1.5.59 wrote it: no filledAt on the group.
      const {key,filledAt:_f,...r}=w.row('o1');assert.ok(Number.isFinite(_f),'S3a-2 writes it');w.f.put('A',key,{...r});assert.equal(w.row('o1').filledAt,undefined);
      // A fall in the band before one U.S. business day from the report's date: not taken.
      w.to('2026-11-10T12:00:00');w.kr(2866000);assert.equal(w.row('o1').state,'krw');w.to('2026-11-10T12:01:00');w.kr(3000000);
      w.to('2026-11-11T08:24:00');if(order==='us-first'){w.us(0,0,[o]);assert.equal(w.row('o1').state,'awaiting-kr');w.to('2026-11-11T08:25:00');w.kr(2866000);}
      else{w.kr(2866000);assert.equal(w.row('o1').state,'kr-paid');w.to('2026-11-11T08:25:00');w.us(0,0,[o]);}
      assert.equal(w.row('o1').state,'booked',order);assert.equal(w.f.current('A').krwUnpaidKRW,0);assert.equal(w.notes.length,0);}
  });
  test('condition 3: guard edges: a fall in the band before the U.S. settlement date is not the payment; two near-equal groups settling in one Korean reading are both paid',()=>{
    // (a) The fill's U.S. settlement date is 11-10 (New York): a Korean fall of the amount on 11-10 at 12:00 KST (New York
    // 11-09 22:00) is before it, so it is not taken; the deduction stays and the fall is the detector's to judge.
    {const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const o=k1(w,'o1',100,134000);w.us(0,134000,[o]);
      w.to('2026-11-10T12:00:00');w.kr(2866000);assert.equal(w.row('o1').state,'krw');assert.equal(w.f.current('A').krwUnpaidKRW,134000);
      // From 14:00 KST on 11-10 (New York 11-10) it would be.
      w.to('2026-11-10T14:00:00');w.kr(3000000);w.to('2026-11-10T14:01:00');w.kr(2866000);assert.equal(w.row('o1').state,'kr-paid');}
    // (b) Two K1 groups of 134,000 and 134,500 (two fills, two reports).
    const two=()=>{const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const a=w.b('a',100),b2=w.b('b',100.37);w.to('2026-11-09T23:41:00');w.us(0,0,[a,b2],{open:['a','b'],openUSD:200.37});
      w.to('2026-11-10T09:00:00');w.us(0,134000,[a,b2],{open:['b'],openUSD:100.37});w.to('2026-11-10T09:01:00');w.us(0,268500,[a,b2]);assert.deepEqual([w.row('a').state,w.row('b').state],['krw','krw']);
      w.to('2026-11-11T08:24:00');w.us(0,0,[a,b2]);assert.deepEqual([w.row('a').state,w.row('b').state],['awaiting-kr','awaiting-kr']);return w;};
    {const w=two();w.to('2026-11-11T08:25:00');w.kr(3000000-268500);assert.deepEqual([w.row('a').state,w.row('b').state],['booked','booked'],'one Korean reading pays both');assert.equal(w.f.current('A').krwUnpaidKRW,0);}
    // Only one of them in this reading: one is paid (either: the amounts are equal within the band, and no booking follows),
    // the other stays deducted until its own fall.
    {const w=two();w.to('2026-11-11T08:25:00');w.kr(3000000-134000);const left=w.f.current('A').krwUnpaidKRW;assert.ok(left===134000||left===134500,String(left));
      w.to('2026-11-11T08:30:00');w.kr(3000000-268500);assert.equal(w.f.current('A').krwUnpaidKRW,0);assert.deepEqual([w.row('a').state,w.row('b').state],['booked','booked']);}
  });
  test('S3a-3 (1): a kr-paid group KIS\'s report fell for without attribution claims none of a later buy\'s report once past the age rule',()=>{
    // Two K1 groups of 134,000 each, both paid in Korea (kr-paid); KIS's report then falls by one of them and then the
    // other, which uniqueSet cannot attribute (two equal groups): both stay kr-paid while nothing is reported.
    const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const a=w.b('a',100);w.to('2026-11-09T23:41:00');w.us(0,0,[a],{open:['a'],openUSD:100});w.to('2026-11-10T09:00:00');w.us(0,134000,[a]);
    const b=w.b('b',100);w.to('2026-11-10T09:05:00');w.us(0,134000,[a,b],{open:['b'],openUSD:100});w.to('2026-11-10T09:10:00');w.us(0,268000,[a,b]);assert.deepEqual([w.row('a').state,w.row('b').state],['krw','krw']);
    w.to('2026-11-11T08:25:00');w.kr(2866000);w.to('2026-11-11T08:26:00');w.kr(2732000);assert.deepEqual([w.row('a').state,w.row('b').state],['kr-paid','kr-paid']);
    w.to('2026-11-18T08:30:00');w.us(0,134000,[a,b]);w.to('2026-11-18T08:31:00');w.us(0,0,[a,b]);assert.deepEqual([w.row('a').state,w.row('b').state],['kr-paid','kr-paid'],'not attributable');
    assert.equal(w.f.current('A').krwKRW,268000,'still counted as reported by KIS (the stale state)');
    // A new buy with U.S. cash to carry it, reported after the age limit (New York 11-12 for 11-09/17 fills).
    w.to('2026-11-20T23:40:00');const c=w.b('c',100);w.us(500,0,[a,b,c],{open:['c'],openUSD:100});w.to('2026-11-21T09:00:00');const cur=w.us(500,134000,[a,b,c]);
    assert.deepEqual([w.row('a').state,w.row('b').state],['booked','booked']);assert.match(w.row('a').reason,/settled by age after its Korean payment/);assert.equal(w.row('c').state,'us');
    assert.equal(cur.krwKRW,0,'the old groups claim none of it');assert.equal(cur.usReportedKRW,134000,'the U.S. side carries the new buy');assert.equal(cur.provisionalKRW,0);
    assert.equal(w.notes.length,0,'no System line');assert.deepEqual(w.flows().filter(id=>id.startsWith('funding:a:')||id.startsWith('funding:b:')),['funding:a:out','funding:a:in','funding:b:out','funding:b:in'],'no flow at the change');
  });
  test('S3a-3 (2): KIS still reporting the group at the age limit: its KRW becomes unattributed (provisional); the split and the values do not change',()=>{
    const w=lone();w.to('2026-11-09T23:00:00');w.us(0,0,[]);w.kr(3000000);const o=k1(w,'o1',100,134000);w.us(0,134000,[o]);w.to('2026-11-11T08:25:00');w.kr(2866000);assert.equal(w.row('o1').state,'kr-paid');
    w.to('2026-11-12T12:00:00');const before=w.us(0,134000,[o]);assert.equal(w.row('o1').state,'kr-paid');assert.deepEqual([before.krwKRW,before.provisionalKRW],[134000,0]);
    w.to('2026-11-20T15:00:00');const after=w.us(0,134000,[o]);assert.equal(w.row('o1').state,'booked');assert.deepEqual([after.krwKRW,after.provisionalKRW],[0,134000]);
    // The split's Korean part is krwKRW + provisional: unchanged, so the Korean low and high are too (and the e2e
    // sequence "K1, Korean paid, KIS keeps reporting" checks .low/.high and the loss checks across the change).
    assert.equal(after.krwKRW+after.provisionalKRW,before.krwKRW+before.provisionalKRW);assert.equal(after.krwUnpaidKRW,0);assert.equal(before.krwUnpaidKRW,0);
  });
  test('condition 5: the values (.low and .high) of both markets at every reading are those of the code before S3a-2 (F-d1: less the KRW KIS settled from Korea not yet seen leaving)',()=>{
    const before=JSON.parse(fs.readFileSync(FIXTURE,'utf8'));for(const [name,seq] of Object.entries(SEQUENCES))assert.deepEqual(valuesOf(e2e(seq)),before[name],name);});
  // F-d1: the Korean value deducts the KRW KIS has settled from Korea for a K1 group until the Korean reading shows it
  // leaving (krwSettledUnpaidKRW), as the loss value does. Before, the reading between had a false gain of it.
  test('F-d1: the combined value never rises above its start in any sequence; the low of K1 with the U.S. reading first and of the partial reversal is right at every reading',()=>{
    for(const [name,seq] of Object.entries(SEQUENCES)){const run=e2e(seq),fx=seq[0].fx,c=r=>r.value.KR.low+r.value.US.low*fx,c0=c(run.out[0]);
      for(const r of run.out)assert.ok(c(r)<=c0+2,`${name} at ${r.note}: ${c(r)} above ${c0}`);
      if(['K1, U.S. reading first','partial reversal'].includes(name))for(const r of run.out)assert.ok(Math.abs(c(r)-c0)<=2,`${name} at ${r.note}: ${c(r)} vs ${c0}`);}
  });}

// Condition C of the several-orders work (artifacts/reviews/2026-11-16-multi-order/m1/plan.md): several U.S. buys filled
// in one reading, USD-funded as the control is. Right: no Korean check wrong, no U.S. low-bound drift, and every U.S.
// high-bound check is the in-flight range change, as for one buy. Not run in the command-line modes.
if(!mode){
  const hold=list=>list.map(o=>({symbol:o.symbol,quantity:1,price:o.fillPrice}));
  const two=(a,b)=>{const o=[buy('X',a,K('2026-11-09T23:40:00')),buy('Y',b,K('2026-11-09T23:40:30'))],h=hold(o);
    return [at('2026-11-09T23:00:00','before',3000000,{cash:500,holdings:[]},[]),at('2026-11-09T23:45:00','both filled',3000000,{cash:500,holdings:h},o),at('2026-11-10T08:59:00','before report',3000000,{cash:500,holdings:h},o),
      at('2026-11-10T09:00:00','report',3000000,{cash:500,holdings:h,buyKRW:Math.round((a+b)*FX)},o),at('2026-11-11T08:25:00','settled in USD',3000000,{cash:500-a-b,holdings:h,buyKRW:0},o),at('2026-11-11T23:00:00','end',3000000,{cash:500-a-b,holdings:h,buyKRW:0},o)];};
  const apart=()=>{const o=[buy('X',100,K('2026-11-09T23:40:00')),buy('Y',100,K('2026-11-09T23:41:00'))],h=hold(o);
    return [at('2026-11-09T23:00:00','before',3000000,{cash:500,holdings:[]},[]),at('2026-11-09T23:45:00','both filled',3000000,{cash:500,holdings:h},o),
      at('2026-11-10T09:00:00','first report',3000000,{cash:500,holdings:h,buyKRW:134000},o),at('2026-11-10T10:00:00','second report',3000000,{cash:500,holdings:h,buyKRW:268000},o),
      at('2026-11-11T08:25:00','settled in USD',3000000,{cash:300,holdings:h,buyKRW:0},o),at('2026-11-11T23:00:00','end',3000000,{cash:300,holdings:h,buyKRW:0},o)];};
  const many=n=>{const o=Array.from({length:n},(_,i)=>buy('B'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=hold(o),total=o.reduce((s,x)=>s+x.fillPrice,0);
    return [at('2026-11-09T23:00:00','before',3000000,{cash:1000,holdings:[]},[]),at('2026-11-09T23:45:00','all filled',3000000,{cash:1000,holdings:h},o),
      at('2026-11-10T09:00:00','report',3000000,{cash:1000,holdings:h,buyKRW:Math.round(total*FX)},o),at('2026-11-11T08:25:00','settled in USD',3000000,{cash:1000-total,holdings:h,buyKRW:0},o),
      at('2026-11-11T23:00:00','end',3000000,{cash:1000-total,holdings:h,buyKRW:0},o),at('2026-11-21T23:00:00','after the age rule',3000000,{cash:1000-total,holdings:h,buyKRW:0},o)];};
  const right=(name,seq)=>{const run=e2e(seq),w=wrong(run);
    assert.deepEqual(w.filter(x=>x.market==='KR'),[],name+': the Korean check');
    assert.deepEqual(w.filter(x=>x.market==='US'&&Math.abs(x.drift.low)>TOL.US).map(x=>[x.from,x.at,x.drift.low]),[],name+': the U.S. low bound (the value)');
    for(const x of w.filter(x=>x.market==='US'))assert.ok(Math.abs(x.drift.high-x.cause.inFlight)<=TOL.US&&Math.abs(x.cause.other)<=TOL.US&&Math.abs(x.cause.receivable)<=TOL.US,`${name}: U.S. at "${x.at}" from "${x.from}": ${JSON.stringify(x.cause)}`);return run;};
  test('condition C: two U.S. buys filled in one reading ($100 + $150, and $100 + $100): as for one buy, only the in-flight range',()=>{
    const run=right('$100 + $150',two(100,150));assert.equal(run.out.find(r=>r.note==='both filled').width.inFlight,250,'both in flight together');assert.equal(run.out.find(r=>r.note==='report').width.inFlight,0,'the report settles both');
    right('$100 + $100',two(100,100));});
  test('condition C: two equal U.S. buys reported apart: nothing is settled on an ambiguous report, and the value stays right',()=>{
    // M-1.6c1: the report's group covers one of the two (either: equal amounts), so the in-flight range is $100; neither
    // piece is settled (both still in flight), and the value stays right (right()).
    const run=right('equal buys reported apart',apart());assert.equal(run.out.find(r=>r.note==='first report').width.inFlight,100,'the report covers one of the two');
    {const e=e2e(apart().slice(0,3)),st=JSON.parse(e.db.prepare('SELECT payload FROM inflight_settlement').get().payload);assert.equal((st[A]??st).open.length,2,'neither is settled');}});
  test('condition C: up to 8 U.S. buys filled and reported together: as for one buy',()=>{for(const n of [3,8])right(n+' fills',many(n));});
  // The limit these tests found (m1/condition-c-report.md: 9+ buys a false gain at the report, 13+ a false loss until
  // age), fixed by M-1.6a to c2; a todo until then, a plain test now.
  test('condition C: 9 and 13 U.S. buys filled and reported together: as for one buy (M-1.6a to c2)',()=>{for(const n of [9,13])right(n+' fills',many(n));});
}

// M-1.6c1 (Alt 3): 13 and 25 U.S. buys reported together, over InFlight's bound. From the report the batch is booked and
// covers its in-flight pieces: each market's low and the combined low are right at the report reading, the KRW-paid
// transfer pair is booked, and no detected flow appears. (Settlement over the bound is M-1.6c2.)
if(!mode){
  const batch=(n,cash)=>{const o=Array.from({length:n},(_,i)=>buy('B'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})),T=o.reduce((s,x)=>s+x.fillPrice,0),R=Math.round(T*FX);
    return {T,R,steps:[at('2026-11-09T23:00:00','before',3000000,{cash,holdings:[]},[]),at('2026-11-09T23:45:00','filled',3000000,{cash,holdings:h},o),at('2026-11-10T09:00:00','report',3000000,{cash,holdings:h,buyKRW:R},o)]};};
  test('M-1.6c1: 13 and 25 U.S. buys reported together, USD- and KRW-paid: right at the report, the pair booked once, no detected flow',()=>{
    for(const n of [13,25])for(const cash of [2000,0]){const {T,R,steps}=batch(n,cash),run=e2e(steps),rep=run.out.find(r=>r.note==='report').value,label=`${n} buys, U.S. cash ${cash}`;
      const usTrue=cash>0?cash:T,krTrue=cash>0?3000000:3000000-R;
      assert.ok(Math.abs(rep.US.low-usTrue)<0.01,`${label}: the U.S. low ${rep.US.low} = ${usTrue}`);assert.ok(Math.abs(rep.KR.low-krTrue)<1,`${label}: the Korean low ${rep.KR.low} = ${krTrue}`);
      assert.ok(Math.abs(rep.KR.low+rep.US.low*FX-(3000000+(cash>0?cash*FX:0)))<2,`${label}: the combined low counts the batch once`);
      const flows=run.flows();assert.equal(flows.filter(f=>f.detected).length,0,label+': no detected flow');assert.equal(flows.filter(f=>f.transfer).length,cash>0?0:2,label+': the KRW-paid pair, once');}
  });
  // M-1.6c2: the same batches through settlement and age, reading by reading. Funding: USD (U.S. cash $2,000), KRW ($0)
  // or mixed ($100: KIS takes the cash first, then exchanges the shortfall a reading later). Reported, and settled, together
  // or in two parts (the second part the odd-numbered buys: not a prefix). The combined low against the true value.
  const parts=(o,k)=>k===1?[o]:[o.filter((_,i)=>i%2===0),o.filter((_,i)=>i%2===1)],sum=l=>l.reduce((s,x)=>s+x.fillPrice,0),c2=v=>Math.round(v*100)/100;
  function lifecycle(n,fund,k){const cash0={usd:2000,krw:0,mixed:100}[fund],o=Array.from({length:n},(_,i)=>buy('B'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice}));
    const s=[at('2026-11-09T23:00:00','before',3000000,{cash:cash0,holdings:[]},[]),at('2026-11-09T23:45:00','filled',3000000,{cash:cash0,holdings:h},o)];
    let rep=0,t=K('2026-11-10T09:00:00');for(const [i,p] of parts(o,k).entries()){rep+=Math.round(sum(p)*FX);s.push({...at('2026-11-10T09:00:00',`report ${i+1}`,3000000,{cash:cash0,holdings:h,buyKRW:rep},o),at:t+i*3600000});}
    let cash=cash0,kr=3000000;t=K('2026-11-11T08:24:00');const step=(note)=>{s.push({...at('2026-11-11T08:24:00',note,kr,{cash:c2(cash),holdings:h,buyKRW:Math.max(0,rep)},o),at:t});t+=60000;};
    for(const [i,p] of parts(o,k).entries()){const P=sum(p),short=P-Math.min(Math.max(0,cash),P);rep-=Math.round(P*FX);cash-=P;step(`debit ${i+1}`);if(short>0.001){kr-=Math.round(short*FX);cash+=short;step(`exchange ${i+1}`);}}
    t+=86400000;step('next day');t+=7*86400000;step('after age');return {s,combined:3000000+cash0*FX};}
  test('M-1.6c2: 13 and 25 buys, USD-, KRW- and mixed-paid, together and in parts: never above the true value, right from settlement on, no detected flow',()=>{
    for(const n of [13,25])for(const fund of ['usd','krw','mixed'])for(const k of [1,2]){const {s,combined}=lifecycle(n,fund,k),run=e2e(s),label=`${n} buys, ${fund}, in ${k}`;
      const settledFrom=run.out.findIndex(r=>r.note===(k===1?'debit 1':'debit 2'));
      for(const [i,r] of run.out.entries()){const low=r.value.KR.low+r.value.US.low*FX;assert.ok(low<=combined+2,`${label} at ${r.note}: ${low} is above the true ${combined}`);
        // Right at every reading except while KIS reports a batch in parts (the batch set within the band: M-1.6b).
        if(k===1||i>=settledFrom&&!(fund!=='usd'&&r.note==='debit 2'))assert.ok(Math.abs(low-combined)<=2,`${label} at ${r.note}: ${low} vs ${combined}`);}
      assert.ok(run.out.slice(run.out.findIndex(r=>r.note==='next day')).every(r=>Math.abs(r.value.KR.low+r.value.US.low*FX-combined)<=2),`${label}: right after settlement`);
      assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>f.amount),[],label+': no detected flow');}
  });
  // C2 (the planner's addition): KIS's report reaches 0 a reading before its debit, with a $300 withdrawal between.
  test('M-1.6c2 C2: the report at 0 before KIS\'s debit, a withdrawal between: right throughout, one detected flow (the withdrawal)',()=>{
    for(const n of [13,25])for(const W of [0,300]){const o=Array.from({length:n},(_,i)=>buy('B'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})),T=sum(o);
      const s=[at('2026-11-09T23:00:00','before',3000000,{cash:2000,holdings:[]},[]),at('2026-11-09T23:45:00','filled',3000000,{cash:2000,holdings:h},o),at('2026-11-10T09:00:00','report',3000000,{cash:2000,holdings:h,buyKRW:Math.round(T*FX)},o),
        at('2026-11-11T08:20:00','zero',3000000,{cash:2000,holdings:h,buyKRW:0},o),...(W?[at('2026-11-11T08:22:00','withdrawal',3000000,{cash:2000-W,holdings:h,buyKRW:0},o)]:[]),
        at('2026-11-11T08:24:00','debit',3000000,{cash:c2(2000-W-T),holdings:h,buyKRW:0},o),at('2026-11-11T12:00:00','later',3000000,{cash:c2(2000-W-T),holdings:h,buyKRW:0},o),at('2026-11-27T12:00:00','after age',3000000,{cash:c2(2000-W-T),holdings:h,buyKRW:0},o)];
      const run=e2e(s),label=`${n} buys, withdrawal ${W}`;let gone=0;
      for(const r of run.out){if(r.note==='withdrawal')gone=W;const low=r.value.KR.low+r.value.US.low*FX;assert.ok(Math.abs(low-(3000000+(2000-gone)*FX))<=2,`${label} at ${r.note}: ${low}`);}
      assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]),W?[['US',-W]]:[],label);
      // The recorder books KIS's late debit by usd (no exchange is awaited for it, nothing is left unmatched).
      const groups=run.rec.rows(A).filter(r=>(r.orders??[]).length>0&&r.state!=='none');assert.ok(groups.length>0&&groups.every(r=>r.state==='booked'&&r.via==='usd'),`${label}: ${JSON.stringify(groups.map(r=>[r.state,r.via]))}`);}
  });
  // D5 (the planner's addition): the zero at n with U.S. cash $100 untouched; at n + 1 KIS takes the $100 (cash to 0) and
  // exchanges the rest, in the same reading or the next.
  test('M-1.6c2 D5: the zero, then a mixed debit a reading later: right from then on, no detected flow, the exchange matched',()=>{
    for(const n of [13,25])for(const same of [true,false]){const o=Array.from({length:n},(_,i)=>buy('B'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})),T=sum(o),S=Math.round((T-100)*FX);
      const s=[at('2026-11-09T23:00:00','before',3000000,{cash:100,holdings:[]},[]),at('2026-11-09T23:45:00','filled',3000000,{cash:100,holdings:h},o),at('2026-11-10T09:00:00','report',3000000,{cash:100,holdings:h,buyKRW:Math.round(T*FX)},o),
        at('2026-11-11T08:20:00','zero',3000000,{cash:100,holdings:h,buyKRW:0},o),
        ...(same?[at('2026-11-11T08:24:00','debit',3000000-S,{cash:0,holdings:h,buyKRW:0},o)]:[at('2026-11-11T08:24:00','debit',3000000,{cash:0,holdings:h,buyKRW:0},o),at('2026-11-11T08:26:00','exchange',3000000-S,{cash:0,holdings:h,buyKRW:0},o)]),
        at('2026-11-11T12:00:00','later',3000000-S,{cash:0,holdings:h,buyKRW:0},o),at('2026-11-27T12:00:00','after age',3000000-S,{cash:0,holdings:h,buyKRW:0},o)];
      const run=e2e(s),label=`${n} buys, exchange ${same?'with the debit':'a reading later'}`;
      for(const r of run.out){const low=r.value.KR.low+r.value.US.low*FX;assert.ok(Math.abs(low-(3000000+100*FX))<=2,`${label} at ${r.note}: ${low}`);}
      assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]),[],label+': no detected flow');
      const groups=run.rec.rows(A).filter(r=>(r.orders??[]).length>0&&r.state!=='none');assert.ok(groups.every(r=>r.state==='booked'&&r.via==='exchange'),`${label}: ${JSON.stringify(groups.map(r=>[r.state,r.via]))}`);}
  });
  // C3 (the planner's addition): 13 and 25 sales, the reported sale total modelled (sellKRW), proceeds pending at the fill
  // or a reading later, reported and settled together or in two parts. The high is right from settlement on (from the
  // fill when KIS shows the proceeds then), and the low is never above the true value.
  test('M-1.6c2 C3: 13 and 25 U.S. sales: the high right from settlement on, the low never above the true value',()=>{
    for(const n of [13,25])for(const late of [false,true])for(const k of [1,2]){const o=Array.from({length:n},(_,i)=>sell('S'+i,10+i,K('2026-11-09T23:40:00')+i*1000)),h=o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})),T=sum(o);
      const s=[at('2026-11-09T23:00:00','before',3000000,{cash:1000,holdings:h},[]),at('2026-11-09T23:45:00','filled',3000000,{cash:1000,holdings:[],...(late?{}:{pending:T})},o)];
      if(late)s.push(at('2026-11-09T23:55:00','proceeds shown',3000000,{cash:1000,holdings:[],pending:T},o));
      let rep=0,pending=T,cash=1000,t=K('2026-11-10T09:00:00');for(const [i,p] of parts(o,k).entries()){rep+=Math.round(sum(p)*FX);s.push({...at('2026-11-10T09:00:00',`report ${i+1}`,3000000,{cash,holdings:[],pending,sellKRW:rep},o),at:t+i*3600000});}
      t=K('2026-11-11T08:24:00');for(const [i,p] of parts(o,k).entries()){const P=sum(p);rep-=Math.round(P*FX);pending=c2(pending-P);cash=c2(cash+P);s.push({...at('2026-11-11T08:24:00',`settle ${i+1}`,3000000,{cash,holdings:[],...(pending>0.001?{pending}:{}),sellKRW:Math.max(0,rep)},o),at:t});t+=60000;}
      s.push({...at('2026-11-11T08:24:00','next day',3000000,{cash,holdings:[]},o),at:t+86400000},{...at('2026-11-11T08:24:00','after age',3000000,{cash,holdings:[]},o),at:t+8*86400000});
      const run=e2e(s),label=`${n} sales, proceeds ${late?'late':'at the fill'}, in ${k}`,truth=3000000+(1000+T)*FX,from=run.out.findIndex(r=>r.note===(k===1?'settle 1':'settle 2'));
      for(const [i,r] of run.out.entries()){const low=r.value.KR.low+r.value.US.low*FX,high=r.value.KR.high+r.value.US.high*FX;assert.ok(low<=truth+2,`${label} at ${r.note}: low ${low}`);
        if(i>=from||!late&&i>=1)assert.ok(Math.abs(high-truth)<=2,`${label} at ${r.note}: high ${high} vs ${truth}`);}
      assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>f.amount),[],label+': no detected flow');}
  });
}
