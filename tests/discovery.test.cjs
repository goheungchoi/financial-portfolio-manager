const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {SecurityMaster,unzipSingle}=require('../electron/security-master.cjs');const {Watchlist,Screener,StarterCandidates,AI_LIMIT}=require('../electron/discovery.cjs');
const {normalizeDomestic,normalizeOverseas,rankings}=require('../electron/kis-rankings.cjs');const {researchReview}=require('../electron/research-review.cjs');
const {masterFiles,fetcherFor}=require('./discovery-fixtures.cjs');
async function loadedMaster(db=new DatabaseSync(':memory:'),options){const master=new SecurityMaster(db,fetcherFor(masterFiles(),options));await master.refresh();return master;}

test('security master parses KIS fixed-width and tab-separated files with type mapping',async()=>{
  const master=await loadedMaster();const status=master.status();
  assert.equal(status.markets.length,5);assert.equal(status.error,null);
  assert.deepEqual(master.get('005930'),{symbol:'005930',name:'삼성전자',englishName:'',market:'KOSPI',type:'stock',isin:'KR7005930000',industry:'0027',sector:'0027',marketCap:null},'the broad class stands in for a missing mid sector; a blank market cap stays unknown');
  assert.equal(master.get('069500').type,'etf');assert.equal(master.get('F70100'),null,'non-numeric domestic codes are skipped');
  assert.equal(master.get('247540').market,'KOSDAQ');
  assert.equal(master.get('NASD:AAPL').englishName,'APPLE INC');assert.equal(master.get('NASD:QQQ').type,'etf');assert.equal(master.get('NASD:SEATW').type,'warrant');assert.equal(master.get('NYSE:KO').name,'Coca-Cola');
  assert.throws(()=>unzipSingle(Buffer.from('not a zip')),/MASTER_FORMAT/);
});

test('search ranks exact codes and name prefixes first and filters by market and type',async()=>{
  const master=await loadedMaster();
  assert.equal(master.search('005930')[0].symbol,'005930');assert.equal(master.search('삼성')[0].symbol,'005930');
  assert.equal(master.search('aapl')[0].symbol,'NASD:AAPL');assert.equal(master.search('apple')[0].symbol,'NASD:AAPL');
  assert.ok(master.search('fixture',{market:'KR'}).every(row=>['KOSPI','KOSDAQ'].includes(row.market)));
  assert.deepEqual(master.search('KODEX',{type:'stock'}),[]);assert.deepEqual(master.search('%'),[]);assert.deepEqual(master.search(''),[]);
});

test('a failed market keeps its previous rows and refresh only runs when stale',async()=>{
  const db=new DatabaseSync(':memory:');let now=Date.now();const files=masterFiles();let calls=0;
  const fetcher=fetcherFor(files);const master=new SecurityMaster(db,async url=>{calls++;return fetcher(url);},()=>now);await master.refresh();assert.equal(calls,5);
  await master.refresh();assert.equal(calls,5,'fresh master is not downloaded again');
  now+=21*3600000;const failing=new SecurityMaster(db,fetcherFor(files,{fail:['nasmst.cod.zip']}),()=>now);await failing.refresh();
  assert.match(failing.status().error,/NASD: download failed/);assert.ok(failing.get('NASD:AAPL'),'previous NASDAQ rows remain');
});

