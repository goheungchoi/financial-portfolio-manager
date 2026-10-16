const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {OutcomeLedger}=require('../electron/outcome-ledger.cjs');
function fixture(){const db=new DatabaseSync(':memory:');for(const table of ['reviews','live_intents','paper_orders','paper_fills'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,payload TEXT)`);return {db,ledger:new OutcomeLedger(db),put:(table,row)=>db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?)`).run(row.id,JSON.stringify(row))};}
test('broker cumulative partial fills replace outcomes, preserve estimates and link manual approval to decision',()=>{
  const {db,ledger,put}=fixture();try{
    put('reviews',{id:'review',proposalId:'order',orderId:null,decision:{action:'Sell',explanation:'Reduce exposure'}});
    const order={id:'order',accountKey:'private-account',environment:'mock',market:'US',currency:'USD',symbol:'NASD:AAPL',side:'Sell',quantity:4,filled:2,fillPrice:100,status:'Partially filled',createdAt:1,reconciledAt:2,resultCosts:{gross:200,commission:1,transactionTax:.01,netCash:198.99,gainAfterFees:-3,gainAfterEstimatedTax:null}};
    put('live_intents',order);ledger.sync();ledger.sync();assert.equal(ledger.list().length,1);assert.equal(ledger.list()[0].quantity,2);assert.equal(ledger.list()[0].reviewId,'review');assert.equal(ledger.list()[0].taxStatus,'Unknown');assert.equal(ledger.list()[0].accountKey,undefined);
    put('live_intents',{...order,filled:4,status:'Filled',resultCosts:{...order.resultCosts,gross:400,netCash:397.98,gainAfterFees:-6}});ledger.sync();const row=ledger.list()[0];assert.equal(row.quantity,4);assert.equal(row.gainAfterFees,-6);assert.equal(row.costBasis,'estimated');assert.match(row.evaluation,/cause unassessed/);
    const restarted=new OutcomeLedger(db);assert.equal(restarted.list()[0].quantity,4);
  }finally{db.close();}
});
test('paper executions aggregate exactly once, include fees, and link through proposal after manual submission',()=>{
  const {db,ledger,put}=fixture();try{
    put('reviews',{id:'r',proposalId:'p',decision:{explanation:'Test sale'}});put('paper_orders',{id:'o',proposalId:'p',symbol:'005930',side:'Sell',quantity:4,status:'Filled'});
    for(let i=0;i<2;i++)put('paper_fills',{id:'f'+i,orderId:'o',quantity:2,price:100+i,fee:1,realized:-5,timestamp:i+1});
    ledger.sync();ledger.sync();const row=ledger.list()[0];assert.equal(row.quantity,4);assert.equal(row.averagePrice,100.5);assert.equal(row.fees,2);assert.equal(row.netCash,400);assert.equal(row.gainAfterFees,-10);assert.equal(row.reviewId,'r');assert.equal(row.taxStatus,'Not modeled');assert.equal(row.gainAfterEstimatedTax,null);
  }finally{db.close();}
});
test('missing broker costs remain unknown; unrelated accounts and markets are separate',()=>{
  const {db,ledger,put}=fixture();try{
    for(const [id,market] of [['a','KR'],['b','US']])put('live_intents',{id,accountKey:id,market,environment:'mock',currency:market==='US'?'USD':'KRW',side:'Sell',filled:1,quantity:1,createdAt:1,status:'Filled'});
    ledger.sync();assert.equal(ledger.list().length,2);for(const row of ledger.list()){assert.equal(row.netCash,null);assert.equal(row.gainAfterFees,null);assert.equal(row.costBasis,'unknown');assert.equal(row.reviewId,null);}
  }finally{db.close();}
});

test('economic versions ignore polling timestamps, retain corrections, redact private evidence and retract withdrawn fills',()=>{
  const {db,ledger,put}=fixture();try{const order={id:'v',accountKey:'secret-account',environment:'mock',market:'KR',currency:'KRW',symbol:'005930',side:'Sell',quantity:2,filled:1,fillPrice:100,status:'Partially filled',createdAt:1,reconciledAt:2,resultCosts:{gross:100,commission:1,transactionTax:0,netCash:99,gainAfterFees:-1,gainAfterEstimatedTax:-1}};
    put('live_intents',order);ledger.sync();assert.equal(ledger.list()[0].version,1);put('live_intents',{...order,reconciledAt:999});ledger.sync();assert.equal(ledger.list()[0].version,1);assert.equal(ledger.list()[0].timestamp,2);
    put('live_intents',{...order,status:'Filled',filled:2});ledger.sync();assert.equal(ledger.history('broker:v').length,2);assert.equal(JSON.stringify(ledger.history('broker:v')).includes('secret-account'),false);
    put('live_intents',{...order,filled:0});ledger.sync();assert.equal(ledger.list()[0].status,'Retracted');assert.equal(ledger.list()[0].assessment.eligible,false);const version=ledger.list()[0].version;ledger.sync();assert.equal(ledger.list()[0].version,version);
  }finally{db.close();}
});

test('legacy current rows cannot collide with retained version history',()=>{
  const {db,ledger,put}=fixture();try{
    const order={id:'legacy',accountKey:'fixture',environment:'mock',market:'KR',symbol:'005930',side:'Sell',quantity:1,filled:1,fillPrice:100,status:'Filled',createdAt:1};
    put('live_intents',order);ledger.sync();const first=ledger.history('broker:legacy')[0];
    const legacy={...ledger.list()[0]};delete legacy.version;delete legacy.signature;put('trade_outcomes',legacy);
    ledger.sync();assert.equal(ledger.list()[0].version,1);assert.equal(ledger.history('broker:legacy').length,1);
    put('trade_outcomes',legacy);put('live_intents',{...order,fillPrice:110});ledger.sync();assert.equal(ledger.list()[0].version,2);assert.deepEqual(ledger.history('broker:legacy')[1],first);
    // A stale restored current row must not reuse version 2 either.
    put('trade_outcomes',{...legacy,version:1,signature:'old'});put('live_intents',{...order,fillPrice:120});ledger.sync();assert.equal(ledger.list()[0].version,3);
    new OutcomeLedger(db).sync();assert.equal(ledger.history('broker:legacy').length,3);
  }finally{db.close();}
});
