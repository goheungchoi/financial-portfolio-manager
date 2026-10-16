const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {normalizeBalance}=require('../electron/kis-client.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {indexHistory}=require('../electron/kis-index.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const holding={pdno:'005930',prdt_name:'Samsung',hldg_qty:'1',pchs_avg_pric:'1000',prpr:'1000',evlu_amt:'1000',evlu_pfls_amt:'0'};
const at=day=>Date.parse(day+'T03:00:00Z');

test('Korean valuation uses settled (D+2) cash so an unsettled purchase is not counted twice',()=>{
  const balance=normalizeBalance([holding],{dnca_tot_amt:'10000',prvs_rcdl_excc_amt:'9000',tot_evlu_amt:'10000'},'mock');
  assert.equal(balance.cash,10000);assert.equal(balance.settledCash,9000);
  const view=combinePortfolio(balance,null,null);assert.equal(view.totals.KRW,10000,'settled cash plus shares, matching the KIS total');assert.equal(view.cash.KRW,9000);assert.equal(view.depositCash.KRW,10000);
  const legacy=normalizeBalance([holding],{dnca_tot_amt:'10000',tot_evlu_amt:'10000'},'mock');assert.equal(legacy.settledCash,null);assert.equal(combinePortfolio(legacy,null,null).totals.KRW,11000,'without the field the deposit balance is used as before');
});

test('buy capacity uses the lower of deposit and settled cash',async()=>{
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[]};let posts=0,settled=50;
  const live=new LiveEngine(db,{request:async operation=>{if(operation==='prepare-order')return {ticket:'t',balance:{...snapshot,settledCash:settled}};if(operation==='place-order'){posts++;return {brokerOrderId:'1'};}throw new Error('unexpected '+operation);}},()=>({status:'connected',snapshot}));
  live.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');live.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const order=live.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:100});
  await assert.rejects(live.submit(order.id,'PLACE MOCK ORDER'),/INSUFFICIENT_CAPACITY/);assert.equal(posts,0);
  settled=1000000;const next=live.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:100});assert.equal((await live.submit(next.id,'PLACE MOCK ORDER')).status,'Accepted');assert.equal(posts,1);
});

test('time-weighted returns exclude deposits and compare with the benchmark over the same days',()=>{
  let now=at('2026-10-01');const perf=new PerformanceHistory(new DatabaseSync(':memory:'),()=>now);const record=(KRW,USD=null,fx=1400)=>perf.record('acct',{totals:{KRW,USD,equityKRW:USD==null?KRW:KRW+USD*fx},cash:{KRW:0,USD:0},fx:{usdKRW:fx}});
  record(100);now=at('2026-10-02');record(110);now=at('2026-10-03');perf.addFlow('acct',{day:'2026-10-03',market:'KR',amount:50,note:'Deposit'});record(165);
  perf.saveCloses('KOSPI',[{day:'2026-10-01',close:100},{day:'2026-10-02',close:102},{day:'2026-10-03',close:105}]);
  const summary=perf.summary('acct','KRW','KOSPI');const all=summary.periods.find(p=>p.label==='All');
  assert.ok(Math.abs(all.twr-(1.1*(165/160)-1))<1e-12);assert.equal(all.gain,15,'gain excludes the deposit');assert.equal(all.flows,50);assert.ok(Math.abs(all.benchmark-0.05)<1e-12);
  assert.equal(summary.periods.find(p=>p.label==='1W').partial,true,'history shorter than the period is flagged');
  assert.equal(perf.history('acct').length,3);
});

test('a refresh missing one market keeps that market for the day; U.S. flows are converted in the combined series',()=>{
  let now=at('2026-10-01');const perf=new PerformanceHistory(new DatabaseSync(':memory:'),()=>now);
  perf.record('acct',{totals:{KRW:1000,USD:10,equityKRW:15000},cash:{},fx:{usdKRW:1400}});perf.record('acct',{totals:{KRW:1100,USD:null,equityKRW:null},cash:{},fx:null});
  assert.deepEqual(perf.history('acct')[0].USD,{equity:10,cash:null});assert.equal(perf.history('acct')[0].equityKRW,15000);
  now=at('2026-10-02');perf.addFlow('acct',{day:'2026-10-02',market:'US',amount:1,note:''});perf.record('acct',{totals:{KRW:1100,USD:11,equityKRW:16500},cash:{},fx:{usdKRW:1400}});
  const combined=perf.series('acct','COMBINED');assert.equal(combined[1].flow,1400);assert.ok(Math.abs(combined[1].dailyReturn-(16500/16400-1))<1e-12);
  assert.throws(()=>perf.addFlow('acct',{day:'2099-01-01',market:'KR',amount:1}),/INVALID_FLOW/);assert.throws(()=>perf.addFlow('acct',{day:'2026-10-02',market:'KR',amount:0}),/INVALID_FLOW/);
  const flow=perf.flows('acct')[0];perf.removeFlow('other',flow.id);assert.equal(perf.flows('acct').length,1,'flows belong to one account');perf.removeFlow('acct',flow.id);assert.equal(perf.flows('acct').length,0);
});

test('benchmark history pages backwards until the start date',async()=>{
  const calls=[];const rows=n=>Array.from({length:n},(_,i)=>{const d=new Date(Date.UTC(2026,9,16)-i*86400000).toISOString().slice(0,10).replaceAll('-','');return {stck_bsop_date:d,bstp_nmix_prpr:String(5000+i)};});
  const all=rows(40);const client={quotation:async(_e,_t,p)=>{calls.push([p.FID_INPUT_DATE_1,p.FID_INPUT_DATE_2]);return {output2:all.filter(r=>r.stck_bsop_date<=p.FID_INPUT_DATE_2&&r.stck_bsop_date>=p.FID_INPUT_DATE_1).slice(0,30)};}};
  const result=await indexHistory(client,{index:'KOSPI',start:'2026-09-10',end:'2026-10-16'});
  assert.equal(calls.length,2);assert.equal(result[0].day,'2026-09-10');assert.equal(result.at(-1).day,'2026-10-16');assert.equal(result.length,37);
  await assert.rejects(indexHistory(client,{index:'NIKKEI',start:'2026-01-01',end:'2026-02-01'}),/INVALID_REQUEST/);
});
