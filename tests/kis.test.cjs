const test=require('node:test');
const assert=require('node:assert/strict');
const {KisReadOnlyClient,parseCredentials}=require('../electron/kis-client.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const row={pdno:'005930',prdt_name:'Samsung',hldg_qty:'2',pchs_avg_pric:'100',prpr:'150',evlu_amt:'300',evlu_pfls_amt:'100',account:'should-not-escape'};
const summary={dnca_tot_amt:'500',tot_evlu_amt:'800',account:'should-not-escape'};
const reply=(body,continuation='')=>new Response(JSON.stringify(body),{headers:{tr_cont:continuation}});
test('cash order preflight uses non-credit capacity and sends one explicit KRX limit POST',async()=>{
  const calls=[];const client=new KisReadOnlyClient(credentials,async(url,options)=>{calls.push({url,options});if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'fixture-token',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:{nrcvb_buy_amt:'1000',nrcvb_buy_qty:'10',max_buy_amt:'999999999'}});if(url.includes('order-cash'))return reply({rt_cd:'0',output:{ODNO:'42',KRX_FWDG_ORD_ORGNO:'fixture'}});throw new Error('Unexpected request');},async()=>{});
  client.checkSession=async()=>({open:true});client.getBalance=async()=>({accountKey:'fixture',reportedTotal:10000,holdings:[{symbol:'005930',availableQuantity:2}]});client.getActivity=async()=>({orders:[]});
  const command={symbol:'005930',side:'Buy',quantity:2,limitPrice:100};assert.equal((await client.prepareOrder(command)).availableQuantity,10);
  await assert.rejects(client.prepareOrder({...command,quantity:11}),/INSUFFICIENT_CAPACITY/);await assert.rejects(client.prepareOrder({...command,side:'Sell',quantity:3}),/INSUFFICIENT_CAPACITY/);
  assert.equal(calls.filter(call=>call.url.includes('order-cash')).length,0);
  assert.equal((await client.placeOrder(command)).brokerOrderId,'42');const post=calls.find(call=>call.url.includes('order-cash'));assert.equal(post.options.headers.tr_id,'VTTC0012U');const body=JSON.parse(post.options.body);assert.equal(body.ORD_DVSN,'00');assert.equal(body.EXCG_ID_DVSN_CD,'KRX');assert.equal(body.ORD_QTY,'2');assert.equal(body.ORD_UNPR,'100');
});
test('credential schema rejects extra endpoints and invalid environment/product',()=>{
  assert.deepEqual(parseCredentials(JSON.stringify(credentials)),credentials);
  for(const extra of [{url:'https://evil.example'},{environment:'other'},{accountProductCode:'03'},{appKey:'key\r\nsecret'}]) assert.throws(()=>parseCredentials(JSON.stringify({...credentials,...extra})),/INVALID_CREDENTIAL_FILE/);
});
test('read-only balance query paginates, reuses token, and returns allowlisted data',async()=>{
  const calls=[];let page=0;
  const client=new KisReadOnlyClient(credentials,async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/oauth2/tokenP')) return reply({access_token:'fixture-token',expires_in:86400});
    assert.equal(options.method,'GET');assert.equal(options.headers.tr_id,'VTTC8434R');
    if(page++===0) return reply({rt_cd:'0',output1:[row],output2:[summary],ctx_area_fk100:'next',ctx_area_nk100:'key'},'M');
    return reply({rt_cd:'0',output1:[],output2:[summary]});
  },async()=>{});
  const result=await client.getBalance();await client.getBalance();
  assert.equal(calls.filter(c=>c.url.endsWith('/oauth2/tokenP')).length,1);
  assert.ok(calls.every(c=>c.url.startsWith('https://openapivts.koreainvestment.com:29443/')));
  assert.equal(calls[2].options.headers.tr_cont,'N');
  assert.equal(new URL(calls[2].url).searchParams.get('CTX_AREA_FK100'),'next');
  assert.deepEqual(result.holdings,[{symbol:'005930',name:'Samsung',quantity:2,cost:100,price:150,marketValue:300,unrealized:100,availableQuantity:null}]);
  assert.equal(result.cash,500);assert.equal(result.reportedTotal,800);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.ok(!JSON.stringify(result).includes('should-not-escape'));
});
test('incomplete pages and malformed balances fail without partial results',async()=>{
  for(const payload of [{rt_cd:'0',output1:[row],output2:[summary],ctx_area_fk100:'',ctx_area_nk100:''},{rt_cd:'0',output1:[{...row,prpr:''}],output2:[summary]}]) {
    const client=new KisReadOnlyClient(credentials,async(url)=>url.endsWith('/oauth2/tokenP')?reply({access_token:'token',expires_in:1000}):reply(payload,payload.ctx_area_fk100!==undefined?'M':''),async()=>{});
    await assert.rejects(client.getBalance(),/INCOMPLETE_BALANCE|INVALID_RESPONSE/);
  }
});
test('transport and broker errors do not expose secret messages',async()=>{
  const client=new KisReadOnlyClient(credentials,async()=>{throw new Error('fixture-secret '+credentials.accountNumber);},async()=>{});
  await assert.rejects(client.getBalance(),error=>error.message==='NETWORK_UNAVAILABLE');
});
test('HTTP error bodies retain only safe status/code and classify KIS mock throttling, including HTTP 500',async()=>{
  let calls=0;const client=new KisReadOnlyClient(credentials,async()=>{calls++;return new Response(JSON.stringify({msg_cd:'EGW00201',msg1:'fixture-secret '+credentials.accountNumber}),{status:500});},async()=>{});
  await assert.rejects(client.request('/fixture',{method:'GET'}),error=>error.code==='RATE_LIMITED'&&error.httpStatus===500&&error.brokerCode==='EGW00201'&&!JSON.stringify(error).includes('fixture-secret'));
  await assert.rejects(client.request('/fixture',{method:'GET'}),/RATE_LIMITED/);assert.equal(calls,1);
});
test('transient read-only queries retry once, POST never retries and HTTP calls share one queue',async()=>{
  let calls=0;const client=new KisReadOnlyClient(credentials,async()=>{calls++;return calls===1?new Response('temporary server outage',{status:503}):reply({rt_cd:'0'});},async()=>{});
  assert.equal((await client.request('/fixture',{method:'GET'})).body.rt_cd,'0');assert.equal(calls,2);
  let posts=0;const writer=new KisReadOnlyClient(credentials,async()=>{posts++;throw new Error('private transport details');},async()=>{});
  await assert.rejects(writer.request('/fixture',{method:'POST'}),/NETWORK_UNAVAILABLE/);assert.equal(posts,1);
  let active=0,max=0;const waits=[];const queued=new KisReadOnlyClient(credentials,async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;return reply({rt_cd:'0'});},async delay=>waits.push(delay));await Promise.all([queued.request('/one',{method:'GET'}),queued.request('/two',{method:'GET'})]);assert.equal(max,1);assert.ok(waits.some(ms=>ms>=1000));
});
test('quotes and daily history normalize only market fields and use read-only endpoints',async()=>{
  const calls=[];
  const client=new KisReadOnlyClient(credentials,async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'token',expires_in:1000});
    if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'150',appsecret:'excluded'}});
    return reply({rt_cd:'0',output2:[{stck_bsop_date:'20261014',stck_oprc:'100',stck_hgpr:'160',stck_lwpr:'90',stck_clpr:'150',acml_vol:'25'},{stck_bsop_date:'20261013',stck_oprc:'90',stck_hgpr:'120',stck_lwpr:'80',stck_clpr:'100',acml_vol:'10'}]});
  },async()=>{});
  const quote=await client.getQuote('005930');
  assert.equal(quote.price,150);assert.deepEqual(Object.keys(quote).sort(),['price','retrievedAt','symbol']);
  const candles=await client.getDailyHistory('005930');
  assert.equal(candles.length,2);assert.ok(candles[0].timestamp<candles[1].timestamp);
  assert.equal(candles[1].timestamp,Date.parse('2026-10-14T00:00:00+09:00'));
  assert.ok(calls.slice(1).every(call=>call.options.method==='GET'));
  assert.equal(new URL(calls.at(-1).url).searchParams.get('FID_ORG_ADJ_PRC'),'0');
  await assert.rejects(client.getQuote('https://evil'),/INVALID_INSTRUMENT/);
});
test('KIS dashboard mapping retains quote source and marks fallback prices stale',()=>{
  const {buildKisMarket}=require('../electron/kis-market.cjs');
  const state={status:'connected',error:null,snapshot:{environment:'mock',timestamp:'2026-10-15',cash:500,reportedTotal:800,holdings:[{symbol:'005930',name:'Samsung',quantity:2,cost:100,price:150}]}};
  let view=buildKisMarket(state,new Map(),100000);
  assert.equal(view.source,'kis');assert.equal(view.status,'stale');assert.equal(view.snapshot.holdings[0].sector,'Unknown');
  view=buildKisMarket(state,new Map([['005930',{price:200,retrievedAt:100000}]]),101000);
  assert.equal(view.status,'connected');assert.equal(view.snapshot.holdings[0].price,200);
  assert.equal(buildKisMarket(state,new Map([['005930',{price:200,retrievedAt:100000}]]),161000).status,'stale');
});
test('minute history uses validated exchange time and per-bar volume; approval stays client-side',async()=>{
  const calls=[];
  const client=new KisReadOnlyClient(credentials,async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/oauth2/Approval'))return reply({approval_key:'approval-fixture'});
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'token',expires_in:1000});
    return reply({rt_cd:'0',output2:[{stck_bsop_date:'20261015',stck_cntg_hour:'090100',stck_oprc:'100',stck_hgpr:'160',stck_lwpr:'90',stck_prpr:'150',cntg_vol:'25'}]});
  },async()=>{});
  const config=await client.getStreamConfig();await client.getStreamConfig();
  assert.equal(config.url,'ws://ops.koreainvestment.com:31000');
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].options.body).secretkey,'fixture-secret');
  const candles=await client.getMinuteHistory('005930');
  assert.deepEqual(candles,[{timestamp:Date.parse('2026-10-15T09:01:00+09:00'),open:100,high:160,low:90,close:150,volume:25}]);
  assert.ok(!JSON.stringify(candles).includes('approval-fixture'));
});

