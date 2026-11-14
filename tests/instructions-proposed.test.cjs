// The proposed built-in text (instruction rewrite step 3, artifacts/reviews/2026-11-13-instruction-rewrite: draft-2.md
// with the rulings in review.md; tests of design.md section 7). The current text stays what every live review sends;
// the proposed set is sent only by the replay's "Built-in text: proposed".
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const RI=require('../electron/review-instructions.cjs');const C=require('../electron/ai-client.cjs');const A=require('../electron/anthropic-client.cjs');
const src=f=>fs.readFileSync(path.join(__dirname,'..','electron',f),'utf8');
const ids=RI.REVIEW_PARTS.map(p=>p.id);
const subsets=list=>list.reduce((all,id)=>all.flatMap(s=>[s,[...s,id]]),[[]]);
const ALL=subsets(ids);
const HEADINGS={'two-markets':'TWO MARKETS',extended:'EXTENDED SESSIONS',leveraged:'LEVERAGED AND INVERSE PRODUCTS',credit:'CREDIT',discovery:'DISCOVERY','scout-plan':'THE SCOUT PLAN','scout-brief':'THE SCOUT BRIEF',interval:'REVIEW INTERVAL',conditional:'CONDITIONAL ORDERS',desk:'DESK TOOLS'};

test('every one of the 1,024 part sets assembles: the core, then exactly those parts in the fixed order',()=>{
  assert.equal(ALL.length,1024);assert.deepEqual(RI.PROPOSED_REVIEW_PARTS.map(p=>p.id),ids,'same ids and order as the current set');
  for(const p of RI.PROPOSED_REVIEW_PARTS){assert.ok(p.text.startsWith(HEADINGS[p.id]+'\n'),p.id);assert.equal(p.when,RI.REVIEW_PARTS.find(q=>q.id===p.id).when,'same condition');}
  const lines=t=>t.split('\n');
  for(const s of ALL){
    const text=RI.setReviewText(s,'proposed');
    assert.equal(text,[RI.PROPOSED_REVIEW_CORE,...ids.filter(id=>s.includes(id)).map(id=>RI.PROPOSED_REVIEW_PARTS.find(p=>p.id===id).text)].join('\n\n'));
    for(const id of ids)assert.equal(lines(text).filter(l=>l===HEADINGS[id]).length,s.includes(id)?1:0,`${id} in ${s.join(',')}`);
    const b=RI.reviewBlocks(s,'proposed');assert.equal(b.core,RI.PROPOSED_REVIEW_CORE);assert.equal(b.parts?`${b.core}\n\n${b.parts}`:b.core,text);
  }
  for(const s of subsets(RI.SCOUT_PARTS.map(p=>p.id)))assert.equal(RI.setScoutText(s,'proposed'),s.length?`${RI.PROPOSED_SCOUT_CORE}\n\nLEVERAGED AND INVERSE ETFS\n${RI.PROPOSED_SCOUT_PARTS[0].text.split('\n')[1]}`:RI.PROPOSED_SCOUT_CORE);
  // The current set is untouched: every set gives the current core, and Claude gets no parts block.
  for(const s of ALL){assert.equal(RI.setReviewText(s),RI.REVIEW_CORE);assert.deepEqual(RI.reviewBlocks(s),{core:RI.REVIEW_CORE,parts:''});}
  assert.throws(()=>RI.setReviewText([],'other'),/INVALID_INSTRUCTION_SET/);assert.throws(()=>RI.setReviewText(['nope'],'proposed'),/INVALID_INSTRUCTION_PARTS/);
});

