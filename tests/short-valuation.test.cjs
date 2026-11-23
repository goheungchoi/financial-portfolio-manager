// B3a: a short valued from KIS's own figures (found in live use, a distribution short opened and covered in KIS's app:
// net assets count a short as zero; its proceeds are in no cash figure). KIS's row and summary shapes with made-up
// symbols and figures.
const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeBalance}=require('../electron/kis-client.cjs');const {value}=require('../electron/valuation.cjs');const {cashEffect}=require('../electron/flow-detector.cjs');
const now=Date.now();const fx={usdKRW:1400,source:'test',timestamp:new Date(now).toISOString()};
const cashRow=(pdno,qty,price,extra={})=>({pdno,prdt_name:'Long',trad_dvsn_name:'현금',hldg_qty:String(qty),ord_psbl_qty:String(qty),pchs_avg_pric:String(price),prpr:String(price),evlu_amt:String(qty*price),evlu_pfls_amt:'0',loan_dt:'',loan_amt:'0',stln_slng_chgs:'0',expd_dt:'',...extra});
const shortRow=(pdno,qty,price,proceeds,extra={})=>({pdno,prdt_name:'Short',trad_dvsn_name:'유통대주',hldg_qty:String(qty),ord_psbl_qty:String(qty),pchs_avg_pric:String(proceeds/qty),prpr:String(price),evlu_amt:String(qty*price),evlu_pfls_amt:String(proceeds-qty*price),loan_dt:'20261007',loan_amt:String(qty*price),stln_slng_chgs:String(proceeds),expd_dt:'',...extra});
// The summary as KIS gives it: holdings at market (the short's row included), total = settled cash + holdings, net = total - loans.
function summary({settled,rows,loans,proceeds}){const scts=rows.reduce((n,r)=>n+Number(r.evlu_amt),0),total=settled+scts;
  return {dnca_tot_amt:String(settled),prvs_rcdl_excc_amt:String(settled),nxdy_excc_amt:String(settled),scts_evlu_amt:String(scts),tot_evlu_amt:String(total),tot_loan_amt:String(loans),nass_amt:String(total-loans),tot_stln_slng_chgs:String(proceeds)};}
