const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {orderBook,validRequest,DATASETS}=require('../electron/market-evidence.cjs');const {fetchEvidence}=require('../electron/kis-evidence.cjs');
// Shapes from read-only live KIS asking-price quotations on 2026-10-22 (TIGER S&P500 after the close, NVDA pre-market).
const levels=(prefix,prices,sizes)=>Object.fromEntries(prices.flatMap((p,i)=>[[prefix[0]+(i+1),String(p)],[prefix[1]+(i+1),String(sizes[i])]]));
const KR={rt_cd:'0',output1:{aspr_acpt_hour:'160000',...levels(['askp','askp_rsqn'],[25285,25290,25295,25300,25305,0,0,0,0,0],[9125,8000,7000,6000,5000,0,0,0,0,0]),...levels(['bidp','bidp_rsqn'],[25280,25275,25270,25265,25260,0,0,0,0,0],[32336,9000,8000,7000,6000,0,0,0,0,0]),total_askp_rsqn:'260878',total_bidp_rsqn:'289688'},output2:{antc_cnpr:'25285',stck_prpr:'25285'}};
const US={rt_cd:'0',output1:{last:'216.6600',dymd:'20261022',dhms:'183344'},output2:{pbid1:'216.6200',pask1:'216.6800',vbid1:'21',vask1:'7',pbid2:'216.6000',pask2:'216.6900',vbid2:'100',vask2:'1'}};
test('the KIS asking-price quotation becomes best bid/ask, spread and levels; one-sided or empty books are unavailable',()=>{
  const kr=orderBook(KR);assert.deepEqual({bid:kr.bid,ask:kr.ask,bidSize:kr.bidSize,askSize:kr.askSize,spread:kr.spread,spreadPct:kr.spreadPct,quoteTime:kr.quoteTime,totalBidSize:kr.totalBidSize},{bid:25280,ask:25285,bidSize:32336,askSize:9125,spread:5,spreadPct:0.02,quoteTime:'16:00:00 KST',totalBidSize:289688});
  assert.equal(kr.levels.length,5,'zero-priced levels are absent, not prices');
  const us=orderBook(US,true);assert.deepEqual({bid:us.bid,ask:us.ask,spreadPct:us.spreadPct,quoteTime:us.quoteTime,levels:us.levels.length},{bid:216.62,ask:216.68,spreadPct:0.03,quoteTime:'2026-10-22 18:33:44 KST',levels:2});
  assert.equal(orderBook({output1:{askp1:'0',bidp1:'25280'}}),null,'no ask: unavailable');
  assert.equal(orderBook({output1:{askp1:'100',bidp1:'101'}}),null,'crossed book: unavailable');
  assert.equal(orderBook({}),null);
  assert.ok(DATASETS.includes('order_book'));assert.ok(validRequest({symbol:'360750',dataset:'order_book'},['360750']));
});
test('order_book is fetched read-only from the matching KIS quotation for each market',async()=>{
  const calls=[];const client={quotation:async(path,tr,params)=>{calls.push([path,tr,params.FID_INPUT_ISCD]);return KR;},overseasRequest:async(path,tr,params)=>{calls.push([path,tr,params.SYMB]);return {body:US};}};
  const kr=await fetchEvidence(client,{symbol:'360750',dataset:'order_book'});assert.equal(kr.status,'available');assert.equal(kr.data.ask,25285);assert.equal(kr.currency,'KRW');
  const us=await fetchEvidence(client,{symbol:'NASD:NVDA',dataset:'order_book'});assert.equal(us.data.bid,216.62);assert.equal(us.currency,'USD');
  assert.deepEqual(calls,[['inquire-asking-price-exp-ccn','FHKST01010200','360750'],['/uapi/overseas-price/v1/quotations/inquire-asking-price','HHDFS76200100','NVDA']]);
  const empty=await fetchEvidence({quotation:async()=>({output1:{}})},{symbol:'005930',dataset:'order_book'});assert.deepEqual([empty.status,empty.reason],['unavailable','NO_TWO_SIDED_BOOK']);
});
function automation(){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],async()=>50000),{request:async()=>({})},()=>{});
  const asked=[];a.evidence={get:async args=>{asked.push(args.symbol);return args.symbol==='000270'?{symbol:args.symbol,status:'unavailable'}:{symbol:args.symbol,dataset:'order_book',status:'available',data:{bid:100,ask:101,bidSize:5,askSize:7,spreadPct:1,quoteTime:'10:00:00 KST',levels:[]}};}};
  return {a,asked};
}
const session=open=>({open,status:open?'open':'closed',...(open?{session:{id:'regular',regular:true}}:{})});
test('reviews get the live book for holdings, scout targets and watches whose regular session is open',async()=>{
  const {a,asked}=automation();
  const context={environment:'kis-combined',markets:[{market:'KR',marketSession:session(true)},{market:'US',marketSession:session(false)}],
    universe:['005930','000270','360750','069500','NASD:AMZN'].map(symbol=>({symbol})),positions:{'069500':{quantity:2}},
    scoutPlan:{targets:[{symbol:'005930'},{symbol:'000270'},{symbol:'NASD:AMZN'},{symbol:'999999'}]},reviewWatches:[{symbol:'360750'}]};
  await a.attachOrderBooks(context);
  assert.deepEqual(asked,['069500','005930','000270','360750'],'U.S. closed and out-of-universe symbols are not read');
  assert.deepEqual(context.orderBooks.map(b=>b.symbol),['069500','005930','360750'],'unavailable books are left out');
  assert.deepEqual(Object.keys(context.orderBooks[0]),['symbol','bid','ask','bidSize','askSize','spreadPct','quoteTime']);
  const closed={...context,markets:[{market:'KR',marketSession:session(false)},{market:'US',marketSession:session(false)}]};delete closed.orderBooks;
  await a.attachOrderBooks(closed);assert.equal('orderBooks' in closed,false,'no book outside regular sessions');
  const paper={environment:'local-paper',universe:[{symbol:'005930'}],positions:{'005930':{quantity:1}}};await a.attachOrderBooks(paper);assert.equal('orderBooks' in paper,false);
});
test('a changing order book alone does not stop an unchanged review from being skipped',()=>{
  const {fingerprint}=require('../electron/token-saver.cjs');const base={universe:[],quotes:[]};
  assert.equal(fingerprint({...base,orderBooks:[{symbol:'360750',bid:1,ask:2}]}).exact,fingerprint({...base,orderBooks:[{symbol:'360750',bid:3,ask:4}]}).exact);
});
