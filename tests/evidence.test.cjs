const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {technicals,company,MarketEvidence}=require('../electron/market-evidence.cjs');const {ReviewWatches}=require('../electron/review-watches.cjs');const {researchReview}=require('../electron/research-review.cjs');const {AiClient}=require('../electron/ai-client.cjs');const {LearningMemory}=require('../electron/learning-memory.cjs');
const now=Date.UTC(2026,9,15,12,0);const candles=Array.from({length:21},(_,i)=>({timestamp:now-(20-i)*60000,open:i+1,high:i+2,low:i+.5,close:i+1,volume:10}));
test('KIS evidence adapters use fixed read-only endpoints and normalized company fields',async()=>{
  const {fetchEvidence}=require('../electron/kis-evidence.cjs');let seen;
  const client={quotation:async(...args)=>{seen=args;return {output:{stck_hgpr:'110',per:'12'}};},overseasRequest:async(...args)=>{seen=args;return {body:{output:{h52p:'250',perx:'20'}}};}};
  const kr=await fetchEvidence(client,{symbol:'005930',dataset:'company'});assert.equal(kr.metrics.dayHigh,110);assert.equal(seen[0],'inquire-price');
  const us=await fetchEvidence(client,{symbol:'NASD:AAPL',dataset:'company'});assert.equal(us.metrics.PER,20);assert.equal(seen[1],'HHDFS76200200');assert.deepEqual(seen[2],{AUTH:'',EXCD:'NAS',SYMB:'AAPL'});assert.equal(us.metrics.ROE,null);
  await assert.rejects(fetchEvidence(client,{symbol:'https://example.com',dataset:'company'}),/INVALID_REQUEST/);
});
test('technical indicators exclude forming bars, calculate SMA/fast stochastic and report incomplete ten-minute windows',()=>{
  const result=technicals(candles,'1m','minute_technicals',now);assert.equal(result.bars,20);assert.equal(result.SMA5,18);assert.equal(result.SMA10,15.5);assert.equal(result.SMA20,10.5);assert.ok(result.stochastic.K>90&&result.stochastic.K<100);
  const range=technicals(candles,'1m','range_10m',now);assert.equal(range.coverage,'complete');assert.equal(range.high,21);assert.equal(range.low,10.5);assert.equal(technicals(candles.slice(-5),'1m','range_10m',now).coverage,'partial');assert.equal(technicals([],'1m','minute_technicals',now).SMA5,null);
});
test('company fields map broker data and never fabricate missing consensus or ROE',()=>{
  assert.equal(company({per:'12',pbr:'0',w52_hgpr:'100'}).PER,12);assert.equal(company({pbr:'0'}).PBR,null);assert.equal(company({perx:'15',h52p:'250'},true).high52Week,250);assert.equal(company({}).ROE,null);assert.equal(company({}).consensusTarget,null);
});
test('research rejects out-of-universe requests and masks data-source failures',async()=>{
  let calls=0;const evidence=new MarketEvidence(async()=>{calls++;throw new Error('secret');});const context={universe:[{symbol:'005930'}]};assert.equal((await evidence.get({symbol:'bad',dataset:'company'},context)).status,'unavailable');assert.equal(calls,0);assert.equal((await evidence.get({symbol:'005930',dataset:'company'},context)).reason,'DATA_SOURCE_UNAVAILABLE');
});
test('review watches persist per scope, allow self-tuning, reject unsafe values, and ignore stale quotes',()=>{
  const db=new DatabaseSync(':memory:');try{const watches=new ReviewWatches(db),context={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:100}]};
    assert.equal(watches.set('paper',{symbol:'005930',percent:1,price:105,direction:'above',reason:'Watch momentum'},context).status,'saved');assert.equal(watches.list('live').length,0);
    assert.equal(watches.detect('paper',[{symbol:'005930',price:101.1,timestamp:now}],new Map(),3,now).kind,'percent');assert.equal(watches.detect('paper',[{symbol:'005930',price:110,timestamp:now-100000}],new Map(),3,now),null);
    assert.equal(watches.detect('paper',[{symbol:'005930',price:106,timestamp:now}],new Map(),3,now).kind,'price');watches.fired('paper','005930');watches.rebase('paper',[{symbol:'005930',price:106}]);assert.equal(watches.detect('paper',[{symbol:'005930',price:106,timestamp:now}],new Map(),3,now),null);
    assert.equal(new ReviewWatches(db).list('paper')[0].priceFired,true);assert.equal(watches.set('paper',{symbol:'005930',percent:0,price:null,direction:'above',reason:''},context).status,'rejected');watches.reset('paper');assert.equal(watches.list('paper').length,0);
  }finally{db.close();}
});
test('AI client returns validated read-only tool requests and replays function outputs',async()=>{
  const context={universe:[{symbol:'005930'}]};let request;
  const client=new AiClient('fake_key_12345',async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'function_call',name:'get_market_evidence',call_id:'c1',arguments:JSON.stringify({symbol:'005930',dataset:'company'})}],usage:{input_tokens:10,output_tokens:5}})};});
  const result=await client.decide(context,{research:true});assert.equal(result.toolCalls[0].args.dataset,'company');assert.equal(request.tools.length,3);assert.equal(request.parallel_tool_calls,true,'up to four requests per round');assert.equal(request.store,false);assert.ok(!JSON.stringify(result).includes('fake_key'));
  await assert.rejects(client.decide(context,{research:true,final:true}),/INVALID_AI_RESPONSE/);
});
test('research rounds are bounded, cached, logged and accumulate token usage',async()=>{
  let requests=0,reads=0;const events=[];const context={universe:[{symbol:'005930'}]};
  const result=await researchReview({context,evidence:{get:async()=>{reads++;return {status:'available'};}},log:(...args)=>events.push(args),request:async options=>{requests++;if(requests===4){assert.equal(options.final,true);assert.ok(options.continuation.some(row=>row.type==='function_call_output'));return {decision:{action:'Hold'},usage:{inputTokens:2,outputTokens:1}};}return {toolCalls:[{name:'get_market_evidence',callId:'c'+requests,args:{symbol:'005930',dataset:'company'}}],continuation:options.continuation??[],usage:{inputTokens:2,outputTokens:1}};}});
  assert.equal(requests,4,'three research rounds, then the answer');assert.equal(reads,1);assert.equal(events.length,6);assert.equal(result.usage.inputTokens,8);
});
test('evidence lessons require approval, isolate paper/account/symbol, and invalidate approval on changed outcome',()=>{
  const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT)');const memory=new LearningMemory(db);const outcome={id:'broker:o',side:'Sell',source:'broker',accountKey:'a',environment:'mock',market:'US',symbol:'NASD:AAPL',quantity:1,status:'Filled',gainAfterFees:-1,gainAfterEstimatedTax:null,costBasis:'estimated',currency:'USD'};
    db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run(outcome.id,JSON.stringify(outcome));memory.sync();memory.sync();assert.equal(db.prepare('SELECT count(*) AS n FROM lessons').get().n,1);const context={environment:'kis',universe:[{symbol:'NASD:AAPL'}]};assert.equal(memory.relevant(context,['a']).length,0);memory.review('outcome:'+outcome.id,{action:'approve',expectedSignature:memory.lifecycle('outcome:'+outcome.id).signature});assert.equal(memory.relevant(context,['a']).length,1);assert.equal(memory.relevant(context,['b']).length,0);assert.equal(memory.relevant({...context,environment:'local-paper'},['a']).length,0);memory.sync();assert.equal(memory.relevant(context,['a']).length,1);
    db.prepare('UPDATE trade_outcomes SET payload=?').run(JSON.stringify({...outcome,gainAfterFees:-2}));memory.sync();assert.equal(memory.relevant(context,['a']).length,0);
  }finally{db.close();}
});

test('chart candles are opt-in UI evidence and never inflate ordinary AI tool responses',async()=>{
  const {fetchEvidence}=require('../electron/kis-evidence.cjs');const client={getMinuteHistory:async()=>[...candles,{timestamp:NaN,low:1}]};
  const compact=await fetchEvidence(client,{symbol:'005930',dataset:'minute_technicals'});assert.equal(compact.candles,undefined);
  const chart=await fetchEvidence(client,{symbol:'005930',dataset:'minute_technicals'},true);assert.equal(chart.candles.length,21);assert.ok(chart.candles.every(c=>Number.isFinite(c.timestamp)));
});
