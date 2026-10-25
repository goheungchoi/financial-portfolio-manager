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
test('review fix: a gap is identified by metric, period and document, not wording; a different metric starts afresh',()=>{
  const g=new ResearchGaps(new DatabaseSync(':memory:'));const ask=(unresolved,metric,period='FY2026 Q3',document='10-Q')=>({...wait('NASD:AMZN',unresolved),dataGap:{material:true,why:'w',otherSource:'',alternative:'',retry:'',metric,period,document}});
  for(const [q,m,p] of [['What was operating income in the quarter?','Operating income','FY2026 Q3'],['Is the operating-income figure filed yet?','operating income','Q3 FY2026'],['Profit from operations, per the 10-Q','Operating Income.','fy2026 q3']])
    g.record('s',[ask(q,m,p)],[{symbol:'NASD:AMZN',source:'get_company_research:financials'}]);
  const [gap]=g.context('s');assert.equal(gap.reviews,3,'three wordings of one gap');assert.equal(gap.status,'retry limit reached');assert.equal(gap.metric,'operating income');assert.match(gap.id,/^[0-9a-f]{16}$/);
  const ctx={researchGaps:g.context('s')};const issue=v=>verdictIssues(ctx,{action:'Hold',plan:{invalidation:'x'},planVerdicts:[v]}).some(i=>/retry limit/.test(i));
  assert.ok(issue(ask('Operating income still missing','operating income','Q3 FY2026')),'the same gap again is flagged');
  assert.ok(!issue(ask('What was operating income in the quarter?','net income')),'net income is a different metric: not flagged, however similar the wording');
  g.record('s',[ask('What was net income in the quarter?','Net income')],[{symbol:'NASD:AMZN',source:'get_company_research:events'}]);
  const [fresh]=g.context('s');assert.equal(fresh.reviews,1,'reproduced case: operating income then net income no longer reaches the limit');assert.equal(fresh.status,'retrying');assert.deepEqual(fresh.sourcesTried,['get_company_research:events']);
  g.record('s',[ask('Net income for the next quarter','Net income','FY2026 Q4')]);assert.equal(g.context('s')[0].reviews,1,'a different period is a different gap');
  g.record('s',[ask('Net income for the next quarter','Net income','FY2026 Q4','annual report')]);assert.equal(g.context('s')[0].reviews,1,'and a different document');
  const {gapIdentity}=require('../electron/research-gaps.cjs');assert.equal(gapIdentity('X',ask('a','capex')).id,gapIdentity('X',ask('b','Capital expenditures')).id,'exact abbreviations are the same metric');
  assert.notEqual(gapIdentity('X',ask('a','capex')).id,gapIdentity('X',ask('a','free cash flow')).id);
});
test('reviews are asked to name the missing metric, period and document for a data wait',()=>{
  const {validateDecision}=require('../electron/ai-client.cjs');const d=validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:'',planVerdicts:[{...wait('NASD:AMZN'),dataGap:{material:true,why:'w',otherSource:'o',alternative:'a',retry:'r',metric:'Operating income',period:'FY2026 Q3',document:'10-Q'},minimumPosition:null}]},['NASD:AMZN']);
  assert.deepEqual([d.planVerdicts[0].dataGap.metric,d.planVerdicts[0].dataGap.period,d.planVerdicts[0].dataGap.document],['Operating income','FY2026 Q3','10-Q']);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');assert.match(src,/required:\['material','why','otherSource','alternative','retry','metric','period','document'\]/);assert.match(src,/a different metric, period or document is a different gap/);
});