test('watchlist caps AI entries by evicting the oldest unpinned AI entry and never evicts user entries',async()=>{
  const db=new DatabaseSync(':memory:');const master=await loadedMaster(db);const list=new Watchlist(db,master);
  list.add('acct','005930',{source:'user'});const ai=Array.from({length:AI_LIMIT},(_,i)=>String(100000+i));
  for(const symbol of ai)list.add('acct',symbol,{source:'ai',reason:'Fixture'});
  list.pin('acct',ai[0],true);
  assert.equal(list.add('acct','247540',{source:'ai',reason:'Volume leader'}).evicted,null,'a pinned AI entry no longer counts toward the AI cap');
  const result=list.add('acct','200000',{source:'ai',reason:'Momentum'});assert.equal(result.evicted,ai[1]);
  const symbols=list.list('acct').map(row=>row.symbol);assert.ok(symbols.includes('005930')&&symbols.includes(ai[0])&&!symbols.includes(ai[1]));
  assert.throws(()=>list.add('acct','999999',{source:'ai'}),/UNKNOWN_SYMBOL/);assert.throws(()=>list.add('acct','NASD:aapl',{source:'user'}),/INVALID_WATCHLIST/);
  const again=list.add('acct','005930',{source:'ai',reason:'Re-added'});assert.equal(again.entry.source,'user','AI cannot downgrade a user entry');
  assert.deepEqual(list.symbols('acct','US'),[]);list.add('acct','NASD:AAPL',{source:'user'});assert.deepEqual(list.symbols('acct','US'),['NASD:AAPL']);
  assert.deepEqual(list.list('other'),[],'watchlists are per account');
});

test('rankings normalize KIS rows, units and symbol formats',async()=>{
  const kr=normalizeDomestic([{mksc_shrn_iscd:'005930',hts_kor_isnm:'삼성전자',stck_prpr:'213500',prdy_ctrt:'1.67',acml_vol:'7179383',stck_avls:'12640000'},{stck_shrn_iscd:'45226K',hts_kor_isnm:'Pref',stck_prpr:'5200'},{mksc_shrn_iscd:'000001',stck_prpr:'0'}]);
  assert.equal(kr[0].marketCap,1264e12);assert.equal(kr[0].changePct,1.67);assert.equal(kr.length,2,'zero prices are dropped; format filtering happens in the screener');
  const us=normalizeOverseas([{excd:'NAS',symb:'EQIX',name:'에퀴닉스',ename:'EQUINIX INC',last:'996.26',rate:'+0.04',tvol:'616888',valx:'98302668',per:'64.12',e_ordyn:'○'},{excd:'XXX',symb:'BAD',last:'1'}]);
  assert.deepEqual(us.map(r=>[r.symbol,r.marketCap,r.changePct,r.orderable]),[['NASD:EQIX',98302668000,0.04,true]]);
  const sent=[];const client={quotation:async(path,trId,params)=>{sent.push([path,trId,params.fid_rank_sort_cls_code]);return {output:[]};},overseasRequest:async(endpoint,trId,params,options)=>{sent.push([endpoint,trId,params.GUBN??params.CO_YN_VALX,options.includeAccount]);return {body:{output2:[{excd:'NYS',symb:'KO',last:'70',valx:'1'},{excd:'NYS',symb:'JPM',last:'300',valx:'5'}]}};}};
  await rankings(client,{market:'KR',kind:'losers'});const top=await rankings(client,{market:'US',kind:'market-cap',exchange:'NYSE'});await rankings(client,{market:'US',kind:'gainers',exchange:'NASD'});
  assert.deepEqual(sent,[['/uapi/domestic-stock/v1/ranking/fluctuation','FHPST01700000','1'],['/uapi/overseas-price/v1/quotations/inquire-search','HHDFS76410000','1',false],['/uapi/overseas-stock/v1/ranking/updown-rate','HHDFS76290000','1',false]]);
  assert.deepEqual(top.map(r=>r.symbol),['NYSE:JPM','NYSE:KO'],'U.S. market-cap results are sorted locally');
  await assert.rejects(rankings(client,{market:'US',kind:'volume',exchange:'LSE'}),/INVALID_REQUEST/);
});

