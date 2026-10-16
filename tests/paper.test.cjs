const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PaperEngine}=require('../electron/paper-engine.cjs');
function setup(){const db=new DatabaseSync(':memory:');let now=Date.now();let sequence=1;let price=100;const quotes=()=>[{symbol:'005930',price,timestamp:now,sequence,volume:10,stale:false}];const engine=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],quotes,()=>now);return {db,engine,advance:()=>{sequence++;now+=1000;},stale:()=>{now+=6000;},price:value=>{price=value;},quotes,clock:()=>now};}
test('paper caps default off and near-full single-company allocation is permitted',()=>{const {db,engine}=setup();try{engine.saveAccount({...engine.account(),cash:102000,dayBaseline:102000,paused:false});assert.equal(engine.getState().policy.maxDailyTurnoverKRW,null);assert.equal(engine.getState().policy.maxCompanyPct,null);assert.equal(engine.getState().loss.breached,false);const proposal=engine.propose({symbol:'005930',side:'Buy',quantity:1000});assert.equal(proposal.status,'Ready');engine.submit(proposal.id);assert.equal(engine.getState().account.availableCash,0);engine.setPaused(true);engine.setPaused(false);engine.configureCaps({maxCompanyPct:25});assert.equal(engine.propose({symbol:'005930',side:'Buy',quantity:1000}).reason,'CONCENTRATION_LIMIT');engine.configureCaps({});assert.equal(engine.propose({symbol:'005930',side:'Buy',quantity:1000}).status,'Ready');}finally{db.close();}});
test('amount and percentage loss thresholds preserve trading and allow exposure reduction',()=>{for(const policy of [{mode:'amount',value:100},{mode:'percent',value:.001}]){const f=setup();const {engine,db}=f;try{engine.configureLoss(policy);engine.setPaused(false);engine.submit(engine.propose({symbol:'005930',side:'Buy',quantity:2}).id);engine.tick();engine.submit(engine.propose({symbol:'005930',side:'Buy',quantity:1}).id);f.price(50);f.advance();engine.tick();const state=engine.getState();assert.equal(state.loss.breached,true);assert.equal(state.account.paused,false);assert.equal(state.fills.length,2);assert.ok(!state.orders.some(order=>order.reason==='DAILY_LOSS_LIMIT'));const reduce=engine.propose({symbol:'005930',side:'Sell',quantity:1});assert.equal(reduce.status,'Ready');engine.submit(reduce.id);f.advance();engine.tick();assert.equal(engine.getState().fills.length,3);assert.deepEqual(state.loss.policy,policy);const restarted=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],f.quotes,f.clock);assert.deepEqual(restarted.lossPolicy(),policy);assert.throws(()=>engine.configureLoss({mode:'percent',value:101}),/INVALID/);}finally{db.close();}}});
test('partial fills are idempotent per quote and fees/cost basis reconcile across buys and sells',()=>{
  const fixture=setup();const {engine,db}=fixture;
  try {
    engine.setPaused(false);let proposal=engine.propose({symbol:'005930',side:'Buy',quantity:5});assert.equal(proposal.status,'Ready');
    const order=engine.submit(proposal.id);assert.equal(engine.submit(proposal.id).id,order.id);assert.equal(engine.orders().length,1);
    engine.tick();engine.tick();assert.equal(engine.getState().fills.length,1);assert.equal(engine.getState().account.positions['005930'].quantity,2);
    fixture.advance();engine.tick();fixture.advance();engine.tick();assert.equal(engine.getState().account.cash,10000000-508);
    proposal=engine.propose({symbol:'005930',side:'Sell',quantity:5});engine.submit(proposal.id);
    for(let i=0;i<3;i++){fixture.advance();engine.tick();}
    const state=engine.getState();assert.equal(state.account.cash,10000000-16);assert.equal(state.account.realized,-16);assert.deepEqual(state.account.positions,{});
    assert.equal(state.account.reservedCash,0);
  }finally{db.close();}
});
test('pending reservations, stale proposals and paper pause prevent overspending or duplicate exposure',()=>{
  const fixture=setup();const {engine,db}=fixture;
  try {
    assert.equal(engine.propose({symbol:'005930',side:'Buy',quantity:1}).reason,'PAPER_PAUSED');engine.setPaused(false);
    const a=engine.propose({symbol:'005930',side:'Buy',quantity:1}),b=engine.propose({symbol:'005930',side:'Buy',quantity:1});
    engine.submit(a.id);assert.equal(engine.submit(b.id).reason,'PORTFOLIO_CHANGED');assert.ok(engine.getState().account.reservedCash>0);
    engine.setPaused(true);assert.equal(engine.getState().account.reservedCash,0);assert.equal(engine.orders()[0].status,'Canceled');
    assert.throws(()=>engine.propose({symbol:'005930',side:'Buy',quantity:1,appKey:'must-not-persist'}),/INVALID_REQUEST/);
  }finally{db.close();}
});
test('short sales, excessive order size and changed prices are blocked; restart preserves fills and cancels remaining orders',()=>{
  const fixture=setup();const {engine,db}=fixture;
  try {
    engine.setPaused(false);assert.equal(engine.propose({symbol:'005930',side:'Sell',quantity:1}).reason,'INSUFFICIENT_SHARES');
    engine.configureCaps({maxOrderKRW:1000000});fixture.price(100000);assert.equal(engine.propose({symbol:'005930',side:'Buy',quantity:20}).reason,'ORDER_SIZE_LIMIT');fixture.price(100);
    let proposal=engine.propose({symbol:'005930',side:'Buy',quantity:5});engine.submit(proposal.id);engine.tick();
    const restored=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],fixture.quotes,fixture.clock);
    assert.equal(restored.getState().account.positions['005930'].quantity,2);assert.equal(restored.getState().fills.length,1);assert.equal(restored.account().paused,true);assert.equal(restored.orders()[0].status,'Canceled');
    restored.setPaused(false);proposal=restored.propose({symbol:'005930',side:'Buy',quantity:1});fixture.price(150);assert.equal(restored.submit(proposal.id).reason,'PRICE_MOVED');
  }finally{db.close();}
});