test('repeated KIS throttles increase cooldown without retrying orders or sending during cooldown',async()=>{
  let calls=0;const client=new KisReadOnlyClient(credentials,async()=>{calls++;return new Response(JSON.stringify({msg_cd:'EGW00201'}),{status:500});},async()=>{});
  await assert.rejects(client.request('/fixture',{method:'POST'}),e=>e.code==='RATE_LIMITED'&&e.retryAt>Date.now()+59000);
  await assert.rejects(client.request('/fixture',{method:'GET'}),/RATE_LIMITED/);assert.equal(calls,1);
  client.rateLimitedUntil=0;await assert.rejects(client.request('/fixture',{method:'GET'}),e=>e.retryAt>Date.now()+119000);assert.equal(calls,2);
});

test('mock accounts check Korean hours and weekdays without the unsupported holiday API; live accounts use it',async()=>{
  const realNow=Date.now;const at=iso=>{Date.now=()=>Date.parse(iso);};
  try{
    const calls=[];const mock=new KisReadOnlyClient(credentials,async url=>{calls.push(url);return reply({access_token:'fixture-token',expires_in:3600});},async()=>{});
    at('2026-10-16T05:00:00Z');assert.equal((await mock.checkSession()).open,true,'Friday 14:00 KST is open');assert.equal(calls.length,0,'no holiday request on mock');
    at('2026-10-16T06:30:00Z');await assert.rejects(mock.checkSession(),/SESSION_CLOSED/,'15:30 KST is closed');
    at('2026-10-17T02:00:00Z');await assert.rejects(mock.checkSession(),/SESSION_CLOSED/,'Saturday is closed');
    at('2026-10-15T23:30:00Z');await assert.rejects(mock.checkSession(),/SESSION_CLOSED/,'08:30 KST is closed');
    const liveCalls=[];const live=new KisReadOnlyClient({...credentials,environment:'live'},async url=>{liveCalls.push(url);if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'fixture-token',expires_in:3600});return reply({rt_cd:'0',output:[{bass_dt:'20261016',opnd_yn:'N'}]});},async()=>{});
    at('2026-10-16T05:00:00Z');await assert.rejects(live.checkSession(),/SESSION_CLOSED/,'live honours the holiday calendar');assert.ok(liveCalls.some(url=>url.includes('chk-holiday')));
  }finally{Date.now=realNow;}
});
