const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient,normalizeBalance}=require('../electron/kis-client.cjs');const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
const live={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const row=(extra)=>({pdno:'005930',prdt_name:'Samsung',hldg_qty:'10',pchs_avg_pric:'70000',prpr:'72000',evlu_amt:'720000',evlu_pfls_amt:'20000',ord_psbl_qty:'10',trad_dvsn_name:'현금',...extra});
test('balance merges cash and margin rows per symbol, lists shorts separately and values the account at net assets',()=>{
  const b=normalizeBalance([row(),row({hldg_qty:'5',evlu_amt:'360000',evlu_pfls_amt:'10000',ord_psbl_qty:'5',trad_dvsn_name:'자기융자',loan_dt:'20260901',loan_amt:'350000',expd_dt:'20261230'}),row({pdno:'000660',prdt_name:'SK hynix',hldg_qty:'3',pchs_avg_pric:'0',prpr:'200000',evlu_amt:'600000',evlu_pfls_amt:'0',ord_psbl_qty:'3',trad_dvsn_name:'유통대주',loan_dt:'20261001',stln_slng_chgs:'540000',expd_dt:'20261230'})],{dnca_tot_amt:'1000000',tot_evlu_amt:'2680000',tot_loan_amt:'350000',tot_stln_slng_chgs:'540000',nass_amt:'1790000'},'live');
  const samsung=b.holdings.find(h=>h.symbol==='005930');assert.equal(samsung.quantity,15);assert.equal(samsung.availableQuantity,15);assert.equal(samsung.loans.length,1);assert.deepEqual([samsung.loans[0].loanDate,samsung.loans[0].source,samsung.loans[0].amount],['2026-09-01','self',350000]);
  assert.equal(b.holdings.length,1,'the short is not a holding');assert.deepEqual([b.shorts[0].symbol,b.shorts[0].quantity,b.shorts[0].entryPrice,b.shorts[0].source],['000660',3,180000,'distribution']);
  assert.equal(b.reportedTotal,1790000);assert.equal(b.grossTotal,2680000);
  assert.equal(normalizeBalance([row()],{dnca_tot_amt:'1',tot_evlu_amt:'720001'},'mock').reportedTotal,720001,'cash accounts are unchanged');
  assert.throws(()=>normalizeBalance([row(),row()],{dnca_tot_amt:'1',tot_evlu_amt:'1'},'live'),/INVALID_RESPONSE/,'duplicate cash rows are still rejected');
});
const balance={environment:'live',reportedTotal:10000000,cash:2000000,loanTotal:1000000,holdings:[{symbol:'005930',name:'Samsung',quantity:20,price:72000,marketValue:1440000,loans:[{quantity:10,amount:700000,loanDate:'2026-09-01',expiry:'2026-10-20',source:'distribution'}]}],shorts:[{symbol:'000660',quantity:3,price:200000,entryPrice:180000,proceeds:540000,loanDate:'2026-10-01',expiry:null,source:'self'}]};
test('credit checks: switches, caps, KIS credit types by source, repayments always allowed',()=>{
  const e=new Exposure(new DatabaseSync(':memory:'));const base={account:'a',symbol:'005930',equity:10000000,balance};
  assert.throws(()=>e.checkCredit({...base,kind:'margin-buy',notional:100000}),/MARGIN_NOT_ENABLED/);assert.throws(()=>e.checkCredit({...base,kind:'short',notional:100000}),/SHORT_NOT_ENABLED/);
  assert.deepEqual(e.checkCredit({...base,kind:'margin-sell',notional:72000,loanDate:'2026-09-01'}),{type:'27',requiresApproval:false},'repay a 유통 loan with 27');
  assert.deepEqual(e.checkCredit({...base,symbol:'000660',kind:'cover',notional:600000,loanDate:'2026-10-01'}),{type:'28',requiresApproval:false});
  assert.throws(()=>e.checkCredit({...base,kind:'margin-sell',notional:1,loanDate:'2026-01-01'}),/INSUFFICIENT_CAPACITY/);
  e.savePolicy('a',{margin:{enabled:true,maxLoanPctOfEquity:15},short:{enabled:true,auto:true,maxGrossPctOfEquity:10}});
  assert.deepEqual(e.checkCredit({...base,kind:'margin-buy',notional:400000}),{type:'21',requiresApproval:true});assert.throws(()=>e.checkCredit({...base,kind:'margin-buy',notional:600000}),/MARGIN_LIMIT/);
  assert.deepEqual(e.checkCredit({...base,kind:'short',notional:300000}),{type:'22',requiresApproval:false},'distribution source by default, automatic');assert.throws(()=>e.checkCredit({...base,kind:'short',notional:500000}),/SHORT_LIMIT/);
  assert.throws(()=>e.savePolicy('a',{short:{source:'other'}}),/INVALID_SETTINGS/);
  const risk=e.creditRisk('a',balance,'2026-10-16');assert.equal(risk.margin.loans[0].daysToExpiry,4);assert.equal(risk.short.positions[0].adversePct,11.1);assert.equal(risk.short.positions[0].daysToRepay,75);
  assert.ok(risk.warnings.some(w=>/matures in 4 days/.test(w)));assert.ok(!risk.warnings.some(w=>/past your/.test(w)),'11% is below the 15% stop');
  e.savePolicy('a',{short:{stopLossPct:10}});assert.ok(e.creditRisk('a',balance,'2026-10-16').warnings.some(w=>/past your 10% stop/.test(w)));
});
function engine(environment){
  const d=new DatabaseSync(':memory:');const snapshot={...balance,accountKey:'acct',environment};const calls=[];
  const l=new LiveEngine(d,{request:async(op,payload)=>{calls.push([op,payload]);if(op==='prepare-order')return {ticket:'t',balance:snapshot};if(op==='place-order')return {brokerOrderId:'9'};throw new Error(op);}},()=>({status:'connected',snapshot}));
  l.exposure=new Exposure(d);l.configure({symbols:[],lossLimit:{mode:'off',value:0}},environment==='live'?'ENABLE LIVE':'ENABLE MOCK');return {l,calls};
}
test('live engine credit orders: unavailable on mock, approval-gated margin buy passes its credit type to the broker',async()=>{
  const mock=engine('mock');assert.throws(()=>mock.l.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:72000,credit:{kind:'margin-buy'}}),/FEATURE_UNAVAILABLE/);
  const {l,calls}=engine('live');assert.throws(()=>l.propose({symbol:'005930',side:'Sell',quantity:1,limitPrice:72000,credit:{kind:'margin-buy'}}),/INVALID_ORDER/,'side must match the credit kind');
  assert.throws(()=>l.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:72000,credit:{kind:'margin-buy'}}),/MARGIN_NOT_ENABLED/);
  l.exposure.savePolicy('acct',{margin:{enabled:true,maxLoanPctOfEquity:40}});l.enableAuto('ENABLE AUTO LIVE');
  const order=l.propose({symbol:'005930',side:'Buy',quantity:30,limitPrice:72000,credit:{kind:'margin-buy'}});assert.deepEqual(order.credit,{kind:'margin-buy',type:'21',loanDate:null});assert.equal(order.requiresApproval,true);
  assert.equal((await l.autoSubmit(order.id)).reason,'APPROVAL_REQUIRED');assert.equal(calls.length,0);
  const placed=await l.submit(order.id,'PLACE LIVE ORDER');assert.equal(placed.status,'Accepted','a margin buy larger than cash is funded by the loan');
  assert.deepEqual(calls[0][1].command.credit,{kind:'margin-buy',type:'21',loanDate:null});
  const repay=l.propose({symbol:'005930',side:'Sell',quantity:5,limitPrice:72000,credit:{kind:'margin-sell',loanDate:'2026-09-01'}});assert.equal(repay.credit.type,'27');assert.equal(repay.requiresApproval,false);
});
test('AI decisions: credit fields are optional for legacy decisions and must match the side and loan date',()=>{
  const {validateDecision}=require('../electron/ai-client.cjs');const s=['005930'];const base={symbol:'005930',quantity:1,explanation:'x'};
  assert.deepEqual(validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'x'},s),{action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:''});
  assert.equal(validateDecision({...base,action:'Sell',credit:'short',loanDate:''},s).credit,'short');
  assert.equal(validateDecision({...base,action:'Buy',credit:'cover',loanDate:'2026-10-01'},s).loanDate,'2026-10-01');
  for(const bad of [{action:'Buy',credit:'short',loanDate:''},{action:'Sell',credit:'margin-sell',loanDate:''},{action:'Buy',credit:'leverage',loanDate:''},{action:'Hold',credit:'margin-buy',loanDate:''}])assert.throws(()=>validateDecision({...base,...bad,...(bad.action==='Hold'?{symbol:'',quantity:0}:{})},s),/INVALID_AI_RESPONSE/);
});
test('client: credit orders are refused on mock, validated, and sent to order-credit with the loan date',async()=>{
  const mock=new KisReadOnlyClient({...live,environment:'mock'},async()=>{throw new Error('no network expected');});
  await assert.rejects(mock.prepareOrder({symbol:'005930',side:'Buy',quantity:1,limitPrice:100,credit:{kind:'margin-buy',type:'21'}}),/FEATURE_UNAVAILABLE/);
  await assert.rejects(mock.prepareOrder({symbol:'005930',side:'Buy',quantity:1,limitPrice:100,credit:{kind:'short',type:'22'}}),/INVALID_ORDER/,'short is a sale');
  await assert.rejects(mock.prepareOrder({symbol:'005930',side:'Sell',quantity:1,limitPrice:100,credit:{kind:'margin-sell',type:'25'}}),/INVALID_ORDER/,'repayment needs its loan date');
  const calls=[];const client=new KisReadOnlyClient(live,async(url,options)=>{calls.push({url,options});if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});if(url.includes('inquire-credit-psamount'))return reply({rt_cd:'0',output:{max_buy_qty:'7'}});if(url.includes('order-credit'))return reply({rt_cd:'0',output:{ODNO:'0001234'}});throw new Error(url);},async()=>{});
  client.checkSession=async()=>({open:true});client.getBalance=async()=>({accountKey:'fixture',reportedTotal:10000,holdings:[]});client.getActivity=async()=>({orders:[]});
  const command={symbol:'005930',side:'Buy',quantity:7,limitPrice:100,credit:{kind:'margin-buy',type:'21'}};assert.equal((await client.prepareOrder(command)).availableQuantity,7);
  await assert.rejects(client.prepareOrder({...command,quantity:8}),/INSUFFICIENT_CAPACITY/);
  assert.equal(new URL(calls.find(c=>c.url.includes('inquire-credit-psamount')).url).searchParams.get('CRDT_TYPE'),'21');
  assert.equal((await client.placeOrder(command)).brokerOrderId,'0001234');const post=calls.find(c=>c.url.includes('order-credit'));
  assert.equal(post.options.headers.tr_id,'TTTC0052U');const body=JSON.parse(post.options.body);assert.equal(body.CRDT_TYPE,'21');assert.match(body.LOAN_DT,/^\d{8}$/);
  await client.placeOrder({symbol:'005930',side:'Sell',quantity:2,limitPrice:100,credit:{kind:'margin-sell',type:'25',loanDate:'2026-09-01'}});const sell=calls.filter(c=>c.url.includes('order-credit')).at(-1);
  assert.equal(sell.options.headers.tr_id,'TTTC0051U');assert.equal(JSON.parse(sell.options.body).LOAN_DT,'20260901');
  // Observed on a live cash-only account: KIS answers APBK1617 to the credit capacity inquiry.
  const cashOnly=new KisReadOnlyClient(live,async url=>url.endsWith('/oauth2/tokenP')?reply({access_token:'t',expires_in:3600}):url.includes('inquire-price')?reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}}):reply({rt_cd:'4',msg_cd:'APBK1617',msg1:'신용계좌만 신용주문가능금액조회가 가능합니다.'}),async()=>{});
  cashOnly.checkSession=async()=>({open:true});cashOnly.getBalance=async()=>({holdings:[]});
  await assert.rejects(cashOnly.prepareOrder(command),/CREDIT_ACCOUNT_REQUIRED/);
});
