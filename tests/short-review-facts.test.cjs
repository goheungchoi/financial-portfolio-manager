// Short selling B3e (artifacts/reviews/2026-11-24-short-selling/rulings-b3e-text.md): what the review is told about
// shorts, only while they are enabled. With shorts off every text, version and fingerprint is byte for byte as before.
// Made-up codes, prices and figures.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const RI=require('../electron/review-instructions.cjs');
// In force only when shorts are allowed AND the short and cover paths can be sent (B4); allowed with the paths off is off.
const PATHS=open=>({short:{executable:open,automatic:false},cover:{executable:open,automatic:open}});
const ON={environment:'kis',universe:[{symbol:'990010'}],positions:{},productRisk:{products:[],warnings:[],credit:{effective:PATHS(true),short:{allowed:true}}}};
const OFF={...ON,productRisk:{...ON.productRisk,credit:{effective:PATHS(true),short:{allowed:false}}}};
const ALLOWED_PATH_OFF={...ON,productRisk:{...ON.productRisk,credit:{effective:PATHS(false),short:{allowed:true}}}};
// Opens the short and cover paths for a test (they are executable:false until B4).
function withPathsOpen(fn){const CP=require('../electron/credit-paths.cjs'),was=CP.shortPathsOpen;CP.shortPathsOpen=()=>true;try{return fn();}finally{CP.shortPathsOpen=was;}}
test('allowed while the short and cover paths cannot be sent (today, until B4) is shorts off byte for byte: text, record, both providers\' requests, the dry-run gate, the context',async()=>{
  const CP=require('../electron/credit-paths.cjs');assert.equal(CP.shortPathsOpen(),false,'today: not executable');assert.equal(CP.shortPathsOpen({approved:true}),false);
  const offAllowedFalse={...OFF,productRisk:{...OFF.productRisk,credit:{effective:PATHS(false),short:{allowed:false}}}};
  assert.deepEqual(RI.record(ALLOWED_PATH_OFF),RI.record(offAllowedFalse));assert.deepEqual(RI.partsFor(ALLOWED_PATH_OFF),RI.partsFor(offAllowedFalse));
  assert.deepEqual(RI.reviewBlocks(RI.partsFor(ALLOWED_PATH_OFF)),RI.reviewBlocks(RI.partsFor(offAllowedFalse)),'Claude\'s system blocks');
  // OpenAI's request as sent.
  const A=require('../electron/ai-client.cjs');const sent=async ctx=>{let body=null;const client=new A.AiClient('k'.repeat(20),async(url,init)=>{body=JSON.parse(init.body);return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});try{await client.decide(ctx,{research:true});}catch{}return body.instructions;};
  assert.equal(await sent(ALLOWED_PATH_OFF),await sent(offAllowedFalse));assert.doesNotMatch(await sent(ALLOWED_PATH_OFF),/SHORT SELLING/);assert.match(await sent(ON),/SHORT SELLING/);
  // The dry-run gate and the facts in automation: off while the paths are closed, whatever the switch says.
  const {Automation}=require('../electron/automation.cjs');const a=Object.create(Automation.prototype);a.config={scope:'kis'};a.shortsEnabled=()=>true;a.live={creditApproved:()=>true};assert.equal(a.shortFactsInForce(),false);
  a.completedClaudeDryRun=()=>({instructions:{fingerprint:'e36e408915854800'}});assert.ok(a.claudeTradingDryRun(),'today\'s dry run keeps counting');
  withPathsOpen(()=>{assert.equal(a.shortFactsInForce(),true);assert.equal(a.claudeTradingDryRun(),null,'with the paths open: a new dry run');});
});
test('the off pin: both fingerprints, versions and the text exactly as before; on: the short part after CREDIT, its own versions and fingerprints',()=>{
  assert.equal(RI.fingerprint(),'e36e408915854800');assert.equal(RI.fingerprint(undefined,{orders:true}),'270c1047cfa0a70e');
  assert.equal(RI.fingerprint(undefined,{short:true}),'67577dc81443657e');assert.equal(RI.fingerprint(undefined,{orders:true,short:true}),'236a6e7d3e6aff2e');
  assert.deepEqual(RI.record(OFF),{version:'review 2026-11-25.4',fingerprint:'e36e408915854800',parts:['extended','credit']});
  assert.deepEqual(RI.record(ON),{version:'review 2026-11-25.4 short',fingerprint:'67577dc81443657e',parts:['extended','credit','short']});
  assert.deepEqual(RI.record({...ON,ordersPerReview:3}),{version:'review 2026-11-25.4 orders short',fingerprint:'236a6e7d3e6aff2e',parts:['extended','credit','short','more-orders']});
  assert.equal(RI.record(ON,'proposed').version,'proposed 2026-11-25.2 short');assert.equal(RI.record({...ON,ordersPerReview:2},'proposed').version,'proposed 2026-11-25.2 orders short');
  // No credit at all, or a U.S. context: no short part.
  assert.deepEqual(RI.partsFor({environment:'kis-us',universe:[],positions:{}}),['extended']);
  const off=RI.setReviewText(RI.partsFor(OFF)),on=RI.setReviewText(RI.partsFor(ON));
  assert.doesNotMatch(off,/SHORT SELLING/);assert.equal(off,RI.setReviewText(['extended','credit']));
  const credit=RI.REVIEW_PARTS.find(p=>p.id==='credit').text;assert.ok(on.includes(credit+'\n\n'+RI.SHORT_TEXT),'right after CREDIT');assert.equal(Buffer.byteLength(on)-Buffer.byteLength(off),Buffer.byteLength(RI.SHORT_TEXT)+2);
  // Claude's two blocks: the short part with the other parts, the core unchanged.
  const blocks=RI.reviewBlocks(RI.partsFor(ON));assert.equal(blocks.core,RI.REVIEW_CORE);assert.ok(blocks.parts.endsWith(RI.SHORT_TEXT));
  // Facts only: the ruled wording.
  for(const s of ['They are facts, not reasons to short.','Stocks listed on KOSPI or KOSDAQ only; an ETF short is refused for now.','KIS lends for 90 days with no extension. daysToRepay is the app\'s count from loanDate','the borrow fee is estimated at annualFeePct','KIS\'s own figure replaces it when known','productRisk.credit.short.automatic says whether a short you decide is sent by itself or proposed for approval','coverStop.state "unprotected" means no stop is working for that short, with the cause.','borrowable null means not read','shortfall is the cash the app holds back from its own buys','maxGrossPctOfEquity caps all shorts together','capUsedPct is the share they use now and capLeftPct what is left','Without the kind the order is refused.'])assert.ok(RI.SHORT_TEXT.includes(s.replace(/^Stocks/,'stocks')),s);
  assert.doesNotMatch(RI.SHORT_TEXT,/dividend|your buys|long plus short|must be covered within/i);
});
test('both providers\' decision schemas take the credit kinds the text names',()=>{
  const C=require('../electron/ai-client.cjs');for(const a of [false,true])for(const b of [false,true])for(const t of [false,true]){const s=C.decisionSchema(a,b,t);assert.deepEqual(s.properties.credit.enum,['none','margin-buy','margin-sell','short','cover']);assert.ok(s.required.includes('credit')&&s.required.includes('loanDate'));}
  // OpenAI (the strict schema) and Claude (the flat form, its field guard and rebuild): a short and a cover are taken.
  const A=require('../electron/anthropic-client.cjs');
  for(const credit of ['short','cover']){const d={action:credit==='short'?'Sell':'Buy',symbol:'990010',quantity:1,credit,loanDate:credit==='cover'?'2026-09-03':'',explanation:'x'};
    assert.equal(C.validateDecision(d,['990010']).credit,credit);
    for(const [b,p] of [[false,false],[true,false],[false,true],[true,true]]){const flat=A.flatDecisionSchema(b,p);assert.deepEqual(flat.properties.credit.enum,['none','margin-buy','margin-sell','short','cover']);assert.ok(flat.required.includes('credit')&&flat.required.includes('loanDate'));}
    const flat=A.flatDecisionSchema(false,false);const answer=Object.fromEntries(Object.keys(flat.properties).map(k=>[k,k in d?d[k]:null]));assert.equal(A.rebuildDecision(answer,flat).decision.credit,credit);}
});
// Start on Claude: a dry run made with shorts off does not count once shorts are switched on, and the reverse.
const record=fingerprint=>({id:'D',timestamp:Date.now(),model:'claude-opus-5-5',calls:3,costUSD:0.33,account:'KIS live',appVersion:'1.5.73',instructions:{version:'x',fingerprint},answerForm:'enforced'});
function harness(){require('./fixtures/order-book.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
  a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};return a;}