const kr=(rows,s)=>({...normalizeBalance(rows,s,'live'),timestamp:new Date(now).toISOString()});
test('an open distribution short: net assets plus proceeds less the obligation, exact, with no range',()=>{
  const rows=[cashRow('111110',10,20000),shortRow('222220',2,49000,100000)];const k=kr(rows,summary({settled:3000000,rows,loans:98000,proceeds:100000}));
  assert.equal(k.shorts[0].loanAmount,98000);const v=value({korea:k,us:null,fx,now}).markets.KR;
  assert.equal(v.equity.low,3200000+2000,'net assets (3,000,000 + 200,000 long + 98,000 − 98,000) + 100,000 − 98,000');assert.equal(v.equity.high,v.equity.low);assert.equal(v.exact,true);assert.equal(v.credit.settled,true);
  assert.ok(!v.reasons.some(r=>/Stage 3|not yet verified/.test(r)),'no "unverified" reason');
});
test('the price moves: the value moves by the short\'s gain or loss; after the cover the row is zero and the value is plain',()=>{
  const up=[shortRow('222220',2,52000,100000)];const v=value({korea:kr(up,summary({settled:3000000,rows:up,loans:104000,proceeds:100000})),us:null,fx,now}).markets.KR;assert.equal(v.equity.low,3000000-4000);
  const after=[shortRow('222220',0,51000,0,{loan_amt:'0',evlu_amt:'0',evlu_pfls_amt:'0'})];const k=kr(after,summary({settled:3001500,rows:after,loans:0,proceeds:0}));assert.deepEqual(k.shorts??[],[],'a zero row is skipped');
  const plain=value({korea:k,us:null,fx,now}).markets.KR;assert.equal(plain.equity.low,3001500);assert.equal(plain.exact,true);
});
test('a stock held and shorted at once: two rows kept apart; the value is exact',()=>{
  const rows=[cashRow('222220',5,50000),shortRow('222220',1,50000,51000)];const k=kr(rows,summary({settled:1000000,rows,loans:50000,proceeds:51000}));
  assert.equal(k.holdings.find(h=>h.symbol==='222220').quantity,5);assert.equal(k.shorts.find(s=>s.symbol==='222220').quantity,1);
  const v=value({korea:k,us:null,fx,now}).markets.KR;assert.equal(v.equity.low,1000000+250000+1000);assert.equal(v.exact,true);
});
test('still a range: an own-stock-loan short, a margin loan, or figures that do not reconcile',()=>{
  const self=[shortRow('222220',1,50000,51000,{trad_dvsn_name:'자기대주'})];const a=value({korea:kr(self,summary({settled:1000000,rows:self,loans:50000,proceeds:51000})),us:null,fx,now}).markets.KR;
  assert.equal(a.exact,false);assert.match(a.reasons.join(' '),/own-stock-loan short/);
  const margin=[cashRow('111110',3,20000,{trad_dvsn_name:'유통융자',loan_amt:'30000',loan_dt:'20261001'}),shortRow('222220',1,50000,51000)];const b=value({korea:kr(margin,summary({settled:1000000,rows:margin,loans:80000,proceeds:51000})),us:null,fx,now}).markets.KR;
  assert.equal(b.exact,false);assert.match(b.reasons.join(' '),/margin loan/);
  const rows=[shortRow('222220',1,50000,51000)];const s=summary({settled:1000000,rows,loans:50000,proceeds:51000});s.nass_amt=String(Number(s.nass_amt)-5000);
  assert.equal(value({korea:kr(rows,s),us:null,fx,now}).markets.KR.exact,false,'net assets do not equal total less loans');
});
test("the app's own short and cover move Korean cash by the fees, and by the proceeds less the buy-back",()=>{
  const short={side:'Sell',symbol:'222220',filled:1,fillPrice:50000,credit:{kind:'short'},lotLoanDate:'2026-10-07',resultCosts:{netCash:49890}};assert.equal(cashEffect(short),-110,'fees and tax only');
  const cover={side:'Buy',symbol:'222220',filled:1,fillPrice:48000,credit:{kind:'cover',loanDate:'2026-10-07'},resultCosts:{netCash:-48010}};assert.equal(cashEffect(cover,[short,cover]),50000-48000-10);
  assert.equal(cashEffect(cover,[cover]),0,'no short of its lot known: not explained');
  // Two lots at different prices: each cover by its own lot; a partial cover of a lot.
  const lotB=[{side:'Sell',symbol:'222220',filled:2,fillPrice:60000,credit:{kind:'short'},lotLoanDate:'2026-10-20',resultCosts:{netCash:119700}},{side:'Sell',symbol:'222220',filled:2,fillPrice:62000,credit:{kind:'short'},lotLoanDate:'2026-10-20',resultCosts:{netCash:123700}}];
  const coverB={side:'Buy',symbol:'222220',filled:1,fillPrice:55000,credit:{kind:'cover',loanDate:'2026-10-20'},resultCosts:{netCash:-55010}};
  assert.equal(cashEffect(coverB,[short,...lotB,coverB]),61000-55000-10,'a partial cover of the second lot, by its own average');assert.equal(cashEffect(cover,[short,...lotB,cover]),50000-48000-10,'the first lot unchanged');
  const {resolve}=require('../electron/order-chain.cjs');assert.equal(resolve({brokerOrderId:'41',quantity:1},[{orderId:'41',filled:1,averagePrice:50000,status:'Filled',loanDate:'2026-10-07'}]).loanDate,'2026-10-07','the lot\'s loan date comes from KIS\'s history');
});
