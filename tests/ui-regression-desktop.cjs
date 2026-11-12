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
const report={checks:[],screenshots:[],errors:[]};let win;let failUS=false;let usDelayMs=0;let posts=0;let researchMode=false;let researchRound=0;let decisionFailure=false;let dartFixture=false;
const domestic={accountKey:'ui-regression-fixture',environment:'mock',source:'kis',cash:10000000,reportedTotal:10000000,holdings:[]};
const overseas={accountKey:'ui-regression-fixture:US',environment:'mock',source:'kis-us',currency:'USD',cash:0,reportedTotal:0,holdings:[]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-ui-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:true,dartConnected:dartFixture,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='company-chart')return {status:'available',retrievedAt:Date.now(),metrics:{price:110,dayHigh:115,dayLow:100,PER:12,PBR:2,high52Week:150,low52Week:70,ROE:null},data:{SMA5:105,SMA10:102,SMA20:98,stochastic:{K:60,D:58},asOf:Date.now()-86400000},candles:Array.from({length:30},(_,i)=>({timestamp:Date.now()-(30-i)*86400000,open:90+i,high:94+i,low:88+i,close:92+i,volume:100+i}))};
  if(operation==='refresh')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='us-context'&&usDelayMs)await new Promise(resolve=>setTimeout(resolve,usDelayMs));
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
  if(operation==='decision'&&payload.context.reviewInterval?.auto&&!payload.options?.continuation)return {provider:'openai',toolCalls:[{name:'set_review_interval',callId:'cadence',args:{minutes:15,reason:'Fixture volatility calls for closer monitoring.'}}],continuation:[],usage:{inputTokens:10,outputTokens:5}};
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
// 150 s (was 90 s): the case took 87-89 s before the Home Result tile and Holdings Movement screenshots (2026-11-11).
const timer=setTimeout(()=>{report.errors.push('UI regression timed out');finish(1);},150000);
function finish(code){clearTimeout(timer);fs.writeFileSync(path.join(output,'ui-regression.json'),JSON.stringify(report,null,2));app.exit(code);}
app.once('browser-window-created',(_event,created)=>{win=created;win.webContents.on('console-message',(...args)=>{const m=args[0]?.message??args[2];const level=args[0]?.level??args[1];if(level==='error'||level===3||/Error|Uncaught/.test(String(m)))console.log('RENDERER-ERROR '+String(m).slice(0,800));});win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{
  const run=code=>win.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(code,message)=>{for(let i=0;i<60;i++){if(await run(code))return;await wait(50);}throw new Error(message);};
  const click=async text=>{await run(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing UI button');button.click();})()`);await wait(80);};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1').textContent===${JSON.stringify(tab)}`,'Navigation failed');await wait(100);};
  // Step A3: Engine settings has four tabs; only the open one is rendered.
  const engine=async tab=>{await navigate('Engine settings');await run(`Array.from(document.querySelectorAll('[aria-label="Engine sections"] [role=tab]')).find(b=>b.textContent===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('[role=tabpanel]')?.getAttribute('aria-label')===${JSON.stringify(tab)}`,'Engine tab '+tab);await wait(80);};
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
    // Home Result tile (2026-11-11): the third tile is Result; its Unrealized line keeps the old tile's figure.
    await check('Overview: the Result tile shows the unrealized loss in KRW, with Total, Today and the date line, in both themes',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.cash=0;overseas.reportedTotal=180;
      await run("(async()=>window.portfolio.saveCosts({...await window.portfolio.getCosts(),usdKRW:1000}))()");await run('window.portfolio.refreshPortfolio()');await navigate('Home');
      for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme)await run('document.querySelector(`[aria-label="Dark mode"]`).click()');
        await until('document.querySelector(`[aria-label="Result"] [aria-label="Unrealized"] dd`)?.dataset.amount==="-20000"','Combined P/L missing');
        // The U.S. amount in dollars is under More (step 3).
        assert.equal(await run('document.querySelector(`[aria-label="Result"] [aria-label="U.S. unrealized"]`).dataset.amount'),'-20');
        const tile=await run('(()=>{const t=document.querySelector(`[aria-label="Result"]`);return {label:t.querySelector("small").textContent,total:t.querySelector(".result-total").textContent,lines:Array.from(t.querySelectorAll(".result-lines dt")).map(d=>d.textContent),text:t.textContent};})()');
        console.log('RESULT-TILE '+JSON.stringify(tile));assert.equal(tile.label,'Result');assert.deepEqual(tile.lines.slice(0,2),['Today','Unrealized']);assert.ok(!/realized/i.test(tile.text.replace(/unrealized/gi,'')),'no realized line');
        assert.equal(await run('document.querySelectorAll(".home-metrics .metric-card").length'),3,'three key numbers');assert.ok((await run('document.querySelector(`[aria-label="Combined equity"] strong`).textContent')).includes('₩'),'total equity shown');
        await run('document.querySelector(".home-metrics").scrollIntoView({block:"center"})');await capture('overview-pnl-'+theme);
        // More, opened: every line, the dollar amount and the closing sentence; captured with the whole tile in view.
        const more=await run('(()=>{const d=document.querySelector(`[aria-label="Result"] details.result-more`);d.open=true;d.closest("section").scrollIntoView({block:"center"});return {summary:d.querySelector("summary").textContent,lines:Array.from(d.querySelectorAll("li")).map(l=>l.textContent),bench:document.querySelector(`[aria-label="Result"] [aria-label="Benchmark"] dd`)?.textContent??null};})()');
        console.log('RESULT-MORE '+JSON.stringify(more));assert.equal(more.summary,'More');assert.deepEqual(more.lines.map(l=>l.split(':')[0]),['Total','Unrealized','U.S. unrealized','Total and Unrealized come from different records and need not add up.'],'More: Total, Unrealized, U.S. dollars and the closing line only (no Today, no benchmark)');assert.ok(more.lines.includes('U.S. unrealized: −$20.00 (-10.0%), in dollars.'),'U.S. dollar line');assert.equal(await run('getComputedStyle(document.querySelector(`[aria-label="Result"] [aria-label="U.S. unrealized"] .nowrap`)).whiteSpace'),'nowrap','the sign stays with the dollar amount');assert.equal(more.lines.at(-1),'Total and Unrealized come from different records and need not add up.');
        if(more.bench)assert.match(more.bench,/%· you [+-]/);await wait(150);await capture('home-result-more-'+theme);
        await run('document.querySelector(`[aria-label="Result"] details.result-more`).open=false');
        // Wide, mid and the minimum window width (760): nothing in the three tiles overflows its tile.
        const [w0,h0]=win.getSize();
        for(const [width,height] of [[1360,880],[960,720],[760,700]]){win.setSize(width,height);await wait(250);await run('document.querySelector(`[aria-label="Result"]`).scrollIntoView({block:"center"})');
          const over=await run('Array.from(document.querySelectorAll(".home-metrics .metric-card")).flatMap(c=>[c,...c.querySelectorAll("*")].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=="visible"||e.getBoundingClientRect().right>c.getBoundingClientRect().right+1).map(e=>(c.getAttribute("aria-label")??"")+" "+e.tagName+"."+e.className))');
          assert.deepEqual(over,[],`Home tiles overflow at ${width}px (${theme})`);await capture(`home-result-${width}-${theme}`);}
        win.setSize(w0,h0);await wait(200);
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
      await navigate('Connections');await click('Import provider JSON');await navigate('Engine settings');await run("window.portfolio.configureRuntime({scope:'both',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true,enabled:false})");await wait(2200);await click('Run portfolio review');await until('document.querySelector("main").textContent.includes("Completed.")','Read-only review did not complete');const runtime=await run('window.portfolio.getRuntime()');assert.equal(runtime.lastError,null);assert.equal(runtime.reviews[0].decision.action,'Hold');assert.match(runtime.execution.detail,/Korea: orders off/);assert.match(runtime.execution.detail,/U.S.: orders off/);assert.equal(posts,0);assert.equal((await run("window.portfolio.liveAction('get')")).state.enabled,false);assert.equal((await run("window.portfolio.usAction('get')")).state.enabled,false);
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
      await engine('Alerts');await until('document.querySelector(\`[aria-label="AI review alerts"]\`)?.textContent.includes("1.5%")','AI alert not visible');await run('document.querySelector(`[aria-label="AI review alerts"]`).scrollIntoView({block:"center"})');await capture('agent-review-alert');await click('Reset to default alerts');await until('document.querySelector(\`[aria-label="AI review alerts"]\`).textContent.includes("Default movement threshold")','Reset failed');researchMode=false;
    });
    await check('No page search; draft actions persist across tabs',async()=>{
      assert.equal(await run('document.querySelector(`[aria-label="Find a page"]`)'),null);
      await engine('Trading');const before=await run('window.portfolio.getRuntime()');
      await run('(()=>{const input=document.querySelector(`[aria-label="Agent guidelines"]`);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"UI draft fixture");input.dispatchEvent(new Event("input",{bubbles:true}));})()');await until('Boolean(document.querySelector(".settings-draft-bar"))','Draft bar missing');
      assert.ok(await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Run portfolio review").disabled'));
      await navigate('Home');await engine('Trading');assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),'UI draft fixture');await capture('settings-draft-actions');await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard did not clear draft');assert.equal((await run('window.portfolio.getRuntime()')).config.guidelines,before.config.guidelines);assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),before.config.guidelines);
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
      await run("window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithOpenAI:true,enabled:false,autoSubmit:false,closedMarketReviews:'keep'})");await navigate('Home');await wait(2200);const before=(await run('window.portfolio.getRuntime()')).reviews[0]?.id??null;await click('Start auto trading');await until('(async()=>{const s=await window.portfolio.getRuntime();return s.launch.running&&!s.busy;})()','Launch failed');const active=await run('window.portfolio.getRuntime()');assert.equal(active.execution.markets[0].automatic,true);const startNote=await run('Array.from(document.querySelectorAll(`p[role=status]`)).map(p=>p.textContent).find(t=>t.startsWith("Auto trading started"))??""');assert.match(startNote,/Next review at \d\d:\d\d KST|review is due|before the next open/,'Start says when the next review runs');if(/Next review at/.test(startNote))assert.equal(active.reviews[0]?.id??null,before,'Start does not run a review');assert.equal(posts,0);await wait(2200);await click('Stop auto trading');await until('(async()=>!(await window.portfolio.getRuntime()).sessionArmed)()','Stop failed');await capture('auto-trading-controls');
    });
    // Release gate G4 (1.5.50): Start reaches running and says so; how long it takes; what the buttons show meanwhile; a
    // second click during start; Stop. Then the same with a slow U.S. refresh (the start waits for it with Korea + U.S.).
    await check('G4: Start auto trading reaches running and says so, with a normal and a slow U.S. refresh; a second click during start; Stop',async()=>{
      await run("window.portfolio.configureRuntime({scope:'both',provider:'openai',shareKisWithOpenAI:true,enabled:false,autoSubmit:false,closedMarketReviews:'keep'})");await navigate('Home');await wait(2200);
      const header='Array.from(document.querySelectorAll(`button`)).find(b=>/^(Start auto trading|Cancel start|Starting…|Working…|Stop auto trading)$/.test(b.textContent))';const labels=`(()=>({header:${header}?.textContent??null,headerDisabled:Boolean(${header}?.disabled)}))()`;
      const timeline=async(ms,until)=>{const t0=Date.now(),seen=[];let last='';while(Date.now()-t0<ms){const l=await run(labels),s=await run('window.portfolio.getRuntime().then(s=>({running:Boolean(s?.launch?.running),starting:Boolean(s?.launch?.starting),busy:Boolean(s?.busy)}))');
          const key=JSON.stringify({...l,...s});if(key!==last){seen.push({atMs:Date.now()-t0,...l,...s});last=key;}if(until&&until(s))break;await new Promise(r=>setTimeout(r,25));}return seen;};
      const g4={};
      for(const [name,delay] of [['normal',0],['slow U.S. refresh (3 s)',3000]]){usDelayMs=delay;await until('(async()=>{const s=await window.portfolio.getRuntime();return Boolean(s?.launch)&&!s.launch.running&&!s.launch.starting&&!s.busy;})()','not idle before Start');
        const t0=Date.now();await run(`${header}?.click()`);
        // A second click 300 ms into the start, on the same header button.
        const early=await timeline(300,s=>!delay&&s.running);const second=delay?await run(`(()=>{const b=${header};if(!b)return null;const before={text:b.textContent,disabled:b.disabled};b.click();return before;})()`):'not attempted: the start had completed before a second click could land';
        const rest=await timeline(15000,s=>s.running&&!s.busy);const confirmedMs=Date.now()-t0;await wait(400);
        const note=await run('Array.from(document.querySelectorAll(`p[role=status]`)).map(p=>p.textContent).find(t=>/^Auto trading (started|stopped)|Launch canceled|Could not|already running/.test(t))??null');
        const state=await run('window.portfolio.getRuntime().then(s=>({running:Boolean(s?.launch?.running),sessionArmed:s?.sessionArmed??null,label:s?.scheduler?.label??null}))');
        g4[name]={confirmedMs,timeline:[...early,...rest.map(x=>({...x,atMs:x.atMs+300}))],secondClick:second,note,state,headerAfter:await run(labels)};
        if(state.running){const s0=Date.now();await run(`${header}?.click()`);await until('(async()=>!(await window.portfolio.getRuntime()).sessionArmed)()','Stop failed');g4[name].stopMs=Date.now()-s0;g4[name].stopNote=await run('Array.from(document.querySelectorAll(`p[role=status]`)).map(p=>p.textContent).find(t=>t.startsWith("Auto trading stopped"))??null');g4[name].headerAfterStop=await run(labels);}
        await capture(delay?'g4-start-slow':'g4-start-normal');}
      usDelayMs=0;console.log('G4 '+JSON.stringify(g4));report.g4=g4;
      for(const [name,r] of Object.entries(g4)){assert.ok(r.state.running,`${name}: running: ${JSON.stringify(r)}`);assert.match(r.note??'',/^Auto trading started/,`${name}: the start is said`);assert.match(r.stopNote??'',/^Auto trading stopped/,`${name}: the stop is said`);}
      // While its own start is pending the clicked button is disabled and says so; it never offers a cancel it cannot do.
      const pending=g4['slow U.S. refresh (3 s)'].timeline.filter(x=>x.starting);assert.ok(pending.length&&pending.every(x=>x.header==='Starting…'&&x.headerDisabled),'during a slow start the button reads Starting…: '+JSON.stringify(pending));
    });
    // Release gate G5 (1.5.50): the screens 1.5.50 changes that no other check captures, and Journal/News history: the
    // window's light state counts each history list (lag fix L2), and the full lists it loads on demand match those counts.
    await check('G5: Connections, the consent hint and the status header are captured; history counts match the loaded lists',async()=>{
      await navigate('Connections');await wait(300);await capture('g5-connections');
      // B1: the Anthropic card in AI providers (status, Test, sharing, limits); dark and light at 1360 and 760.
      await until('Boolean(document.querySelector(`[aria-label="Anthropic provider"]`))','the Anthropic card is missing');
      assert.match(await run('document.querySelector(`[aria-label="Anthropic provider"]`).textContent'),/^AnthropicDry run(?! only)(?!,).*Share KIS data with Anthropic.*Calls per day.*Spending per day/);
      {const [w0,h0]=win.getSize();const t0=await run('document.documentElement.dataset.theme');try{for(const [w,h] of [[1360,880],[760,700]]){win.setSize(w,h);await wait(250);for(const t of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==t){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await wait(200);}
        await run('document.querySelector(`[aria-label="AI providers"]`).scrollIntoView({block:"start"})');await wait(200);assert.equal(await run('document.documentElement.scrollWidth<=window.innerWidth+1'),true,`no overflow at ${w} ${t}`);await capture(`b1-ai-providers-${t}-${w}`);}}}
        finally{win.setSize(w0,h0);if(await run('document.documentElement.dataset.theme')!==t0){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await wait(200);}}}
      await capture('g5-connections-anthropic');
      // B1: data sharing is per provider on the Connections cards; Engine → Trading links there.
      await engine('Trading');assert.match(await run('Array.from(document.querySelectorAll(`.setting-row`)).find(r=>r.textContent.startsWith("Data sharing"))?.textContent??""'),/^Data sharingPer provider, in Connections · OpenAI (on|off), Anthropic (on|off)Open Connections$/);
      await click('Open Connections');await until('document.querySelector("h1")?.textContent==="Connections"','link did not open Connections');await until('Boolean(document.querySelector(`[aria-label="Share KIS data with OpenAI"]`))','OpenAI consent missing');
      assert.equal(await run('document.querySelector(`[aria-label="Share KIS data with Anthropic"]`)?.getAttribute("role")'),'switch');await run('document.querySelector(`[aria-label="AI providers"]`).scrollIntoView({block:"start"})');await wait(200);await capture('g5-engine-consent');
      await navigate('Home');await run('document.querySelector(`button.top-chip[title="AI engine"]`)?.click()');await until('Boolean(document.querySelector(`.chip-panel`))','the status header menu opens');await wait(200);await capture('g5-status-header');
      assert.ok(await run('/Start auto trading|Stop auto trading|Starting…|Cancel start/.test(document.querySelector(`.chip-panel`).textContent)'),'the menu shows the start control');await run('document.querySelector(`button.top-chip[title="AI engine"]`).click()');
      // H2/H3: the value tile and the Cash tile follow the range rule (under 0.05% of the value: one figure).
      const pf=await run('window.portfolio.getPortfolio()'),cv=pf?.valuation?.combined;const spread=cv&&!cv.exact&&cv.high!=null&&cv.low>0?(cv.high-cv.low)/cv.low:null;
      const tile=await run('({title:document.querySelector(`[aria-label="Combined equity"] small`)?.textContent??null,range:Boolean(document.querySelector(`[aria-label="Value range"]`)),text:document.querySelector(`[aria-label="Combined equity"]`)?.textContent??"",cash:document.querySelector(`[aria-label="Cash"] .metric-foot span`)?.textContent??null})');
      console.log('G5-HOME '+JSON.stringify({spread,exact:cv?.exact??null,tile}));
      if(spread!=null&&spread<0.0005){assert.equal(tile.title,'Account value');assert.equal(tile.range,false);assert.ok(!/so the value is (a range|an estimate)\./.test(tile.text.replace(/Details.*$/s,'')),'the sentence is under Details');if(spread===0)assert.ok(!/Range ₩/.test(tile.text)&&!/a range\./.test(tile.text),'no range of zero');
        if((cv?.reasons??[]).every(r=>/^Korea:/.test(r)))assert.ok(!/U\.S\. trades/.test(tile.text),'a Korean reason is not called a U.S. one');assert.match(tile.cash,/% of account value$/);}
      else if(spread!=null){assert.equal(tile.title,'Estimated account value');assert.equal(tile.range,true);assert.equal(tile.cash,'Share of account value: not shown while the value is a range');}
      await capture('g5-home-value');
      const light=await run('window.portfolio.getRuntime()'),full=await run('window.portfolio.getRuntimeHistory()');const counts=light.historyCounts??{};
      const mismatched=Object.entries(counts).filter(([k,n])=>(Array.isArray(full?.[k])?full[k].length:0)!==n);console.log('G5-HISTORY '+JSON.stringify({counts,loaded:Object.fromEntries(Object.keys(counts).map(k=>[k,Array.isArray(full?.[k])?full[k].length:null])),version:light.historyVersion}));
      assert.deepEqual(mismatched,[],'each history list loads with the length the light state counts');assert.ok(Object.keys(counts).length>0,'counts are sent');
      await navigate('Journal');await wait(300);await capture('g5-journal');await run("Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='News')?.click()");await wait(300);await capture('g5-news');
    });
    // Release gate G5 / F3 (1.5.50): the deposits and withdrawals table, with a 7-digit KRW deposit, a negative USD
    // transfer and a long note, in both themes, at the default and the minimum window width; its layout is measured.
    await check('G5/F3: the deposits and withdrawals table keeps its columns apart, dates on one line, and the button on the form edge',async()=>{
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));const {PerformanceHistory}=require('../electron/performance.cjs');const perf=new PerformanceHistory(db);
      const acct=(await run('window.portfolio.getPerformance?.()'))?.account??'ui-regression-fixture';const day=new Date(Date.now()-3*86400000).toISOString().slice(0,10);
      const added=[];for(const f of [{day,market:'KR',amount:1000000,note:'Deposit'},{day,market:'US',amount:-10000,note:'Moved to the Korean account for the KOSPI rebalance, as agreed with the planner on the monthly call',transfer:true},{day,market:'KR',amount:-10000000,note:''}])try{added.push(perf.addFlow(acct,f).id);}catch(e){console.log('F3 fixture: '+e.message);}db.close();
      const measure=`(()=>{const t=document.querySelector('[aria-label="Recorded flows"]');if(!t)return null;const rows=Array.from(t.tBodies[0].rows);const text=el=>{const r=document.createRange();r.selectNodeContents(el);return Array.from(r.getClientRects());};
        const lines=el=>{const rs=text(el).filter(r=>r.width>0);return new Set(rs.map(r=>Math.round(r.top))).size;};
        const out=rows.map(r=>{const [d,a,m,n]=r.cells;const ar=text(a).at(-1),mr=text(m)[0];return {date:d.textContent,dateLines:lines(d),amount:m.textContent,amountLines:lines(m),gap:ar&&mr?Math.round(mr.left-ar.right):null,amountRight:Math.round(m.getBoundingClientRect().right-text(m).at(-1).right)};});
        const head=Array.from(t.tHead.rows[0].cells).map((h,i)=>Math.round(h.getBoundingClientRect().left-t.tBodies[0].rows[0].cells[i].getBoundingClientRect().left));
        const form=document.querySelector('.flow-form label'),btn=document.querySelector('.flow-form-actions button');return {rows:out,headOffsets:head,buttonEdge:form&&btn?Math.round(btn.getBoundingClientRect().left-form.getBoundingClientRect().left):null,overflow:document.querySelector('main').scrollWidth-document.querySelector('main').clientWidth};})()`;
      const shots={};
      for(const [width,height] of [[1360,880],[760,600]]){win.setSize(width,height);for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'theme');}
        await navigate('Performance');await until('Boolean(document.querySelector(`[aria-label="Deposits and withdrawals"]`))','the flows section');await run('(()=>{const d=document.querySelector(`[aria-label="Deposits and withdrawals"]`);d.open=true;d.scrollIntoView({block:"start"});})()');
        await until('document.querySelectorAll(`[aria-label="Recorded flows"] tbody tr`).length>=3','the fixture flows');await wait(250);const m=await run(measure);shots[`${theme}-${width}`]=m;await capture(`g5-flows-${theme}-${width}`);
        for(const r of m.rows){assert.equal(r.dateLines,1,`${theme} ${width}: ${r.date} on one line`);assert.equal(r.amountLines,1,`${theme} ${width}: ${r.amount} on one line`);assert.ok(r.gap>=12,`${theme} ${width}: Account and Amount apart (${r.gap}px)`);assert.ok(r.amountRight<=1,`${theme} ${width}: Amount right-aligned`);}
        assert.ok(m.headOffsets.every(x=>Math.abs(x)<=1),`${theme} ${width}: headers aligned with their columns ${m.headOffsets}`);assert.ok(Math.abs(m.buttonEdge)<=1,`${theme} ${width}: Record on the form's left edge (${m.buttonEdge}px)`);assert.ok(m.overflow<=2,`${theme} ${width}: no horizontal overflow (${m.overflow}px)`);}}
      win.setSize(1280,900);console.log('G5-FLOWS '+JSON.stringify(shots));
      // The fixture flows are removed again, so the later flow checks see the table as they left it.
      {const db2=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));for(const id of added)db2.prepare('DELETE FROM cash_flows WHERE id=?').run(id);db2.close();}
    });
    // Journal redesign (1.5.50, J1/J2) and gate check G5: one row of six tabs, Decisions by default, nothing stacked above
    // the tabs; the decision detail shows a short summary first and everything else under More.
    // Release gate review Q1 (1.5.50): the material-range branch of Home (H2/H3). A $100 U.S. buy filled moments ago and
    // listed at the tracker's first reading stays in flight, awaiting verification, so the value is a range of about
    // ₩130,000 on ₩10M (above 0.05%): the tile shows both ends and the Cash tile says why there is no share.
    await check('Q1: a material value range shows both ends on Home, the reason, and no Cash share',async()=>{
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));const {InFlight}=require('../electron/valuation.cjs');
      const acct='ui-regression-fixture';const saved=db.prepare('SELECT payload FROM inflight_settlement WHERE account=?').get(acct)?.payload??null;db.prepare('DELETE FROM inflight_settlement WHERE account=?').run(acct);
      const now=Date.now();const f=new InFlight(db,()=>now);const pf0=await run('window.portfolio.getPortfolio()');const usCash=pf0?.cash?.USD??0;
      const Q={id:'q1-open-buy',symbol:'NASD:TQ',side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'mock',accountKey:acct+':US',market:'US',day:new Date(now).toISOString().slice(0,10),createdAt:now-60000,filledObservedAt:now-60000};
      f.observe(acct,{us:{accountKey:acct+':US',environment:'mock',cash:usCash,pendingSaleProceeds:0,holdings:[],timestamp:new Date(now).toISOString()},orders:[Q],fx:1300});
      try{
        await navigate('Performance');await navigate('Home');await until('document.querySelector(`[aria-label="Combined equity"] small`)?.textContent==="Estimated account value"','the tile shows an estimated value');
        const pf=await run('window.portfolio.getPortfolio()'),cv=pf.valuation.combined;const spread=(cv.high-cv.low)/cv.low;
        const tile=await run('({range:document.querySelector(`[aria-label="Value range"]`)?.textContent??null,text:document.querySelector(`[aria-label="Combined equity"]`).textContent,cash:document.querySelector(`[aria-label="Cash"] .metric-foot span`)?.textContent??null})');
        console.log('Q1-HOME '+JSON.stringify({low:cv.low,high:cv.high,spread,tile}));assert.ok(spread>=0.0005,'a material range: '+spread);
        const nums=(tile.range??'').match(/₩[\d,]+/g)??[];assert.equal(nums.length,2,'both ends: '+tile.range);assert.ok(Number(nums[1].replace(/[₩,]/g,''))>Number(nums[0].replace(/[₩,]/g,'')),'low then high');
        assert.match(tile.text.replace(/Details.*$/s,''),/Some U\.S\. trades are still being checked, so the value is a range\./,'the reason on the tile');
        assert.equal(tile.cash,'Share of account value: not shown while the value is a range');await capture('q1-home-range');
      }finally{db.prepare('DELETE FROM inflight_settlement WHERE account=?').run(acct);if(saved)db.prepare('INSERT INTO inflight_settlement VALUES(?,?)').run(acct,saved);db.close();}
      // The day's valuation range changed with no money change awaiting the user: the summary is provisional with range
      // changes only. Performance renders (it blanked on pv.included.find before), with no "money changes awaiting you" notice.
      await navigate('Performance');await until('Boolean(document.querySelector(`[aria-label="Period returns"]`))','Performance renders with range changes only');
      const perf=await run('window.portfolio.getPerformance()');const prov=(perf?.summaries??perf?.summary??perf)?.provisional??null;console.log('Q1-PROVISIONAL '+JSON.stringify({keys:prov?Object.keys(prov):null}));
      assert.ok(!(await run('document.querySelector(`main`).textContent.includes("Provisional performance")')),'no notice about money changes that do not exist');
    });
    // Fact check fixes (2026-11-11): X1 the Extended hours card without the ended KRX single-price auction; X2 the
    // leveraged eligibility row, its notice while not confirmed, and the details behind More. Dark and light.
    await check('X1/X2: Extended hours has four switches and says when the KRX auction ended; leveraged products wait for confirmed eligibility',async()=>{
      const theme0=await run('document.documentElement.dataset.theme');const setTheme=async t=>{if(await run('document.documentElement.dataset.theme')!==t){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(t)}`,'theme');}};
      await engine('Trading');await until('Boolean(document.querySelector(`#eng-extended`))','Extended hours card');
      const card=await run('(()=>{const c=document.querySelector(`#eng-extended`);c.querySelectorAll(`details`).forEach(d=>d.open=true);c.scrollIntoView({block:"start"});return {text:c.textContent,switches:c.querySelectorAll(`[role=switch],input[type=checkbox]`).length};})()');
      console.log('X1-CARD '+JSON.stringify({switches:card.switches}));assert.equal(card.switches,4,'four session switches');assert.ok(!/single price|order type 07/.test(card.text.replace(/KRX ended its after-hours single-price auction on 2026-09-14, so the app no longer offers it\./,'')),'no single-price row or route');
      assert.match(card.text,/KRX ended its after-hours single-price auction on 2026-09-14, so the app no longer offers it\./);
      for(const t of ['dark','light']){await setTheme(t);await run('document.querySelector(`#eng-extended`).scrollIntoView({block:"start"})');await wait(150);await capture('x1-extended-hours-'+t);}
      const before=await run('window.portfolio.getExposure()');const savedKR=before.state.markets.KR.policy?.leveragedEtps??null;
      try{
        await run("window.portfolio.saveExposurePolicy('KR',{leveragedEtps:{enabled:true,brokerEligible:null}})");await navigate('Short & leverage');
        await until('document.querySelector(`[aria-label="Korea eligibility notice"]`)?.textContent==="Not offered to the AI until you confirm eligibility."','the notice while not confirmed');
        const row=await run('(()=>{const s=document.querySelector(`[aria-label="Korea broker eligibility"]`);const sec=s.closest(`.exposure-section`);sec.querySelectorAll(`details`).forEach(d=>d.open=true);sec.scrollIntoView({block:"start"});return {value:s.value,options:Array.from(s.options).map(o=>o.textContent),text:sec.textContent};})()');
        console.log('X2-ROW '+JSON.stringify({value:row.value,options:row.options}));assert.equal(row.value,'');assert.deepEqual(row.options,['Not confirmed','Yes','No']);
        for(const s of ['My KIS account can buy these products','KIS requires a basic deposit and investor education.','Why the app asks','KRW 10 million','KRW 30 million'])assert.ok(row.text.includes(s),s);
        for(const t of ['dark','light']){await setTheme(t);await run('document.querySelector(`[aria-label="Korea broker eligibility"]`).closest(`.exposure-section`).scrollIntoView({block:"start"})');await wait(150);await capture('x2-leverage-not-confirmed-'+t);}
        await run("window.portfolio.saveExposurePolicy('KR',{leveragedEtps:{brokerEligible:true}})");await navigate('Home');await navigate('Short & leverage');
        await until('document.querySelector(`[aria-label="Korea broker eligibility"]`)?.value==="yes"','confirmed');assert.equal(await run('Boolean(document.querySelector(`[aria-label="Korea eligibility notice"]`))'),false,'no notice once confirmed');
        await run('document.querySelector(`[aria-label="Korea broker eligibility"]`).closest(`.exposure-section`).scrollIntoView({block:"start"})');await wait(150);await capture('x2-leverage-confirmed-'+(await run('document.documentElement.dataset.theme')));
      }finally{await run(`window.portfolio.saveExposurePolicy('KR',{leveragedEtps:${JSON.stringify(savedKR?{enabled:savedKR.enabled,auto:savedKR.auto,brokerEligible:savedKR.brokerEligible??null}:{enabled:false,brokerEligible:null})}})`);await setTheme(theme0);}
    });
    // Plan stop fixes P1-P3 (2026-11-11): a purchase without its stop order is on Home and opens the Journal's Orders and
    // triggers tab; that tab shows the notice, a stop linked to its purchase, and a cancelled one with its reason.
    await check('P3: a purchase without a stop order is on Home and opens Orders and triggers, with a linked stop and a cancelled one',async()=>{
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      const rt=await run('window.portfolio.getRuntime()');const cfgScope=rt.config?.scope??JSON.parse(db.prepare('SELECT payload FROM automation_settings WHERE id=1').get().payload).scope;const scope=cfgScope==='paper'?'paper':`${cfgScope}:ui-regression-fixture`;const now=Date.now();
      const base={scope,symbol:'005930',side:'Sell',limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:200000}],symbols:['005930'],combine:'all',purpose:'stop_loss',createdAt:now-60000,expiresAt:now+86400000,priceAtCreation:216000,reviewId:'ui-fixture'};
      const rows=[{...base,id:'C-UILNK',status:'armed',quantity:2,reason:'Stop from the trade plan: breaks the August low',linkedBuy:{id:'P-UI',market:'KR',quantity:2}},
        {...base,id:'C-UICXL',status:'cancelled',quantity:1,reason:'Stop from the trade plan: closes below support',linkedBuy:{id:'P-UI2',market:'KR',quantity:1},outcome:'Not needed: the purchase did not fill (it was canceled: its stop time passed).',closedAt:now-30000,closedBy:'app'}];
      const failure={id:'PSF-UI',scope,symbol:'000660',quantity:3,reason:'Up to 5 armed conditional orders; cancel one first.',proposalId:'P-UI3',at:now-10000};
      try{
        for(const r of rows)db.prepare('INSERT INTO conditional_orders VALUES(?,?,?,?)').run(r.id,r.scope,r.status,JSON.stringify(r));db.prepare('INSERT INTO plan_stop_failures VALUES(?,?,?)').run(failure.id,scope,JSON.stringify(failure));
        await navigate('Performance');await navigate('Home');
        let att=null;for(let i=0;i<40;i++){att=await run('window.portfolio.getAttention()');if(att.items.some(x=>x.title==='No stop order for the purchase of 000660'))break;await wait(250);}
        console.log('P3-ATTENTION '+JSON.stringify({scope,items:att.items.map(x=>x.title)}));assert.ok(att.items.some(x=>x.title==='No stop order for the purchase of 000660'),'the attention state lists it');
        for(let i=0;i<40&&!(await run('Array.from(document.querySelectorAll(`[aria-label="Needs your attention"] li`)).some(li=>li.textContent.includes("No stop order for the purchase of 000660"))'));i++)await wait(250);
        const item=await run('(()=>{const li=Array.from(document.querySelectorAll(`[aria-label="Needs your attention"] li`)).find(l=>l.textContent.includes("No stop order for the purchase of 000660"));li.scrollIntoView({block:"center"});return li.textContent+" | "+li.getAttribute(`title`);})()');
        console.log('P3-HOME '+JSON.stringify(item));assert.match(item,/No stop order for the purchase of 000660/);assert.match(item,/3 000660: Up to 5 armed conditional orders; cancel one first\./);
        const theme0=await run('document.documentElement.dataset.theme');const setTheme=async t=>{if(await run('document.documentElement.dataset.theme')!==t){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(t)}`,'theme');}};
        for(const t of ['dark','light']){await setTheme(t);await run('Array.from(document.querySelectorAll(`[aria-label="Needs your attention"] li`)).find(l=>l.textContent.includes("No stop order for the purchase of 000660")).scrollIntoView({block:"center"})');await wait(150);await capture('p3-home-attention-'+t);}
        await run('Array.from(document.querySelectorAll(`[aria-label="Needs your attention"] li`)).find(l=>l.textContent.includes("No stop order for the purchase of 000660")).querySelector(`button`).click()');
        await until('document.querySelector(`h1`)?.textContent==="Journal"&&Boolean(document.querySelector(`[aria-label="Purchases without a stop order"]`))','Orders and triggers opened from Home');
        const desk=await run('(()=>{document.querySelectorAll(`[aria-label="Agent desk"] details`).forEach(d=>d.open=true);const d=document.querySelector(`[aria-label="Agent desk"]`);d.scrollIntoView({block:"start"});return {notice:document.querySelector(`[aria-label="Purchases without a stop order"]`).textContent,armed:document.querySelector(`[aria-label="Armed conditional orders"]`)?.textContent??"",text:d.textContent};})()');
        console.log('P3-DESK '+JSON.stringify({notice:desk.notice}));assert.equal(desk.notice,'The purchase of 3 000660 has no stop order. Up to 5 armed conditional orders; cancel one first.');
        assert.match(desk.armed,/sells only the shares its purchase buys/);assert.match(desk.text,/Not needed: the purchase did not fill \(it was canceled: its stop time passed\)\./);
        for(const t of ['dark','light']){await setTheme(t);await run('document.querySelector(`[aria-label="Agent desk"]`).scrollIntoView({block:"start"})');await wait(150);await capture('p3-orders-and-triggers-'+t);}
        await setTheme(theme0);await run('Array.from(document.querySelectorAll(`[aria-label="Journal views"] button`)).find(b=>b.textContent==="Decisions")?.click()');await wait(100);
      }finally{db.prepare('DELETE FROM conditional_orders WHERE id IN (?,?)').run('C-UILNK','C-UICXL');db.prepare('DELETE FROM plan_stop_failures WHERE id=?').run('PSF-UI');db.close();}
      // The window's runtime poll (2 s) drops the fixture orders before the next check counts the badges.
      for(let i=0;i<20&&(await run('window.portfolio.getRuntime()')).desk?.orders?.some(o=>o.id==='C-UILNK');i++)await wait(250);await wait(2500);
    });
    await check('J1/J2: six Journal tabs in order, Decisions by default, each captured; the decision detail collapsed and expanded',async()=>{
      // The tab is session memory (useDraftState): the default and the fallback for an unknown saved tab are unit-tested.
      await navigate('Journal');await until('Boolean(document.querySelector(`[aria-label="Journal views"]`))','Journal tabs');
      const tabs=await run('Array.from(document.querySelectorAll(`[aria-label="Journal views"] button`)).map(b=>b.textContent)');assert.deepEqual(tabs,['Decisions','Orders and triggers','Trades','Lessons','Scoreboard','Replay']);
      assert.ok(!(await run('Boolean(document.querySelector(`[aria-label="Replay"]`)||document.querySelector(`[aria-label="Agent desk"]`))')),'nothing stacked above the tabs');
      const pressed=await run('document.querySelector(`[aria-label="Journal views"] button[aria-pressed="true"]`)?.textContent');console.log('J-DEFAULT '+pressed);
      const st=await run('window.portfolio.getRuntime()');const armed=st.desk?.orders?.length??0,pending=(st.lessons??[]).filter(l=>!l.lifecycle||['pending','needs-review'].includes(l.lifecycle.status)).length;
      const counts=await run('Object.fromEntries(Array.from(document.querySelectorAll(`[aria-label="Journal views"] button`)).map(b=>[b.textContent,b.dataset.count??null]))');
      assert.equal(counts['Orders and triggers'],armed?String(armed):null);assert.equal(counts.Lessons,pending?String(pending):null);for(const t of ['Decisions','Trades','Scoreboard','Replay'])assert.equal(counts[t],null,t+': no badge');
      console.log('J-BADGES '+JSON.stringify({counts,armed,pending,navBadge:await run('document.querySelector(`.nav[data-tab="Journal"]`)?.textContent??null')}));
      for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'theme');}
        for(const tab of tabs){await click(tab);await wait(350);await capture(`g5-journal-${tab.toLowerCase().replace(/ /g,'-')}-${theme}`);}
        await click('Decisions');await until('Boolean(document.querySelector(`[aria-label="Decision detail"]`))','detail');
        await run('(()=>{const d=document.querySelector(`[aria-label="More about this decision"]`);if(d)d.open=false;})()');await wait(150);
        const collapsed=await run('({facts:Array.from(document.querySelectorAll(`[aria-label="Decision facts"] .decision-fact`)).map(f=>f.textContent),more:document.querySelector(`[aria-label="More about this decision"]`)?.open??null,id:document.querySelector(`[aria-label="Decision detail"]`).dataset.id})');
        assert.equal(collapsed.more,false);assert.ok(collapsed.facts.length>=1&&collapsed.facts.length<=3&&/^Order/.test(collapsed.facts[0]),'facts row: '+JSON.stringify(collapsed.facts));await capture(`g5-journal-detail-collapsed-${theme}`);
        await run('document.querySelector(`[aria-label="More about this decision"]`).open=true');await wait(150);
        assert.ok(await run('Array.from(document.querySelectorAll(`[aria-label="More about this decision"] button`)).some(b=>b.textContent==="Open conversation")'),'everything else is under More');
        assert.ok((await run('document.querySelector(`[aria-label="More about this decision"]`).textContent')).includes(collapsed.id.slice(0,8)),'the review id is under More');await capture(`g5-journal-detail-expanded-${theme}`);
        console.log('J-DETAIL '+JSON.stringify({theme,facts:collapsed.facts}));}
      await click('Decisions');
    });
    await check('Journal lists decisions beside a detail view that opens the matching AI conversation',async()=>{
      await navigate('Journal');await click('Decisions');await until('Boolean(document.querySelector(`[aria-label="Decision detail"]`))','Decision detail missing');
      const items=await run('document.querySelectorAll(`[aria-label="Decision list"] .run-item`).length');assert.ok(items>=2,'several decisions listed');
      await run('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[1].click()');await until('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[1].getAttribute("aria-current")==="true"','Selection did not move');
      const id=await run('window.portfolio.getRuntime().then(s=>s.reviews[1].id)');assert.ok((await run('document.querySelector(`[aria-label="Decision detail"]`).textContent')).includes(id.slice(0,8)),'detail shows the selected review');
      const pair=await run('[document.querySelectorAll(`[aria-label="Decision list"] .run-item[aria-current="true"]`).length,document.querySelector(`[aria-label="Decision list"] .run-item[aria-current="true"]`)?.dataset.id,document.querySelector(`[aria-label="Decision detail"]`).dataset.id,Array.from(document.querySelectorAll(`[aria-label="Decision list"] .run-item`)).map(b=>b.dataset.id.slice(0,6)).join(",")]');console.log('JOURNAL-SELECTION',JSON.stringify(pair));assert.equal(pair[0],1,'one decision highlighted');assert.equal(pair[1],pair[2],'highlight matches the detail');await wait(400);await capture('journal-decisions');const after=await run('[document.querySelector(`[aria-label="Decision list"] .run-item[aria-current="true"]`)?.dataset.id,document.querySelector(`[aria-label="Decision detail"]`).dataset.id,document.querySelector(`[aria-label="Decision list"] .run-item`).dataset.id]');console.log('JOURNAL-AFTER',JSON.stringify(after));assert.equal(after[0],after[1],'highlight still matches after capture');
      // The newest decision is a real review with a conversation (the seeded ones have none): it opens in the console.
      await run('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[0].click()');await until('document.querySelectorAll(`[aria-label="Decision list"] .run-item`)[0].getAttribute("aria-current")==="true"','Selection did not move back');const newest=await run('window.portfolio.getRuntime().then(s=>s.reviews[0].id)');
      await run('document.querySelector(`[aria-label="More about this decision"]`).open=true');await wait(120);await click('Open conversation');await until('document.querySelector("h1").textContent==="AI console"','Console did not open');await until(`document.querySelector('.thread-head')?.textContent.includes(${JSON.stringify(newest.slice(0,8))})`,'The matching conversation is not open');
    });
    await check('Journal and console content are separate; News exposes source coverage',async()=>{
      await navigate('Journal');assert.equal(await run('document.querySelectorAll(".timeline").length'),0);await click('Decisions');assert.ok(await run('document.querySelector(".journal-entry")!==null'));await capture('organized-decisions');await click('Lessons');assert.equal(await run('document.querySelectorAll(".journal-entry time").length'),0);
      await navigate('AI console');assert.equal(await run('document.querySelectorAll(`[aria-label="Portfolio journal"]`).length'),0);assert.equal(await run('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Run demo")'),false);
      await navigate('News');assert.ok(await run('document.querySelector("main").textContent.includes("Not connected")'));await capture('news-sources');
    });
    await check('Post-trade reflection is visible and suggestion needs explicit approval',async()=>{
      await run("window.portfolio.configureRuntime({reflectionEnabled:true,reflectionUSDPerDay:1,reflectionCallsPerDay:5,shareKisWithOpenAI:true})");
      await until('(async()=> (await window.portfolio.getRuntime()).reflections.jobs.some(j=>j.status==="completed"))()','Reflection did not complete');
      await navigate('Journal');await click('Lessons');await until('document.querySelector("main").textContent.includes("AI reflection · unvalidated")','Reflection missing');
      await click('Use suggestion in draft');assert.equal(await run('document.querySelector(`[aria-label="Reviewed lesson"]`).value'),'Check full costs before similar exits.');
      assert.equal((await run('window.portfolio.getRuntime()')).lessons.find(l=>l.id==='outcome:broker:outcome-ui').approved,0);
      await run('document.querySelector(`[aria-label="Learning candidate"]`).scrollIntoView({block:"start"})');await capture('post-trade-reflection');
      await run("window.portfolio.configureRuntime({reflectionEnabled:false})");
    });
    await check('Learning queue approval, retirement and economic-evidence invalidation',async()=>{
      await navigate('Journal');await click('Lessons');await until('document.querySelector(`[aria-label="Learning candidate"]`)?.textContent.includes("NASD:TEST")','Learning candidate missing');await capture('learning-queue');await click('Approve for future reviews');await until('(async()=> (await window.portfolio.getRuntime()).lessons.some(l=>l.id==="outcome:broker:outcome-ui"&&l.approved===1))()','Lesson not approved');
      const approved=(await run('window.portfolio.getRuntime()')).lessons.find(l=>l.id==='outcome:broker:outcome-ui');assert.equal(approved.lifecycle.status,'approved');assert.ok(approved.lifecycle.expiresAt>Date.now());
      const {DatabaseSync}=require('node:sqlite');const fixtureDb=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));const order=JSON.parse(fixtureDb.prepare('SELECT payload FROM live_intents WHERE id=?').get('outcome-ui').payload);order.resultCosts.gainAfterFees=-2;fixtureDb.prepare('UPDATE live_intents SET payload=? WHERE id=?').run(JSON.stringify(order),'outcome-ui');fixtureDb.close();
      await until('(async()=> (await window.portfolio.getRuntime()).lessons.find(l=>l.id==="outcome:broker:outcome-ui").lifecycle.status==="needs-review")()','Changed evidence retained approval');const stale=await run(`window.portfolio.reviewLesson('outcome:broker:outcome-ui',{action:'approve',expectedSignature:${JSON.stringify(approved.lifecycle.signature)}})`);assert.equal(stale.error,'LESSON_CHANGED');await wait(2200);await click('Retire lesson');await until('(async()=> (await window.portfolio.getRuntime()).lessons.find(l=>l.id==="outcome:broker:outcome-ui").lifecycle.status==="retired")()','Retirement failed');const versions=await run("window.portfolio.getOutcomeHistory('broker:outcome-ui')");assert.ok(versions.length>=2);assert.equal(versions[0].accountKey,undefined);
    });
    await check('Model and reasoning selection saves without making paid calls',async()=>{
      await engine('Agents');assert.deepEqual(await run('Array.from(document.querySelectorAll(`[aria-label="Trading model"] optgroup`)).map(g=>[g.label,Array.from(g.children).map(o=>[o.value,o.disabled])])'),[['OpenAI',[['gpt-6-luna',false],['gpt-6-sol',false],['gpt-6-astra',false]]],['Anthropic',[['claude-opus-5-5',true]]]]);await navigate('Connections');assert.ok(await run('Boolean(document.querySelector(`[aria-label="Share KIS data with OpenAI"]`))&&Boolean(document.querySelector(`[aria-label="Share KIS data with Anthropic"]`))'),'one consent switch per provider (B1)');await engine('Agents');const before=await run('window.portfolio.getRuntime()');await run('(()=>{const select=document.querySelector(`[aria-label="Trading model"]`);select.value="gpt-6-astra";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await until('document.querySelector(`[aria-label="Reasoning effort"]`).value==="low"','Astra reasoning was not normalized');await click('Save changes');await until('(async()=> (await window.portfolio.getRuntime()).config.openaiModel==="gpt-6-astra")()','Model did not save');assert.equal((await run('window.portfolio.getRuntime()')).usage.calls,before.usage.calls);await navigate('Home');await engine('Agents');assert.equal(await run('document.querySelector(`[aria-label="Trading model"]`).value'),'gpt-6-astra');await capture('model-settings');await run("window.portfolio.configureRuntime({openaiModel:'gpt-6-luna',reasoningEffort:'none'})");
    });
    await check('Review failures display actionable diagnostics and status has no Settings button',async()=>{
      decisionFailure=true;await run("window.portfolio.configureRuntime({scope:'paper',provider:'openai',enabled:false,maxCallsPerDay:200,maxUSDPerDay:100})");await navigate('Engine settings');await wait(2200);await click('Run portfolio review');await until('document.querySelector("main").textContent.includes("unavailable to this API key or project")','Safe diagnosis missing');
      const state=await run('window.portfolio.getRuntime()');assert.equal(state.lastError,'AI_MODEL_UNAVAILABLE');assert.match(state.lastErrorDetail,/AI research and decision/);assert.equal(await run('Array.from(document.querySelectorAll(".runtime-pulse button")).some(b=>b.textContent==="Settings")'),false);await capture('review-error-details');
      // 1.5.48 UI: on Home, one current error with its time and what happens next; the full diagnostic is collapsed.
      await navigate('Home');await until('Boolean(document.querySelector(`[aria-label="Last review error"]`))','the error line on Home');
      assert.match(await run('document.querySelector(`[aria-label="Last review error"] p`).textContent'),/^Last review failed at \d\d:\d\d.*(tries again|nothing retries automatically|paused)/);
      assert.equal(await run('document.querySelector(`[aria-label="Last review error"] details`).open'),false,'details collapsed by default');
      await run('document.querySelector(`[aria-label="Last review error"]`).scrollIntoView({block:"center"})');await capture('stage1548-error-state');decisionFailure=false;
    });
    await check('Holdings open the selected company; allocation segments show keyboard-accessible detail; replay runs offline',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.reportedTotal=180;await run('window.portfolio.refreshPortfolio()');await navigate('Holdings');await until('Boolean(document.querySelector(`[aria-label="View Test holding charts"]`))','Company link missing');await run('document.querySelector(`[aria-label="View Test holding charts"]`).click()');await until('document.querySelector("h1").textContent==="Charts"&&document.querySelector(`[aria-label="Company stock code"]`)?.value==="NASD:TEST"','Chart symbol not selected');await until('Boolean(document.querySelector(".company-tiles"))','Company data missing');await run('Array.from(document.querySelectorAll("details")).find(d=>d.querySelector("summary")?.textContent.includes("Paper replay")).open=true');await click('Run offline replay');await until('document.querySelector("main").textContent.includes("Later holdout")','Replay missing');
      await navigate('Home');await until('Boolean(document.querySelector(".interactive-ring circle[tabindex]"))','Allocation missing');await run('(()=>{const segment=Array.from(document.querySelectorAll(".interactive-ring circle[tabindex]")).find(e=>e.getAttribute("aria-label").includes("Test holding"));segment.focus();segment.dispatchEvent(new FocusEvent("focusin",{bubbles:true}));})()');await until('document.querySelector(`[role="tooltip"]`)?.textContent.includes("NASD:TEST")','Tooltip details missing');await run('document.querySelector(".allocation-explorer").scrollIntoView({block:"center"})');await wait(250);await capture('allocation-detail-tooltip');
    });
    // Holdings Movement cards (2026-11-11): one card per holding with its price line (fixture daily closes) and P/L line
    // (recorded days). 005930 has records with one missing weekday (a gap); 000660 has none ("P/L history unavailable").
    await check('Holdings Movement: price and P/L cards, a gap in the P/L line, a holding without records, no overflow at 1360, 960 and 760',async()=>{
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      const acct=domestic.accountKey,dayN=n=>new Date(Date.now()+9*3600000-n*86400000).toISOString().slice(0,10);
      const touched=[];const original=new Map();const usBefore={holdings:overseas.holdings,reportedTotal:overseas.reportedTotal,cash:overseas.cash};
      try{
        // Korea only: the U.S. fixture holding an earlier check leaves would be a third card.
        overseas.holdings=[];overseas.reportedTotal=overseas.cash??0;
        domestic.holdings=[{symbol:'005930',name:'Samsung Electronics',quantity:10,price:216000,cost:200000},{symbol:'000660',name:'SK Hynix',quantity:2,price:180000,cost:190000}];
        await run('window.portfolio.refreshPortfolio()');
        for(let n=12;n>=0;n--){const day=dayN(n);if(n===5)continue;// one weekday-or-not missing day: a gap in the P/L line
          const row=db.prepare('SELECT payload FROM nav_history WHERE account=? AND day=?').get(acct,day);if(row)original.set(day,row.payload);
          const p=row?JSON.parse(row.payload):{day,at:Date.parse(day+'T06:00:00Z'),KRW:{equity:12160000,cash:10000000,open:12160000,high:12160000,low:12160000,positions:[]},USD:null,fx:null};
          const value=10*(216000-n*1200+(n%3)*900);p.KRW={...(p.KRW??{equity:12160000,cash:10000000,open:12160000,high:12160000,low:12160000}),positions:[...((p.KRW?.positions??[]).filter(x=>x.symbol!=='005930')),{symbol:'005930',name:'Samsung Electronics',quantity:10,value,cost:2000000}]};
          db.prepare('INSERT INTO nav_history VALUES(?,?,?) ON CONFLICT(account,day) DO UPDATE SET payload=excluded.payload').run(acct,day,JSON.stringify(p));touched.push(day);}
        // Not through Performance: opening it records today's positions, which would give 000660 a record. The app also
        // records every minute, so 000660 is removed from today's row just before Holdings opens and reads the records.
        await navigate('Charts');const today=dayN(0);const t=db.prepare('SELECT payload FROM nav_history WHERE account=? AND day=?').get(acct,today);if(t){const p=JSON.parse(t.payload);if(p.KRW?.positions){p.KRW.positions=p.KRW.positions.filter(x=>x.symbol!=='000660');db.prepare('UPDATE nav_history SET payload=? WHERE account=? AND day=?').run(JSON.stringify(p),acct,today);}}
        await navigate('Holdings');
        await until('document.querySelectorAll(`[aria-label="Movement"] .movement-card`).length===2&&!document.querySelector(`[aria-label="Movement"]`).textContent.includes("Loading prices")','Movement cards missing');
        const cards=await run('Array.from(document.querySelectorAll(`[aria-label="Movement"] .movement-card`)).map(c=>({symbol:c.dataset.symbol,text:c.textContent,priceLines:c.querySelectorAll(`[aria-label="Price"] polyline`).length,plLines:c.querySelectorAll(`[aria-label="P/L"] polyline`).length}))');
        console.log('MOVEMENT '+JSON.stringify(cards.map(c=>({...c,text:c.text.slice(0,220)}))));
        assert.deepEqual(cards.map(c=>c.symbol),['005930','000660'],'largest first');
        const sam=cards[0],sk=cards[1];
        assert.match(sam.text,/10 shares · \d+% of equity/);assert.match(sam.text,/Price₩216,000/);assert.match(sam.text,/ in 1M/);assert.ok(sam.priceLines>=1,'price line drawn');
        assert.match(sam.text,/P\/L\+₩160,000\+8\.0% since first recorded /,'P/L from the records, labelled "since first recorded"');assert.equal(sam.plLines,2,'the missing day splits the P/L line');
        assert.equal(await run('document.querySelectorAll(`[data-symbol="005930"] .movement-marker`).length'),0,'no purchase marker for a first recorded day');
        assert.match(sk.text,/P\/L history unavailable: this holding is not in the daily records yet\./);assert.ok(sk.priceLines>=1,'its price line still shows');
        // Step 2 review: the price line is neutral (not the gain colour); first and last days under both lines.
        const look=await run('(()=>{const c=document.querySelector(`[data-symbol="005930"]`);const price=getComputedStyle(c.querySelector(`[aria-label="Price"] .movement-line`)).color,pl=getComputedStyle(c.querySelector(`[aria-label="P/L"] .movement-line`)).color,gain=getComputedStyle(c.querySelector(`[aria-label="P/L"] b.positive`)).color;return {price,pl,gain,days:Array.from(c.querySelectorAll(".movement-days")).map(d=>d.children.length)};})()');
        assert.notEqual(look.price,look.gain,'the price line is not drawn in the gain colour');assert.equal(look.pl,look.gain,'the P/L line is coloured by its sign');assert.deepEqual(look.days,[2,2],'first and last day under each line');
        // Step 4: More, opened: sources, how the lines end, the first recorded day, and both daily tables with the gap.
        const more=await run('(()=>{const d=document.querySelector(`[data-symbol="005930"] details.movement-more`);d.open=true;return {items:Array.from(d.querySelectorAll("li")).map(l=>l.textContent),prices:d.querySelectorAll(`[aria-label="Daily prices"] tbody tr`).length,pl:Array.from(d.querySelectorAll(`[aria-label="Daily P/L"] tbody tr`)).map(r=>r.textContent),firstPrice:d.querySelector(`[aria-label="Daily prices"] tbody tr`)?.textContent};})()');
        console.log('MOVEMENT-MORE '+JSON.stringify({...more,pl:more.pl.slice(0,8)}));
        assert.match(more.items[0],/^Prices: KIS daily closes, read .+ KST\. The price line ends on the live price from the holdings table\.$/);
        assert.match(more.items[1],/^P\/L: the app's daily records, value minus average cost at each day's last reading\. The line ends on today's last recorded reading/);
        assert.ok(more.items.some(i=>/^The purchase is not in the app's orders: P\/L starts at the first recorded day, /.test(i)),'first recorded day');
        assert.ok(more.prices>5,'daily prices listed');assert.match(more.firstPrice,/₩216,000 \(live\)$/,'newest first, the live point marked');
        assert.ok(more.pl.some(r=>/Not recorded/.test(r)),'the missing day is listed as not recorded');
        await run('document.querySelector(`[data-symbol="005930"]`).scrollIntoView({block:"center"})');await wait(200);await capture('movement-more-'+await run('document.documentElement.dataset.theme'));
        await run('document.querySelector(`[data-symbol="005930"] details.movement-more`).open=false');
        // Period control: Since purchase relabels the price change with the first recorded day.
        await run('Array.from(document.querySelectorAll(`[aria-label="Movement period"] button`)).find(b=>b.textContent==="Since purchase").click()');
        await until('document.querySelector(`[data-symbol="005930"] [aria-label="Price"]`).textContent.includes("since first recorded")','Since purchase label');
        const theme0=await run('document.documentElement.dataset.theme');const [w0,h0]=win.getSize();
        await run('Array.from(document.querySelectorAll(`[aria-label="Movement period"] button`)).find(b=>b.textContent==="1M").click()');
        for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'theme');}
          for(const [width,height] of [[1360,880],[960,720],[760,700]]){win.setSize(width,height);await wait(250);await run('document.querySelector(`[aria-label="Movement"]`).scrollIntoView({block:"start"})');await wait(200);
            const over=await run('(()=>{const s=document.querySelector(`[aria-label="Movement"]`);return Array.from(s.querySelectorAll(".movement-card")).flatMap(c=>[c,...c.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().right>c.getBoundingClientRect().right+1||e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=="visible").map(e=>c.dataset.symbol+" "+e.tagName+"."+(e.getAttribute("class")??"")));})()');
            assert.deepEqual(over,[],`Movement overflows at ${width}px (${theme})`);await capture(`movement-${width}-${theme}`);}}
        win.setSize(w0,h0);if(await run('document.documentElement.dataset.theme')!==theme0)await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");
      }finally{for(const day of touched){if(original.has(day))db.prepare('UPDATE nav_history SET payload=? WHERE account=? AND day=?').run(original.get(day),acct,day);else db.prepare('DELETE FROM nav_history WHERE account=? AND day=?').run(acct,day);}db.close();
        domestic.holdings=[];Object.assign(overseas,usBefore);await run('window.portfolio.refreshPortfolio()');}
    });
    // Release gate 1.5.52, G3: unreadable records fail visibly. A damaged daily record is left out (a gap) and counted in
    // More, and the Result tile says the performance records could not be read while the other tiles still render; with
    // the records table unreadable, Movement shows "Daily records could not be read." with Retry, never "Loading".
    await check('G3: a damaged daily record and an unreadable records table are shown as such on Holdings and Home',async()=>{
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      const acct=domestic.accountKey,dayN=n=>new Date(Date.now()+9*3600000-n*86400000).toISOString().slice(0,10);
      const usBefore={holdings:overseas.holdings,reportedTotal:overseas.reportedTotal,cash:overseas.cash};let damaged=null,saved=null,renamed=false,added=false;
      try{
        overseas.holdings=[];overseas.reportedTotal=overseas.cash??0;domestic.holdings=[{symbol:'005930',name:'Samsung Electronics',quantity:10,price:216000,cost:200000}];await run('window.portfolio.refreshPortfolio()');
        damaged=dayN(3);const old=db.prepare('SELECT payload FROM nav_history WHERE account=? AND day=?').get(acct,damaged);saved=old?.payload??null;
        if(old)db.prepare('UPDATE nav_history SET payload=? WHERE account=? AND day=?').run('{damaged',acct,damaged);else{db.prepare('INSERT INTO nav_history VALUES(?,?,?)').run(acct,damaged,'{damaged');added=true;}
        // The fill as the live records keep it (G5, 2026-11-11): acceptedAt an ISO text, no filledObservedAt. It must not blank
        // the window; the card reads the purchase from it.
        const fillDay=dayN(8),fillAt=Date.parse(fillDay+'T01:30:00Z');
        db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('UI-ISO-FILL',acct,JSON.stringify({id:'UI-ISO-FILL',accountKey:acct,environment:'mock',source:'kis',market:'KR',currency:'KRW',symbol:'005930',side:'Buy',quantity:10,filled:10,status:'Filled',limitPrice:200000,fillPrice:200000,day:fillDay,createdAt:fillAt-5000,acceptedAt:new Date(fillAt).toISOString()}));
        // Holdings: the section loads, the damaged day is counted in More, the ISO-time fill is the purchase.
        await navigate('Charts');await navigate('Holdings');
        await until('Boolean(document.querySelector(`[aria-label="Movement"] .movement-card`))&&!document.querySelector(`[aria-label="Movement"]`).textContent.includes("Loading the daily records")','Movement did not load with a damaged record');
        assert.equal(await run('Boolean(document.querySelector("h1"))&&!document.querySelector(`[data-section-error]`)'),true,'the page stands and no section failed');
        const more=await run('(()=>{const d=document.querySelector(`[data-symbol="005930"] details.movement-more`);d.open=true;return Array.from(d.querySelectorAll("li")).map(l=>l.textContent);})()');
        console.log('G3-MORE '+JSON.stringify(more));assert.ok(more.includes('1 recorded day could not be read and is left out.'),'the damaged day is counted');
        assert.ok(more.some(l=>/^Bought .+ \(the app's order\)\.$/.test(l)),'the purchase is read from the ISO-time fill');
        assert.equal(await run('document.querySelectorAll(`[data-symbol="005930"] .movement-marker`).length'),1,'its day is marked on the price line');
        // Home with the damaged day skipped (perf-fix R1): the Result tile has its figures; nothing says "could not be read".
        await navigate('Home');
        await until('Boolean(document.querySelector(`[aria-label="Result"] .result-total`))&&!document.querySelector(`[aria-label="Result"]`).textContent.includes("Starts after")','Result tile missing with a damaged record');
        const skipped=await run('document.querySelector(`[aria-label="Result"]`).textContent');console.log('G3-HOME-SKIPPED '+JSON.stringify(skipped.slice(0,160)));
        assert.ok(!skipped.includes('could not be read'),'a skipped day is not a failed read');
        // The Today line stays brief (review of the blank-window fix): figure and a "Provisional" tag; range and correction
        // are in More; the account value box still shows them.
        const today=await run('(()=>{const r=document.querySelector(`[aria-label="Result"]`);const d=r.querySelector(`[aria-label="Today"] dd`);const m=r.querySelector("details.result-more");return {dd:d.textContent,tag:d.querySelector(".result-tag")?.textContent??null,more:Array.from(m.querySelectorAll("li")).map(l=>l.textContent),box:document.querySelector(`[aria-label="Account trend"] .home-trend-stats`)?.textContent??""};})()');
        console.log('G3-TODAY '+JSON.stringify({...today,box:today.box.slice(0,160)}));
        assert.equal(today.tag,'Provisional');assert.ok(!/ to |Correction/.test(today.dd),'no range or correction on the line itself');
        assert.ok(today.more.some(l=>/^Today is provisional: between .+ and .+; the valuation range changed this day/.test(l)),'the range in More');
        assert.ok(today.more.some(l=>/^Today includes a settlement correction of .+: bookkeeping, not investment P\/L\.$/.test(l)),'the correction in More');
        assert.match(today.box,/Provisional: .+ to /,'the account value box keeps the range');assert.match(today.box,/Correction /,'and the correction');
        await run('document.querySelector(`[aria-label="Result"]`).scrollIntoView({block:"center"})');await wait(150);await capture('result-today-provisional');
        // A damaged deposit or withdrawal record (review of the 1.5.52 fixes, change 1): the return is tagged as an estimate
        // on the account value box, the Result tile and the Performance page.
        db.prepare('INSERT INTO cash_flows VALUES(?,?,?)').run('ui-damaged-flow',acct,'oops');
        await navigate('Charts');await navigate('Home');
        await until('document.querySelector(`[aria-label="Account trend"]`)?.textContent.includes("Return estimate: a deposit or withdrawal record could not be read.")&&document.querySelector(`[aria-label="Result"] .result-tag`)?.textContent==="Return estimate"','Home estimate tags missing');
        await run('document.querySelector(".home-metrics").scrollIntoView({block:"start"})');await wait(150);await capture('g3-home-flow-unreadable');
        await navigate('Performance');await until('Boolean(document.querySelector(`[aria-label="Unreadable money movements"]`))','Performance estimate notice missing');
        assert.equal(await run('document.querySelector(`[aria-label="Unreadable money movements"]`).textContent'),'Return estimate: a deposit or withdrawal record could not be read. It is left out of the returns, so a deposit or withdrawal may be counted as gain or loss.');
        await capture('g3-performance-flow-unreadable');
        db.prepare('DELETE FROM cash_flows WHERE id=?').run('ui-damaged-flow');
        // The records table unreadable: Movement says so with Retry; Retry recovers once it is readable again.
        db.exec('ALTER TABLE nav_history RENAME TO nav_history_gone');renamed=true;
        await navigate('Charts');await navigate('Holdings');
        await until('Boolean(document.querySelector(`[aria-label="Daily records unavailable"]`))','Movement error state missing');
        const err=await run('(()=>{const s=document.querySelector(`[aria-label="Movement"]`);return {notice:s.querySelector(`[aria-label="Daily records unavailable"]`).textContent,pl:s.querySelector(`[data-symbol="005930"] [aria-label="P/L"]`)?.textContent??"",loading:s.textContent.includes("Loading the daily records")};})()');
        console.log('G3-ERROR '+JSON.stringify(err));assert.equal(err.notice,'Daily records could not be read. Retry');assert.match(err.pl,/P\/L history unavailable: the daily records could not be read\./);assert.equal(err.loading,false);
        await run('document.querySelector(`[aria-label="Movement"]`).scrollIntoView({block:"start"})');await wait(150);await capture('g3-movement-records-unreadable');
        // Home and Performance with the records unreadable (perf-fix R4): the same sentence on the Result tile, the account
        // value box and the Performance page; Account value and Cash still render.
        await navigate('Home');
        await until('document.querySelector(`[aria-label="Result"]`)?.textContent.includes("The performance records could not be read.")&&document.querySelector(`[aria-label="Account trend"]`)?.textContent.includes("The performance records could not be read.")','Home reasons missing');
        const home=await run('(()=>({value:document.querySelector(`[aria-label="Combined equity"] strong`)?.textContent??"",cash:document.querySelector(`[aria-label="Cash"] strong`)?.textContent??"",result:document.querySelector(`[aria-label="Result"]`).textContent,unrealized:document.querySelector(`[aria-label="Result"] [aria-label="Unrealized"] dd`)?.dataset.amount}))()');
        console.log('G3-HOME '+JSON.stringify(home));assert.match(home.value,/₩/,'Account value renders');assert.match(home.cash,/₩/,'Cash renders');assert.ok(!home.result.includes('Starts after values are recorded on two days'),'not the two-day message');assert.equal(home.unrealized,'160000','Unrealized does not depend on the records');
        await run('document.querySelector(".home-metrics").scrollIntoView({block:"start"})');await wait(150);await capture('g3-home-records-unreadable');
        await navigate('Performance');await until('document.querySelector(`[aria-label="Account performance"]`)?.textContent.includes("The performance records could not be read.")','Performance page reason missing');await capture('g3-performance-records-unreadable');
        await navigate('Holdings');await until('Boolean(document.querySelector(`[aria-label="Daily records unavailable"]`))','Movement error state missing on return');
        db.exec('ALTER TABLE nav_history_gone RENAME TO nav_history');renamed=false;
        await run('document.querySelector(`[aria-label="Daily records unavailable"] button`).click()');
        await until('!document.querySelector(`[aria-label="Daily records unavailable"]`)&&Boolean(document.querySelector(`[aria-label="Movement"] .movement-card`))','Retry did not recover');
      }finally{db.prepare('DELETE FROM live_intents WHERE id=?').run('UI-ISO-FILL');db.prepare('DELETE FROM cash_flows WHERE id=?').run('ui-damaged-flow');if(renamed)db.exec('ALTER TABLE nav_history_gone RENAME TO nav_history');if(damaged){if(added)db.prepare('DELETE FROM nav_history WHERE account=? AND day=?').run(acct,damaged);else if(saved!=null)db.prepare('UPDATE nav_history SET payload=? WHERE account=? AND day=?').run(saved,acct,damaged);}db.close();
        domestic.holdings=[];Object.assign(overseas,usBefore);await run('window.portfolio.refreshPortfolio()');}
    });
    // Restart part 1, step 3: "Start with Windows" in Engine → Trading. The desktop suite runs on the in-memory fake
    // (PORTFOLIO_SMOKE_DATA), so the machine's real login items are never touched.
    await check('Start with Windows: the row and its hint in Engine settings; the switch applies at once and reads back (fake)',async()=>{
      await engine('Trading');await until('Boolean(document.querySelector(`[aria-label="Start with Windows"]`))','Start with Windows row missing');
      const row=await run('(()=>{const sw=document.querySelector(`[aria-label="Start with Windows"]`);const r=sw.closest(".setting-row");return {text:r.textContent,checked:sw.checked,disabled:sw.disabled};})()');
      console.log('SWW '+JSON.stringify(row));assert.match(row.text,/Start with Windows/);
      assert.match(row.text,/Opens the app when you sign in to Windows\. After a restart at night it opens only once you sign in\. It starts paused\./);
      assert.equal(row.checked,false,'off by default');assert.equal(row.disabled,false);
      assert.equal((await run('window.portfolio.getLoginItem()')).test,true,'the fake, not Windows');
      await run('document.querySelector(`[aria-label="Start with Windows"]`).click()');await until('document.querySelector(`[aria-label="Start with Windows"]`).checked===true','switch did not turn on');
      assert.equal((await run('window.portfolio.getLoginItem()')).on,true,'read back on');
      const theme0=await run('document.documentElement.dataset.theme');
      for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'theme');}
        await run('document.querySelector(`[aria-label="Start with Windows"]`).scrollIntoView({block:"center"})');await wait(150);await capture('start-with-windows-'+theme);}
      if(await run('document.documentElement.dataset.theme')!==theme0)await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");
      await run('document.querySelector(`[aria-label="Start with Windows"]`).click()');await until('document.querySelector(`[aria-label="Start with Windows"]`).checked===false','switch did not turn off');
      assert.equal((await run('window.portfolio.getLoginItem()')).on,false,'read back off');
    });
    // Since fdc5d5f (2026-10-29) an interval shorter than the user's needs a moving holding, which this paper fixture has
    // not; the case checks that the AI's own choice is kept, so it asks for a longer one (the guard is in review-interval tests).
    await check('Auto review interval persists the AI choice and shows its reason',async()=>{
      await run("window.portfolio.configureRuntime({scope:'paper',enabled:false,autoReviewInterval:true,provider:'openai'})");const reply=await run("window.portfolio.reviewRuntime()");assert.equal(reply.ok,true,JSON.stringify([reply.error,reply.message])+" getRuntime: "+await run("window.portfolio.getRuntime().then(()=>\"ok\",e=>String(e))"));assert.equal(reply.state.reviewInterval.minutes,15);assert.equal(reply.state.config.enabled,false);await engine('Schedule and triggers');await until('document.querySelector("main").textContent.includes("Fixture volatility calls for closer monitoring")','Auto cadence reason missing');await run("window.portfolio.configureRuntime({autoReviewInterval:false})");
    });
    await check('Unlimited budgets save independently and calculated usage replaces reservation labels',async()=>{
      // B1: the provider limits are on the Connections cards (their own Save); reflection's stay on the Agents tab.
      await navigate('Connections');await wait(2200);for(const label of ['OpenAI calls per day','OpenAI daily budget (USD)'])await run(`document.querySelector('[aria-label="Unlimited ${label}"]').click()`);await click('Save limits');
      await engine('Agents');for(const label of ['Reflection calls per day','Daily reflection budget (USD)'])await run(`document.querySelector('[aria-label="Unlimited ${label}"]').click()`);await click('Save changes');
      await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.unlimitedCalls&&c.unlimitedBudget&&c.reflectionUnlimitedCalls&&c.reflectionUnlimitedBudget;})()','Unlimited settings not saved');await navigate('Home');await navigate('Connections');assert.equal(await run('document.querySelector(`[aria-label="Unlimited OpenAI calls per day"]`).checked'),true);
      await engine('Agents');assert.match(await run('document.querySelector(`[aria-label="OpenAI usage today"]`).textContent'),/calls · \$[0-9.]+ of no limit$/);await capture('unlimited-api-settings');
    });
    await check('Autopilot guardrails save, survive navigation and preview the daily digest',async()=>{
      await engine('Trading');await wait(2200);await until('Boolean(document.querySelector(`[aria-label="Autopilot guardrails"]`))','Guardrails section missing');
      await run('(()=>{const set=(label,proto,value,type)=>{const el=document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(proto.prototype,"value").set.call(el,value);el.dispatchEvent(new Event(type,{bubbles:true}));};set("Loss-limit response",HTMLSelectElement,"block-buys","change");})()');
      assert.equal(await run('document.querySelector(`[aria-label="Automatic orders per day"]`)'),null,'the number is hidden while there is no limit');await run('document.querySelector(`[aria-label="Unlimited Automatic orders per day"]`).click()');await wait(100);
      await run('(()=>{const el=document.querySelector(`[aria-label="Automatic orders per day"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"3");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await click('Save changes');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.lossAction==="block-buys"&&c.maxAutoOrdersPerDay===3;})()','Guardrails not saved');await until('document.querySelector(".toaster")?.textContent.includes("Settings saved")','No saved confirmation');
      await navigate('Home');await engine('Trading');assert.equal(await run('document.querySelector(`[aria-label="Loss-limit response"]`).value'),'block-buys');
      await engine('Alerts');await click("Preview today's digest");await until('document.querySelector(`[aria-label="Digest preview"]`)?.textContent.includes("Daily digest")','Digest preview missing');
      await engine('Trading');await run('document.querySelector(`[aria-label="Autopilot guardrails"]`).scrollIntoView({block:"start"})');await wait(200);await capture('autopilot-guardrails');
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
      await engine('Trading');await until('Boolean(document.querySelector(`[aria-label="Engine sections"]`))','Engine tabs missing');
      for(const [tab,label] of [['Trading','Scheduled reviews'],['Trading','Place orders automatically'],['Schedule and triggers','Auto review interval'],['Alerts','Desktop alerts']]){await engine(tab);assert.equal(await run(`document.querySelector('[aria-label="${label}"]')?.getAttribute('role')`),'switch',label);}
      await run('document.querySelector(`[aria-label="Desktop alerts"]`).click()');await until('Boolean(document.querySelector(".settings-draft-bar"))','Save bar missing');
      assert.equal(await run('getComputedStyle(document.querySelector(".settings-draft-bar")).position'),'fixed');await capture('engine-settings-rows');
      await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard failed');
    });
    await check('Engine settings: four tabs; every row is on one tab, reachable and saves; Model and Effort per agent; dark, light and the minimum width',async()=>{
      const tabs=['Trading','Agents','Schedule and triggers','Alerts'];const saved=(await run('window.portfolio.getRuntime()')).config;
      await navigate('Engine settings');assert.deepEqual(await run('Array.from(document.querySelectorAll(`[aria-label="Engine sections"] [role=tab]`)).map(b=>b.textContent)'),tabs);
      // Show every row that depends on another, so each control can be found.
      await run("window.portfolio.configureRuntime({conditionalOrders:true,mobileAlerts:true,phoneSnapshots:true,digestEnabled:true,scoutEnabled:true,watchlistAlerts:'observe',skipUnchanged:true})");await wait(2200);
      const seen={};for(const tab of tabs){await engine(tab);seen[tab]=await run('Array.from(document.querySelectorAll(`[role=tabpanel] input, [role=tabpanel] select, [role=tabpanel] textarea`)).map(e=>e.getAttribute("aria-label")).filter(Boolean)');}
      console.log('A3-TABS '+JSON.stringify(seen));const all=Object.values(seen).flat();assert.equal(new Set(all).size,all.length,'no control on two tabs');
      const want={Trading:['Agent guidelines','Portfolio scope','Decision provider','Scheduled reviews','Place orders automatically','Risk per trade','Stop distance in ATR','Start with Windows','Korea · Nextrade (NXT)','U.S. · KIS daytime session','U.S. · Pre-market','U.S. · After-market','Largest extended-session order','Loss-limit response','Follow the best price','Let the AI set conditional orders','Submit conditional orders automatically','Most armed conditional orders','Largest conditional order','Conditional order price drift','Conditional order lifetime'],
        Agents:['Trading model','Reasoning effort','Scout model','Scout effort','Scheduled market narrative','Market narrative model','Market narrative effort','Context compacting model','Context compacting effort','Post-trade reflection','Reflection model','Reflection effort'],
        'Schedule and triggers':['Auto review interval','Review interval','Reviews while markets are closed','Price move trigger','Watchlist alerts','Watchlist move trigger','Scheduled scout runs','Reviews can request a scout run','Before Korea opens','After Korea opens','Korea midday','Before the U.S. opens','Minutes after the Korean open','Skip unchanged reviews','Review gate','Research suppression','Routine review scope','Maximum skip minutes','Slow down near the budget'],
        Alerts:['Desktop alerts','Phone alerts','Snapshot on each trade','Show amounts in snapshots','Send a daily digest','Daily digest time']};
      for(const [tab,labels] of Object.entries(want))for(const l of labels)assert.ok(seen[tab].includes(l),`${l} on ${tab}`);
      // The agents start on today's models: Same as the trading agent, compacting on its own.
      await engine('Agents');assert.deepEqual(await run('["Scout","Market narrative","Reflection"].map(n=>[document.querySelector(`[aria-label="${n} model"]`).value,document.querySelector(`[aria-label="${n} effort"]`).value])'),[['same','same'],['same','same'],['same','same']]);
      assert.equal(await run('Array.from(document.querySelectorAll(`[aria-label="Scout effort"] option`)).some(o=>o.value==="none")'),false,'no None for the scout');
      const pick=(label,value)=>run(`(()=>{const s=document.querySelector('[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      // Picking GPT-6 Astra for an agent on effort None raises its effort to Low in the same edit (both apply).
      await pick('Reflection effort','none');await pick('Reflection model','gpt-6-astra');await until('document.querySelector(`[aria-label="Reflection effort"]`).value==="low"','Astra did not raise the effort');
      assert.equal(await run('document.querySelector(`[aria-label="Reflection model"]`).value'),'gpt-6-astra');await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard failed');
      // Review F1: a change of the trading model or effort corrects an agent that follows it, and the row shows the draft.
      const shown=label=>run(`(()=>{const s=document.querySelector('[aria-label="${label}"]');return [s.value,s.selectedOptions[0]?.textContent];})()`);
      await pick('Context compacting model','same');await pick('Context compacting effort','none');await pick('Trading model','gpt-6-astra');
      await until('document.querySelector(`[aria-label="Context compacting effort"]`).value==="low"','Compacting effort not corrected when the trading model became Astra');
      assert.deepEqual(await shown('Context compacting effort'),['low','Low']);await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard failed');
      await pick('Reasoning effort','low');await pick('Reflection model','gpt-6-astra');await pick('Reflection effort','same');assert.deepEqual(await shown('Reflection effort'),['same','Same as the trading agent']);
      await pick('Reasoning effort','none');await until('document.querySelector(`[aria-label="Reflection effort"]`).value==="low"','Reflection effort not corrected when the trading effort became None');
      assert.deepEqual(await shown('Reflection effort'),['low','Low']);await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard failed');
      // One edit on each tab, one save: the draft survives switching tabs.
      await engine('Trading');await run('document.querySelector(`[aria-label="Follow the best price"]`).click()');
      await engine('Agents');await pick('Scout model','gpt-6-luna');await pick('Reflection effort','low');
      await engine('Schedule and triggers');await run('document.querySelector(`[aria-label="Reviews can request a scout run"]`).click()');
      await engine('Alerts');await run('document.querySelector(`[aria-label="Desktop alerts"]`).click()');
      await engine('Trading');assert.equal(await run('document.querySelector(`[aria-label="Follow the best price"]`).checked'),!saved.orderTracking,'the draft is kept across tabs');
      await click('Save changes');await until('!document.querySelector(".settings-draft-bar")','Save did not finish');
      const after=await run('window.portfolio.getRuntime()');
      assert.deepEqual([after.config.orderTracking,after.config.scoutModel,after.config.reflectionEffort,after.config.scoutAiRequests,after.config.desktopAlerts],[!saved.orderTracking,'gpt-6-luna','low',!saved.scoutAiRequests,!saved.desktopAlerts]);
      assert.equal(after.agentModels.scout.openaiModel,'gpt-6-luna');assert.equal(after.agentModels.reflection.reasoningEffort,'low');
      await engine('Agents');assert.match(await run('document.querySelector(`[aria-label="Scout model"]`).closest(".setting-row").textContent'),/Now GPT-6 Luna · /);
      // Layout: each tab in dark and light, at the default size and the minimum width; nothing wider than the window.
      const theme0=await run('document.documentElement.dataset.theme');const setTheme=async t=>{if(await run('document.documentElement.dataset.theme')!==t){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(t)}`,'theme');}};
      const [w0,h0]=win.getSize();
      try{for(const [width,height] of [[1360,880],[760,600]]){win.setSize(width,height);await wait(250);for(const theme of ['dark','light']){await setTheme(theme);for(const tab of tabs){await engine(tab);await run('document.querySelector(`[aria-label="Engine sections"]`).scrollIntoView({block:"start"})');await wait(150);
        const fit=await run('(()=>{const t=document.querySelector(`[aria-label="Engine sections"]`).getBoundingClientRect();const p=document.querySelector(`.engine-settings`);return {tabs:t.right<=window.innerWidth+1,panel:p.scrollWidth<=p.clientWidth+1,page:document.documentElement.scrollWidth<=window.innerWidth+1};})()');
        assert.deepEqual(fit,{tabs:true,panel:true,page:true},`${tab} at ${width} in ${theme}`);await capture(`a3-engine-${tab.toLowerCase().replace(/[^a-z]+/g,'-')}-${theme}-${width}`);}}}}
      finally{win.setSize(w0,h0);await setTheme(theme0);}
      await run(`window.portfolio.configureRuntime(${JSON.stringify({orderTracking:saved.orderTracking,scoutModel:saved.scoutModel,reflectionEffort:saved.reflectionEffort,scoutAiRequests:saved.scoutAiRequests,desktopAlerts:saved.desktopAlerts,conditionalOrders:saved.conditionalOrders,mobileAlerts:saved.mobileAlerts,phoneSnapshots:saved.phoneSnapshots,digestEnabled:saved.digestEnabled,scoutEnabled:saved.scoutEnabled,watchlistAlerts:saved.watchlistAlerts,skipUnchanged:saved.skipUnchanged})})`);await wait(2200);
    });
    await check('The AI scout runs from Discover, shows its plan and is scheduled from Engine settings',async()=>{
      await run("window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithOpenAI:true,enabled:false,autoSubmit:false,openaiModel:'gpt-6-sol',reasoningEffort:'low'})");
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
      await engine('Schedule and triggers');await run('document.querySelector(`[aria-label="Scheduled scout runs"]`).click()');await until('Boolean(document.querySelector(`[aria-label="After Korea opens"]`))','Scout timing switches missing');
      // Step A4: four switches by market event; the offset behind More; the next runs by name in the card hint.
      await run('document.querySelector(`[aria-label="Before the U.S. opens"]`).click()');await run('document.querySelector(`[aria-label="Scout settings"] details`).open=true');
      await run('(()=>{const el=document.querySelector(`[aria-label="Minutes after the Korean open"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"45");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      const t0=await run('document.documentElement.dataset.theme');for(const t of ['dark','light',t0]){if(await run('document.documentElement.dataset.theme')!==t){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await wait(150);}await run('document.querySelector(`[aria-label="Scout settings"]`).scrollIntoView({block:"start"})');await wait(150);await capture('a4-scout-timing-'+t);}
      await click('Save changes');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.scoutEnabled===true&&c.scoutBeforeUsOpen===true&&c.scoutAfterOpenMinutes===45;})()','Scout timing not saved');
      assert.match(await run('document.querySelector(`[aria-label="Scout settings"]`).textContent'),/Next: .*KST/);await run("window.portfolio.configureRuntime({scoutBeforeUsOpen:false,scoutAfterOpenMinutes:60})");
      await engine('Trading');assert.ok(!(await run('Boolean(document.querySelector(`[aria-label="Largest conditional order"]`))')),'guardrail rows stay hidden while off');
      assert.equal(await run('document.querySelector(`[aria-label="Risk per trade"]`).value'),'1');assert.equal(await run('document.querySelector(`[aria-label="Stop distance in ATR"]`).value'),'2');
      await run('document.querySelector(`[aria-label="Let the AI set conditional orders"]`).click()');await until('Boolean(document.querySelector(`[aria-label="Largest conditional order"]`))','Conditional order guardrails missing');
      await click('Save changes');await until('(async()=>(await window.portfolio.getRuntime()).config.conditionalOrders===true)()','Conditional orders not saved');await run('document.querySelector(`[aria-label="Conditional order settings"]`).scrollIntoView({block:"start"})');await wait(150);await capture('conditional-order-settings');
      await navigate('Journal');await click('Orders and triggers');await until('document.querySelector(`[aria-label="Agent desk"]`)?.textContent.includes("conditional orders")','Agent desk missing');
      await click('Replay');await until('Boolean(document.querySelector(`[aria-label="Replay"]`))','Replay card missing');await run('Array.from(document.querySelectorAll(`[aria-label="Replay"] button`)).find(b=>b.textContent==="Run replay").click()');await until('document.querySelector(`[aria-label="Replay"]`).textContent.includes("Add instructions, remove a section or pick another model")','Replay without a change should explain itself');
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
      // A detected deposit is confirmed with its Confirm button (2026-11-10: the live app's Confirm did nothing).
      {const {DatabaseSync}=require('node:sqlite');const {PerformanceHistory}=require('../electron/performance.cjs');const fdb=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
        const det=new PerformanceHistory(fdb).addFlow('ui-regression-fixture',{day:new Date(Date.now()-86400000).toISOString().slice(0,10),market:'KR',amount:3000000,detected:true,note:'Detected: fixture'});fdb.close();
        await navigate('Home');await navigate('Performance');await run('document.querySelector(`[aria-label="Deposits and withdrawals"]`).open=true');
        await until('Boolean(document.querySelector(`[aria-label^="Confirm flow"]`))','the detected deposit is listed with Confirm');
        const before=await run('Array.from(document.querySelectorAll(`[aria-label^="Confirm flow"]`)).map(b=>b.disabled)');console.log('CONFIRM-BUTTONS',JSON.stringify(before));
        await run('document.querySelector(`[aria-label^="Confirm flow"]`).click()');
        await until('!document.querySelector(`[aria-label^="Confirm flow"]`)','Confirm did not confirm the detected deposit');
        const row=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite')).prepare('SELECT payload FROM cash_flows WHERE id=?').get(det.id);assert.ok(!JSON.parse(row.payload).detected&&JSON.parse(row.payload).confirmedAt,'stored as confirmed');}
    });
    // Settlement simplification S2: no day is unavailable for a settlement reason, the restatement card is gone, and a day
    // the tracker could not be read still has no return, with its own reason.
    await check('S2: settlement days have returns (an estimate), corrections stay apart, no restatements; an unreadable day is still unavailable',async()=>{
      // A U.S. settlement history built with the real tracker on the fixture database (synchronous, so no app reading
      // interleaves): a $100 buy paid on its settlement date S while still counted, reconciled two days later.
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');
      const acct='ui-regression-fixture',S=new Date(Date.now()-10*86400000).toISOString().slice(0,10),B=Date.parse(new Date(Date.parse(S+'T00:00:00Z')-2*86400000).toISOString().slice(0,10)+'T05:00:00Z');
      let t=B;const clock=()=>t;db.prepare('DELETE FROM inflight_settlement WHERE account=?').run(acct);
      const f=new InFlight(db,clock),perf=new PerformanceHistory(db,clock);perf.settlement=a=>f.snapshot(a);const rec=new Reconciliation(db,{inFlight:f,funding:new FundingLedger(db,{clock}),performance:perf,clock,who:{user:'fixture',session:'fixture'}});
      // Scaled near the mock account's own U.S. value (about $180), which the app records for today in the same series:
      // with $1,400 synthetic days that recording read as an 88% fall (a fixture artefact, release gate review).
      const us={cash:180,price:100};const U=()=>({accountKey:acct+':US',environment:'mock',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
      const A={id:'stage34-A',symbol:'NASD:TA',side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'mock',accountKey:acct+':US',market:'US',day:S,createdAt:B+60000,filledObservedAt:B+60000};
      const see=list=>{f.observe(acct,{us:U(),orders:list,fx:1300});t+=60000;};
      const record=()=>{const v=value({us:U(),inFlight:f.current(acct),fx:{usdKRW:1300,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity.low;perf.record(acct,{totals:{USD:v,KRW:10000000,equityKRW:10000000+v*1300},fx:{usdKRW:1300}});t+=60000;};
      see([]);see([A]);record();t=B+33*3600000;us.price=101;record();t=B+55*3600000;us.cash=80;t=B+73*3600000;us.price=102;record();t=B+97*3600000;
      const q={requestId:'stage34-r1',account:acct,pieceId:f.current(acct).open.find(p=>p.id==='stage34-A').pid,cents:10000,explanation:'settled',route:'USD',kisReference:'KIS-FIXTURE',note:'desktop fixture',settledOn:S};const pv=rec.preview(q);rec.confirm({...q,stateVersion:pv.stateVersion,binding:pv.binding});record();
      const approvals=()=>db.prepare('SELECT COUNT(*) n FROM valuation_settlement_approvals WHERE account=?').get(acct).n;
      // Home: a return, tagged as an estimate (the period has an accounting correction); never the settlement red line.
      await navigate('Home');await until('document.querySelector(`[aria-label="Account trend"] .trend-note`)?.textContent.startsWith("Return estimate")','the Home trend should show the return as an estimate');
      assert.ok(!(await run('document.querySelector(`[aria-label="Account trend"]`).textContent.includes("Investment return unavailable")')),'no settlement red line');
      assert.ok(!(await run('Boolean(document.querySelector(`[aria-label="Account trend"] .trend-note.negative`))')),'the note is not red');
      assert.ok(await run('document.querySelector(`[aria-label="Account trend"]`).textContent.includes("Investment P/L")'),'the investment P/L is shown');
      assert.equal(await run('document.querySelectorAll(`[aria-label="Account trend"] .trend-note`).length'),1);assert.ok(!(await run('document.querySelector(`[aria-label="Account trend"]`).textContent.includes("Not verified")')),'no isolated badge');
      await capture('s2-home-trend-estimate');
      // Performance, U.S. series: the All period is a number with the Estimate tag; corrections listed apart; no gap; no restatements.
      await navigate('Performance');await run(`(()=>{const s=document.querySelector('[aria-label="Performance series"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'USD');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await until('/[+−-]?\\d+\\.\\d{2}%/.test(Array.from(document.querySelectorAll(`[aria-label="Period returns"] tbody tr`)).find(r=>r.cells[0].textContent.startsWith("All"))?.cells[2].textContent??"")','the All period has a return');
      assert.ok(!(await run('Array.from(document.querySelectorAll(`[aria-label="Period returns"] tbody tr`)).some(r=>r.textContent.includes("Unavailable"))')),'no period is unavailable');
      assert.ok(await run('document.querySelector(`[aria-label="Account performance"]`).textContent.includes("Estimate")'));assert.ok(await run('Boolean(document.querySelector(`[aria-label="Return labels"]`))'),'the labels are explained');
      assert.ok(await run('document.querySelector(`[aria-label="Settlement effects"]`)?.textContent.includes("Accounting corrections")'),'corrections are listed apart');
      assert.ok(!(await run('document.querySelector(`[aria-label="Settlement effects"]`).textContent.includes("Days without a return")')),'no day without a return');
      for(const label of ['Daily P/L','Drawdown']){await run(`Array.from(document.querySelectorAll('[aria-label="Chart"] button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await wait(150);}
      assert.ok(!(await run('document.querySelector(`[aria-label="Account performance"]`).textContent.includes("Drawdown is unavailable from")')),'the drawdown chart is whole');
      assert.ok(!(await run('Boolean(document.querySelector(`[aria-label="Historical restatements"]`)||document.querySelector(`[aria-label^="Preview restatement"]`))')),'the restatement card is hidden');
      assert.deepEqual((await run('window.portfolio.getRestatements()')).restatements?.candidates??[],[],'no candidates are discovered');assert.equal(approvals(),0);
      await capture('s2-performance-estimate');
      // A day recorded while the tracker could not be read: still no return, with that reason (U4), on Home and Performance.
      t=B+121*3600000;us.price=103;perf.settlement=()=>{throw new Error('disk I/O error');};record();perf.settlement=a=>f.snapshot(a);
      await navigate('Home');await until('document.querySelector(`[aria-label="Account trend"] .trend-note`)?.textContent.startsWith("Investment return unavailable")','an unreadable day still makes the return unavailable');
      assert.match(await run('document.querySelector(`[aria-label="Account trend"] .trend-note`).textContent'),/^Investment return unavailable: the settlement tracker could not be read when this day was recorded \(disk I\/O error\)/,'its own reason, not a settlement one');
      assert.ok(await run('Boolean(document.querySelector(`[aria-label="Account trend"] .trend-note.negative`))'));await capture('s2-home-trend-unreadable');db.close();
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
      assert.equal(await run('Array.from(document.querySelectorAll(`[aria-label="About the company"] button`)).some(b=>/open filing/i.test(b.textContent))'),false,'the description does not open a browser window');
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
      await engine('Schedule and triggers');await until('Boolean(document.querySelector(`[aria-label="Token saving"]`))','Token saving section missing');
      assert.equal(await run('document.querySelector(`[aria-label="Skip unchanged reviews"]`).checked'),true);
      // Step A1 (2026-11-12): shadow evaluation and model routing are gone; near the budget only the interval slows down.
      const card=()=>run('document.querySelector(`[aria-label="Token saving"]`).textContent');const text=await card();
      for(const gone of ['Shadow evaluation','Reviews to shadow','Shadow budget','Main model from','Spot checks','Cheaper model limit','Save near the budget'])assert.ok(!text.includes(gone),`${gone} row removed`);
      assert.equal(await run('Boolean(document.querySelector(`[aria-label="Model routing"]`))'),false);
      assert.ok(text.includes('Slow down near the budget')&&text.includes('scheduled reviews run half as often'));assert.ok(!text.includes('Condensing model'),'the condensing model is the Context compacting agent on the Agents tab (A3)');
      assert.equal(await run('document.querySelector(`[aria-label="Slow down near the budget"]`).checked'),true,'on by default');
      await run('document.querySelector(`[aria-label="Slow down near the budget"]`).click()');await click('Save changes');
      await until('(async()=>(await window.portfolio.getRuntime()).config.degradeNearBudget===false)()','Slow down not saved');
      await run('document.querySelector(`[aria-label="Token saving"]`).scrollIntoView({block:"start"})');await wait(200);await capture('token-saving');
      await run("window.portfolio.configureRuntime({degradeNearBudget:true})");
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