test('a Claude dry run counts only for the instructions in force: switching shorts on asks a new one, and Start is refused until then',()=>{
  const M=require('../electron/ai-models.cjs');M.setClaudeTradingForTests(true);try{const a=harness();let shorts=false;a.shortFactsInForce=()=>shorts;
    const use=fp=>{a.completedClaudeDryRun=()=>record(fp);return a.claudeTradingDryRun();};
    assert.ok(use('e36e408915854800'));assert.ok(use('270c1047cfa0a70e'));assert.equal(use('67577dc81443657e'),null,'off: a short dry run does not count');
    shorts=true;assert.equal(use('e36e408915854800'),null,'shorts on: the off dry run no longer counts');assert.equal(use('270c1047cfa0a70e'),null);
    assert.ok(use('67577dc81443657e'));assert.ok(use('236a6e7d3e6aff2e'));
    a.completedClaudeDryRun=()=>record('270c1047cfa0a70e');assert.throws(()=>a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true,enabled:true}),/CLAUDE_TRADING_DRY_RUN/,'Start is refused');
    a.completedClaudeDryRun=()=>record('236a6e7d3e6aff2e');a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true});a.configure({enabled:true,autoSubmit:true});assert.equal(a.config.enabled,true,'with a dry run under the short text: Start goes through');
  }finally{M.setClaudeTradingForTests(false);}
});
// The context fields, from readings already held (no KIS read for the context).
const {LiveEngine}=require('../electron/live-engine.cjs');
const LOT={symbol:'990010',quantity:10,price:1200,entryPrice:1000,proceeds:10000,loanAmount:12000,loanDate:'2026-09-03'};
const POLICY={short:{enabled:true,auto:false,maxGrossPctOfEquity:20,stopLossPct:15,feePct:5,coverBeforeDays:5,maxDays:90},margin:{enabled:false,auto:false,maxLoanPctOfEquity:30,interestPct:8}};
function engine(policy=POLICY,{lend}={}){const held={margin:{loans:[],estimatedCollateralPct:null},short:{positions:[{symbol:'990010',quantity:10,entryPrice:1000,price:1200,adversePct:20,loanDate:'2026-09-03',daysToRepay:20,estimatedFee:96}]},warnings:[]};
  return Object.assign(Object.create(LiveEngine.prototype),{market:'KR',exposure:{context:()=>({products:[],warnings:[],leveragedEtps:{allowed:false}}),policy:()=>policy,creditRisk:()=>held},identity:()=>'acct',day:()=>'2026-11-24',creditApproved:()=>false,
    shortCapBase:()=>100000,orders:()=>[],netEquityOf:()=>({low:100000}),...(lend?{lendReads:lend}:{})});}
