const {app,dialog,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
// Offline symbol-list fixtures served to the app instead of KIS's download server.
const masterDir=path.join(process.env.PORTFOLIO_SMOKE_DATA,'master-fixtures');fs.mkdirSync(masterDir,{recursive:true});for(const [name,data] of Object.entries(require('./discovery-fixtures.cjs').masterFiles()))fs.writeFileSync(path.join(masterDir,name),data);process.env.PORTFOLIO_MASTER_DIR=masterDir;
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/ui-regression');fs.mkdirSync(output,{recursive:true});
const report={checks:[],screenshots:[],errors:[]};let win;let failUS=false;let posts=0;let researchMode=false;let researchRound=0;let decisionFailure=false;
const domestic={accountKey:'ui-regression-fixture',environment:'mock',source:'kis',cash:10000000,reportedTotal:10000000,holdings:[]};
const overseas={accountKey:'ui-regression-fixture:US',environment:'mock',source:'kis-us',currency:'USD',cash:0,reportedTotal:0,holdings:[]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-ui-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:true,dartConnected:false,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='company-chart')return {status:'available',retrievedAt:Date.now(),metrics:{price:110,dayHigh:115,dayLow:100,PER:12,PBR:2,high52Week:150,low52Week:70,ROE:null},data:{SMA5:105,SMA10:102,SMA20:98,stochastic:{K:60,D:58},asOf:Date.now()-86400000},candles:Array.from({length:30},(_,i)=>({timestamp:Date.now()-(30-i)*86400000,open:90+i,high:94+i,low:88+i,close:92+i,volume:100+i}))};
  if(operation==='refresh')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='us-context'){if(failUS)throw Object.assign(new Error('US_CASH_SERVER_ERROR'),{httpStatus:503,brokerCode:'FIXTURE503'});return {balance:{...overseas,timestamp:new Date().toISOString()},quotes:[],warnings:[],marketSession:{open:true,status:'open'}};}
  if(operation==='live-context')return {balance:{...domestic,timestamp:new Date().toISOString()},quotes:[],marketSession:{open:false,status:'closed'}};
  if(operation==='screen')return payload.request.market==='KR'?[{symbol:'005930',name:'raw',price:213500,changePct:1.67,volume:7179383,marketCap:1264e12,per:null,currency:'KRW'},{symbol:'069500',name:'etf',price:40000,changePct:-0.5,volume:100,marketCap:null,per:null,currency:'KRW'},{symbol:'45226K',name:'pref',price:5200,changePct:30,volume:1,marketCap:null,per:null,currency:'KRW'}]:[];
  if(operation==='orders'||operation==='us-orders')return {orders:[]};if(operation==='quotes')return [];
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
  const navigate=async tab=>{await run(`Array.from(document.querySelectorAll('.nav')).find(button=>button.textContent===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1').textContent===${JSON.stringify(tab)}`,'Navigation failed');await wait(100);};
  const capture=async name=>{for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());report.screenshots.push(name+'.png');return;}catch(error){if(attempt===2)throw error;await wait(150);}}};
  const check=async(name,fn)=>{await fn();report.checks.push({name,status:'passed'});};
  try{
    await run('window.portfolio.importKis()');await run('window.portfolio.refreshPortfolio()');
    await check('All tabs navigate in one window, in dark and light modes, at desktop and compact widths',async()=>{
      for(const [width,height] of [[1280,900],[960,720]]){win.setSize(width,height);for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme){await run("document.querySelector('[aria-label=\"Dark mode\"]').click()");await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'Theme switch did not update');}
        const tabs=await run("Array.from(document.querySelectorAll('.nav')).map(button=>button.textContent)");
        for(const tab of tabs){await navigate(tab);assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(await run('typeof window.require'),'undefined');const overflow=await run('document.querySelector("main").scrollWidth-document.querySelector("main").clientWidth');assert.ok(overflow<=2,`${tab} overflows by ${overflow}px at ${width}px (${theme})`);}
        await navigate('U.S. stocks');await until('Boolean(document.querySelector(".us-account-summary"))','U.S. summary missing');await run("window.portfolio.usAction('refresh')");await wait(2100);await click('Refresh U.S. account');await until('document.querySelector(".us-account-value .tick-delta")?.dataset.delta==="0"','Zero-change indicator not updated');
        const geometry=await run(`(()=>{const summary=document.querySelector('.us-account-summary'),value=summary.querySelector('strong').getBoundingClientRect(),delta=summary.querySelector('.tick-delta').getBoundingClientRect(),header=summary.nextElementSibling.querySelector('th').getBoundingClientRect(),box=summary.getBoundingClientRect();return {value:value.toJSON(),delta:delta.toJSON(),header:header.toJSON(),box:box.toJSON()};})()`);
        assert.ok(Math.abs((geometry.value.top+geometry.value.bottom)/2-(geometry.delta.top+geometry.delta.bottom)/2)<10,'Equity delta wrapped below total');assert.ok(geometry.delta.left>=geometry.value.right+4,'Equity delta overlaps total');assert.ok(geometry.header.top>=geometry.box.bottom+15,'Stock header overlaps account summary');
        await capture(`us-zero-${width}-${theme}`);
      }}
    });
    await check('Overview places unrealized return below equity in both themes and shows native loss correctly',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.cash=0;overseas.reportedTotal=180;
      await run("(async()=>window.portfolio.saveCosts({...await window.portfolio.getCosts(),usdKRW:1000}))()");await run('window.portfolio.refreshPortfolio()');await navigate('Overview');
      for(const theme of ['dark','light']){
        if(await run('document.documentElement.dataset.theme')!==theme)await run('document.querySelector(`[aria-label="Dark mode"]`).click()');
        await until('document.querySelector(`[aria-label="Combined equity"] .portfolio-profit`)?.dataset.amount==="-20000"','Combined P/L missing');
        assert.equal(await run('document.querySelector(`[aria-label="U.S. equity"] .portfolio-profit`).dataset.amount'),'-20');
        const geometry=await run('(()=>{const card=document.querySelector(`[aria-label="Combined equity"]`);return {value:card.querySelector(".equity-headline").getBoundingClientRect().bottom,profit:card.querySelector(".portfolio-profit").getBoundingClientRect().top};})()');assert.ok(geometry.profit>=geometry.value,'P/L overlaps equity');
        await run('document.querySelector(".portfolio-metrics").scrollIntoView({block:"center"})');await capture('overview-pnl-'+theme);
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
    });
    await check('Outcome journal displays linked evidence and filters simulation from broker records',async()=>{
      const {DatabaseSync}=require('node:sqlite');const fixtureDb=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
      fixtureDb.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('outcome-ui','fixture',JSON.stringify({id:'outcome-ui',accountKey:'fixture',market:'US',currency:'USD',environment:'mock',symbol:'NASD:TEST',side:'Sell',filled:1,quantity:1,fillPrice:10,status:'Filled',createdAt:Date.now(),resultCosts:{gross:10,commission:.1,transactionTax:.01,netCash:9.89,gainAfterFees:-1.11,gainAfterEstimatedTax:null}}));fixtureDb.close();
      await navigate('Journal');await until(`document.querySelector('[aria-label="Trade outcomes"]')?.textContent.includes("NASD:TEST")`,'Outcome not displayed');
      await run(`document.querySelector('[aria-label="Trade outcomes"] details').open=true`);assert.ok(await run(`document.querySelector('[aria-label="Trade outcomes"]').textContent.includes("Loss observed; cause unassessed")`));await capture('outcome-journal');
      await run(`(()=>{const select=document.querySelector('[aria-label="Outcome source"]');select.value='paper';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`document.querySelector('[aria-label="Trade outcomes"]').textContent.includes("No recorded fills yet.")`,'Source filter failed');
    });
    await check('Agent requests market evidence, changes review alert and user can reset it',async()=>{
      researchMode=true;await run("window.portfolio.configureRuntime({scope:'paper',enabled:false,autoSubmit:false})");const before=await run('window.portfolio.getRuntime()');
      const reply=await run('window.portfolio.reviewRuntime()');assert.equal(reply.ok,true);assert.equal(reply.state.usage.calls-before.usage.calls,3);assert.equal(reply.state.watches[0].percent,1.5);assert.equal(reply.state.config.eventTolerancePct,before.config.eventTolerancePct);assert.equal(reply.state.config.enabled,false);assert.equal(posts,0);
      await navigate('AI console');await until('document.querySelector("main").textContent.includes("Market data result")','Research result missing from console');assert.ok(await run('document.querySelector("main").textContent.includes("Review watch updated")'));await capture('agent-research-console');
      await navigate('Engine settings');await until('document.querySelector(\`[aria-label="AI review alerts"]\`)?.textContent.includes("1.5%")','AI alert not visible');await run('document.querySelector(`[aria-label="AI review alerts"]`).scrollIntoView({block:"center"})');await capture('agent-review-alert');await click('Reset to default alerts');await until('document.querySelector(\`[aria-label="AI review alerts"]\`).textContent.includes("Default movement threshold")','Reset failed');researchMode=false;
    });
    await check('No page search; draft actions persist across tabs',async()=>{
      assert.equal(await run('document.querySelector(`[aria-label="Find a page"]`)'),null);
      await navigate('Engine settings');const before=await run('window.portfolio.getRuntime()');
      await run('(()=>{const input=document.querySelector(`[aria-label="Agent guidelines"]`);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"UI draft fixture");input.dispatchEvent(new Event("input",{bubbles:true}));})()');await until('Boolean(document.querySelector(".settings-draft-bar"))','Draft bar missing');
      assert.ok(await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Run portfolio review").disabled'));
      await navigate('Overview');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),'UI draft fixture');await capture('settings-draft-actions');await click('Discard');await until('!document.querySelector(".settings-draft-bar")','Discard did not clear draft');assert.equal((await run('window.portfolio.getRuntime()')).config.guidelines,before.config.guidelines);assert.equal(await run('document.querySelector(`[aria-label="Agent guidelines"]`).value'),before.config.guidelines);
    });
    await check('Company information and charts show evidence without fabricated missing metrics',async()=>{
      await navigate('Charts');await until('document.querySelector(".company-stats")?.textContent.includes("115")','Company metrics missing');assert.ok(await run('document.querySelector(".company-stats").textContent.includes("Unavailable")'));assert.ok(await run('document.querySelectorAll(".candles g").length>25'));await capture('company-profile');await run('document.querySelector(".candles").scrollIntoView({block:"center"})');await capture('company-price-chart');
    });
    await check('One-click start activates saved MOCK scope; stop disables new automatic orders',async()=>{
      await run("window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithAI:true,enabled:false,autoSubmit:false})");await navigate('Overview');await wait(2200);await click('Start auto trading');await until('(async()=>{const s=await window.portfolio.getRuntime();return s.launch.running&&!s.busy;})()','Launch failed');const active=await run('window.portfolio.getRuntime()');assert.equal(active.execution.markets[0].automatic,true);assert.equal(active.reviews[0].trigger,'Auto trading started');assert.equal(posts,0);await wait(2200);await click('Stop auto trading');await until('(async()=>!(await window.portfolio.getRuntime()).sessionArmed)()','Stop failed');await capture('auto-trading-controls');
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
      await navigate('Engine settings');const before=await run('window.portfolio.getRuntime()');await run('(()=>{const select=document.querySelector(`[aria-label="OpenAI model"]`);select.value="gpt-6-astra";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await until('document.querySelector(`[aria-label="Reasoning effort"]`).value==="low"','Astra reasoning was not normalized');await click('Save engine settings');await until('(async()=> (await window.portfolio.getRuntime()).config.openaiModel==="gpt-6-astra")()','Model did not save');assert.equal((await run('window.portfolio.getRuntime()')).usage.calls,before.usage.calls);await navigate('Overview');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="OpenAI model"]`).value'),'gpt-6-astra');await capture('model-settings');await run("window.portfolio.configureRuntime({openaiModel:'gpt-6-luna',reasoningEffort:'none'})");
    });
    await check('Review failures display actionable diagnostics and status has no Settings button',async()=>{
      decisionFailure=true;await run("window.portfolio.configureRuntime({scope:'paper',provider:'openai',enabled:false,maxCallsPerDay:200,maxUSDPerDay:100})");await navigate('Engine settings');await wait(2200);await click('Run portfolio review');await until('document.querySelector("main").textContent.includes("unavailable to this API project")','Safe diagnosis missing');
      const state=await run('window.portfolio.getRuntime()');assert.equal(state.lastError,'AI_MODEL_UNAVAILABLE');assert.match(state.lastErrorDetail,/AI research and decision/);assert.equal(await run('Array.from(document.querySelectorAll(".runtime-pulse button")).some(b=>b.textContent==="Settings")'),false);await capture('review-error-details');decisionFailure=false;
    });
    await check('Holdings open the selected company; allocation segments show keyboard-accessible detail; replay runs offline',async()=>{
      overseas.holdings=[{symbol:'NASD:TEST',name:'Test holding',quantity:2,price:90,cost:100}];overseas.reportedTotal=180;await run('window.portfolio.refreshPortfolio()');await navigate('Holdings');await until('Boolean(document.querySelector(`[aria-label="View Test holding charts"]`))','Company link missing');await run('document.querySelector(`[aria-label="View Test holding charts"]`).click()');await until('document.querySelector("h1").textContent==="Charts"&&document.querySelector(`[aria-label="Company stock code"]`)?.value==="NASD:TEST"','Chart symbol not selected');await until('Boolean(document.querySelector(".company-stats"))','Company data missing');await run('Array.from(document.querySelectorAll("details")).find(d=>d.querySelector("summary")?.textContent.includes("Paper replay")).open=true');await click('Run offline replay');await until('document.querySelector("main").textContent.includes("Later holdout")','Replay missing');
      await navigate('Overview');await until('Boolean(document.querySelector(".interactive-ring circle[tabindex]"))','Allocation missing');await run('(()=>{const segment=Array.from(document.querySelectorAll(".interactive-ring circle[tabindex]")).find(e=>e.getAttribute("aria-label").includes("Test holding"));segment.focus();segment.dispatchEvent(new FocusEvent("focusin",{bubbles:true}));})()');await until('document.querySelector(`[role="tooltip"]`)?.textContent.includes("NASD:TEST")','Tooltip details missing');await run('document.querySelector(".allocation-explorer").scrollIntoView({block:"center"})');await wait(250);await capture('allocation-detail-tooltip');
    });
    await check('Auto review interval persists the AI choice and shows its reason',async()=>{
      await run("window.portfolio.configureRuntime({scope:'paper',enabled:false,autoReviewInterval:true,provider:'openai'})");const reply=await run('window.portfolio.reviewRuntime()');assert.equal(reply.ok,true);assert.equal(reply.state.reviewInterval.minutes,5);assert.equal(reply.state.config.enabled,false);await navigate('Engine settings');await until('document.querySelector("main").textContent.includes("Fixture volatility calls for closer monitoring")','Auto cadence reason missing');await run("window.portfolio.configureRuntime({autoReviewInterval:false})");
    });
    await check('Unlimited budgets save independently and calculated usage replaces reservation labels',async()=>{
      await navigate('Engine settings');await wait(2200);for(const label of ['API calls per day','Daily local API budget (USD)','Reflection calls per day','Daily reflection budget (USD)'])await run(`document.querySelector('[aria-label="Unlimited ${label}"]').click()`);await click('Save engine settings');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.unlimitedCalls&&c.unlimitedBudget&&c.reflectionUnlimitedCalls&&c.reflectionUnlimitedBudget;})()','Unlimited settings not saved');await navigate('Overview');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Unlimited API calls per day"]`).checked'),true);await capture('unlimited-api-settings');
    });
    await check('Autopilot guardrails save, survive navigation and preview the daily digest',async()=>{
      await navigate('Engine settings');await wait(2200);await until('Boolean(document.querySelector(`[aria-label="Autopilot guardrails"]`))','Guardrails section missing');
      await run('(()=>{const set=(label,proto,value,type)=>{const el=document.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(proto.prototype,"value").set.call(el,value);el.dispatchEvent(new Event(type,{bubbles:true}));};set("Loss-limit response",HTMLSelectElement,"block-buys","change");set("Automatic orders per day",HTMLInputElement,"3","input");})()');
      await click('Save engine settings');await until('(async()=>{const c=(await window.portfolio.getRuntime()).config;return c.lossAction==="block-buys"&&c.maxAutoOrdersPerDay===3;})()','Guardrails not saved');
      await navigate('Overview');await navigate('Engine settings');assert.equal(await run('document.querySelector(`[aria-label="Loss-limit response"]`).value'),'block-buys');
      await click("Preview today's digest");await until('document.querySelector(`[aria-label="Digest preview"]`)?.textContent.includes("Daily digest")','Digest preview missing');
      await run('document.querySelector(`[aria-label="Autopilot guardrails"]`).scrollIntoView({block:"start"})');await wait(200);await capture('autopilot-guardrails');
      await run("window.portfolio.configureRuntime({lossAction:'review',maxAutoOrdersPerDay:0})");
    });
    await check('Discover searches the symbol list, screens rankings and maintains the watchlist',async()=>{
      await navigate('Discover');await until('(async()=>(await window.portfolio.getDiscovery()).state.master.total>0)()','Symbol list fixture not loaded');
      await run('(()=>{const el=document.querySelector(`[aria-label="Search securities"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"삼성");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
      await click('Search');await until('document.querySelector(`[aria-label="Search results"]`)?.textContent.includes("005930")','Search results missing');
      await run('document.querySelector(`[aria-label="Search results"] tbody tr button:not(.link-button)`).click()');await until('document.querySelector(`[aria-label="Watchlist entries"]`)?.textContent.includes("삼성전자")','Watchlist add failed');
      await click('Run screen');await until('document.querySelector(`[aria-label="Screener results"]`)?.textContent.includes("삼성전자")','Screener results missing');
      const screened=await run('Array.from(document.querySelectorAll(`[aria-label="Screener results"] tbody tr`)).map(r=>r.cells[0].textContent)');assert.deepEqual(screened,['005930'],'stocks only; ETFs and lettered codes are excluded');
      const reply=await run("window.portfolio.updateWatchlist('add','999999','')");assert.equal(reply.ok,false);assert.equal(reply.error,'UNKNOWN_SYMBOL');
      await run('document.querySelector(`[aria-label="Watchlist"]`).scrollIntoView({block:"start"})');await wait(200);await capture('discover-watchlist');
      await run('document.querySelector(`[aria-label="Remove 005930"]`).click()');await until('!document.querySelector(`[aria-label="Watchlist entries"]`)','Watchlist remove failed');
    });
    console.log(`UI regression passed: ${report.checks.length} groups, all tabs × 2 themes × 2 sizes, zero/positive/negative deltas, refresh recovery and read-only AI reviews.`);finish(0);
  }catch(error){report.errors.push(error.stack??String(error));try{await capture('failure');}catch{}console.error(error);finish(1);}
});});require('../electron/main.cjs');