test('screener joins master data, filters types and invalid codes, and caches for a minute',async()=>{
  const master=await loadedMaster();let now=1000,calls=0;
  const screener=new Screener(async()=>{calls++;return [{symbol:'005930',name:'raw',price:1,changePct:1},{symbol:'069500',name:'etf',price:1},{symbol:'45226K',name:'pref',price:1},{symbol:'123456',name:'unlisted',price:1}];},master,()=>now);
  const stocks=await screener.screen({market:'KR',kind:'volume'});assert.deepEqual(stocks.rows.map(r=>[r.symbol,r.name,r.type]),[['005930','삼성전자','stock']]);
  const any=await screener.screen({market:'KR',kind:'volume',type:'any'});assert.deepEqual(any.rows.map(r=>r.symbol),['005930','069500','123456']);assert.equal(calls,1);
  now+=61000;await screener.screen({market:'KR',kind:'volume',type:'etf'});assert.equal(calls,2);
  await assert.rejects(screener.screen({market:'US',kind:'volume'}),/INVALID_REQUEST/,'U.S. screens need an exchange');
});

test('research loop routes discovery tools, caches reads and reports failures as data',async()=>{
  const calls=[];const discovery={screen_market:async args=>{calls.push(['screen',args]);return {status:'ok',rows:[{symbol:'005930'}]};},search_securities:async()=>{throw new Error('KIS_NOT_CONNECTED');},update_watchlist:async args=>{calls.push(['watch',args]);return {status:'added'};}};
  const rounds=[[{name:'screen_market',callId:'a',args:{market:'KR',ranking:'volume',exchange:null,security_type:'stock'}},{name:'search_securities',callId:'b',args:{query:'삼성',market:'KR'}}],[{name:'update_watchlist',callId:'c',args:{action:'add',symbol:'005930',reason:'Liquidity leader'}},{name:'screen_market',callId:'d',args:{market:'KR',ranking:'volume',exchange:null,security_type:'stock'}}]];
  const outputs=[];let round=0;
  const result=await researchReview({context:{universe:[]},evidence:{get:async()=>({})},discovery,log:()=>{},request:async({continuation})=>{if(continuation)outputs.push(...continuation.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output)));const toolCalls=rounds[round++];return toolCalls?{toolCalls,continuation:[]}:{decision:{action:'Hold'},usage:{}};}});
  assert.equal(result.decision.action,'Hold');assert.deepEqual(calls.map(c=>c[0]),['screen','watch'],'the repeated screen is served from cache');
  assert.deepEqual(outputs.find(o=>o.status==='unavailable'),{status:'unavailable',reason:'KIS_NOT_CONNECTED'});
});

test('AI request includes discovery tools only when discovery is enabled',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');let body;
  const client=new AiClient('fixture-private-key',async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,explanation:'Fixture.'})}]}]})};});
  await client.decide({universe:[]},{research:true});assert.ok(!body.tools.some(tool=>tool.name==='screen_market'));
  await client.decide({universe:[],discovery:{enabled:true,watchlist:[]}},{research:true});assert.deepEqual(body.tools.filter(tool=>['screen_market','search_securities','update_watchlist'].includes(tool.name)).length,3);
  assert.match(body.instructions,/lack of candidates is not a reason to Hold/);assert.match(body.instructions,/discovery\.starterCandidates/);
});

test('Korean review context quotes watchlist symbols after the allowlist',async()=>{
  const db=new DatabaseSync(':memory:');const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};let request;
  const live=new LiveEngine(db,{request:async(operation,data)=>{request=data;return {balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}};}},()=>({status:'connected',snapshot}));
  live.configure({symbols:['005930'],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');live.extraSymbols=()=>['005930','247540','NASD:AAPL','247540'];
  await live.context();assert.deepEqual(request,{symbols:['005930'],extra:['247540']});
  live.extraSymbols=()=>[];await live.context();assert.deepEqual(request,{symbols:['005930']});
});

