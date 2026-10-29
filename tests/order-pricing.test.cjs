const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {usableBook,target,onGrid,shouldRevise}=require('../electron/order-pricing.cjs');
const now=Date.parse('2026-10-29T13:31:00Z');const reply=(bid,ask,{age=1000,status='available'}={})=>({status,retrievedAt:now-age,data:{bid,ask,quoteAt:now-60000}});

test('a sale is placed at the best bid and a purchase at the best ask, not at a quote',()=>{
  // 2026-10-29 22:31 KST: the context quote was $287.65 (pre-open); the book's best bid was $285.32.
  const book=usableBook(reply(285.32,285.48),now);assert.deepEqual(target({side:'Sell',book,market:'US'}),{price:285.32,best:285.32,atBound:false});
  assert.equal(target({side:'Buy',book,market:'US'}).price,285.48);
  const kr=usableBook(reply(60300,60400),now);assert.equal(target({side:'Sell',book:kr,market:'KR'}).price,60300);assert.equal(target({side:'Buy',book:kr,market:'KR'}).price,60400);
});
test('the agent’s bound holds the price: never below a sale’s floor or above a purchase’s cap, rounded so it is never crossed',()=>{
  const book=usableBook(reply(278.4,278.6),now);
  assert.deepEqual(target({side:'Sell',book,bound:280,market:'US'}),{price:280,best:278.4,atBound:true},'bid below the floor: held at the floor');
  assert.equal(target({side:'Sell',book,bound:270,market:'US'}).price,278.4,'floor below the bid: the bid');
  assert.deepEqual(target({side:'Buy',book,bound:278.5,market:'US'}),{price:278.5,best:278.6,atBound:true});assert.equal(target({side:'Buy',book,bound:300,market:'US'}).price,278.6);
  assert.equal(target({side:'Sell',book,bound:280.001,market:'US'}).price,280.01,'a floor between cents rounds up');assert.equal(target({side:'Buy',book,bound:278.559,market:'US'}).price,278.55,'a cap rounds down');
  const kr=usableBook(reply(59800,59900),now);assert.equal(target({side:'Sell',book:kr,bound:60030,market:'KR'}).price,60100,'Korean floor rounds up to the 100-won tick');assert.equal(target({side:'Buy',book:kr,bound:59870,market:'KR'}).price,59800,'cap rounds down');
  assert.equal(onGrid(279.5,1,'US'),279.5,'float noise does not add a cent');assert.equal(onGrid(1.1,1,'US'),1.1);assert.equal(onGrid(4999,1,'KR'),5000,'5-won ticks below 5,000');
});
test('only a fresh two-sided book is used; a 0.2% change revises, less does not',()=>{
  assert.equal(usableBook(reply(100,101,{age:11000}),now),null,'read over 10 s ago');assert.ok(usableBook(reply(100,101,{age:9000}),now));
  assert.equal(usableBook(reply(0,101),now),null,'no bid');assert.equal(usableBook(reply(100,null),now),null,'no ask');assert.equal(usableBook(reply(101,100),now),null,'crossed');
  assert.equal(usableBook({status:'unavailable',reason:'NO_TWO_SIDED_BOOK'},now),null);assert.equal(usableBook(null,now),null);assert.equal(usableBook(reply(100,101,{age:-5000}),now),null,'from the future');
  assert.ok(usableBook({...reply(100,101),data:{bid:100,ask:101,quoteAt:now-600000}},now),'a quiet book that has not changed for 10 minutes is still current');
  assert.equal(shouldRevise(287.64,285.32),true,'0.81%');assert.equal(shouldRevise(280,279.44),true,'exactly 0.2%');assert.equal(shouldRevise(280,279.5),false,'0.18%');assert.equal(shouldRevise(280,280.6),true,'up as well');
});
function automation(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));a.waits_=0;a.wait=async()=>{a.waits_++;};return {a,events};}
test('placement retries every 3 s for up to a minute without a book, then asks for a review; it stops when no longer wanted',async()=>{
  const {a,events}=automation();let reads=0;let clock=Date.now();const realNow=Date.now;Date.now=()=>clock;a.wait=async ms=>{clock+=ms;};
  try{a.orderBook=async()=>{reads++;return {status:'unavailable',reason:'NO_TWO_SIDED_BOOK'};};
    assert.equal(await a.placementPrice({symbol:'NASD:GOOGL',side:'Sell',id:'R1'}),null);assert.equal(reads,21,'at 0, 3, ... 60 s');assert.equal(a.reviewRequested.trigger,'Order not placed');assert.match(a.reviewRequested.reason,/NO_TWO_SIDED_BOOK/);
    assert.equal(events.filter(e=>e.title==='Order waits for the order book').length,1,'logged once');
    let n=0;a.reviewRequested=null;a.orderBook=async()=>{n++;return n<3?{status:'unavailable'}:{status:'available',retrievedAt:clock,data:{bid:285.32,ask:285.48}};};
    const p=await a.placementPrice({symbol:'NASD:GOOGL',side:'Sell',id:'R2'});assert.equal(p.price,285.32);assert.equal(n,3,'found on the third read, 6 s later');assert.equal(a.reviewRequested,null);assert.ok(events.some(e=>e.title==='Order priced'&&/best bid 285.32/.test(e.body)));
    a.orderBook=async()=>{throw new Error('KIS_NOT_CONNECTED');};let wanted=2;assert.equal(await a.placementPrice({symbol:'005930',side:'Buy',id:'R3',still:()=>wanted-->0}),null);assert.equal(a.reviewRequested,null,'the account changed: no review asked');
  }finally{Date.now=realNow;}
});
test('a requested review starts once when nothing else runs, with the reason as its evidence',async()=>{
  const {a}=automation();const started=[];a.review=async trigger=>{started.push([trigger,a.triggerEvidence]);};a.schedulerStatus=()=>({label:'Monitoring'});a.config.scope='kis';
  a.requestReview('Order not placed','Sell NASD:GOOGL could not be priced');a.tick();assert.deepEqual(started,[['Order not placed',{kind:'placement',reason:'Sell NASD:GOOGL could not be priced'}]]);
  a.tick();assert.equal(started.length,1,'once');a.requestReview('Order not placed','x');a.busy=true;a.tick();assert.equal(started.length,1,'not while a review runs');
});
test('an unreadable book asks for at most one review per symbol every 15 minutes',async()=>{
  const {a}=automation();a.orderBook=async()=>({status:'unavailable'});let clock=Date.now();const realNow=Date.now;Date.now=()=>clock;a.wait=async ms=>{clock+=ms;};
  try{await a.placementPrice({symbol:'NASD:GOOGL',side:'Sell',id:'R1'});assert.ok(a.reviewRequested);a.reviewRequested=null;
    await a.placementPrice({symbol:'NASD:GOOGL',side:'Sell',id:'R2'});assert.equal(a.reviewRequested,null,'a minute later: no second review');
    await a.placementPrice({symbol:'NASD:NVDA',side:'Sell',id:'R3'});assert.ok(a.reviewRequested,'another symbol is its own');a.reviewRequested=null;
    clock+=15*60000;await a.placementPrice({symbol:'NASD:GOOGL',side:'Sell',id:'R4'});assert.ok(a.reviewRequested,'after 15 minutes');}finally{Date.now=realNow;}
});
