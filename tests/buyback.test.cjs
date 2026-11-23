// The buy-back block and the review context's facts about orders made outside the app (the user's rule; found in live
// use). Made-up symbols, order numbers, days and amounts.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {BuybackBlocks,blocksFrom,outsideCashTrades,refusal}=require('../electron/buyback.cjs');const {apply}=require('../electron/outside-context.cjs');
const at=s=>Date.parse(s);
const row=(orderId,side,time,extra={})=>({orderId,originalOrderId:null,symbol:'123450',side,filled:1,quantity:1,remaining:0,executionAmount:50000,timestamp:at(time),creditName:side==='Sell'?'현금매도':'현금매수',market:'KR',day:time.slice(0,10),status:'Filled',...extra});
test('a sale made outside the app blocks app buys for 30 days; an outside buy lifts it; a Remove lifts it until the next sale',()=>{
  const now=at('2026-10-10T12:00:00+09:00');const trades=outsideCashTrades([row('11','Sell','2026-10-05T09:10:00+09:00')],[],'KR');
  const [b]=blocksFrom(trades,{},now);assert.deepEqual({symbol:b.symbol,soldOn:b.soldOn,blockedUntil:b.blockedUntil},{symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'});
  assert.equal(refusal(b),'Not sent: you sold 123450 outside the app on 2026-10-05; app buys of it are blocked until 2026-11-04, or until you remove it in Activity.');
  assert.deepEqual(blocksFrom(trades,{},at('2026-11-05T12:00:00+09:00')),[],'day 31: no block');
  assert.deepEqual(blocksFrom(outsideCashTrades([row('11','Sell','2026-10-05T09:10:00+09:00'),row('12','Buy','2026-10-06T09:10:00+09:00')],[],'KR'),{},now),[],'your buy outside the app lifts it');
  assert.deepEqual(blocksFrom(trades,{'KR|123450':at('2026-10-06T00:00:00+09:00')},now),[],'removed');
  const again=outsideCashTrades([row('11','Sell','2026-10-05T09:10:00+09:00'),row('13','Sell','2026-10-08T09:10:00+09:00')],[],'KR');assert.equal(blocksFrom(again,{'KR|123450':at('2026-10-06T00:00:00+09:00')},now)[0].soldOn,'2026-10-08','a later sale blocks again');
});
test("nothing is listed for the app's own sale, a short sale made outside the app, or a margin order; U.S. sales are listed the same way",()=>{
  const now=at('2026-10-10T12:00:00+09:00');
  assert.deepEqual(outsideCashTrades([row('21','Sell','2026-10-05T09:10:00+09:00')],[{market:'KR',brokerOrderId:'21',day:'2026-10-05'}],'KR'),[],"the app's sale");
  assert.deepEqual(outsideCashTrades([row('22','Sell','2026-10-05T09:10:00+09:00',{creditName:'유대신규'}),row('23','Sell','2026-10-05T09:11:00+09:00',{creditName:'유통융자상환'})],[],'KR'),[]);
  const us=outsideCashTrades([{orderId:'31',symbol:'NASD:NWTH',side:'Sell',filled:2,timestamp:at('2026-10-05T23:40:00+09:00'),market:'US',day:'2026-10-05'}],[],'US');assert.equal(blocksFrom(us,{},now)[0].symbol,'NASD:NWTH');
  const db=new DatabaseSync(':memory:');const store=new BuybackBlocks(db,()=>now);const src=[{market:'KR',rows:[row('24','Sell','2026-10-05T09:10:00+09:00')],intents:[]}];
  assert.equal(store.list('acct',src).length,1);store.remove('acct','KR','123450');assert.deepEqual(store.list('acct',src),[]);assert.throws(()=>store.remove('acct','XX','123450'),/INVALID_REQUEST/);
});
test('an app buy of a blocked stock is refused with the words; a sale and your own ticket are not',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,holdings:[{symbol:'123450',name:'S',quantity:5,cost:50000,price:50000}]};
  const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot}));e.configure({symbols:['123450'],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  e.buybackBlock=s=>s==='123450'?{symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'}:null;
  assert.throws(()=>e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000}),err=>err.message==='BUYBACK_BLOCKED'&&/you sold 123450 outside the app on 2026-10-05/.test(err.detail));
  assert.ok(e.propose({symbol:'123450',side:'Sell',quantity:1,limitPrice:50000}).id,'a sale');
  assert.ok(e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000},{ticket:true}).id,'your own ticket');
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(src,/live\.propose\(command,\{ticket:true\}\)/);assert.match(src,/usLive\.propose\(args\[0\],\{ticket:true\}\)/);
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','electron','order-outcomes.cjs'),'utf8'),/'BUYBACK_BLOCKED'/,'an order-level refusal: the rest of a batch continues');
});
test('the review context gets the facts in fields of their own; the app\'s memory and its reversal check are unchanged',()=>{
  const PM=require('../electron/position-memory.cjs');
  const ctx={positions:{},positionMemory:[{symbol:'123450',holding:0,lastMaterial:'exit',lastExit:{decisionId:'r1',filledAt:'2026-10-01T00:00:00.000Z',effect:'CLOSE_LONG',rationale:'exit thesis'}}],
    planGap:{targets:[{symbol:'123450',targetPct:5,heldPct:0}]},reviewWatches:[{symbol:'123450',direction:'below',price:45000,updatedAt:at('2026-10-02T09:00:00+09:00')}]};
  apply(ctx,{trades:[{market:'KR',symbol:'123450',side:'Sell',filled:3,at:at('2026-10-05T09:10:00+09:00'),orderId:'41'},{market:'KR',symbol:'234560',side:'Buy',filled:2,at:at('2026-10-06T09:10:00+09:00'),orderId:'42'}],
    blocks:[{symbol:'123450',soldOn:'2026-10-05',soldAt:at('2026-10-05T09:10:00+09:00'),blockedUntil:'2026-11-04'}],openOrders:[{market:'KR',symbol:'345670',side:'Sell',quantity:4,remaining:4,price:30000,at:at('2026-10-07T09:00:00+09:00'),orderId:'43'}]});
  assert.equal(ctx.ordersMadeOutsideApp.trades.length,2);assert.match(ctx.buybackBlocked.rule,/refused for 30 days/);assert.equal(ctx.buybackBlocked.stocks.length,1,'the rule once, the stocks listed');assert.equal(ctx.openOrdersOutsideApp[0].remaining,4);
  const m=ctx.positionMemory.find(x=>x.symbol==='123450');assert.equal(m.lastMaterial,'exit');assert.equal(m.lastExit.rationale,'exit thesis','the app\'s exit untouched');assert.equal(m.lastOutsideExit.shares,3);
  const r=PM.reversalOf({action:'Buy',symbol:'123450',quantity:1,credit:'none'},ctx.positionMemory,{now:at('2026-10-08T00:00:00+09:00')});assert.equal(r?.required,true,'the reversal check still sees the app\'s exit');
  assert.ok(ctx.positionMemory.find(x=>x.symbol==='234560').lastOutsideEntry);assert.deepEqual(ctx.planGap.targets[0].soldByYouOutsideApp,{on:'2026-10-05',shares:3});assert.equal(ctx.reviewWatches[0].setWhileHeld,true);
  const plain={positions:{}};apply(plain,{trades:[],blocks:[],openOrders:[]});assert.deepEqual(plain,{positions:{}},'nothing added without facts');
  const big={positions:{},positionMemory:Array.from({length:10},(_,i)=>({symbol:'S'+i}))};apply(big,{trades:[{market:'KR',symbol:'999990',side:'Buy',filled:1,at:at('2026-10-05T09:00:00+09:00'),orderId:'1'}],blocks:[],openOrders:[]});assert.equal(big.positionMemory.length,10,'within the memory\'s limit');
  const rc=require('../electron/review-context.cjs');assert.equal(rc.classOf('buybackBlocked'),'protective');assert.equal(rc.classOf('openOrdersOutsideApp'),'protective');assert.ok(rc.REFERENCE_ORDER.includes('ordersMadeOutsideApp'));
});
test('a plan target is not marked after a buy-back outside the app or the app\'s own later fill',()=>{
  const ctx={positions:{},positionMemory:[{symbol:'123450',lastEntry:{filledAt:'2026-10-07T00:00:00.000Z',effect:'OPEN_LONG'}}],planGap:{targets:[{symbol:'123450'}]},reviewWatches:[]};
  apply(ctx,{trades:[{market:'KR',symbol:'123450',side:'Sell',filled:1,at:at('2026-10-05T09:10:00+09:00'),orderId:'51'}],blocks:[{symbol:'123450',soldOn:'2026-10-05',soldAt:at('2026-10-05T09:10:00+09:00'),blockedUntil:'2026-11-04'}],openOrders:[]});
  assert.equal(ctx.planGap.targets[0].soldByYouOutsideApp,undefined);
  const none={positions:{},planGap:{targets:[{symbol:'123450'}]}};apply(none,{trades:[{market:'KR',symbol:'123450',side:'Sell',filled:1,at:at('2026-10-05T09:10:00+09:00'),orderId:'52'}],blocks:[],openOrders:[]});assert.equal(none.planGap.targets[0].soldByYouOutsideApp,undefined,'no standing block (lifted): not marked');
});
test('U.S. rows in the engine\'s real shape (no time on older records); one market that cannot be read leaves the other\'s blocks',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot:{accountKey:'acct:US',environment:'mock'}}),{market:'US'});e.identity=()=>'acct:US';
  e.recordHistory({orders:[{orderId:'0000071',originalOrderId:null,kind:'order',symbol:'NYSE:BRK/B',side:'Sell',quantity:2,filled:2,remaining:0,orderPrice:400,fillPrice:400,status:'Filled'},{orderId:'0000072',timestamp:at('2026-10-06T23:40:00+09:00'),symbol:'NASD:NWTH',side:'Sell',quantity:1,filled:1,remaining:0,status:'Filled'}]},'2026-10-05');
  const rows=e.historyRange('2026-10-01');const store=new BuybackBlocks(new DatabaseSync(':memory:'),()=>at('2026-10-10T12:00:00+09:00'));
  const list=store.list('acct',[{market:'US',rows,intents:[]},{market:'KR',rows:null,intents:null}]);assert.deepEqual(list.map(b=>b.symbol).sort(),['NASD:NWTH','NYSE:BRK/B']);
  const kr=[{market:'KR',rows:[row('61','Sell','2026-10-05T09:10:00+09:00')],intents:[]}],errors=[];const both=store.list('acct',[...kr,{market:'US',rows:[{get symbol(){throw new Error('BAD');},filled:1,market:'US'}],intents:[]}],undefined,errors);
  assert.deepEqual(both.map(b=>b.symbol),['123450'],'Korea kept');assert.equal(errors[0].market,'US');
  store.remove('acct','US','NYSE:BRK/B');assert.deepEqual(store.list('acct',[{market:'US',rows,intents:[]}]).map(b=>b.symbol),['NASD:NWTH'],'a symbol with / can be removed');
});
test('an app order whose KIS reply was lost, a row without a kind name, and a partly filled then cancelled sale',()=>{
  assert.deepEqual(outsideCashTrades([row('81','Sell','2026-10-05T09:10:00+09:00')],[{market:'KR',status:'Uncertain',symbol:'123450',side:'Sell',day:'2026-10-05',quantity:1,createdAt:at('2026-10-05T09:09:00+09:00')}],'KR'),[],'may be the app\'s own order');
  assert.deepEqual(outsideCashTrades([row('82','Sell','2026-10-05T09:10:00+09:00',{creditName:undefined})],[],'KR'),[],'no kind name: never blocks');
  assert.equal(outsideCashTrades([row('83','Sell','2026-10-05T09:10:00+09:00',{quantity:3,filled:1,status:'Partially filled / canceled'})],[],'KR').length,1);
});
function engine(){const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const sent=[];const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,holdings:[{symbol:'123450',name:'S',quantity:5,cost:50000,price:50000}]};
  const e=new LiveEngine(db,{request:async(op)=>{sent.push(op);if(op==='place-order')return {brokerOrderId:'0000091',organization:'1'};if(op==='revise-order')return {brokerOrderId:'0000092'};if(op==='orders')return {orders:[]};return {};}},()=>({status:'connected',snapshot}));
  e.configure({symbols:['123450'],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');return {e,sent};}
test('a proposal made before the block is not sent after it; your ticket is; the list failing is recorded, never silent',async()=>{
  const {e}=engine();const p=e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000});e.buybackBlock=()=>({symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'});
  await assert.rejects(()=>e.submit(p.id,'PLACE MOCK ORDER'),err=>err.message==='BUYBACK_BLOCKED'&&/blocked until 2026-11-04/.test(err.detail));
  const t=e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000},{ticket:true});e.annotate(t.id,{madeBy:'ticket'});const sentTicket=await e.submit(t.id,'PLACE MOCK ORDER').catch(err=>err);assert.notEqual(sentTicket?.message,'BUYBACK_BLOCKED','your ticket is sent');
  // The user's rule: a check that throws fails closed (buys wait), recorded for Home; a sale is not held.
  const f=engine();f.e.buybackBlock=()=>{throw new Error('BROKEN');};assert.throws(()=>f.e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000}),err=>err.message==='BUYBACK_UNKNOWN'&&/could not read the orders you made outside the app in the Korean account/.test(err.detail));
  assert.equal(f.e.buybackFailure?.error,'BROKEN','recorded for Home');assert.ok(f.e.propose({symbol:'123450',side:'Sell',quantity:1,limitPrice:50000}).id,'a sale is not held');
});
test("buys wait while a market's history is not ready (the user's rule); one market never holds the other; the ticket, sales, covers are exempt",()=>{
  const B=require('../electron/buyback.cjs');
  assert.deepEqual(B.blockFor({ready:false,market:'KR',symbol:'123450'}),{unknown:true,market:'KR',why:'not read yet'},'the start window');
  assert.deepEqual(B.blockFor({ready:true,errors:[{market:'US'}],list:[],market:'KR',symbol:'123450'}),null,'a U.S. failure does not hold Korea');
  assert.equal(B.blockFor({ready:true,errors:[{market:'US'}],list:[],market:'US',symbol:'NASD:NWTH'}).why,'could not be read');
  assert.match(B.waitWords({market:'KR',why:'not read yet'}),/has not yet read the orders you made outside the app in the Korean account/);
  assert.equal(B.appliesTo({side:'Buy'}),true);assert.equal(B.appliesTo({side:'Buy',credit:'margin-buy'}),true,'a margin buy');assert.equal(B.appliesTo({side:'Buy',credit:'cover'}),false,'a cover');
  assert.equal(B.appliesTo({side:'Sell'}),false);assert.equal(B.appliesTo({side:'Buy',ticket:true}),false,'your ticket');
  const {e}=engine();e.buybackBlock=()=>B.blockFor({ready:false,market:'KR',symbol:'123450'});
  assert.throws(()=>e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000}),/BUYBACK_UNKNOWN/);assert.ok(e.propose({symbol:'123450',side:'Buy',quantity:1,limitPrice:50000},{ticket:true}).id,'your ticket is not held');
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','electron','order-outcomes.cjs'),'utf8'),/'BUYBACK_UNKNOWN'/,'an order-level refusal: a batch continues');
});
test('U.S. end to end through the engine: a blocked stock is refused, your ticket is not; symbols are compared as KIS gives them (exchange and ticker)',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const B=require('../electron/buyback.cjs');const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct:US',environment:'mock',reportedTotal:10000,cash:10000,holdings:[]};
  const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot}),{market:'US'});e.configure({symbols:['NASD:NWTH','NYSE:NWTH'],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  const blocks=B.blocksFrom(B.outsideCashTrades([{orderId:'0000071',timestamp:at('2026-10-05T23:40:00+09:00'),symbol:'NASD:NWTH',side:'Sell',filled:1,market:'US',day:'2026-10-05'}],[],'US'),{},at('2026-10-08T12:00:00+09:00'));
  e.buybackBlock=s=>B.blockFor({ready:true,list:blocks,market:'US',symbol:s});
  let err=null;try{e.propose({symbol:'NASD:NWTH',side:'Buy',quantity:1,limitPrice:10});}catch(x){err=x;}assert.equal(err?.message,'BUYBACK_BLOCKED');
  let ok=null;try{ok=e.propose({symbol:'NASD:NWTH',side:'Buy',quantity:1,limitPrice:10},{ticket:true});}catch(x){ok=x;}assert.notEqual(ok?.message,'BUYBACK_BLOCKED','the ticket');
  let other=null;try{other=e.propose({symbol:'NYSE:NWTH',side:'Buy',quantity:1,limitPrice:10});}catch(x){other=x;}assert.notEqual(other?.message,'BUYBACK_BLOCKED','another exchange prefix is another symbol');
});
test('shape() keeps the new sections registered, with their dates and the rule',()=>{
  const RC=require('../electron/review-context.cjs');const ctx={environment:'kis',market:'KR',currency:'KRW',equity:1e7,cash:5e6,positions:{},quotes:[],universe:[]};
  apply(ctx,{trades:[{market:'KR',symbol:'123450',side:'Sell',filled:3,at:at('2026-10-05T09:10:00+09:00'),orderId:'41'}],blocks:Array.from({length:30},(_,i)=>({symbol:String(100000+i),soldOn:'2026-10-05',soldAt:at('2026-10-05T09:10:00+09:00'),blockedUntil:'2026-11-04'})),openOrders:[]});
  const out=RC.shape(ctx).context;assert.equal(out.buybackBlocked.stocks.length,20,'bounded');assert.equal(out.buybackBlocked.stocks[0].blockedUntil,'2026-11-04');assert.match(out.buybackBlocked.rule,/30 days/);assert.ok(out.ordersMadeOutsideApp.trades[0].at);
});