test('starter candidates fill an empty Korean universe with large companies, skip ETFs and give way to user choices',async()=>{
  let now=0,calls=0,fail=false;const screener={screen:async query=>{calls++;if(fail)throw new Error('REQUEST_FAILED');assert.deepEqual([query.market,query.kind,query.type],['KR','market-cap','any']);return {rows:[{symbol:'005930',type:'stock'},{symbol:'069500',type:'etf'},{symbol:'000660',type:'stock'},{symbol:'NASD:AAPL',type:'stock'}]};}};
  const starters=new StarterCandidates(screener,()=>now);
  assert.deepEqual(await starters.symbols({scope:'acct'}),['005930','000660']);assert.deepEqual(starters.current('acct'),['005930','000660']);assert.deepEqual(starters.current('other'),[]);
  await starters.symbols({scope:'acct'});assert.equal(calls,1,'cached within six hours');
  assert.deepEqual(await starters.symbols({scope:'acct',watched:['247540']}),['247540']);assert.deepEqual(starters.current('acct'),[],'watchlist replaces starters');
  assert.deepEqual(await starters.symbols({scope:'acct',allowed:['035420']}),[]);assert.deepEqual(await starters.symbols({scope:'acct',holdings:['005380']}),[]);
  assert.deepEqual(await starters.symbols({scope:'acct',holdings:['NASD:NVDA']}),['005930','000660'],'U.S. holdings do not count as Korean candidates');
  assert.deepEqual(await starters.symbols({scope:null}),[]);
  now=7*3600000;fail=true;assert.deepEqual(await starters.symbols({scope:'acct'}),[],'a failed ranking leaves the universe empty');
  now+=60000;await starters.symbols({scope:'acct'});assert.equal(calls,2,'failures retry after 15 minutes, not every review');
  fail=false;now+=15*60000;assert.deepEqual(await starters.symbols({scope:'acct'}),['005930','000660']);
});

test('Korean review context names starter candidates and awaits async extra symbols',async()=>{
  const db=new DatabaseSync(':memory:');const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:10000000,holdings:[]};let request;
  const live=new LiveEngine(db,{request:async(operation,data)=>{request=data;return {balance:snapshot,quotes:[{symbol:'005930',price:70000,retrievedAt:1}],marketSession:{open:true,status:'open'}};}},()=>({status:'connected',snapshot}));
  live.extraSymbols=async()=>['005930'];live.nameOf=symbol=>symbol==='005930'?'삼성전자':null;
  const context=await live.context();assert.deepEqual(request,{symbols:[],extra:['005930']});assert.deepEqual(context.universe,[{symbol:'005930',name:'삼성전자',price:70000}]);
});

test('agent watchlist updates add up to three entries, reject per entry and never remove user entries',async()=>{
  const {applyAiUpdate}=require('../electron/discovery.cjs');const db=new DatabaseSync(':memory:');const master=await loadedMaster(db);const list=new Watchlist(db,master);list.add('acct','247540',{source:'user'});
  const added=applyAiUpdate(list,'acct',{action:'add',entries:[{symbol:'005930',reason:'Liquid leader'},{symbol:'999999',reason:'Unknown'},{symbol:'NASD:AAPL',reason:'Mega cap'},{symbol:'NYSE:KO',reason:'Ignored fourth'}]});
  assert.deepEqual(added.results.map(r=>[r.symbol,r.status]),[['005930','added'],['999999','rejected'],['NASD:AAPL','added']]);assert.equal(added.ignored,1);
  const removed=applyAiUpdate(list,'acct',{action:'remove',entries:[{symbol:'247540',reason:'x'},{symbol:'005930',reason:'Thesis changed'}]});
  assert.deepEqual(removed.results.map(r=>r.status),['refused','removed']);assert.deepEqual(list.list('acct').map(r=>r.symbol),['247540','NASD:AAPL']);
  assert.throws(()=>applyAiUpdate(list,'acct',{action:'add',symbol:'005930'}),/INVALID_WATCHLIST/);
  assert.equal(normalizeDomestic([{mksc_shrn_iscd:'005930',stck_prpr:'1',stck_avls:''}])[0].marketCap,null,'rankings without market value report null, not zero');
});