const value={quotes:[{symbol:'990010',price:1200},{symbol:'990020',price:800},{symbol:'AAPL:US',price:1}],balance:{environment:'live',holdings:[],reportedTotal:100000,shorts:[LOT]}};
test('the facts while shorts are on: the loan rule, fee per day, shortfall, cap used and left, lending answers; none with shorts off',()=>{
  const at=Date.parse('2026-11-24T01:00:00Z');
  // Allowed, but the paths cannot be sent (today): none of the facts.
  const closed=engine(POLICY).productRisk(value).productRisk.credit;for(const k of ['coverBeforeDays','shortfall','capUsedPct','capLeftPct','candidates'])assert.equal(k in closed.short,false,k);assert.equal('feePerDay' in closed.shorts[0],false);
  withPathsOpen(()=>{const c=engine(POLICY,{lend:new Map([['990010',{borrowable:true,at}]])}).productRisk(value).productRisk.credit;
  assert.equal(c.short.coverBeforeDays,5);assert.deepEqual(c.short.shortfall,{amountKRW:2000,known:true,rows:[{symbol:'990010',loanDate:'2026-09-03',amountKRW:2000}]});
  assert.equal(c.short.capUsedPct,12);assert.equal(c.short.capLeftPct,8,'12,000 of 100,000 against 20%');
  assert.equal(c.shorts[0].feePerDay,Math.round(10000*5/100/365));
  assert.deepEqual(c.short.candidates,[{symbol:'990010',borrowable:true,readAt:new Date(at).toISOString()},{symbol:'990020',borrowable:null,readAt:null}],'not read: null; U.S. symbols left out');
  // Shorts off (a short held by hand): the context exactly as before B3e.
  const off=engine({...POLICY,short:{...POLICY.short,enabled:false}}).productRisk(value).productRisk.credit;
  for(const k of ['coverBeforeDays','shortfall','capUsedPct','capLeftPct','candidates'])assert.equal(k in off.short,false,k);assert.equal('feePerDay' in off.shorts[0],false);
  // An unreadable cap amount: null, not a guess.
  const bad=engine(POLICY).productRisk({...value,balance:{...value.balance,shorts:[{...LOT,loanAmount:null}]}}).productRisk.credit.short;assert.equal(bad.capUsedPct,null);assert.equal(bad.capLeftPct,null);
  // capUsedPct is the cap check's own count: an open short order the app made, and one made outside the app as the send's
  // check sees it (a pending row with credit 'short' and yours), through exposure.shortWaiting.
  // Your open short in KIS comes from the stored order history (KIS names it 유대신규); a cash sale, a cover and a row with
  // no kind name are not shorts; a row the app sent is not yours; a finished or cancelled row is not open.
  const E=require('../electron/exposure.cjs');const w=engine(POLICY);w.openShortOrders=()=>[{notional:3000}];w.pendingOrders=()=>[];
  const row=(orderId,extra)=>({day:'2026-11-24',orderId,symbol:'990010',side:'Sell',quantity:2,remaining:2,orderPrice:1000,status:'Pending',timestamp:Date.parse('2026-11-24T01:00:00Z'),...extra});
  w.historyRange=()=>[row('11',{creditName:'유대신규'}),row('12',{creditName:'현금매도'}),row('13',{}),row('14',{side:'Buy',creditName:'유대상환'}),row('15',{creditName:'유대신규',remaining:0,status:'Filled'}),row('16',{creditName:'유대신규',status:'Canceled'})];
  assert.deepEqual(w.outsideOpenShorts().map(o=>[o.symbol,o.credit,o.notional,o.yours]),[['990010','short',2000,true]]);
  assert.equal(w.productRisk(value).productRisk.credit.short.capUsedPct,17,'12,000 + 3,000 (the app) + 2,000 (yours in KIS) of 100,000');
  assert.deepEqual(E.shortWaiting({openShorts:[{notional:3000}],pending:[{credit:'short',notional:2000,yours:true},{credit:'short',notional:9999}],lagging:[{notional:1}]}),[{notional:3000},{notional:2000},{notional:1}]);
  });
});
test('the lending answer is noted from a short\'s preparation only: borrowable, not lendable or too few; any other refusal notes nothing',()=>{
  const e=engine();const short={symbol:'990010',credit:{kind:'short'}};e.noteLend(short,{},null);assert.equal(e.lendReads.get('990010').borrowable,true);
  e.noteLend(short,null,new Error('SHORT_NOT_LENDABLE'));assert.equal(e.lendReads.get('990010').borrowable,false);
  e.noteLend({symbol:'990020',credit:{kind:'short'}},null,new Error('SHORT_BORROW_SHORT'));assert.equal(e.lendReads.get('990020').borrowable,false);
  e.noteLend({symbol:'990030',credit:{kind:'short'}},null,new Error('BROKER_UNAVAILABLE'));e.noteLend({symbol:'990040'},{},null);assert.equal(e.lendReads.has('990030'),false);assert.equal(e.lendReads.has('990040'),false);
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.match(src,/\.then\(p=>\{this\.noteLend\(order,p,null\);return p;\},error=>\{this\.noteLend\(order,null,error\);throw error;\}\)/);
});
test('coverStop: armed with its level, unprotected with the cause, null when none; nothing with shorts off',()=>{
  const {Automation}=require('../electron/automation.cjs');const ctx=()=>({environment:'kis',productRisk:{credit:{shorts:[{symbol:'990010',loanDate:'2026-09-03'},{symbol:'990020',loanDate:'2026-09-04'},{symbol:'990030',loanDate:'2026-09-05'}]}}});
  const a=Object.assign(Object.create(Automation.prototype),{shortFactsInForce:()=>true,unprotectedNow:()=>[{symbol:'990020',short:true,loanDate:'2026-09-04',cause:'rejected',outcome:'its cover stop was rejected'},{symbol:'990010',loanDate:'2026-09-03'}],
    desk:{lotStops:(scope,symbol)=>symbol==='990010'?[{status:'armed',conditions:[{expr:'price("990010")',op:'>=',value:1150}]}]:[{status:'submitted'}]}});
  const c=ctx();a.coverStopFacts(c,'s');assert.deepEqual(c.productRisk.credit.shorts.map(s=>s.coverStop),[{state:'armed',level:1150},{state:'unprotected',cause:'its cover stop was rejected'},null]);
  const combined={environment:'kis-combined',markets:[{market:'US'},{market:'KR',...ctx()}]};a.coverStopFacts(combined,'s');assert.equal(combined.markets[1].productRisk.credit.shorts[0].coverStop.state,'armed');
  a.unprotectedNow=()=>[{symbol:'990010',short:true,loanDate:'2026-09-03',held:true,waiting:'your approval of its cover'}];const h=ctx();a.coverStopFacts(h,'s');assert.deepEqual(h.productRisk.credit.shorts[0].coverStop,{state:'unprotected',cause:'held: your approval of its cover'});
  a.shortFactsInForce=()=>false;const o=ctx();a.coverStopFacts(o,'s');assert.deepEqual(o,ctx());
});
// A covered short's row reaches a review (lessons, position memory) only while shorts are enabled.
const DAY=86400000,T=Date.parse('2026-11-20T01:00:00Z');
const fill=(id,side,effect,at,extra={})=>({id:'broker:'+id,orderId:id,reviewId:'R-'+id,source:'broker',accountKey:'acct',environment:'live',market:'KR',currency:'KRW',symbol:'990010',side,effect,status:'Filled',quantity:10,requested:10,averagePrice:1000,timestamp:at,decision:{action:side,explanation:id},...extra});
const shortSale=fill('S1','Sell','OPEN_SHORT',T-5*DAY,{credit:{kind:'short'}}),cover=fill('C1','Buy','CLOSE_SHORT',T,{credit:{kind:'cover',loanDate:'2026-11-17'},gainAfterFees:-2300,shortProceeds:10000,shortCosts:{saleCharges:30,coverCharges:20,interest:{amount:7,basis:'estimate',pct:5,days:3},beforeCharges:-2000}});
function lessons(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT)');
  for(const o of [shortSale,cover])db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run(o.id,JSON.stringify(o));return {db,memory:new (require('../electron/learning-memory.cjs').LearningMemory)(db)};}