test('versions: the current pin is unchanged; the proposed set has its own version and fingerprint',()=>{
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-13');assert.equal(RI.fingerprint(),'d50342a570a47586');assert.equal(RI.fingerprint('current'),'d50342a570a47586');
  assert.equal(RI.PROPOSED_VERSION,'proposed 2026-11-14');assert.equal(RI.fingerprint('proposed'),'83ab4d1b1e9de0ec');
  assert.deepEqual(C.instructions(),{version:'review 2026-11-13',fingerprint:'d50342a570a47586'});
  assert.deepEqual(C.instructions({environment:'kis-combined',extendedSessions:[],agentDesk:{}}),{version:'review 2026-11-13',fingerprint:'d50342a570a47586',parts:['two-markets','desk']},'the review record keeps the parts');
  assert.deepEqual(RI.scoutRecord({products:{leveragedOrInverseEtps:{allowed:true}}}),{version:'scout 2026-11-13',parts:['leveraged']});
  assert.match(src('automation.cjs'),/scoutStore\.save\(scope,plan,\{runId:id,trigger,focus:focus\.markets,instructions:require\('\.\/review-instructions\.cjs'\)\.scoutRecord\(context\)/,'each plan record keeps the scout version');
});

// Each app rule: a phrase every proposed text carries, and the code that enforces it. A rule removed from the text or
// from the code fails here.
const buy={action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'x'};
const RULES=[
  ['A trade\'s quantity is 1 to 1,000 shares; a Hold\'s is 0.',()=>{
    assert.doesNotThrow(()=>C.validateDecision({...buy,quantity:1000},['005930']));
    assert.throws(()=>C.validateDecision({...buy,quantity:1001},['005930']),e=>/1 to 1,000/.test(e.detail.rule));
    assert.throws(()=>C.validateDecision({...buy,action:'Hold',symbol:'',quantity:1},[]),e=>/Hold with a quantity/.test(e.detail.rule));}],
  ['A Buy or short sale is held back without a horizon, thesis, invalidation, stopPrice, horizonDays from 1 to 3,650, portfolioImpact and at least one sourced evidence item',()=>{
    assert.ok(C.validateDecision(buy,['005930'],{requirePlan:true}).withheld,'a Buy without a plan');
    assert.ok(C.validateDecision({...buy,action:'Sell',credit:'short'},['005930'],{requirePlan:true}).withheld,'a short sale without a plan');}],
  ['A cover is not held back for its plan.',()=>{assert.equal(C.validateDecision({...buy,credit:'cover',loanDate:'2026-11-01'},['005930'],{requirePlan:true}).withheld,undefined);}],
  ['An opening on an axis the account does not permit is held back.',()=>{
    assert.equal(typeof require('../electron/strategy-axes.cjs').gap,'function');assert.match(src('ai-client.cjs'),/const denied=requirePlan&&context&&axes&&!decision\.withheld\?SA\.gap\(/);}],
  ['An opening within 30 days of a filled exit without a complete reversal is held back. A reduction is never held back for it.',()=>{
    const PM=require('../electron/position-memory.cjs');assert.equal(PM.REVERSAL_DAYS,30);
    assert.match(src('ai-client.cjs'),/if\(gap&&rev\.required&&requirePlan\)decision=\{action:'Hold'/,'withheld only when required (an opening)');}],
  ['A symbol outside the review universe cannot be traded.',()=>{assert.throws(()=>C.validateDecision(buy,['000660']),e=>/outside this review's tradable list/.test(e.detail.rule));}],
  ['Every order, including a conditional order when it fires, passes the app\'s risk checks.',()=>{
    assert.match(src('agent-desk.cjs')+src('automation.cjs'),/risk/i);assert.ok(fs.existsSync(path.join(__dirname,'portfolio-risk.test.cjs')));}],
  ['The daily loss threshold starts an emergency review; it does not prohibit orders.',()=>{assert.match(src('automation.cjs'),/emergency/);}],
  ['cancelIf: cancels the order when any of at most 5 price conditions is met',()=>{
    const cond={expr:'price',op:'<',value:1};const d=C.validateDecision({...buy,execution:{cancelIf:Array(6).fill(cond)}},['005930']);
    assert.ok(d.execution.invalid.some(x=>/at most 5/.test(x)));}],
  ['An execution the app cannot read withholds the order.',()=>{assert.match(src('automation.cjs'),/Execution withheld: /);}],
  ['Repay with "margin-sell" (Sell) or "cover" (Buy)',()=>{assert.throws(()=>C.validateDecision({...buy,action:'Sell',credit:'cover',loanDate:'2026-11-01'},['005930']),e=>/credit cover with the action Sell/.test(e.detail.rule));},'credit'],
];
test('each app rule is stated in every text that applies and is enforced by the code',()=>{
  for(const [phrase,check,part] of RULES){
    for(const s of ALL){if(part&&!s.includes(part))continue;assert.ok(RI.setReviewText(s,'proposed').includes(phrase),`"${phrase.slice(0,50)}" in ${s.join(',')||'core'}`);}
    check();
  }
});

test('no setting value is written into the text',()=>{
  const v=7.31;const ctx={environment:'kis-combined',extendedSessions:['U.S. pre-market'],reviewInterval:{auto:true,minutes:v},discovery:{enabled:true},scoutPlan:{targets:[{symbol:'x',targetWeightPct:v}]},scoutBrief:{},
    agentDesk:{conditionalOrders:{allowed:true,maxOrderPctOfEquity:v}},productRisk:{leveragedEtps:{allowed:true,maxPctOfEquity:v,maxHoldingDays:v},credit:{margin:{allowed:true,maxPctOfEquity:v}}},positionSizing:{riskPct:v}};
  const text=RI.setReviewText(RI.partsFor(ctx),'proposed');assert.equal(RI.partsFor(ctx).length,10);assert.ok(!text.includes('7.31'));
  assert.ok(!RI.setScoutText(['leveraged'],'proposed').includes('7.31'));
});

test('every figure the text states equals the code',()=>{
  const all=RI.setReviewText(ids,'proposed'),scout=RI.setScoutText(['leveraged'],'proposed');const has=(t,s)=>assert.ok(t.includes(s),s);
  has(all,'within 30 days');assert.equal(require('../electron/position-memory.cjs').REVERSAL_DAYS,30);
  has(all,'1 to 3,650');assert.match(src('ai-client.cjs'),/const MAX_HORIZON_DAYS=3650;/);
  has(all,'1 to 1,000 shares');
  const RR=require('../electron/research-review.cjs');has(all,'at most three research rounds of up to four tool requests');assert.equal(RR.ROUNDS-1,3,'three research rounds and the answer');assert.equal(RR.MAX_CALLS,4);
  has(all,'1 to 60 minutes');assert.match(src('review-interval.cjs'),/value\.minutes<1\|\|value\.minutes>60/);
  has(all,'a shorter interval lasts an hour');assert.equal(require('../electron/review-interval.cjs').SHORT_FOR_MS,3600000);
  has(all,'Every 3 seconds');assert.match(src('automation.cjs'),/Date\.now\(\)-\(this\.lastTrack\?\?0\)>=3000/);
  has(all,'changed by 0.2% or more');assert.equal(require('../electron/order-pricing.cjs').REVISE_PCT,0.2);
  has(all,'at most 5 price conditions');
  has(scout,'two research rounds of at most six tool requests each (12 in total)');assert.match(src('scout.cjs'),/maxRounds=3,maxCalls=6/);assert.match(src('scout.cjs'),/final:round===maxRounds-1/,'the last round answers');
  has(scout,'within 30 minutes of their regular open or close');assert.match(src('scout.cjs'),/regular session \(30-minute grace\)/);
  has(scout,'up to three such reads per run');assert.match(src('scout.cjs'),/const NEXT_SESSION_READS=3,/);
  has(scout,'beyond the first 15 rows');assert.match(src('research-service.cjs'),/rows\.length>15\?\{moreHoldings:rows\.slice\(15\)/);
});

const fullCtx=extra=>({environment:'kis-combined',extendedSessions:['U.S. pre-market'],universe:[{symbol:'005930'}],positions:{},discovery:{enabled:true,watchlist:[]},agentDesk:{conditionalOrders:{allowed:true}},reviewInterval:{auto:true},
  scoutPlan:{targets:[{symbol:'005930'}]},scoutBrief:{runAllowed:true},productRisk:{leveragedEtps:{allowed:true},credit:{margin:{allowed:true}}},...extra});
test('the proposed text stays the same from review to review',()=>{
  const a=fullCtx({quotes:[{symbol:'005930',price:217000}],news:[{title:'a'}],triggerEvidence:{kind:'news'},reviewScope:{kind:'routine'}});
  const b=fullCtx({quotes:[{symbol:'005930',price:199000}],news:[{title:'b'}],triggerEvidence:{kind:'watchlist'},reviewScope:{kind:'broad'},marketSession:{open:false}});
  assert.equal(RI.setReviewText(RI.partsFor(a),'proposed'),RI.setReviewText(RI.partsFor(b),'proposed'));
  assert.deepEqual(RI.partsFor(require('../electron/token-saver.cjs').compact(a)),RI.partsFor(a),'the compacted context the provider receives gives the same parts');
});

test('every round of one review sends the same proposed text; Claude gets the core and the parts as two blocks',async()=>{
  const ctx=fullCtx({});const want=RI.setReviewText(RI.partsFor(ctx),'proposed');
  const sent=[];const openai=new C.AiClient('k'.repeat(20),async(url,init)=>{sent.push(JSON.parse(init.body));return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  const continuation=[{role:'user',content:JSON.stringify(ctx)},{type:'function_call',name:'get_context_detail',call_id:'c1',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:'{}'}];
  for(const options of [{research:true},{research:true,continuation},{research:true,final:true,continuation}])try{await openai.decide(ctx,{...options,instructionSet:'proposed'});}catch{}
  assert.equal(sent.length,3);for(const b of sent)assert.equal(b.instructions,want);
  try{await openai.decide(ctx,{research:true});}catch{}assert.equal(sent.at(-1).instructions,RI.REVIEW_CORE,'without the option: the current text');
  const bodies=[];const fetch=async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'x'}}),{status:400,headers:{'content-type':'application/json'}});};
  const claude=new A.AnthropicClient('sk-ant-api03-'+'k'.repeat(40),fetch);
  for(const options of [{research:true},{research:true,final:true}])try{await claude.decide(ctx,{openaiModel:'claude-opus-5-5',reasoningEffort:'medium',...options,instructionSet:'proposed'});}catch{}
  assert.ok(bodies.length>=2);const blocks=RI.reviewBlocks(RI.partsFor(ctx),'proposed');
  for(const b of bodies){assert.equal(b.system.length,3);assert.equal(b.system[0].text,blocks.core);assert.deepEqual(b.system[0].cache_control,{type:'ephemeral'});
    assert.equal(b.system[1].text,blocks.parts);assert.equal(b.system[1].cache_control,undefined);assert.deepEqual(b.system[2].cache_control,{type:'ephemeral'});}
  assert.equal(JSON.stringify(bodies[0].system),JSON.stringify(bodies.at(-1).system),'the same system blocks in every round');
  // The current set on Claude: the two blocks it had, with no new breakpoint.
  const n=bodies.length;try{await claude.decide(ctx,{openaiModel:'claude-opus-5-5',reasoningEffort:'medium',research:true});}catch{}
  const cur=bodies.slice(n);assert.ok(cur.length);for(const b of cur){assert.equal(b.system.length,2);assert.equal(b.system[0].text,RI.REVIEW_CORE);assert.equal(b.system[0].cache_control,undefined);}
});

test('size bounds computed with the current text hold for the proposed one',()=>{
  const bytes=t=>Buffer.byteLength(JSON.stringify(t));
  for(const s of [ids,[]])assert.ok(bytes(RI.setReviewText(s,'proposed'))<bytes(RI.REVIEW_ALL),'the proposed review text is shorter than the current');
  for(const s of [['leveraged'],[]])assert.ok(C.scoutOverheadBytes()>=bytes(RI.setScoutText(s,'proposed')),'the scout overhead bound covers the proposed scout text');
  // The Claude answer form does not depend on the text: the flat form counts stay 51/50/50/49 (claude-enforced pins them).
});

test('the replay runs the proposed text on the change side only, fills a missing extendedSessions and records each side\'s text',async()=>{
  const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));const calls=[];
  const provider={request:async(op,payload)=>{calls.push(payload);return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:10,outputTokens:2},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.series={closes:()=>[],ensure:async()=>{}};a.indexCloses=()=>({});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',guidelines:'Grow.',sessionKrNxt:true});
  await a.review();const reviewId=a.getState().reviews[0].id;
  // A context saved before the field existed.
  const saved=a.replays.context(reviewId);delete saved.extendedSessions;a.replays.saveContext(reviewId,saved);
  let before=calls.length;let run=await a.replay({proposedText:true,limit:3});
  const [base,variant]=calls.slice(before);assert.equal(base.options.instructionSet,undefined,'the baseline keeps the current text');assert.equal(variant.options.instructionSet,'proposed');
  assert.deepEqual(base.context.extendedSessions,['Nextrade pre- and after-market']);assert.deepEqual(variant.context.extendedSessions,base.context.extendedSessions,'filled from the current settings on both sides');
  assert.deepEqual(variant.context.userGuidelines,'Grow.','the text is the only change');
  const row=run.rows[0];assert.deepEqual(row.filled,['extendedSessions']);
  assert.equal(row.instructions.baseline.version,'review 2026-11-13');assert.equal(row.instructions.variant.version,'proposed 2026-11-14');assert.ok(row.instructions.variant.parts.includes('extended'));
  assert.equal(run.variant.proposedText,true);
  // Without the option nothing is filled and both sides keep the current text.
  before=calls.length;run=await a.replay({instructions:'Be brief.',limit:3});const [b2,v2]=calls.slice(before);
  assert.equal(b2.options.instructionSet,undefined);assert.equal(v2.options.instructionSet,undefined);assert.equal(b2.context.extendedSessions,undefined);assert.equal(run.rows[0].filled,undefined);
  assert.equal(run.rows[0].instructions.variant.version,'review 2026-11-13');
  // The live review record keeps its parts.
  const rec=JSON.parse(db.prepare('SELECT payload FROM reviews').get().payload);assert.deepEqual(rec.instructions.parts,RI.partsFor(calls[0].context));
});
