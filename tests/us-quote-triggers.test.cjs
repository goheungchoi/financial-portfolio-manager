const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
// 2026-10-29: the GOOGL quote alternated between the regular feed's overnight price ($324.89) and the KIS daytime feed
// (~$295), and each switch started a price movement review of about 115,000 input tokens.
const SYMBOL='NASD:GOOGL';
function fixture(){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],()=>[]);
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'x'}})},()=>{});a.providerStatus.aiConnected=true;a.notify=()=>{};
  a.watchScope=()=>'us:acct';const reviews=[];a.review=async trigger=>{reviews.push(trigger);a.lastRun=Date.now();};return {db,a,reviews};
}
const closed=price=>({marketSession:{open:false,status:'closed'},quotes:[{symbol:SYMBOL,price,retrievedAt:Date.now(),venue:'regular'}]});
const daytime=price=>({marketSession:{open:true,status:'open',session:{id:'us-daytime',regular:false}},quotes:[{symbol:SYMBOL,price,retrievedAt:Date.now(),venue:'daytime'}]});
const regular=price=>({marketSession:{open:true,status:'open'},quotes:[{symbol:SYMBOL,price,retrievedAt:Date.now(),venue:'regular'}]});
const detect=a=>a.watches.detect(a.watchScope(),a.usQuotes,a.lastPrices,3);

test('U.S. quotes name their feed',async()=>{
  const asked=[];const client={overseasRequest:async(path,tr,params)=>{asked.push(params.EXCD);return {body:{output:{last:'294.86'}}};}};const us=new OverseasClient(client);
  assert.equal((await us.quote(SYMBOL)).venue,'regular');assert.equal((await us.quote(SYMBOL,'daytime')).venue,'daytime');assert.deepEqual(asked,['NAS','BAQ']);
});

test('a U.S. quote with no tradable session open is stale and starts no review',()=>{
  const {db,a}=fixture();try{
    a.lastPrices.set(SYMBOL,292.5);a.acceptUSQuotes(closed(324.89));
    assert.equal(a.usQuotes[0].stale,true);assert.equal(detect(a),null,'an overnight snapshot 11% away is not a move');
    a.watches.set(a.watchScope(),{symbol:SYMBOL,percent:null,price:306,direction:'below',reason:'x'},{universe:[{symbol:SYMBOL}],quotes:[]});
    a.acceptUSQuotes(closed(292.5));assert.equal(detect(a),null,'nor does it reach a price level');
    a.acceptUSQuotes(regular(292.5));assert.equal(a.usQuotes[0].stale,false);assert.equal(detect(a)?.kind,'price','an open session reaches it');
  }finally{db.close();}
});

test('when the feed changes, U.S. baselines start again from the new price; real moves within a feed still count',()=>{
  const {db,a}=fixture();try{const scope=a.watchScope();
    a.watches.set(scope,{symbol:SYMBOL,percent:5,price:null,direction:'below',reason:'x'},{universe:[{symbol:SYMBOL}],quotes:[{symbol:SYMBOL,price:324.89}]});
    a.acceptUSQuotes(closed(324.89));a.lastPrices.set(SYMBOL,324.89);
    a.acceptUSQuotes(daytime(294.86));assert.equal(detect(a),null,'regular to daytime: -9% between feeds is not a move');
    assert.equal(a.lastPrices.get(SYMBOL),294.86);assert.equal(a.watches.list(scope)[0].baseline,294.86,'the watch baseline follows');
    a.acceptUSQuotes(daytime(296));assert.equal(detect(a),null);
    a.acceptUSQuotes(daytime(311));const move=detect(a);assert.equal(move?.kind,'percent','a 5.5% daytime move');assert.equal(move.baseline,294.86);
    a.lastPrices.set(SYMBOL,296);a.acceptUSQuotes(closed(324.89));assert.equal(detect(a),null);assert.equal(a.lastPrices.get(SYMBOL),324.89);
    a.acceptUSQuotes(daytime(296));assert.equal(detect(a),null,'and back again');
  }finally{db.close();}
});

test('the morning sequence starts no price movement review',async()=>{
  const {db,a,reviews}=fixture();try{
    a.configure({provider:'openai',scope:'us',enabled:true,closedMarketReviews:'keep',intervalMinutes:240,newsTrigger:'off'});a.sessionArmed=true;
    a.schedulerStatus=()=>({label:'Monitoring'});a.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});a.lastRun=Date.now()-120000;
    const step=async value=>{a.acceptUSQuotes(value);a.lastRun=Math.min(a.lastRun,Date.now()-120000);a.lastDeskCheck=Date.now();a.tick();await new Promise(r=>setImmediate(r));};
    await step(closed(292.5));a.lastPrices.set(SYMBOL,292.5);
    for(const value of [closed(324.89),daytime(294.86),daytime(296),closed(324.89),daytime(295)])await step(value);
    assert.deepEqual(reviews.filter(t=>t==='Price movement trigger'),[]);
  }finally{db.close();}
});