test('with shorts off a cover makes no lesson and no memory row; with shorts on both reach the review, worded as a cover',()=>{
  const {db,memory}=lessons();memory.sync();assert.equal(db.prepare("SELECT count(*) AS n FROM lessons WHERE id LIKE 'outcome:%'").get().n,0,'off: no cover lesson');
  memory.sync({covers:true});const id='outcome:'+cover.id;const row=db.prepare('SELECT text FROM lessons WHERE id=?').get(id);assert.match(row.text,/10 shares bought back to cover a short; after-fee result -2300 KRW against the short sale's proceeds of 10000, borrow interest 7 \(estimated\) included\./);assert.doesNotMatch(row.text,/object Object/,'the interest is a figure, not its record');
  const e=memory.describe(id);assert.equal(e.effect,'CLOSE_SHORT');assert.deepEqual(e.episode.entries.map(x=>x.decisionId),['R-S1'],'its short sale');
  // A cover's assessment is not eligible (outcome-evaluation, B3d-3): its lesson cannot be approved, so it reaches no review
  // by approval today. The gate is shown with the lesson marked approved directly.
  assert.throws(()=>memory.review(id,{action:'approve',expectedSignature:memory.lifecycle(id).signature}),/OUTCOME_NOT_FINAL/);
  memory.saveLifecycle(id,{...memory.lifecycle(id),status:'approved',approvedAt:T,expiresAt:Date.now()+30*DAY});db.prepare('UPDATE lessons SET approved=1 WHERE id=?').run(id);const context={environment:'kis',universe:[{symbol:'990010'}],positions:{}};
  assert.equal(memory.relevantLessons(context,['acct']).length,0,'approved, but shorts off: not given');assert.equal(memory.relevantLessons(context,['acct'],{covers:true}).length,1,'shorts on: given');
  const PM=require('../electron/position-memory.cjs');const opts={accounts:['acct'],positions:{},reviewAt:new Map(),now:T+DAY};
  assert.deepEqual(PM.build([shortSale,cover],opts),[],'off: no memory row');assert.equal(PM.build([shortSale,cover],{...opts,shorts:true})[0].lastExit.decisionId,'R-C1');
  // The review's assembly passes the switch to every reader.
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(src,/const shorts=this\.shortFactsInForce\(\);this\.outcomes\.sync\(\);this\.memory\.sync\(\{covers:shorts\}\);[^\n]*this\.memory\.relevantLessons\(context,accounts,\{covers:shorts\}\)/);
  assert.match(src,/reviewsSince:\(symbol,t\)=>since\?since\.get\(tag,t\)\.n:null,shorts\}\)/);assert.match(src,/this\.memory\.sync\(\{covers:this\.shortFactsInForce\(\)\}\);this\.reflections\.sync\(\)/);
  // The scorecard reads eligible sales only: a cover never.
  assert.equal(require('../electron/outcome-evaluation.cjs').evaluate(cover).eligible,false);
});
test('the dry-run gate follows the instructions the scope\'s context gets: Korea, both, U.S. only and paper, shorts in force or not',()=>{
  const M=require('../electron/ai-models.cjs');M.setClaudeTradingForTests(true);try{
    const kr=open=>({products:[],warnings:[],credit:{effective:PATHS(open),short:{allowed:true}}});
    const contexts={kis:open=>({environment:'kis',universe:[],positions:{},productRisk:kr(open)}),both:open=>({environment:'kis-combined',universe:[],positions:{},markets:[{market:'KR',productRisk:kr(open)},{market:'US'}]}),
      us:()=>({environment:'kis',market:'US',universe:[],positions:{}}),paper:()=>({environment:'local-paper',universe:[],positions:{}})};
    for(const scope of ['kis','both','us','paper'])for(const inForce of [false,true]){const a=harness();a.configure({scope});a.shortFactsInForce=()=>inForce;
      const want=RI.record(contexts[scope](inForce)).fingerprint,other=want==='e36e408915854800'?'67577dc81443657e':'e36e408915854800';
      a.completedClaudeDryRun=()=>record(want);assert.ok(a.claudeTradingDryRun(),`${scope}, in force ${inForce}: the dry run under the context's own text counts`);
      a.completedClaudeDryRun=()=>record(other);assert.equal(a.claudeTradingDryRun(),null,`${scope}, in force ${inForce}: another text does not`);
      assert.equal(want,inForce&&['kis','both'].includes(scope)?'67577dc81443657e':'e36e408915854800',`${scope} ${inForce}`);}
  }finally{M.setClaudeTradingForTests(false);}
});
test('the review step itself: a Korean review\'s context carries each short\'s coverStop while the facts are in force, and none otherwise',async()=>{
  const a=harness();const short={symbol:'990010',quantity:10,entryPrice:1000,price:1200,adversePct:20,loanDate:'2026-09-03',daysToRepay:20,estimatedFee:96};
  const ctx=()=>({environment:'kis',market:'KR',currency:'KRW',equity:1000000,cash:500000,universe:[],positions:{},quotes:[],orders:[],marketSession:{open:true},risk:{},executionEnabled:true,automaticExecutionEnabled:true,productRisk:{products:[],warnings:[],credit:{effective:PATHS(true),short:{allowed:true},shorts:[{...short}]}}});
  a.live={market:'KR',identity:()=>'acct',context:async()=>ctx(),orders:()=>[],getState:()=>({})};a.reconcileOpenOrders=async()=>{};a.unprotectedNow=()=>[];
  a.desk.lotStops=(scope,symbol,loanDate)=>symbol==='990010'&&loanDate==='2026-09-03'?[{status:'armed',conditions:[{expr:'price("990010")',op:'>=',value:1150}]}]:[];
  a.shortFactsInForce=()=>true;let {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'});
  assert.deepEqual(context.productRisk.credit.shorts[0].coverStop,{state:'armed',level:1150});
  a.shortFactsInForce=()=>false;({context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'}));assert.equal('coverStop' in context.productRisk.credit.shorts[0],false,'not in force: as before');
});
test('automatic, as the text names it, is what happens: the setting AND the path\'s own automatic (an opening is proposed until then)',()=>{
  const CP=require('../electron/credit-paths.cjs'),was=CP.pathStatus;const auto={...POLICY,short:{...POLICY.short,auto:true}};
  withPathsOpen(()=>{
    assert.equal(engine(auto).productRisk(value).productRisk.credit.short.automatic,false,'paths open, the opening not automatic: proposed');
    CP.pathStatus=(k,o)=>k==='short'?{executable:true,automatic:true}:was(k,o);try{
      assert.equal(engine(auto).productRisk(value).productRisk.credit.short.automatic,true,'setting on and the path automatic: sent by itself');
      assert.equal(engine(POLICY).productRisk(value).productRisk.credit.short.automatic,false,'setting off: proposed');}finally{CP.pathStatus=was;}});
  assert.equal(engine(auto).productRisk(value).productRisk.credit.short.automatic,true,'paths closed: the field as before B3e (the setting), the text not sent');
});
test('the send\'s check counts your open short in KIS the same way: the open-order guard keeps KIS\'s kind name, pendingOrders marks it a short, and the cap counts it',()=>{
  const {openGuard}=require('../electron/broker-open-orders.cjs');const E=require('../electron/exposure.cjs');
  const kis=[{orderId:'0021',symbol:'990020',side:'Sell',quantity:3,remaining:3,orderPrice:1000,status:'Pending',creditName:'유대신규'},{orderId:'0022',symbol:'990030',side:'Sell',quantity:1,remaining:1,orderPrice:500,status:'Pending',creditName:'현금매도'},{orderId:'0023',symbol:'990040',side:'Sell',quantity:1,remaining:1,orderPrice:700,status:'Pending'}];
  const prepared=openGuard(kis,{symbol:'990010'},{severalOpen:true,fail:()=>new Error('X')});assert.equal(prepared.openOrders[0].creditName,'유대신규');assert.equal('creditName' in prepared.openOrders[2],false);
  const e=Object.assign(Object.create(LiveEngine.prototype),{severalOpenFixed:true,db:{prepare:()=>{throw new Error('no table');}},orders:()=>[]});
  const pending=e.pendingOrders({id:'NEW'},prepared);assert.deepEqual(pending.map(o=>[o.symbol,o.credit,o.notional]),[['990020','short',3000],['990030',null,500],['990040',null,700]],'a row with no kind name is not a short (as today)');
  assert.deepEqual(E.shortWaiting({pending,lagging:[]}),[{notional:3000}],'at the send (no openShorts): yours counted');assert.deepEqual(E.shortWaiting({openShorts:[],pending,lagging:[]}),[{notional:3000}],'at the proposal: yours counted');
  // The cap refuses on it: 12,000 open + 3,000 yours + 6,000 new = 21% of 100,000 against 20%.
  const ex=new E.Exposure(new DatabaseSync(':memory:'));ex.savePolicy('a',{short:{enabled:true,auto:true,maxGrossPctOfEquity:20}});
  assert.throws(()=>ex.checkCredit({account:'a',kind:'short',symbol:'990010',notional:6000,equity:100000,balance:{shorts:[{loanAmount:12000}]},pending,lagging:[]}),/SHORT_LIMIT/);
  assert.equal(ex.checkCredit({account:'a',kind:'short',symbol:'990010',notional:5000,equity:100000,balance:{shorts:[{loanAmount:12000}]},pending,lagging:[]}).type!=null,true,'20%: allowed');
});
test('a half-filled outside short counts its open remainder only (its filled part is in the balance); a fully filled one counts nothing; a cash order keeps its full quantity',()=>{
  const row=(extra)=>({day:'2026-11-24',orderId:'31',symbol:'990020',side:'Sell',quantity:4,remaining:2,orderPrice:1000,status:'Partially filled',timestamp:Date.parse('2026-11-24T01:00:00Z'),creditName:'유대신규',...extra});
  // 100,000 of value: the app's lot of 990010 (5,000 of obligation) and the filled half of yours (2,000) in the balance.
  const bal={...value.balance,shorts:[{...LOT,loanAmount:5000},{symbol:'990020',quantity:2,price:1000,entryPrice:1000,proceeds:2000,loanAmount:2000,loanDate:'2026-11-26'}]};
  withPathsOpen(()=>{const w=engine(POLICY);w.openShortOrders=()=>[];w.pendingOrders=()=>[];
    w.historyRange=()=>[row({})];assert.deepEqual(w.outsideOpenShorts().map(o=>[o.quantity,o.notional]),[[2,2000]],'the open remainder');
    assert.equal(w.productRisk({...value,balance:bal}).productRisk.credit.short.capUsedPct,9,'5,000 + 2,000 filled (balance) + 2,000 open = 9%, not 11%');
    w.historyRange=()=>[row({remaining:0,status:'Filled'})];assert.deepEqual(w.outsideOpenShorts(),[]);assert.equal(w.productRisk({...value,balance:bal}).productRisk.credit.short.capUsedPct,7,'fully filled: the balance only');});
  // At the send: the same remainder; a cash sale of yours keeps its full ordered quantity (M-1.4 F2, unchanged).
  const {openGuard}=require('../electron/broker-open-orders.cjs');const prepared=openGuard([{orderId:'0031',symbol:'990020',side:'Sell',quantity:4,remaining:2,orderPrice:1000,status:'Partially filled',creditName:'유대신규'},{orderId:'0032',symbol:'990030',side:'Sell',quantity:4,remaining:2,orderPrice:500,status:'Partially filled',creditName:'현금매도'}],{symbol:'990010'},{severalOpen:true,fail:()=>new Error('X')});
  const e=Object.assign(Object.create(LiveEngine.prototype),{severalOpenFixed:true,db:{prepare:()=>{throw new Error('no table');}},orders:()=>[]});
  assert.deepEqual(e.pendingOrders({id:'NEW'},prepared).map(o=>[o.credit,o.quantity,o.notional]),[['short',2,2000],[null,4,2000]]);
});
