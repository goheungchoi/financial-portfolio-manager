const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ResearchGaps,researchFromEvents,RETRY_LIMIT}=require('../electron/research-gaps.cjs');const {verdictIssues}=require('../electron/plan-gap.cjs');
const wait=(symbol,unresolved='Free cash flow after capital spending')=>({symbol,verdict:'waiting',reason:'r',condition:{kind:'data',unresolved,evidence:'e',recheck:'k'}});
test('a data gap repeated across reviews reaches its retry limit, keeps the research tried, and closes when resolved',()=>{
  const g=new ResearchGaps(new DatabaseSync(':memory:'));
  g.record('s',[wait('NASD:AMZN')],[{symbol:'NASD:AMZN',source:'get_company_research:financials+risk'}]);
  g.record('s',[wait('NASD:AMZN')],[{symbol:'NASD:AMZN',source:'get_company_research:financials+risk'},{symbol:'NASD:AMZN',source:'get_company_research:events'}]);
  assert.equal(g.context('s')[0].status,'retrying');g.record('s',[wait('NASD:AMZN')]);
  const [gap]=g.context('s');assert.equal(gap.reviews,RETRY_LIMIT);assert.equal(gap.status,'retry limit reached');assert.deepEqual(gap.sourcesTried,['get_company_research:financials+risk','get_company_research:events']);
  g.record('s',[{symbol:'NASD:AMZN',verdict:'passed',reason:'r',condition:{kind:'none'}}]);assert.deepEqual(g.context('s'),[],'a decision under uncertainty closes it');
});
test('research requests are read from the review log; a wait at the limit is flagged as a verdict issue',()=>{
  const ev=[{title:'Discovery request',body:JSON.stringify({symbol:'NASD:AMZN',sections:['risk','financials']})},{title:'Market data request',body:JSON.stringify({symbol:'NASD:AMZN',dataset:'order_book'})},{title:'Decision',body:'{}'}];
  assert.deepEqual(researchFromEvents(ev),[{symbol:'NASD:AMZN',source:'get_company_research:financials+risk'},{symbol:'NASD:AMZN',source:'get_market_evidence:order_book'}]);
  const ctx={researchGaps:[{symbol:'NASD:AMZN',reviews:26,status:'retry limit reached'}]};
  assert.ok(verdictIssues(ctx,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[wait('NASD:AMZN')]}).some(i=>/still waiting on data after 26 reviews/.test(i)));
  assert.ok(!verdictIssues(ctx,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[{...wait('NASD:AMZN'),condition:{kind:'event',unresolved:'u',evidence:'Oct 29 earnings',recheck:'Oct 30'}}]}).some(i=>/retry limit/.test(i)),'a dated event wait is the expected change');
});
test('through real reviews: gaps are recorded from each review and the next review sees them',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,payload TEXT)');
  const log=(runId,kind,title,body)=>db.prepare('INSERT INTO events(id,payload) VALUES(?,?)').run(runId,JSON.stringify({runId,kind,title,body}));
  const supplied=[];const decision={action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:'',plan:{thesis:'',invalidation:'x',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low'},planVerdicts:[wait('005930')]};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:1}],()=>[]),{request:async(op,p)=>{supplied.push(p);return {decision,usage:{inputTokens:1,outputTokens:1},provider:'openai'};}},log);
  const ctx=()=>({environment:'kis',market:'KR',currency:'KRW',executionEnabled:true,marketSession:{open:false},equity:1000000,cash:1000000,positions:{},universe:[{symbol:'005930',name:'S',price:1}],quotes:[{symbol:'005930',price:1,timestamp:Date.now()}],orders:[],risk:{symbols:[],anyStock:true,baseline:1000000,lossLimit:{mode:'off',value:0}}});
  a.live={identity:()=>'acct',enabled:true,market:'KR',context:async()=>ctx(),orderReconciliation:()=>null,getState:()=>({}),orders:()=>[]};a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  for(let i=0;i<3;i++)await a.review('User request');await a.review('User request');
  const last=supplied.at(-1).context.researchGaps;assert.equal(last[0].symbol,'005930');assert.equal(last[0].status,'retry limit reached');assert.equal(last[0].reviews,3);
});
test('review fix: a different question for the same symbol starts a new count; paraphrases continue it',()=>{
  const g=new ResearchGaps(new DatabaseSync(':memory:'));
  for(const q of ['What is filing-backed capital spending and free cash flow after it?','Cash generation after capital expenditure and its implications for the valuation.','How much cash remains after capital expenditures ahead of earnings?'])
    g.record('s',[wait('NASD:AMZN',q)],[{symbol:'NASD:AMZN',source:'get_company_research:financials'}]);
  assert.equal(g.context('s')[0].reviews,3,'three paraphrases of one question');assert.equal(g.context('s')[0].status,'retry limit reached');
  g.record('s',[wait('NASD:AMZN','Whether a recent regulatory filing changes the litigation risk')],[{symbol:'NASD:AMZN',source:'get_company_research:events'}]);
  const [fresh]=g.context('s');assert.equal(fresh.reviews,1,'a new question does not inherit the exhausted limit');assert.equal(fresh.status,'retrying');assert.deepEqual(fresh.sourcesTried,['get_company_research:events'],'nor the old sources');
});
