const {app,dialog,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
// Offline symbol-list fixtures served to the app instead of KIS's download server.
const masterDir=path.join(process.env.PORTFOLIO_SMOKE_DATA,'master-fixtures');fs.mkdirSync(masterDir,{recursive:true});for(const [name,data] of Object.entries(require('./discovery-fixtures.cjs').masterFiles()))fs.writeFileSync(path.join(masterDir,name),data);process.env.PORTFOLIO_MASTER_DIR=masterDir;
const seedDay=offset=>new Date(Date.now()+9*3600000-offset*86400000).toISOString().slice(0,10);
process.env.PORTFOLIO_PERFORMANCE_SEED=JSON.stringify({account:'ui-regression-fixture',history:[[5,9700000],[4,9800000],[3,9750000],[2,9900000],[1,9950000]].map(([offset,value])=>({day:seedDay(offset),at:0,KRW:{equity:value,cash:value},USD:null,fx:null,equityKRW:value})),reviews:[['seed-buy','Buy',7],['seed-sell','Sell',6],['seed-hold','Hold',6]].map(([id,action,offset])=>({id,timestamp:Date.now()-offset*86400000,provider:'openai',model:'gpt-6-luna',account:{key:'ui-regression-fixture',label:'KIS mock'},decision:{action,symbol:'005930',quantity:1,explanation:'Seeded decision'},contextEvidence:{environment:'kis',quote:{symbol:'005930',price:100},reviewedLessons:[]},orderId:null}))});
// Macro snapshot fixture; in test mode the app never fetches ECOS/FRED.
const macroSeries=(id,market,source,name,unit,values)=>({id,market,source,name,unit,frequency:'daily',date:seedDay(1),value:values.at(-1),previous:values.at(-2),change:Math.round((values.at(-1)-values.at(-2))*1000)/1000,history:values.map((value,i)=>({date:seedDay(values.length-i),value}))});
process.env.PORTFOLIO_MACRO_SEED=JSON.stringify({ecosAccess:'sample',calendarAccess:'key',errors:[],calendar:[{date:seedDay(-3),market:'US',event:'U.S. CPI',source:'FRED release calendar'}],series:[macroSeries('KR_BASE_RATE','KR','ECOS','BoK base rate','%',[3,3]),macroSeries('KR_USDKRW','KR','ECOS','USD/KRW','KRW',[1338.6,1345.2,1348.5]),macroSeries('US_10Y','US','FRED','U.S. 10-year Treasury','%',[5.21,5.19])]});
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/ui-regression');fs.mkdirSync(output,{recursive:true});
const report={checks:[],screenshots:[],errors:[]};let win;let failUS=false;let posts=0;let researchMode=false;let researchRound=0;let decisionFailure=false;let dartFixture=false;
const domestic={accountKey:'ui-regression-fixture',environment:'mock',source:'kis',cash:10000000,reportedTotal:10000000,holdings:[]};
const overseas={accountKey:'ui-regression-fixture:US',environment:'mock',source:'kis-us',currency:'USD',cash:0,reportedTotal:0,holdings:[]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-ui-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:true,dartConnected:dartFixture,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='company-chart')return {status:'available',retrievedAt:Date.now(),metrics:{price:110,dayHigh:115,dayLow:100,PER:12,PBR:2,high52Week:150,low52Week:70,ROE:null},data:{SMA5:105,SMA10:102,SMA20:98,stochastic:{K:60,D:58},asOf:Date.now()-86400000},candles:Array.from({length:30},(_,i)=>({timestamp:Date.now()-(30-i)*86400000,open:90+i,high:94+i,low:88+i,close:92+i,volume:100+i}))};
  if(operation==='refresh')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='us-context'){if(failUS)throw Object.assign(new Error('US_CASH_SERVER_ERROR'),{httpStatus:503,brokerCode:'FIXTURE503'});return {balance:{...overseas,timestamp:new Date().toISOString()},quotes:[],warnings:[],marketSession:{open:true,status:'open'}};}
  if(operation==='live-context')return {balance:{...domestic,timestamp:new Date().toISOString()},quotes:[],marketSession:{open:false,status:'closed'}};
  if(operation==='disclosures')return [{title:'삼성전자 · 주요사항보고서(자기주식취득결정)',symbol:'005930',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261016000001',published:'20261016',source:'DART'},{title:'Unrelated Co · 기타공시',symbol:'000001',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261016000002',published:'20261016',source:'DART'}];
  if(operation==='index-history')return Array.from({length:8},(_,i)=>({day:seedDay(7-i),close:5000+i*20}));
  if(operation==='screen')return payload.request.market==='KR'?[{symbol:'005930',name:'raw',price:213500,changePct:1.67,volume:7179383,marketCap:1264e12,per:null,currency:'KRW'},{symbol:'069500',name:'etf',price:40000,changePct:-0.5,volume:100,marketCap:null,per:null,currency:'KRW'},{symbol:'45226K',name:'pref',price:5200,changePct:30,volume:1,marketCap:null,per:null,currency:'KRW'}]:[];
  if(operation==='orders'||operation==='us-orders')return {orders:[]};if(operation==='quotes')return (payload?.symbols??[]).map(symbol=>({symbol,price:216000,retrievedAt:Date.now(),previousClose:210000,changePct:2.86}));
  if(operation==='charges')return {orderId:payload.orderId,filled:0,amount:0,charges:0,retrievedAt:Date.now()};if(operation==='us-charges')throw new Error('FEATURE_UNAVAILABLE');
  if(operation==='research-section')return {overview:{price:216000,changePct:1.2,per:33.1,pbr:3.4,marketCapKRW:1268e12,high52Week:374500,low52Week:94500,foreignOwnershipPct:49.1,sectorName:'전기·전자'},
    analysts:{price:216000,windowDays:180,brokerages:22,buy:22,hold:0,sell:0,medianTarget:500000,highTarget:600000,lowTarget:300000,upsideToMedianPct:131.5,latest:[{date:seedDay(3),firm:'Fixture Securities',opinion:'Buy',target:500000}],targetRevisions:{windowDays:90,raised:5,cut:1,unchanged:2,recent:[]}},
    estimates:{years:['2025','2026E','2027E'],revenue:[3000000,3500000,3900000],eps:[6564,9000,11000]},financials:{periods:[{period:'2026 to Jun',revenueKRW:3053729e8,operatingProfitKRW:1467252e8,netIncomeKRW:1188497e8,operatingMarginPct:48,roePct:31.4},{period:'FY2025',revenueKRW:3336059e8,operatingProfitKRW:436011e8,netIncomeKRW:452068e8,operatingMarginPct:13.1,roePct:10.9,debtRatioPct:29.9,evToEbitda:7.67}],annualRatios:[]},
    valuation:{years:[{year:'2025',close:120000,eps:6564,per:18.3,bps:63997,pbr:1.88},{year:'2024',close:53000,eps:4950,per:10.7,bps:57951,pbr:0.91}],perRange:{min:10.7,median:10.7,max:18.3,years:2},pbrRange:{min:0.91,median:0.91,max:1.88,years:2},return1yPct:180.5,return3yPct:176.4,return5yPct:null},
    dividends:{payments:[{recordDate:seedDay(-70),kind:'결산',perShare:null,pending:true},{recordDate:seedDay(110),kind:'분기',perShare:374,payDate:seedDay(60)}],trailing12mPerShare:1294,trailingYieldPct:0.6,frequency:'quarterly',annualTotals:[],upcoming:[{recordDate:seedDay(-70),kind:'결산',perShare:null,pending:true}]},
    meetings:{meetings:[{date:seedDay(-150),type:'정기총회',agenda:['재무제표승인']}]},
    flows:{investors:{asOf:seedDay(1),net5d:{foreignKRW:198944e6,institutionKRW:-313679e6,individualKRW:-12021e6},net20d:{foreignKRW:-1.5e12,institutionKRW:5e11,individualKRW:9.8e11},foreignStreakDays:2,institutionStreakDays:-3},shortSelling:{latestSharePct:4.65,avg20dSharePct:2.1},margin:{balanceRatePct:0.35,changeSharesPct:-4.9,changeSince:seedDay(21)},program:{net5dKRW:2.1e11,net20dKRW:-4e11}},
    daily:{closes:Array.from({length:90},(_,i)=>({date:seedDay(90-i),close:200000+Math.round(Math.sin(i/6)*15000)+i*200,value:4e12}))},
    'index-daily':{closes:Array.from({length:90},(_,i)=>({date:seedDay(90-i),close:5000+Math.round(Math.sin(i/6)*150)+i*2}))},
    market:{breadth:[{index:'KOSPI',level:5668.05,changePct:2.05,advancers:759,decliners:135,unchanged:22,limitUp:2,limitDown:0,advanceRatioPct:84.9},{index:'KOSDAQ',level:794.78,changePct:4.46,advancers:1471,decliners:222,unchanged:40,limitUp:7,limitDown:0,advanceRatioPct:86.9}],
      kospiSectors:[{code:'0021',name:'금융',changePct:3.1,valueSharePct:8},{code:'0013',name:'전기·전자',changePct:1.75,valueSharePct:28},{code:'0005',name:'음식료·담배',changePct:-0.4,valueSharePct:1}],
      foreignTopBuys:[{symbol:'005930',name:'삼성전자',netBuyKRW:198944e6,changePct:3.3}],institutionTopBuys:[]}}[payload.section];
  if(operation==='dart-about')return {language:'ko',source:{kind:'DART annual report',date:seedDay(200),title:'사업보고서 (2025.12)',rceptNo:'20260311000001',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260311000001',section:'1. 사업의 개요'},
    overview:'당사는 본사를 거점으로 한국 및 해외 지역총괄과 생산ㆍ판매법인 등 230개의 종속기업으로 구성된 글로벌 전자 기업입니다. 사업군별로 DX 부문은 TV, 모니터, 냉장고, 세탁기, 에어컨, 스마트폰 등을 생산ㆍ판매하며, DS 부문은 DRAM, NAND Flash, 모바일AP 등의 반도체 제품을 생산ㆍ판매하고 있습니다.\n\n디스플레이 패널 사업은 자회사 삼성디스플레이가, 전장 부품과 오디오 사업은 자회사 Harman이 담당하고 있습니다.'};
  if(operation==='dart-company')return {filings:[{date:seedDay(9),kind:'earnings',title:'연결재무제표기준영업(잠정)실적(공정공시)',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261008000001'}],earnings:{lastRelease:seedDay(9),nextExpected:seedDay(-83)},dividends:{years:[{year:'2025',perShare:1668,payoutRatioPct:25.1,yieldPct:1.5}]}};
  if(operation==='news')return [];
  if(operation==='narrative')return {narrative:{summary:'Chip stocks fell on doubts about AI profits while rates stay high.',regime:'risk_off',drivers:[{kind:'trigger',title:'Doubts about AI profitability',summary:'Leaked financials raised questions about AI returns.',direction:'negative',themes:['ai_profitability'],affects:['Korean memory chips'],confirmedBy:[{signal:'IDX_KOSPI',observation:'KOSPI fell over the week'}],confidence:'high',continues:'',sources:[]},{kind:'background',title:'High interest rates',summary:'Yields stay elevated.',direction:'negative',themes:['rates'],affects:['Growth stocks'],confirmedBy:[],confidence:'medium',continues:'',sources:[]}]},usage:{inputTokens:60,outputTokens:20},model:'gpt-6-sol'};
  if(operation==='scout'){if(!payload.options?.continuation)return {provider:'openai',toolCalls:[{name:'get_company_research',callId:'s1',args:{symbol:'005930'}}],continuation:[{role:'user',content:'fixture'}],usage:{inputTokens:50,outputTokens:5},model:'gpt-6-sol'};
    return {provider:'openai',plan:{summary:'Memory makers lead earnings revisions; build a position on pullbacks and keep cash for volatility.',cashTargetPct:35,focus:'Samsung earnings at the end of October.',targets:[{symbol:'005930',name:'삼성전자',role:'candidate',targetWeightPct:25,thesis:'22 of 22 brokerages rate it Buy; median target well above the price.',risks:'Memory cycle.'}],briefAnswers:[],retrospective:'Too few scored picks to judge; keep weighing valuation with consensus.'},usage:{inputTokens:80,outputTokens:40},model:'gpt-6-sol'};}
  if(operation==='decision'&&decisionFailure)throw new Error('AI_MODEL_UNAVAILABLE');
  if(operation==='decision'&&payload.context.reviewInterval?.auto&&!payload.options?.continuation)return {provider:'openai',toolCalls:[{name:'set_review_interval',callId:'cadence',args:{minutes:5,reason:'Fixture volatility calls for closer monitoring.'}}],continuation:[],usage:{inputTokens:10,outputTokens:5}};
  if(operation==='decision'&&researchMode){
    const symbol=payload.context.universe[0].symbol;const round=researchRound++;
    if(round<2)return {provider:'openai',toolCalls:[{name:round===0?'get_market_evidence':'set_review_watch',callId:'fixture'+round,args:round===0?{symbol,dataset:'minute_technicals'}:{symbol,percent:1.5,price:null,direction:'above',reason:'Fixture volatility review'}}],continuation:payload.options?.continuation??[],usage:{inputTokens:10,outputTokens:5}};
    return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'Fixture evidence checked; monitoring adjusted.'},usage:{inputTokens:10,outputTokens:5}};
  }
  if(operation==='reflection')return {reflection:{facts:'Fixture sale includes transaction costs.',uncertainty:'Benchmark unavailable.',hypothesis:'Costs may outweigh a small edge.',lesson:'Check full costs before similar exits.',applicability:'Comparable small-edge exits.'},usage:{inputTokens:50,outputTokens:40}};
  if(operation==='decision')return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'Fixture read-only review completed; no trading instruction.'},usage:{inputTokens:100,outputTokens:10}};
  if(operation.includes('place-order')){posts++;throw new Error('UI fixture forbids order submission');}
  throw new Error('Unexpected fixture operation '+operation);
};
const timer=setTimeout(()=>{report.errors.push('UI regression timed out');finish(1);},90000);
function finish(code){clearTimeout(timer);fs.writeFileSync(path.join(output,'ui-regression.json'),JSON.stringify(report,null,2));app.exit(code);}
app.once('browser-window-created',(_event,created)=>{win=created;win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{
  const run=code=>win.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(code,message)=>{for(let i=0;i<60;i++){if(await run(code))return;await wait(50);}throw new Error(message);};
  const click=async text=>{await run(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing UI button');button.click();})()`);await wait(80);};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1').textContent===${JSON.stringify(tab)}`,'Navigation failed');await wait(100);};
  const capture=async name=>{for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());report.screenshots.push(name+'.png');return;}catch(error){if(attempt===2)throw error;await wait(150);}}};
  const check=async(name,fn)=>{await fn();report.checks.push({name,status:'passed'});};
  try{
    await run('window.portfolio.importKis()');await run('window.portfolio.refreshPortfolio()');
    await check('All tabs navigate in one window, in dark and light modes, at desktop and compact widths',async()=>{
      for(const [width,height] of [[1280,900],[960,720]]){win.setSize(width,height);for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'Theme switch did not update');}
        const tabs=await run("Array.from(document.querySelectorAll('.nav')).map(button=>button.dataset.tab)");
        for(const tab of tabs){await navigate(tab);assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(await run('typeof window.require'),'undefined');const overflow=await run('document.querySelector("main").scrollWidth-document.querySelector("main").clientWidth');assert.ok(overflow<=2,`${tab} overflows by ${overflow}px at ${width}px (${theme})`);}
        await navigate('U.S. stocks');await until('Boolean(document.querySelector(".us-account-summary"))','U.S. summary missing');await run("window.portfolio.usAction('refresh')");await wait(2100);await click('Refresh U.S. account');await until('document.querySelector(".us-account-value .tick-delta")?.classList.contains("unchanged")&&document.querySelector(".us-account-value .tick-delta").textContent==="No change yet"','Zero-change indicator not updated');
        const geometry=await run(`(()=>{const summary=document.querySelector('.us-account-summary'),value=summary.querySelector('strong').getBoundingClientRect(),delta=summary.querySelector('.tick-delta').getBoundingClientRect(),header=summary.nextElementSibling.querySelector('th').getBoundingClientRect(),box=summary.getBoundingClientRect();return {value:value.toJSON(),delta:delta.toJSON(),header:header.toJSON(),box:box.toJSON()};})()`);
        assert.ok(Math.abs((geometry.value.top+geometry.value.bottom)/2-(geometry.delta.top+geometry.delta.bottom)/2)<10,'Equity delta wrapped below total');assert.ok(geometry.delta.left>=geometry.value.right+4,'Equity delta overlaps total');assert.ok(geometry.header.top>=geometry.box.bottom+15,'Stock header overlaps account summary');
        await capture(`us-zero-${width}-${theme}`);
      }}
    });
    await check('Overview places unrealized return below equity in both themes and shows native loss correctly',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.cash=0;overseas.reportedTotal=180;
      await run("(async()=>window.portfolio.saveCosts({...await window.portfolio.getCosts(),usdKRW:1000}))()");await run('window.portfolio.refreshPortfolio()');await navigate('Home');
      for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme)await run('document.querySelector(`[aria-label="Dark mode"]`).click()');
        await until('document.querySelector(`[aria-label="Unrealized"] .portfolio-profit`)?.dataset.amount==="-20000"','Combined P/L missing');
        assert.equal(await run('document.querySelector(`[aria-label="U.S. unrealized"] .portfolio-profit`).dataset.amount'),'-20');
        assert.equal(await run('document.querySelectorAll(".home-metrics .metric-card").length'),3,'three key numbers');assert.ok((await run('document.querySelector(`[aria-label="Combined equity"] strong`).textContent')).includes('₩'),'total equity shown');
        await run('document.querySelector(".home-metrics").scrollIntoView({block:"center"})');await capture('overview-pnl-'+theme);
      }
      overseas.holdings=[];overseas.cash=0;overseas.reportedTotal=0;await run('window.portfolio.refreshPortfolio()');await navigate('U.S. stocks');
    });
    await check('Equity updates show signed increases/decreases and keep empty table spacing',async()=>{
      overseas.cash=1.25;overseas.reportedTotal=1.25;await click('Refresh U.S. account');await until('document.querySelector(".us-account-summary .tick-delta")?.dataset.delta==="1.25"','Positive delta missing');assert.ok(await run('document.querySelector(".us-account-summary .tick-delta").classList.contains("increase")'));
      overseas.cash=.75;overseas.reportedTotal=.75;await click('Refresh U.S. account');await until('document.querySelector(".us-account-summary .tick-delta")?.dataset.delta==="-0.5"','Negative delta missing');assert.ok(await run('document.querySelector(".us-account-summary .tick-delta").classList.contains("decrease")'));
    });
    await check('Failed refresh shows last-known values and safe HTTP/broker diagnostics; recovery clears error',async()=>{
      failUS=true;await click('Refresh U.S. account');await until('document.querySelector("main").textContent.includes("HTTP 503")','HTTP status missing');assert.ok(await run('document.querySelector("main").textContent.includes("Last known equity")'));assert.ok(await run('document.querySelector("main").textContent.includes("FIXTURE503")'));await capture('us-failed-refresh');failUS=false;await click('Refresh U.S. account');await until('!document.querySelector("main").textContent.includes("HTTP 503")','Refresh error retained after recovery');
    });
    await check('UI review succeeds with both execution sessions off and explains market-specific state',async()=>{
      await navigate('Connections');await click('Import provider JSON');await navigate('Engine settings');await run("window.portfolio.configureRuntime({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true,enabled:false})");await wait(2200);await click('Run portfolio review');await until('document.querySelector("main").textContent.includes("Completed.")','Read-only review did not complete');const runtime=await run('window.portfolio.getRuntime()');assert.equal(runtime.lastError,null);assert.equal(runtime.reviews[0].decision.action,'Hold');assert.match(runtime.execution.detail,/Korea: orders off/);assert.match(runtime.execution.detail,/U.S.: orders off/);assert.equal(posts,0);assert.equal((await run("window.portfolio.liveAction('get')")).state.enabled,false);assert.equal((await run("window.portfolio.usAction('get')")).state.enabled,false);
      await navigate('AI console');assert.ok(await run('document.querySelector("main").textContent.includes("Review completed")'));await capture('read-only-review-console');
      // The request size reads as a sentence and its record stays inside the panel: the page never scrolls sideways.
      await until('Array.from(document.querySelectorAll(".meta-line")).some(l=>l.querySelector("b")?.textContent==="Review size")','Review size line missing');
      assert.match(await run('Array.from(document.querySelectorAll(".meta-line")).find(l=>l.querySelector("b")?.textContent==="Review size").querySelector("span").textContent'),/^[\d.]+ KB of [\d.]+ KB/);
      assert.ok(await run('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1&&Array.from(document.querySelectorAll(".meta-line")).every(l=>l.scrollWidth<=l.clientWidth+1)'),'no console line overflows sideways');
    });
    await check('Outcome journal displays linked evidence and filters simulation from broker records',async()=>{
      const {DatabaseSync}=require('node:sqlite');const fixtureDb=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      fixtureDb.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('outcome-ui','fixture',JSON.stringify({id:'outcome-ui',accountKey:'fixture',market:'US',currency:'USD',environment:'mock',symbol:'NASD:TEST',side:'Sell',filled:1,quantity:1,fillPrice:10,status:'Filled',createdAt:Date.now(),resultCosts:{gross:10,commission:.1,transactionTax:.01,netCash:9.89,gainAfterFees:-1.11,gainAfterEstimatedTax:null}}));fixtureDb.close();
      await navigate('Journal');await click('Trades');await until(`document.querySelector('[aria-label="Trade outcomes"]')?.textContent.includes("NASD:TEST")`,'Outcome not displayed');
      await run(`document.querySelector('[aria-label="Trade outcomes"] details').open=true`);assert.ok(await run(`document.querySelector('[aria-label="Trade outcomes"]').textContent.includes("Loss observed; cause unassessed")`));await capture('outcome-journal');
      await run(`(()=>{const select=document.querySelector('[aria-label="Outcome source"]');select.value='paper';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`document.querySelector('[aria-label="Trade outcomes"]').textContent.includes("No recorded fills yet.")`,'Source filter failed');
    });
    await check('Agent requests market evidence, changes review alert and user can reset it',async()=>{
      researchMode=true;await run("window.portfolio.configureRuntime({scope:'paper',enabled:false,autoSubmit:false})");const before=await run('window.portfolio.getRuntime()');
      const reply=await run("window.portfolio.reviewRuntime()");assert.equal(reply.ok,true,JSON.stringify([reply.error,reply.message])+" getRuntime: "+await run("window.portfolio.getRuntime().then(()=>\"ok\",e=>String(e))"));assert.equal(reply.state.usage.calls-before.usage.calls,3);assert.equal(reply.state.watches[0].percent,1.5);assert.equal(reply.state.config.eventTolerancePct,before.config.eventTolerancePct);assert.equal(reply.state.config.enabled,false);assert.equal(posts,0);
      await navigate('AI console');await until('document.querySelector("main").textContent.includes("Market data result")','Research result missing from console');assert.ok(await run('document.querySelector("main").textContent.includes("Review watch updated")'));await capture('agent-research-console');
      await navigate('Engine settings');await until('document.querySelector(\`[aria-label="AI review alerts"]\`)?.textContent.includes("1.5%")','AI alert not visible');await run('document.querySelector(`[aria-label="AI review alerts"]`).scrollIntoView({block:"center"})');await capture('agent-review-alert');await click('Reset to default alerts');await until('document.querySelector(\`[aria-label="AI review alerts"]\`).textContent.includes("Default movement threshold")','Reset failed');researchMode=false;
    });
    await check('No page search; draft actions persist across tabs',async()=>{
      assert.equal(await run('document.querySelector(`[aria-label="Find a page"]`)'),null);
      await navigate('Engine settings');const before=await run('window.portfolio.getRuntime()');
      await run('(()=>{const input=document.querySelector(`[aria-label="Agent guidelines"]`);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"UI draft fixture");input.dispatchEvent(new Event("input",{bubbles:true}));})()');await until('Boolean(document.querySelector(".settings-draft-bar"))','Draft bar missing');
      assert.ok(await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Run portfolio review").disabled'));
      await navigate('Home');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),'UI draft fixture');await capture('settings-draft-actions');await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard did not clear draft');assert.equal((await run('window.portfolio.getRuntime()')).config.guidelines,before.config.guidelines);assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),before.config.guidelines);
    });
    await check('Company information and charts show evidence without fabricated missing metrics',async()=>{
      await navigate('Charts');await until('document.querySelector(".company-quote")?.textContent.includes("115")','Company metrics missing');assert.ok(await run('document.querySelector(".company-tiles").textContent.includes("—")'));assert.ok(await run('document.querySelectorAll(".candles g").length>25'));await capture('company-profile');assert.equal(await run('Boolean(document.querySelector(`[aria-label="About the company"]`))'),false,'no description without a filing source');
      await run('document.querySelector(`[aria-label="Company research"]`).scrollIntoView({block:"start"})');await until('document.querySelector(`[aria-label="Company research"] .research-body`)?.textContent.includes("Market cap")','Research overview missing');
      const tab=label=>run(`Array.from(document.querySelectorAll('[aria-label="Research sections"] button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
      await tab('Analysts');await until('document.querySelector(`[aria-label="Company research"]`).textContent.includes("5 raised")','Analyst revisions missing');
      await tab('Dividends');await until('document.querySelector(`[aria-label="Dividend payments"]`)?.textContent.includes("Not set yet")','Dividend table missing');await wait(150);await capture('research-dividends');
      await tab('Events');await until('document.querySelector(`[aria-label="Company research"]`).textContent.includes("OpenDART key")','Missing DART key message');assert.ok(await run('document.querySelector(`.research-events`).textContent.includes("Dividend record date")'),'KSD events still listed');
      await tab('Flows');await until('document.querySelector(`[aria-label="Investor net buying"]`)?.textContent.includes("2 days of net buying")','Investor flows missing');
      await tab('Financials');await until('document.querySelector(`[aria-label="Financial statements"]`)?.textContent.includes("2026 to Jun")','Statements missing');
      await tab('Valuation');await until('document.querySelector(`[aria-label="Valuation history"]`)?.textContent.includes("18.3")','Valuation history missing');assert.ok(await run('document.querySelector(`[aria-label="Company research"]`).textContent.includes("vs median PER")'));
      await tab('Peers');await until('document.querySelector(`[aria-label="Company research"] .research-body`)?.textContent.length>5','Peers tab empty');
      await tab('Fair value');await until('document.querySelector(`[aria-label="Fair value methods"]`)?.textContent.includes("Analyst median target")','Fair value missing');await wait(150);await capture('research-fair-value');
      await tab('Risk');await until('Boolean(document.querySelector(`.research-spark`))&&document.querySelector(`[aria-label="Company research"]`).textContent.includes("Beta to KOSPI")','Risk metrics missing');await wait(150);await capture('research-risk');assert.ok(await run('document.querySelector(`[aria-label="Company research"]`).textContent.includes("RSI (14)")'),'Technical indicators missing');await run('document.querySelector(".candles").scrollIntoView({block:"center"})');await capture('company-price-chart');
    });
    await check('One-click start activates saved MOCK scope; stop disables new automatic orders',async()=>{
      await run("window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithAI:true,enabled:false,autoSubmit:false,closedMarketReviews:'keep'})");await navigate('Home');await wait(2200);await click('Start auto trading');await until('(async()=>{const s=await window.portfolio.getRuntime();return s.launch.running&&!s.busy;})()','Launch failed');const active=await run('window.portfolio.getRuntime()');assert.equal(active.execution.markets[0].automatic,true);assert.equal(active.reviews[0].trigger,'Auto trading started');assert.equal(posts,0);await wait(2200);await click('Stop auto trading');await until('(async()=>!(await window.portfolio.getRuntime()).sessionArmed)()','Stop failed');await capture('auto-trading-controls');
    });
    await check('Journal lists decisions beside a detail view that opens the matching AI conversation',async()=>{
      await navigate('Journal');await click('Decisions');await until('Boolean(document.querySelector(`[aria-label="Decision detail"]`))','Decision detail missing');
      const items=await run('document.querySelectorAll(`[aria-label="Decision list"] .run-item`).length');assert.ok(items>=2,'several decisions listed');
      await run('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[1].click()');await until('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[1].getAttribute("aria-current")==="true"','Selection did not move');
      const id=await run('window.portfolio.getRuntime().then(s=>s.reviews[1].id)');assert.ok((await run('document.querySelector(`[aria-label="Decision detail"]`).textContent')).includes(id.slice(0,8)),'detail shows the selected review');
      const pair=await run('[document.querySelectorAll(`[aria-label="Decision list"] .run-item[aria-current="true"]`).length,document.querySelector(`[aria-label="Decision list"] .run-item[aria-current="true"]`)?.dataset.id,document.querySelector(`[aria-label="Decision detail"]`).dataset.id,Array.from(document.querySelectorAll(`[aria-label="Decision list"] .run-item`)).map(b=>b.dataset.id.slice(0,6)).join(",")]');console.log('JOURNAL-SELECTION',JSON.stringify(pair));assert.equal(pair[0],1,'one decision highlighted');assert.equal(pair[1],pair[2],'highlight matches the detail');await wait(400);await capture('journal-decisions');const after=await run('[document.querySelector(`[aria-label="Decision list"] .run-item[aria-current="true"]`)?.dataset.id,document.querySelector(`[aria-label="Decision detail"]`).dataset.id,document.querySelector(`[aria-label="Decision list"] .run-item`).dataset.id]');console.log('JOURNAL-AFTER',JSON.stringify(after));assert.equal(after[0],after[1],'highlight still matches after capture');await click('Open conversation');await until('document.querySelector("h1").textContent==="AI console"','Console did not open');await until(`document.querySelector('.thread-head')?.textContent.includes(${JSON.stringify(id.slice(0,8))})`,'The matching conversation is not open');
    });
    await check('Journal and console content are separate; News exposes source coverage',async()=>{
      await navigate('Journal');assert.equal(await run('document.querySelectorAll(".timeline").length'),0);await click('Decisions');assert.ok(await run('document.querySelector(".journal-entry")!==null'));await capture('organized-decisions');await click('Reviewed lessons');assert.equal(await run('document.querySelectorAll(".journal-entry time").length'),0);
      await navigate('AI console');assert.equal(await run('document.querySelectorAll(`[aria-label="Portfolio journal"]`).length'),0);assert.equal(await run('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Run demo")'),false);
      await navigate('News');assert.ok(await run('document.querySelector("main").textContent.includes("Not connected")'));await capture('news-sources');
    });
    await check('Post-trade reflection is visible and suggestion needs explicit approval',async()=>{
      await run("window.portfolio.configureRuntime({reflectionEnabled:true,reflectionUSDPerDay:1,reflectionCallsPerDay:5,shareKisWithAI:true})");
      await until('(async()=> (await window.portfolio.getRuntime()).reflections.jobs.some(j=>j.status==="completed"))()','Reflection did not complete');
      await navigate('Journal');await click('Reviewed lessons');await until('document.querySelector("main").textContent.includes("AI reflection · unvalidated")','Reflection missing');
      await click('Use suggestion in draft');assert.equal(await run('document.querySelector(`[aria-label="Reviewed lesson"]`).value'),'Check full costs before similar exits.');
      assert.equal((await run('window.portfolio.getRuntime()')).lessons.find(l=>l.id==='outcome:broker:outcome-ui').approved,0);
      await run('document.querySelector(`[aria-label="Learning candidate"]`).scrollIntoView({block:"start"})');await capture('post-trade-reflection');
      await run("window.portfolio.configureRuntime({reflectionEnabled:false})");
    });
    await check('Learning queue approval, retirement and economic-evidence invalidation',async()=>{
      await navigate('Journal');await click('Reviewed lessons');await until('document.querySelector(`[aria-label="Learning candidate"]`)?.textContent.includes("NASD:TEST")','Learning candidate missing');await capture('learning-queue');await click('Approve for future reviews');await until('(async()=> (await window.portfolio.getRuntime()).lessons.some(l=>l.id==="outcome:broker:outcome-ui"&&l.approved===1))()','Lesson not approved');
      const approved=(await run('window.portfolio.getRuntime()')).lessons.find(l=>l.id==='outcome:broker:outcome-ui');assert.equal(approved.lifecycle.status,'approved');assert.ok(approved.lifecycle.expiresAt>Date.now());
      const {DatabaseSync}=require('node:sqlite');const fixtureDb=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));const order=JSON.parse(fixtureDb.prepare('SELECT payload FROM live_intents WHERE id=?').get('outcome-ui').payload);order.resultCosts.gainAfterFees=-2;fixtureDb.prepare('UPDATE live_intents SET payload=? WHERE id=?').run(JSON.stringify(order),'outcome-ui');fixtureDb.close();
      await until('(async()=> (await window.portfolio.getRuntime()).lessons.find(l=>l.id==="outcome:broker:outcome-ui").lifecycle.status==="needs-review")()','Changed evidence retained approval');const stale=await run(`window.portfolio.reviewLesson('outcome:broker:outcome-ui',{action:'approve',expectedSignature:${JSON.stringify(approved.lifecycle.signature)}})`);assert.equal(stale.error,'LESSON_CHANGED');await wait(2200);await click('Retire lesson');await until('(async()=> (await window.portfolio.getRuntime()).lessons.find(l=>l.id==="outcome:broker:outcome-ui").lifecycle.status==="retired")()','Retirement failed');const versions=await run("window.portfolio.getOutcomeHistory('broker:outcome-ui')");assert.ok(versions.length>=2);assert.equal(versions[0].accountKey,undefined);
    });
    await check('Model and reasoning selection saves without making paid calls',async()=>{
      await navigate('Engine settings');const before=await run('window.portfolio.getRuntime()');await run('(()=>{const select=document.querySelector(`[aria-label="OpenAI model"]`);select.value="gpt-6-astra";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await until('document.querySelector(`[aria-label="Reasoning effort"]`).value==="low"','Astra reasoning was not normalized');await click('Save changes');await until('(async()=> (await window.portfolio.getRuntime()).config.openaiModel==="gpt-6-astra")()','Model did not save');assert.equal((await run('window.portfolio.getRuntime()')).usage.calls,before.usage.calls);await navigate('Home');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="OpenAI model"]`).value'),'gpt-6-astra');await capture('model-settings');await run("window.portfolio.configureRuntime({openaiModel:'gpt-6-luna',reasoningEffort:'none'})");
    });
    await check('Review failures display actionable diagnostics and status has no Settings button',async()=>{
      decisionFailure=true;await run("window.portfolio.configureRuntime({scope:'paper',provider:'openai',enabled:false,maxCallsPerDay:200,maxUSDPerDay:100})");await navigate('Engine settings');await wait(2200);await click('Run portfolio review');await until('document.querySelector("main").textContent.includes("unavailable to this API project")','Safe diagnosis missing');
      const state=await run('window.portfolio.getRuntime()');assert.equal(state.lastError,'AI_MODEL_UNAVAILABLE');assert.match(state.lastErrorDetail,/AI research and decision/);assert.equal(await run('Array.from(document.querySelectorAll(".runtime-pulse button")).some(b=>b.textContent==="Settings")'),false);await capture('review-error-details');decisionFailure=false;
    });
    await check('Holdings open the selected company; allocation segments show keyboard-accessible detail; replay runs offline',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.reportedTotal=180;await run('window.portfolio.refreshPortfolio()');await navigate('Holdings');await until('Boolean(document.querySelector(`[aria-label="View Test holding charts"]`))','Company link missing');await run('document.querySelector(`[aria-label="View Test holding charts"]`).click()');await until('document.querySelector("h1").textContent==="Charts"&&document.querySelector(`[aria-label="Company stock code"]`)?.value==="NASD:TEST"','Chart symbol not selected');await until('Boolean(document.querySelector(".company-tiles"))','Company data missing');await run('Array.from(document.querySelectorAll("details")).find(d=>d.querySelector("summary")?.textContent.includes("Paper replay")).open=true');await click('Run offline replay');await until('document.querySelector("main").textContent.includes("Later holdout")','Replay missing');
      await navigate('Home');await until('Boolean(document.querySelector(".interactive-ring circle[tabindex]"))','Allocation missing');await run('(()=>{const segment=Array.from(document.querySelectorAll(".interactive-ring circle[tabindex]")).find(e=>e.getAttribute("aria-label").includes("Test holding"));segment.focus();segment.dispatchEvent(new FocusEvent("focusin",{bubbles:true}));})()');await until('document.querySelector(`[role="tooltip"]`)?.textContent.includes("NASD:TEST")','Tooltip details missing');await run('document.querySelector(".allocation-explorer").scrollIntoView({block:"center"})');await wait(250);await capture('allocation-detail-tooltip');
    });
    await check('Auto review interval persists the AI choice and shows its reason',async()=>{
      await run("window.portfolio.configureRuntime({scope:'paper',enabled:false,autoReviewInterval:true,provider:'openai'})");const reply=await run("window.portfolio.reviewRuntime()");assert.equal(reply.ok,true,JSON.stringify([reply.error,reply.message])+" getRuntime: "+await run("window.portfolio.getRuntime().then(()=>\"ok\",e=>String(e))"));assert.equal(reply.state.reviewInterval.minutes,5);assert.equal(reply.state.config.enabled,false);await navigate('Engine settings');await until('document.querySelector("main").textContent.includes("Fixture volatility calls for closer monitoring")','Auto cadence reason missing');await run("window.portfolio.configureRuntime({autoReviewInterval:false})");
    });
    await check('Unlimited budgets save independently and calculated usage replaces reservation labels',async()=>{
      await navigate('Engine settings');await wait(2200);for(const label of ['API calls per day','Daily local API budget (USD)','Reflection calls per day','Daily reflection budget (USD)'])await run(`document.querySelector('[aria-label="Unlimited ${label}"]').click()`);await click('Save changes');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.unlimitedCalls&&c.unlimitedBudget&&c.reflectionUnlimitedCalls&&c.reflectionUnlimitedBudget;})()','Unlimited settings not saved');await navigate('Home');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Unlimited API calls per day"]`).checked'),true);await capture('unlimited-api-settings');
    });
    await check('Autopilot guardrails save, survive navigation and preview the daily digest',async()=>{
      await navigate('Engine settings');await wait(2200);await until('Boolean(document.querySelector(`[aria-label="Autopilot guardrails"]`))','Guardrails section missing');
      await run('(()=>{const set=(label,proto,value,type)=>{const el=document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(proto.prototype,"value").set.call(el,value);el.dispatchEvent(new Event(type,{bubbles:true}));};set("Loss-limit response",HTMLSelectElement,"block-buys","change");})()');
      assert.equal(await run('document.querySelector(`[aria-label="Automatic orders per day"]`)'),null,'the number is hidden while there is no limit');await run('document.querySelector(`[aria-label="Unlimited Automatic orders per day"]`).click()');await wait(100);
      await run('(()=>{const el=document.querySelector(`[aria-label="Automatic orders per day"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"3");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await click('Save changes');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.lossAction==="block-buys"&&c.maxAutoOrdersPerDay===3;})()','Guardrails not saved');await until('document.querySelector(".toaster")?.textContent.includes("Settings saved")','No saved confirmation');
      await navigate('Home');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Loss-limit response"]`).value'),'block-buys');
      await click("Preview today's digest");await until('document.querySelector(`[aria-label="Digest preview"]`)?.textContent.includes("Daily digest")','Digest preview missing');
      await run('document.querySelector(`[aria-label="Autopilot guardrails"]`).scrollIntoView({block:"start"})');await wait(200);await capture('autopilot-guardrails');
      await run("window.portfolio.configureRuntime({lossAction:'review',maxAutoOrdersPerDay:0})");
    });
    await check('Discover searches the symbol list, screens rankings and maintains the watchlist',async()=>{
      await navigate('Discover');await until('(async()=>(await window.portfolio.getDiscovery()).state.master.total>0)()','Symbol list fixture not loaded');
      await run('(()=>{const el=document.querySelector(`[aria-label="Search securities"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"삼성");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await click('Search');await until('document.querySelector(`[aria-label="Search results"]`)?.textContent.includes("005930")','Search results missing');
      await run('document.querySelector(`[aria-label="Search results"] tbody tr button:not(.link-button)`).click()');await until('document.querySelector(`[aria-label="Watchlist entries"]`)?.textContent.includes("삼성전자")','Watchlist add failed');
      await until('document.querySelector(`[aria-label="Screener results"]`)?.textContent.includes("삼성전자")','Screener results missing');
      for(let i=0;i<24&&!(await run('Boolean(document.querySelector(`[aria-label="Watchlist entries"] .live-price`)?.textContent.includes("216,000"))'));i++)await wait(500);await until('document.querySelector(`[aria-label="Watchlist entries"] .live-price`)?.textContent.includes("216,000")','Watchlist live price missing');assert.ok(await run('document.querySelector(`[aria-label="Watchlist entries"]`).textContent.includes("+2.86%")'),'day change missing');
      await run(`Array.from(document.querySelectorAll('[aria-label="Screener results"] .sort-head')).find(b=>b.textContent.startsWith('Change')).click()`);assert.equal(await run('document.querySelector(`[aria-label="Screener results"] th[aria-sort="descending"]`)?.textContent'),'Change ▼');
      await run('document.querySelector(`[aria-label="Screener results"] tbody tr td:nth-child(2) .link-button`).click()');await until('document.querySelector(`[aria-label^="Quick look"]`)?.textContent.includes("Full research and chart")','Quick look missing');await wait(300);await capture('discover-quick-look');
      await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');await until('!document.querySelector(`[aria-label^="Quick look"]`)','Quick look did not close');
      const screened=await run('Array.from(document.querySelectorAll(`[aria-label="Screener results"] tbody tr`)).map(r=>r.cells[0].textContent)');assert.deepEqual(screened,['005930'],'stocks only; ETFs and lettered codes are excluded');
      const reply=await run("window.portfolio.updateWatchlist('add','999999','')");assert.equal(reply.ok,false);assert.equal(reply.error,'UNKNOWN_SYMBOL');
      await run('document.querySelector(`[aria-label="Watchlist"]`).scrollIntoView({block:"start"})');await wait(200);await capture('discover-watchlist');
      await run('document.querySelector(`[aria-label="Remove 005930"]`).click()');await until('!document.querySelector(`[aria-label="Watchlist entries"]`)','Watchlist remove failed');
    });
    await check('Screener reloads when a filter changes and shows a loading state, with no run button',async()=>{
      await navigate('Discover');await until('document.querySelector(`[aria-label="Screener results"]`)','Screener did not load on open');
      assert.equal(await run('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Run screen")'),false);
      await run('(()=>{window.__sawBusy=false;const section=document.querySelector(`[aria-label="Market screener"]`);new MutationObserver(()=>{if(section.getAttribute("aria-busy")==="true")window.__sawBusy=true;}).observe(section,{attributes:true});const el=document.querySelector(`[aria-label="Screener ranking"]`);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,"gainers");el.dispatchEvent(new Event("change",{bubbles:true}));})()');
      await until('window.__sawBusy&&document.querySelector(`[aria-label="Market screener"]`).getAttribute("aria-busy")==="false"&&Boolean(document.querySelector(`[aria-label="Screener results"]`))','Filter change did not reload with a loading state');
    });
    await check('The logo opens Home; Back, Forward, Alt+arrows and mouse side buttons move between pages',async()=>{
      assert.equal(await run('Array.from(document.querySelectorAll(".nav")).some(b=>b.textContent==="Overview")'),false,'no Overview tab');
      const page='document.querySelector("h1").textContent';
      await navigate('Discover');await navigate('Macro');
      await run('document.querySelector(`[aria-label="Back"]`).click()');await until(`${page}==="Discover"`,'Back button failed');
      await run('window.dispatchEvent(new MouseEvent("mouseup",{button:4,bubbles:true}))');await until(`${page}==="Macro"`,'Mouse forward button failed');
      await run('window.dispatchEvent(new MouseEvent("mouseup",{button:3,bubbles:true}))');await until(`${page}==="Discover"`,'Mouse back button failed');
      await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",altKey:true,bubbles:true}))');await until(`${page}==="Macro"`,'Alt+Right failed');
      assert.equal(await run('document.querySelector(`[aria-label="Forward"]`).disabled'),true,'nothing ahead');
      await run('document.querySelector(".brand").click()');await until(`${page}==="Home"`,'Logo did not open Home');assert.equal(await run('document.querySelector(".brand").getAttribute("aria-current")'),'page');
    });
    await check('Engine settings uses labelled rows, switches and a floating save bar',async()=>{
      await navigate('Engine settings');await until('Boolean(document.querySelector(`[aria-label="Settings sections"]`))','Section links missing');
      for(const label of ['Scheduled reviews','Place orders automatically','Share KIS data with OpenAI','Auto review interval','Desktop alerts'])assert.equal(await run(`document.querySelector('[aria-label="${label}"]')?.getAttribute('role')`),'switch',label);
      await run('document.querySelector(`[aria-label="Desktop alerts"]`).click()');await until('Boolean(document.querySelector(".settings-draft-bar"))','Save bar missing');
      assert.equal(await run('getComputedStyle(document.querySelector(".settings-draft-bar")).position'),'fixed');await capture('engine-settings-rows');
      await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard failed');
    });
    await check('The AI scout runs from Discover, shows its plan and is scheduled from Engine settings',async()=>{
      await run("window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithAI:true,enabled:false,autoSubmit:false,openaiModel:'gpt-6-sol',reasoningEffort:'low'})");
      await navigate('Discover');await until('Boolean(document.querySelector(`[aria-label="AI scout"]`))','Scout panel missing');
      await until('document.querySelector(`[aria-label="Korea market today"]`)?.textContent.includes("759 up")','Market pulse missing');assert.ok(await run('document.querySelector(`.pulse-sectors`).textContent.includes("금융")'));await capture('market-pulse');
      await until('Boolean(document.querySelector(`[aria-label="Market narrative"]`))','Narrative card missing');await run('Array.from(document.querySelectorAll(`[aria-label="Market narrative"] button`)).find(b=>b.textContent==="Update now").click()');
      await until('document.querySelector(`[aria-label="Market drivers"]`)?.textContent.includes("Doubts about AI profitability")','Narrative drivers missing');assert.ok(await run('document.querySelector(`[aria-label="Market narrative"]`).textContent.includes("Risk-off")'));await run('document.querySelector(`[aria-label="Market narrative"]`).scrollIntoView({block:"start"})');await wait(150);await capture('market-narrative');
      await click('Run scout');await until('document.querySelector(`[aria-label="Scout plan"]`)?.textContent.includes("삼성전자")','Scout plan not shown');
      assert.ok(await run('document.querySelector(`[aria-label="AI scout"]`).textContent.includes("Cash target")'));
      assert.ok(await run('document.querySelector(`.scout-retro`)?.textContent.includes("Too few scored picks")'),'Self-review missing');
      await until('document.querySelector(`[aria-label="AI scout"] .note summary`)?.textContent.includes("Past picks: 1 tracked")','Pick scorecard missing');
      await run('document.querySelector(`[aria-label="AI scout"]`).scrollIntoView({block:"start"})');await wait(150);await capture('scout-plan');
      await navigate('AI console');await until('Array.from(document.querySelectorAll(".run-item")).some(b=>b.textContent.includes("Plan"))','Scout run missing from console');
      await navigate('Engine settings');await run('document.querySelector(`[aria-label="Scheduled scout runs"]`).click()');await until('Boolean(document.querySelector(`[aria-label="Scout schedule"]`))','Schedule select missing');
      await click('Save changes');await until('(async()=>(await window.portfolio.getRuntime()).config.scoutEnabled===true)()','Scout schedule not saved');
      await navigate('Engine settings');assert.ok(!(await run('Boolean(document.querySelector(`[aria-label="Largest conditional order"]`))')),'guardrail rows stay hidden while off');
      assert.equal(await run('document.querySelector(`[aria-label="Risk per trade"]`).value'),'1');assert.equal(await run('document.querySelector(`[aria-label="Stop distance in ATR"]`).value'),'2');
      await run('document.querySelector(`[aria-label="Let the AI set conditional orders"]`).click()');await until('Boolean(document.querySelector(`[aria-label="Largest conditional order"]`))','Conditional order guardrails missing');
      await click('Save changes');await until('(async()=>(await window.portfolio.getRuntime()).config.conditionalOrders===true)()','Conditional orders not saved');await run('document.querySelector(`[aria-label="Conditional order settings"]`).scrollIntoView({block:"start"})');await wait(150);await capture('conditional-order-settings');
      await navigate('Journal');await until('document.querySelector(`[aria-label="Agent desk"]`)?.textContent.includes("conditional orders")','Agent desk missing');
      await until('Boolean(document.querySelector(`[aria-label="Replay"]`))','Replay card missing');await run('Array.from(document.querySelectorAll(`[aria-label="Replay"] button`)).find(b=>b.textContent==="Run replay").click()');await until('document.querySelector(`[aria-label="Replay"]`).textContent.includes("Add instructions, remove a section or pick another model")','Replay without a change should explain itself');
      await run("window.portfolio.configureRuntime({conditionalOrders:false})");
      await run("window.portfolio.configureRuntime({scoutEnabled:false,scope:'paper',provider:'local'})");
    });
    await check('News matches disclosures to watchlist symbols and filters to portfolio-relevant items',async()=>{
      dartFixture=true;await run('window.portfolio.importProviders()');await run("window.portfolio.updateWatchlist('add','005930','')");
      await navigate('News');await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Refresh news"&&!b.disabled)','News controls not ready');await click('Refresh news');await until('Array.from(document.querySelectorAll(".news-entry")).some(e=>e.textContent.includes("IMPORTANT")&&e.querySelector(`[aria-label="Matched symbols"]`)?.textContent.includes("005930"))','Matched disclosure missing');
      await run('document.querySelector(`[aria-label="Only news about my symbols"]`).click()');await wait(150);
      const titles=await run('Array.from(document.querySelectorAll(".news-entry h3")).map(e=>e.textContent)');assert.equal(titles.length,1);assert.match(titles[0],/주요사항보고서/);
      assert.equal(await run('document.querySelector(`[aria-label="News-triggered reviews"]`).value'),'disclosures');await capture('news-matched-disclosure');
      await run("window.portfolio.updateWatchlist('remove','005930')");
    });
    await check('Performance charts time-weighted returns against KOSPI and records deposits',async()=>{
      await navigate('Performance');await until('Boolean(document.querySelector(`[aria-label="Period returns"]`))','Period returns missing');
      await until('document.querySelector(`[aria-label="Period statistics"]`)?.textContent.includes("Max drawdown")','Period statistics missing');assert.ok(await run('Boolean(document.querySelector(`[aria-label^="Account value from"]`))'),'value chart missing');
      for(const label of ['Daily P/L','Drawdown']){await run(`Array.from(document.querySelectorAll('[aria-label="Chart"] button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await until(label==='Daily P/L'?'Boolean(document.querySelector(`[aria-label^="Daily profit and loss"]`))':'Boolean(document.querySelector(`[aria-label^="Drawdown from peak"]`))',label+' chart missing');}
      await run(`Array.from(document.querySelectorAll('[aria-label="Chart"] button')).find(b=>b.textContent==='Value').click()`);
      await run(`Array.from(document.querySelectorAll('[aria-label="Chart"] button')).find(b=>b.textContent==='Return vs benchmark').click()`);
      await until('Boolean(document.querySelector(".perf-line.portfolio"))&&Boolean(document.querySelector(".perf-line.benchmark"))','Return chart missing');
      const allRow=await run('Array.from(document.querySelectorAll(`[aria-label="Period returns"] tbody tr`)).find(r=>r.cells[0].textContent.startsWith("All")).textContent');assert.ok(allRow.includes('+'),'seeded history should show a positive return');
      await run('(()=>{const set=(label,value)=>{const el=document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));};document.querySelector(`[aria-label="Deposits and withdrawals"]`).open=true;set("Flow amount","500000");set("Flow note","Monthly saving");})()');
      await click('Record deposit');await until('document.querySelector(`[aria-label="Recorded flows"]`)?.textContent.includes("Monthly saving")','Deposit not recorded');
      await run('document.querySelector(`[aria-label="Account performance"]`).scrollIntoView({block:"start"})');await wait(200);await capture('performance-returns');
      await run('document.querySelector(`[aria-label^="Remove flow"]`).click()');await until('!document.querySelector(`[aria-label="Recorded flows"]`)','Flow not removed');
    });
    await check('Learning scoreboard scores past decisions against KOSPI',async()=>{
      await navigate('Journal');await click('Scoreboard');await until('Boolean(document.querySelector(`[aria-label="Decision scores by horizon"]`))','Scoreboard missing');
      await until('document.querySelectorAll(".score-bar").length>=2','Decision bars missing (opening the scoreboard fetches prices)');
      const row=await run('Array.from(document.querySelectorAll(`[aria-label="Decision scores by horizon"] tbody tr`)).find(r=>r.cells[0].textContent==="Buy").cells[2].textContent');assert.ok(row.includes('+')&&row.includes('of 1'),'the seeded buy beat a slower benchmark: '+row);
      assert.ok(await run('document.querySelector(`[aria-label="Learning scoreboard"]`).textContent.includes("holds not scored")'));
      await run('document.querySelector(`[aria-label="Learning scoreboard"]`).scrollIntoView({block:"start"})');await until(`Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Refresh prices")`,"Refresh did not finish");await wait(200);await capture("learning-scoreboard");
    });
    await check('Charts shows U.S. candles in New York time with cents and pops out into its own window',async()=>{
      await navigate('Charts');await until('Boolean(document.querySelector(`[aria-label="Company stock code"]`))','Company lookup missing');
      // A Korean stock: its description comes from the DART annual report (the DART fixture is on now).
      await run('(()=>{const el=document.querySelector(`[aria-label="Company stock code"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"005930");el.dispatchEvent(new Event("input",{bubbles:true}));})()');await click('View');
      await until('document.querySelector(`[aria-label="About the company"]`)?.textContent.includes("사업의 개요")','Company description missing');assert.ok(await run('document.querySelector(`[aria-label="About the company"]`).textContent.includes("글로벌 전자 기업")'));
      await run('Array.from(document.querySelectorAll(`[aria-label="About the company"] button`)).find(b=>b.textContent==="More").click()');await until('document.querySelector(`[aria-label="About the company"]`).textContent.includes("Harman")','More did not open the description');await capture('company-about');
      await run('(()=>{const el=document.querySelector(`[aria-label="Company stock code"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"NASD:TEST");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await click('View');const slow=async(code,message)=>{for(let i=0;i<200;i++){if(await run(code))return;await wait(50);}throw new Error(message);};
      await slow('document.querySelector("main").textContent.includes("New York time · USD")&&document.querySelectorAll("svg.candles rect").length>10','U.S. candles missing');
      const summary=await run('document.querySelector(".candle-summary").textContent');assert.match(summary,/C 121\.00/,'cents are shown: '+summary);
      await click('Pop out ↗');for(let i=0;i<100&&BrowserWindow.getAllWindows().length<2;i++)await wait(50);
      const popup=BrowserWindow.getAllWindows().find(item=>item!==win);assert.ok(popup,'chart window opened');
      const inPopup=code=>popup.webContents.executeJavaScript(code);let ready=false;
      for(let i=0;i<200&&!ready;i++){try{ready=await inPopup('Boolean(document.querySelector(`[aria-label="Chart window"] svg.candles`))&&!document.querySelector("aside")&&["Test holding","NASD:TEST"].includes(document.querySelector("h2").textContent)');}catch{}if(!ready)await wait(50);}
      assert.ok(ready,'chart window renders only the chart for the symbol');assert.equal(await inPopup('document.title'),'NASD:TEST · Chart');
      assert.equal(await inPopup('document.documentElement.dataset.theme'),await run('document.documentElement.dataset.theme'),'chart window follows the app theme');
      await click('Pop out ↗');await wait(300);assert.equal(BrowserWindow.getAllWindows().length,2,'the same symbol reuses its window');
      // A window that was never shown has no painted surface to capture.
      popup.showInactive();await wait(400);for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,'chart-pop-out.png'),(await popup.webContents.capturePage()).toPNG());report.screenshots.push('chart-pop-out.png');break;}catch(error){if(attempt===2)throw error;await wait(300);}}
      popup.close();for(let i=0;i<40&&!popup.isDestroyed();i++)await wait(50);assert.equal(BrowserWindow.getAllWindows().length,1);
    });
    await check('Macro shows official indicators by market with the release calendar',async()=>{
      await navigate('Macro');await until('document.querySelectorAll(".macro-tile").length===3','Macro tiles missing');
      const fx=await run('document.querySelector(`[aria-label="USD/KRW"]`).textContent');assert.ok(fx.includes('1,348.5')&&fx.includes('+3.3'),'value and change: '+fx);
      assert.ok(await run('document.querySelector(`[aria-label="Release calendar"]`).textContent.includes("U.S. CPI")'));assert.equal(await run('document.querySelectorAll(".macro-spark").length'),3);
      await click('Refresh');await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Refresh"&&!b.disabled)','Refresh did not finish');
      await run('document.querySelector(`[aria-label="Macro inputs"]`).scrollIntoView({block:"start"})');await wait(200);await capture('macro-inputs');
    });
    await check('Fees & taxes shows the overseas tax ledger, cost method and executed order costs',async()=>{
      await navigate('Fees & taxes');await until('Boolean(document.querySelector(`[aria-label="Overseas capital gains"]`))&&Boolean(document.querySelector(`[aria-label="Order costs"]`))','Tax ledger missing');
      assert.equal(await run('document.querySelector(`[aria-label="Tax cost method"]`).value'),'moving-average');
      assert.ok(await run('document.querySelector(`[aria-label="Overseas capital gains"]`).textContent.includes("Basic deduction left")'));
      await click('Check broker costs');await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Check broker costs"&&!b.disabled)','Broker cost check did not finish');
      await run('document.querySelector(`[aria-label="Overseas capital gains"]`).scrollIntoView({block:"start"})');await wait(200);await capture('fees-taxes-ledger');
    });
    await check('Token saving settings save and show today\'s review counts',async()=>{
      await navigate('Engine settings');await until('Boolean(document.querySelector(`[aria-label="Token saving"]`))','Token saving section missing');
      assert.equal(await run('document.querySelector(`[aria-label="Skip unchanged reviews"]`).checked'),true);
      await run('(()=>{const el=document.querySelector(`[aria-label="Model routing"]`);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,"auto");el.dispatchEvent(new Event("change",{bubbles:true}));})()');
      await click('Save changes');await until('(async()=>(await window.portfolio.getRuntime()).config.modelRouting==="auto")()','Routing not saved');
      assert.ok(await run('document.querySelector(`[aria-label="Token saving"]`).textContent.includes("routing changes nothing")||document.querySelector(`[aria-label="Token saving"]`).textContent.includes("checks it before any order proposal")'));
      await run('document.querySelector(`[aria-label="Token saving"]`).scrollIntoView({block:"start"})');await wait(200);await capture('token-saving');
      await run("window.portfolio.configureRuntime({modelRouting:'fixed'})");
    });
    await check('Short & leverage allows leveraged ETFs per market with approval and records product overrides',async()=>{
      await navigate('Short & leverage');await until('Boolean(document.querySelector(`[aria-label="Korea allow leveraged and inverse ETFs"]`))','Korea leverage settings missing');
      assert.equal(await run('document.querySelector(`[aria-label="Korea automatic leveraged and inverse ETFs"]`).disabled'),true,'automatic mode needs the switch first');
      await run('document.querySelector(`[aria-label="Korea allow leveraged and inverse ETFs"]`).click()');await wait(100);await click('Save Korea settings');
      await until('document.querySelector(`[aria-label="Korea short and leverage"] .state-pill`)?.textContent==="propose only"','Policy not saved');
      await run('(()=>{const set=(label,value)=>{const el=document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));};set("Override symbol","NASD:TEST");set("Override multiple","-2");})()');
      await click('Set multiple');await until('document.querySelector(`[aria-label="Product overrides"]`)?.textContent.includes("2x inverse")','Override not shown');
      assert.ok(await run('document.querySelector(`[aria-label="Korea Margin buying (신용매수)"]`).textContent.includes("KIS does not offer credit orders on mock accounts")'),'margin section explains the live-account requirement');
      assert.ok(await run('Boolean(document.querySelector(`[aria-label="Korea Short selling (대주매도)"]`))')&&!(await run('Boolean(document.querySelector(`[aria-label="U.S. Short selling (대주매도)"]`))')),'short selling is offered for Korea only');
      await run("document.querySelector(`[aria-label=\"Korea short and leverage\"]`).scrollIntoView({block:\"start\"})");await wait(150);await capture("short-leverage-settings");
      await run('document.querySelector(`[aria-label="Korea allow leveraged and inverse ETFs"]`).click()');await wait(100);await click('Save Korea settings');await until('document.querySelector(`[aria-label="Korea short and leverage"] .state-pill`)?.textContent==="off"','Policy not reset');
    });
    await check('Overview shows attention items and AI activity; paper trades in one step; the console reads as conversations',async()=>{
      await navigate('Home');await until('Boolean(document.querySelector(`[aria-label="Needs your attention"]`))&&Boolean(document.querySelector(`[aria-label="AI activity"]`))','Dashboard panels missing');
      assert.ok(await run('document.querySelector(`[aria-label="AI activity"] .decision-feed li`)!==null'),'recent decisions listed');
      await navigate('Paper trading');await until('Boolean(document.querySelector(`[aria-label="Simulation running"]`))','Simulation switch missing');
      if(!(await run('document.querySelector(`[aria-label="Simulation running"]`).checked')))await run('document.querySelector(`[aria-label="Simulation running"]`).click()');
      await until('document.querySelector(`[aria-label="Simulation running"]`).checked','Simulation did not start');
      await run('document.querySelector(`.price-board tbody tr .mini.buy`).click()');await wait(100);
      await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Place paper buy order'&&!b.disabled)`,'Order button not ready');await click('Place paper buy order');
      await until('document.querySelector(`[aria-label="Paper order ticket"]`).textContent.includes("placed")','Paper order not placed');
      await run('document.querySelector(`[aria-label="Simulation running"]`).click()');await until('!document.querySelector(`[aria-label="Simulation running"]`).checked','Simulation did not pause');
      await navigate('AI console');await until('document.querySelectorAll(".run-item").length>0&&Boolean(document.querySelector(".bubble.from-ai"))','Conversation view missing');
      assert.equal(await run('document.querySelector(".run-item").getAttribute("aria-current")'),'true','latest run selected');
      await capture('ai-console-conversation');
    });
    // Optional design review: full-page screenshots of every tab (PORTFOLIO_TOUR=1).
    if(process.env.PORTFOLIO_TOUR){win.setSize(1280,900);await run("document.documentElement.dataset.theme='dark'");const tabs=await run('Array.from(document.querySelectorAll(".nav")).map(b=>b.dataset.tab)');
      win.webContents.on("console-message",(...args)=>{const m=args[0]?.message??args[2];if(/error/i.test(String(m)))console.log("renderer: "+String(m).slice(0,600));});console.log("tour tabs: "+tabs.join(" | "));for(const tab of tabs){try{await navigate(tab);}catch(error){console.log("tour skip "+tab+": "+error.message);continue;}await wait(600);const height=await run('Math.min(6000,document.documentElement.scrollHeight)');win.setSize(1280,height);await wait(300);await capture('tour-'+tab.toLowerCase().replace(/[^a-z]+/g,'-'));win.setSize(1280,900);}}
    console.log(`UI regression passed: ${report.checks.length} groups, all tabs × 2 themes × 2 sizes, zero/positive/negative deltas, refresh recovery and read-only AI reviews.`);finish(0);
  }catch(error){report.errors.push(error.stack??String(error));try{await capture('failure');}catch{}console.error(error);finish(1);}
});});require('../electron/main.cjs');
