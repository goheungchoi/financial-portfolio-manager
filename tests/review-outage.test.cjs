const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
// 2026-10-30 09:00-09:30 KST: every review failed at about 71-72 KB against the 70,000-byte limit because the sections
// added the day before (assessments, waits, pending decisions, review scope) could not be shortened, and a price
// trigger rebuilt and failed the review every 1-2 minutes. The fixture below is made up: it only copies the size of each
// section of a real context (no real content), with Korean text where the app has it.
const rc=require('../electron/review-context.cjs');const cf=require('../electron/context-fit.cjs');
const LIMIT=require('../electron/ai-models.cjs').reviewByteLimit({});
const SIZES={objective:700,userGuidelines:4306,reviewedLessons:1077,discovery:2137,reviewInterval:273,reviewWatches:1318,decisionScoreboard:300,macro:1926,tradingCosts:9417,
  risk:253,markets:975,news:1745,topStories:212,emergency:375,performance:955,sectorLeads:2761,scoutPlan:3574,planGap:1118,scoutBrief:647,agentDesk:7360,marketNarrative:594,
  similarEpisodes:298,portfolioExposure:673,positionSizing:2111,marketRegime:619,eventCalendar:972,researchGaps:1163,previousReview:657};
const ko='삼성E&A 수주 잔고와 해외 플랜트 마진 ';// About n UTF-8 bytes of repeated text, cut at a character boundary.
const fill=(n,unit='x')=>{if(n<=0)return '';let s=unit.repeat(Math.ceil(n/Buffer.byteLength(unit)));while(Buffer.byteLength(s)>n)s=s.slice(0,-1);return s;};
const sized=(base,target,unit)=>{const have=rc.bytes(base);return have>=target?base:{...base,_more:fill(target-have-12,unit)};};
const symbols=n=>Array.from({length:n},(_,i)=>i%3===2?`NASD:T${String(i).padStart(3,'0')}`:String(100000+i));
function fixture({holdings=4,quoted=19,assessments=2,waits=6,thesis=500,evidence=4,extraAssess=0}={}){
  const syms=symbols(quoted),held=syms.slice(0,holdings);
  const c={environment:'kis-combined',currency:'MULTI',baseCurrency:'KRW',equity:1456626,cash:{KRW:414148,USD:0},fx:{usdKRW:1336.3},
    positions:Object.fromEntries(held.map(s=>[s,{quantity:3,costTotal:180900,currency:/:/.test(s)?'USD':'KRW',market:/:/.test(s)?'US':'KR'}])),
    quotes:syms.map(s=>({symbol:s,price:62400,retrievedAt:1793319000000,previousClose:62800,changePct:-0.64,volume:821505,timestamp:1793319000000,stale:false,market:/:/.test(s)?'US':'KR'})),
    universe:syms.map(s=>({symbol:s,name:/:/.test(s)?'Example Holdings':'삼성이앤에이',price:62400,market:/:/.test(s)?'US':'KR',sector:'산업재',region:'South Korea (listing)'})),
    marketSession:{open:true,status:'mixed'},triggerEvidence:{kind:'price',symbol:held[0],price:61900,baseline:63900,changePct:-3.13},
    orderFollowUp:{orders:[{symbol:held[0],side:'Sell',quantity:1,filled:0,status:'Accepted',price:61900,tracked:true}],note:'Orders placed but not filled.'}};
  // Sections the app keeps as lists are lists here too.
  const LISTS=['reviewWatches','news','topStories','similarEpisodes','eventCalendar','researchGaps','reviewedLessons'];
  for(const [k,n] of Object.entries(SIZES))c[k]=k==='userGuidelines'?fill(n,ko):k==='objective'?fill(n):LISTS.includes(k)?[{symbol:syms[0],title:fill(Math.max(10,n-60),k==='news'?ko:'x')}]:sized({},n,k==='agentDesk'?ko:'x');
  c.markets=[{market:'KR',equity:710548,cash:414148,marketSession:{open:true},executionEnabled:true,automaticExecutionEnabled:true},{market:'US',equity:558.51,cash:0,pendingSaleProceeds:279.01,marketSession:{open:false},executionEnabled:true,automaticExecutionEnabled:true}];
  c.risk={markets:{KR:{lossLimit:{mode:'percent',value:5},dayPeakEquity:710548}}};c.emergency={active:false,loss:{breached:false,lossPct:1.2}};
  c.agentDesk={notes:[{symbol:held[0],note:fill(3000,ko)}],conditionalOrders:{allowed:true,armed:[{id:'C-1',symbol:held[1],purpose:'stop_loss'}],unprotected:[{symbol:held[0],orderId:'C-9',quantity:1,coveredQuantity:0,temporary:false}],recent:[]}};
  c.scoutPlan={asOf:'2026-10-30',summary:fill(400,ko),focus:fill(200),targets:held.map(s=>({symbol:s,role:'hold',thesis:fill(300,ko)}))};
  c.positionSizing={rows:syms.map(s=>({symbol:s,maxShares:3,limitedBy:'cash',suggestedStop:99701.5,maxWeightPct:21.3,note:fill(40)}))};
  c.assessments=Array.from({length:assessments+extraAssess},(_,i)=>({symbol:syms[i%syms.length],updated:'2026-10-30T00:30:00Z',strategy:'long-term',horizon:'3 years',thesis:fill(thesis,ko),invalidation:fill(200,ko),
    evidence:Array.from({length:evidence},(_,k)=>({claim:fill(160,ko),sourceId:`dart:2026103000${i}${k}`,published:'2026-10-29',retrieved:'2026-10-30T09:00+09:00'})),assumptions:fill(300),unresolved:[fill(120,ko)],
    nextCatalyst:{event:'실적 발표',date:'2026-11-05'},refreshWhen:fill(120),stale:i%2?['valuation']:[],...(i%2?{staleBecause:['Price 63900 vs 61900 when assessed (-3.1%)']}:{}),...(i===0?{conflict:'DART backlog differs from the IR deck'}:{}),held:i<holdings}));
  c.waits=Array.from({length:waits},(_,i)=>({symbol:syms[i%syms.length],reason:i%2?'publication_pending':'missing_data',...(i%2?{}:{cause:'insufficient'}),question:fill(200,ko),resolvesOn:fill(120),earliestCheck:'2026-10-30T14:10+09:00',expires:'2026-11-01T00:00:00Z',since:'2026-10-29T00:00:00Z',reviews:4,holdsResearch:false}));
  c.pendingDecisions=[{symbol:held[holdings-1],action:'Sell',quantity:1,market:'US',since:'2026-10-29T13:27:39Z',reviews:2,rationale:fill(400,ko),invalidation:'Q3 cloud margin recovers',priceThen:287.5,proposalId:'861b3f79'}];
  return c;}
// Grows the fixture until it is about 72 KB as sent, through the sections the failure came from.
const failingShape=()=>{let n=0,c;do c=fixture({assessments:2,extraAssess:n++});while(rc.wire(c)<72000&&n<40);return c;};
// Reads a shortened section back in full the way the agent can: every page, and every row or field given by path.
function fetchAll(detail,section,part=''){
  const read=from=>rc.detailPart(detail,{section,part,from},8000);let r=read(0);assert.ok(!r.status,`${section}/${part}: ${r.reason??r.status}`);
  if(r.complete&&'data' in r)return r.data;
  if(typeof r.text==='string'){let s=r.text;while(r.next){r=read(r.next.from);s+=r.text;}return s;}
  if(Array.isArray(r.data)){const out=[];for(;;){for(const item of r.data)out.push(item?.omitted===true?fetchAll(detail,section,item.path):item);if(!r.next)break;r=read(r.next.from);}return out;}
  const out={...r.data};for(const o of r.omittedParts??[])out[o.part.split('/').pop().replaceAll('~1','/').replaceAll('~0','~')]=fetchAll(detail,section,o.part);return out;}
const MUST_ARRIVE=['positions','cash','equity','fx','orderFollowUp','agentDesk','markets','marketSession','risk','emergency','quotes','universe','triggerEvidence','userGuidelines','objective','tradingCosts'];

test('the failing shape (about 72 KB, Korean text) now fits, and everything a decision rests on arrives unchanged',()=>{
  const c=failingShape();const sent=rc.wire(c);assert.ok(sent>=71000&&sent<=75000,'about 72 KB as sent: '+sent);
  assert.equal(sent,Buffer.byteLength(JSON.stringify([{role:'user',content:JSON.stringify(c)}])),'measured in UTF-8 bytes as sent');
  const s=rc.shape(c,{limit:LIMIT});assert.equal(s.fits,true,JSON.stringify(s.report));assert.ok(rc.wire(s.context)<=LIMIT);assert.ok(s.mandatoryBytes<LIMIT);
  for(const k of MUST_ARRIVE)assert.deepEqual(s.context[k],c[k],k+' unchanged');
  const shortened=s.steps.filter(x=>x.kind!=='summary').map(x=>x.section);assert.ok(shortened.includes('assessments'),'assessments shortened: '+shortened);
  const a=s.context.assessments;assert.deepEqual(a.map(x=>x.stale),c.assessments.map(x=>x.stale),'stale parts kept');assert.equal(a[0].conflict,'DART backlog differs from the IR deck');assert.deepEqual(a[1].staleBecause,c.assessments[1].staleBecause);
  assert.deepEqual(a[0].sourceIds,c.assessments[0].evidence.map(e=>e.sourceId),'its sources named');assert.match(a[0].full,/get_context_detail section assessments/);
  if(shortened.includes('pendingDecisions')){const p=s.context.pendingDecisions[0];assert.deepEqual([p.market,p.invalidation,p.proposalId,p.priceThen],['US','Q3 cloud margin recovers','861b3f79',287.5],'what keeps it from executing');}
});
test('Korean text is measured in bytes: a context under the limit in characters but over it in bytes is shortened',()=>{
  const c=fixture({assessments:6,thesis:900});const chars=JSON.stringify([{role:'user',content:JSON.stringify(c)}]).length,bytes=rc.wire(c);
  assert.ok(chars<LIMIT&&bytes>LIMIT,`characters ${chars}, bytes ${bytes}`);const s=rc.shape(c,{limit:LIMIT});assert.ok(s.steps.length>0);assert.equal(s.fits,true);assert.ok(rc.wire(s.context)<=LIMIT);
});
test('growth: more holdings, longer assessments and more waits still fit with room; then the failure is named by its cause',()=>{
  for(const opts of [{holdings:8,quoted:24,assessments:8},{assessments:8,thesis:1500,evidence:8},{waits:20},{holdings:10,quoted:26,assessments:10,waits:14,thesis:1200}]){
    const c=fixture(opts),s=rc.shape(c,{limit:LIMIT});assert.equal(s.fits,true,JSON.stringify(opts)+' '+JSON.stringify(s.report));for(const k of MUST_ARRIVE)assert.deepEqual(s.context[k],c[k],k);}
  // Mandatory data alone over the limit: nothing could make it fit.
  const huge={...fixture(),userGuidelines:fill(80000,ko)};const s=rc.shape(huge,{limit:LIMIT});assert.equal(s.fits,false);const e=rc.sizeFailure(s);
  assert.equal(e.message,'CONTEXT_MANDATORY_TOO_LARGE');assert.ok(e.detail.mandatoryBytes>LIMIT);assert.match(e.detail.largest[0],/^userGuidelines:/);
  // Over after every compressor, mandatory part small: an unshortenable background section.
  const big={...fixture(),agentDesk:{notes:[{note:fill(80000)}]}};const t=rc.shape(big,{limit:LIMIT});assert.equal(t.fits,false);const f=rc.sizeFailure(t);assert.equal(f.message,'CONTEXT_OVER_BUDGET');assert.ok(f.detail.mandatoryBytes<LIMIT);
});
test('every shortened section can be read back in full through pagination',()=>{
  for(const c of [failingShape(),fixture({holdings:10,quoted:26,assessments:10,waits:14,thesis:1200})]){const s=rc.shape(c,{limit:LIMIT});
    assert.ok(Object.keys(s.detail).length>0);for(const section of Object.keys(s.detail))assert.deepEqual(fetchAll(s.detail,section),s.detail[section],section+' read back exactly');
    assert.deepEqual(s.context.detailAvailable.sort(),Object.keys(s.detail).sort(),'each listed for the agent');}
});
test('research rounds after a near-limit first request: every continuation stays within its budget and a decision returns',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const c=failingShape(),s=rc.shape(c,{limit:LIMIT});const first=[{role:'user',content:JSON.stringify(s.context)}];
  assert.ok(rc.wire(s.context)>LIMIT*0.85,'near the limit: '+rc.wire(s.context));const sections=Object.keys(s.detail);const sent=[],answers=[];let round=0;
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;const prior=continuation??first;
    if(round<4){const calls=[...sections.slice(0,2).map((sec,k)=>({name:'get_context_detail',callId:`d${round}${k}`,args:{section:sec,part:'',from:0}})),...[0,1].map(k=>({name:'get_company_research',callId:`r${round}${k}`,args:{symbol:c.quotes[k].symbol,sections:['financials']}}))];
      return {toolCalls:calls,continuation:[...prior,...calls.map(x=>({type:'function_call',call_id:x.callId,name:x.name,arguments:JSON.stringify(x.args)}))],usage:{}};}
    for(const item of continuation)if(item.type==='function_call_output')answers.push(JSON.parse(item.output));return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.'},usage:{}};};
  const r=await researchReview({context:{...s.context,discovery:{enabled:true}},detail:s.detail,evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async a=>({symbol:a.symbol,notes:fill(12000,ko)})}});
  assert.equal(r.decision.action,'Hold','a final decision');assert.equal(sent.length,3,'three research rounds');
  assert.ok(sent.every(b=>b<=cf.LIMIT*cf.TARGET),`every continuation within ${cf.LIMIT*cf.TARGET}: ${sent.join(', ')}`);
  assert.ok(answers.every(a=>a.status!=='rejected'),'every detail read and result answered');
});
test('the four size failures are told apart, with stage, measured size and largest sections; local ones say nothing reached OpenAI',async()=>{
  const E=require('../electron/ai-errors.cjs');for(const code of ['CONTEXT_MANDATORY_TOO_LARGE','CONTEXT_OVER_BUDGET','CONTINUATION_OVER_BUDGET'])assert.match(E.messages[code],/not sent to OpenAI|nothing was sent to OpenAI/,code);
  assert.match(E.messages.AI_CONTEXT_LIMIT,/OpenAI rejected/);assert.notEqual(E.messages.AI_CONTEXT_LIMIT,E.messages.AI_SERVER_ERROR);assert.deepEqual(E.SIZE_CODES.slice(0,3),['CONTEXT_MANDATORY_TOO_LARGE','CONTEXT_OVER_BUDGET','CONTINUATION_OVER_BUDGET']);
  const s=rc.shape({...fixture(),userGuidelines:fill(80000,ko)},{limit:LIMIT});const d=E.sizeDetail(rc.sizeFailure(s));
  assert.match(d,/at first request: \d+ bytes against the app limit of 70000 bytes; the part every decision must see is \d+ bytes; largest userGuidelines:/);
  assert.match(E.sizeDetail(Object.assign(new Error('AI_CONTEXT_LIMIT'),{detail:{limit:'model context window',wireBytes:500000,largest:['scoutPlan:9000']}})),/against the model context window/);
  const response={ok:false,status:400,text:async()=>JSON.stringify({error:{code:'context_length_exceeded'}})};assert.equal((await E.responseError(response)).message,'AI_CONTEXT_LIMIT','the provider rejection keeps its own code');
  assert.equal(E.sizeDetail(new Error('AI_SERVER_ERROR')),'','not a size failure');
});
// The review path with assembled contexts supplied directly (no broker), a provider that records calls.
function harness(contexts){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const events=[];const calls=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{calls.push(1);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}},(id,kind,title,body)=>events.push({title,body}));
  a.providerStatus.aiConnected=true;a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',skipUnchanged:false});let i=0;
  a.assembleReviewContext=async()=>({context:structuredClone(contexts[Math.min(i++,contexts.length-1)]),emergency:{active:false},execution:null,usValue:null,lessonIds:[]});
  return {a,db,events,calls};}
test('mandatory data alone over the limit: the review fails clearly, records no Hold and makes no proposal or order',async()=>{
  const ctx={...fixture(),environment:'local-paper',userGuidelines:fill(80000,ko)};const {a,db,events,calls}=harness([ctx]);
  await assert.rejects(a.review('Scheduled review'),/REVIEW_FAILED/);assert.equal(a.lastError,'CONTEXT_MANDATORY_TOO_LARGE');assert.equal(calls.length,0,'nothing sent');
  assert.match(a.lastErrorDetail,/nothing was sent to OpenAI and nothing was decided.*Size at first request: \d+ bytes against the app limit/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews').get().n,0,'no Hold recorded');assert.equal(db.prepare('SELECT COUNT(*) n FROM paper_proposals').get().n,0,'no proposal');
  assert.ok(!events.some(e=>e.title==='Decision'),'no decision event');
});
test('after a size failure: routine quote changes and new trigger evidence do not retry; a fill, a lost stop or your request does, saying why; the skip is logged once',async()=>{
  const {retryAfterSizeFailure,priceTriggerMoved}=require('../electron/size-retry.cjs');const RG=require('../electron/review-gate.cjs');const base=fixture(),at=Date.parse('2026-10-30T00:00:44Z');
  const failed={at,code:'CONTEXT_OVER_BUDGET',version:'1.5.46',state:RG.decisionState(base),seen:[]};const now=at+90000,opts=state=>({trigger:'Price movement trigger',version:'1.5.46',state,now,config:{eventTolerancePct:3}});
  // 09:00-09:30: volumes, percentage changes and each trigger's own evidence changed every minute.
  const routine={...base,quotes:base.quotes.map(q=>({...q,volume:q.volume*2,changePct:-1.2,timestamp:q.timestamp+90000})),triggerEvidence:{...base.triggerEvidence,price:61850}};
  assert.equal(retryAfterSizeFailure(failed,opts(RG.decisionState(routine))).retry,false);
  const filled={...base,positions:{...base.positions,[Object.keys(base.positions)[0]]:{quantity:2}}};const f=retryAfterSizeFailure(failed,opts(RG.decisionState(filled)));assert.equal(f.retry,true);assert.match(f.why,/3 → 2 shares/);
  const lost={...base,agentDesk:{...base.agentDesk,conditionalOrders:{...base.agentDesk.conditionalOrders,unprotected:[...base.agentDesk.conditionalOrders.unprotected,{symbol:Object.keys(base.positions)[1]}]}}};assert.deepEqual(retryAfterSizeFailure(failed,opts(RG.decisionState(lost))).kinds,['protection']);
  const risk={...base,emergency:{active:false,loss:{breached:true}}};assert.match(retryAfterSizeFailure(failed,opts(RG.decisionState(risk))).why,/loss limit/);
  assert.equal(retryAfterSizeFailure(failed,{...opts(RG.decisionState(routine)),trigger:'User request'}).why,'User request');
  assert.match(retryAfterSizeFailure(failed,{...opts(RG.decisionState(routine)),version:'1.5.47'}).why,/app was updated/);assert.match(retryAfterSizeFailure(failed,{...opts(RG.decisionState(routine)),now:at+31*60000}).why,/31 minutes since the failure/);
  // A price trigger is rebuilt only when its symbol moved past the gate's limit since the failure.
  const sym=Object.keys(base.positions)[0];assert.equal(priceTriggerMoved(failed,{kind:'percent',symbol:sym,price:62400*0.995}),false);assert.equal(priceTriggerMoved(failed,{kind:'percent',symbol:sym,price:62400*0.98}),true);
  // Through the review path: the over-budget review fails, two routine price triggers are skipped (logged once), a fill retries.
  const over={...base,environment:'local-paper',agentDesk:{notes:[{note:fill(80000)}]}};const {a,events,calls}=harness([over,{...over,quotes:routine.quotes},{...over,quotes:routine.quotes},{...over,positions:filled.positions}]);
  await assert.rejects(a.review('Scheduled review'));assert.equal(a.lastError,'CONTEXT_OVER_BUDGET');
  assert.equal((await a.review('Price movement trigger')).skipped,true);assert.equal((await a.review('Price movement trigger')).skipped,true);
  assert.equal(events.filter(e=>e.title==='Review skipped · same inputs as a failed review').length,1,'logged once');
  await assert.rejects(a.review('Price movement trigger'));assert.ok(events.some(e=>e.title==='Retrying after a size failure'&&/2 checks skipped since.*3 → 2 shares/.test(e.body)),'the retry says why');assert.equal(calls.length,0,'no AI call at any point');
});

// Trading costs (2026-10-30 13:11 KST input: 87,375 bytes shaped to 65,199 of 70,000, every background section and the
// tighter step already used; tradingCosts 9,421 bytes, never shortened). Made-up rows in the shape the app builds.
const MISSING_US=['KRW acquisition basis','gains realized at other brokers this year (enter 0 if none)'];
const costRow=(symbol,us,i)=>us?{symbol,buy:{gross:200+i,commission:0.5,netCash:-(200.5+i)},sell:{gross:200+i,commission:0.5,transactionTax:0.01,netCash:199.49+i,incomeTax:{status:'incomplete',missingInputs:MISSING_US}}}
  :{symbol,buy:{gross:50000+i,commission:8,netCash:-(50008+i)},sell:{gross:50000+i,commission:8,transactionTax:i%3?100:0,netCash:49892+i,gainAfterFees:-216,capitalGainsTaxKRW:0,gainAfterEstimatedTax:-216,incomeTax:{status:i%4===0?'unsupported':'estimated'}}};
function tradingCosts(nKR=13,nUS=6){
  const kr=Array.from({length:nKR},(_,i)=>String(200000+i)),us=Array.from({length:nUS},(_,i)=>`NYSE:C${i}`);
  const settings={krCommissionPct:0.015,usCommissionPct:0.25,usSellFeePct:0.0021,usSellFeeMinimum:0.01,taxYear:2026,taxMethod:'moving-average'};
  return {taxModel:'Taxes come from the app (rules kr-tax-2026-10-25); use its figures and status, never a flat rate. incomeTax.status: estimated, incomplete (the tax is unknown, not zero), unsupported.',acquisitionFeeAssumption:'Broker average prices exclude acquisition commissions.',ruleVersion:'kr-tax-2026-10-25',
    markets:[{market:'KR',currency:'KRW',settings,krSaleTaxPct:0.2,tax:{applicability:{status:'supported'},assumptions:['acquisition commission estimated from the current fee plan'],
        classification:Object.fromEntries(kr.map((s,i)=>[s,i%3?{instrument:'kr-listed-share',transactionTax:'taxable',incomeTax:'minority-listed-exempt'}:{instrument:'kr-etf',transactionTax:'exempt',incomeTax:'unknown'}]))},
      heldSale:[{symbol:kr[1],quantity:3,netCash:149676,annualTaxChangeKRW:0,gainAfterEstimatedTax:4375,incomeTax:{status:'estimated'}}],oneShare:kr.map((s,i)=>costRow(s,false,i))},
      {market:'US',currency:'USD',settings:{...settings,taxBasisKRW:{[us[0]]:81723}},krSaleTaxPct:0.2,allUSHoldingsSale:{status:'incomplete',missingInputs:[MISSING_US[1]]},
        tax:{applicability:{status:'supported'},annual:{status:'incomplete',missingInputs:[MISSING_US[1]]},assumptions:['exchange rate: the current market rate'],classification:Object.fromEntries(us.map(s=>[s,{instrument:'foreign-share',transactionTax:'exempt',incomeTax:'overseas-capital-gains'}]))},
        heldSale:[{symbol:us[0],quantity:1,netCash:65.67,taxableGainKRW:5966,incomeTax:{status:'incomplete',missingInputs:[MISSING_US[1]]}}],oneShare:us.map((s,i)=>costRow(s,true,i))}]};
}
const costContext=()=>({...fixture(),tradingCosts:tradingCosts()});
// The limit whose target (92%) is the given request size.
const limitFor=wireBytes=>Math.ceil(wireBytes/0.92);
// The request size once the summaries and every background compressor have run, and nothing else.
function afterBackground(c){const all=rc.shape(c,{limit:1000});const keys=all.steps.filter(x=>x.kind!=='summary').filter(x=>x.kind==='compressed').map(x=>x.section);
  let s=rc.shape(c,{limit:1e9}).context;for(const k of keys)s={...s,[k]:rc.COMPRESS.find(([key])=>key===k)[1](s[k])};
  return rc.wire({...s,detailAvailable:[...new Set([...(s.detailAvailable??[]),...keys])]});}
test('trading costs are compacted only after every background section, before the tighter step, and only while still over the target',()=>{
  const c=costContext();const all=rc.shape(c,{limit:1000});const kinds=all.steps.map(s=>s.kind);
  assert.ok(kinds.indexOf('compacted')>kinds.lastIndexOf('compressed')&&kinds.indexOf('compacted')<kinds.indexOf('tightened'),'order: '+all.steps.map(s=>s.kind+':'+s.section).join(', '));
  assert.equal(kinds.filter(k=>k==='compacted').length,1);const saving=all.steps.find(s=>s.kind==='compacted').bytesSaved;const size=afterBackground(c);
  // Background compression meets the target: cost rows untouched, nothing tightened.
  const lo=rc.shape(c,{limit:limitFor(size+20)});
  assert.ok(lo.steps.some(s=>s.kind==='compressed'),'background compressed');assert.ok(!lo.steps.some(s=>s.kind==='compacted'||s.kind==='tightened'),lo.steps.map(s=>s.kind+':'+s.section).join(', '));
  assert.deepEqual(lo.context.tradingCosts,c.tradingCosts,'cost rows unchanged when not needed');
  // Background compression is not enough but compaction is: assessments and waits keep their compressed form.
  const mid=rc.shape(c,{limit:limitFor(size-Math.floor(saving/2))});
  assert.ok(mid.steps.some(s=>s.kind==='compacted'),'costs compacted');assert.ok(!mid.steps.some(s=>s.kind==='tightened'),'not tightened');
  assert.ok(rc.wire(mid.context)<=mid.report.limitBytes*0.92,'within the target with the headroom, as sent (with its list of readable sections)');
});
test('compacted cost rows keep every total, tax figure, tax status and missing input; only fee breakdowns go, and the full section reads back',()=>{
  const c=costContext();const s=rc.shape(c,{limit:1000});const t=s.context.tradingCosts,o=c.tradingCosts;
  for(const k of ['taxModel','acquisitionFeeAssumption','ruleVersion'])assert.equal(t[k],o[k]);assert.match(t.full,/get_context_detail section tradingCosts/);
  o.markets.forEach((m,i)=>{const n=t.markets[i];
    for(const k of ['market','currency','settings','krSaleTaxPct','heldSale','allUSHoldingsSale'])assert.deepEqual(n[k],m[k],`${m.market} ${k} unchanged`);
    assert.deepEqual(n.tax.applicability,m.tax.applicability);assert.deepEqual(n.tax.annual,m.tax.annual,'annual tax uncertainty kept');assert.deepEqual(n.tax.assumptions,m.tax.assumptions);
    m.oneShare.forEach((r,j)=>{const x=n.oneShare[j];assert.equal(x.symbol,r.symbol);
      for(const side of ['buy','sell']){const {gross,commission,gainAfterFees,...kept}=r[side];assert.deepEqual(x[side],kept,`${r.symbol} ${side}: totals and taxes kept`);}});
    const back=Object.fromEntries(n.tax.classification.flatMap(({symbols,...cls})=>symbols.map(sym=>[sym,cls])));assert.deepEqual(back,m.tax.classification,'every symbol keeps its tax class');
    assert.ok(n.tax.classification.length<Object.keys(m.tax.classification).length,'listed once per class');});
  assert.ok(t.markets[0].oneShare.some(r=>r.sell.incomeTax.status==='unsupported'),'unsupported stays unsupported');
  assert.deepEqual(t.markets[1].oneShare[0].sell.incomeTax,{status:'incomplete',missingInputs:MISSING_US},'an unknown tax stays unknown, with what is missing');
  assert.ok(s.context.detailAvailable.includes('tradingCosts'));assert.deepEqual(s.detail.tradingCosts,o,'the full section is kept');
  assert.deepEqual(fetchAll(s.detail,'tradingCosts'),o,'and reads back whole through pagination');
  assert.deepEqual(fetchAll(s.detail,'tradingCosts','markets/0/oneShare'),o.markets[0].oneShare,'a part reads back whole');
});
test('costs of a single-market review compact the same way; simulated costs (no rows) are left alone; Korean text in a tax note is kept',()=>{
  const single={...tradingCosts().markets[1],taxModel:'세금은 앱 계산을 따릅니다 (kr-tax-2026-10-25)'};const c={...fixture(),tradingCosts:single};
  const s=rc.shape(c,{limit:1000});const t=s.context.tradingCosts;assert.ok(s.steps.some(x=>x.kind==='compacted'));assert.equal(t.taxModel,single.taxModel);
  assert.deepEqual(t.oneShare.map(r=>r.sell.netCash),single.oneShare.map(r=>r.sell.netCash));assert.ok(t.oneShare.every(r=>!('gross' in r.buy)));assert.deepEqual(t.heldSale,single.heldSale);
  const sim={basis:'simulation',currency:'KRW',commissionPct:.1,slippagePct:.1,saleTaxPct:0,capitalGainsTax:'Not modeled'};const p=rc.shape({...fixture(),tradingCosts:sim},{limit:1000});
  assert.ok(!p.steps.some(x=>x.section==='tradingCosts'),'nothing to compact');assert.deepEqual(p.context.tradingCosts,sim);
});
test('the mandatory size counts the compacted costs, and mandatory data over the limit still fails by that name',()=>{
  const c=costContext();const full=rc.shape(c,{limit:1e9}),tight=rc.shape(c,{limit:1000});
  assert.ok(tight.mandatoryBytes<full.mandatoryBytes,'the compact cost rows are what must always fit');
  assert.equal(rc.sizeFailure(tight).message,'CONTEXT_MANDATORY_TOO_LARGE');
  const between=rc.shape(c,{limit:Math.floor((tight.mandatoryBytes+full.mandatoryBytes)/2)});assert.notEqual(rc.sizeFailure(between).message,'CONTEXT_MANDATORY_TOO_LARGE','fits once costs are compact');
});

// Review of 4bf7185..1dfddb9, P1: after a size failure, an entry level crossed by less than the percentage threshold
// and a newly met agent trigger were dropped (the level was already marked fired; the trigger lost its identity in a
// comparison as a scheduled review). Each is a one-off event: it retries, and stays pending if no decision completes.
const over=base=>({...base,environment:'local-paper',agentDesk:{notes:[{note:fill(80000)}]}});
const watchRow=(a,scope,w)=>a.db.prepare('INSERT INTO review_watches VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,w.symbol,JSON.stringify(w));
test('after a size failure, an entry level crossed by less than the percentage threshold retries, and stays pending while no decision completes',async()=>{
  const {retryAfterSizeFailure,priceTriggerMoved}=require('../electron/size-retry.cjs');const RG=require('../electron/review-gate.cjs');
  const base=fixture(),cand=base.quotes.map(q=>q.symbol).find(s=>!(s in base.positions));const then=RG.decisionState(base).quotes[cand].price;
  const level=Math.round(then*1.001*100)/100,crossed=Math.round(then*1.002*100)/100;
  const alert={kind:'entry-level',symbol:cand,price:crossed,threshold:level,direction:'above',watchRevision:'rev-1'},evidence={kind:'watchlist',alerts:[alert]};
  const failed={at:Date.now()-60000,code:'CONTEXT_OVER_BUDGET',version:'1.5.46',state:RG.decisionState(base),seen:[]};
  assert.equal(priceTriggerMoved(failed,{kind:'watchlist',alerts:[{...alert,kind:'watchlist-move'}]}),false,'a 0.2% move alone is held');
  assert.equal(priceTriggerMoved(failed,evidence),true,'a newly crossed level is rebuilt however small the move');
  const v=retryAfterSizeFailure(failed,{trigger:'Price movement trigger',evidence,state:RG.decisionState(base),config:{eventTolerancePct:3}});assert.equal(v.retry,true);assert.match(v.why,/crossed its entry level .*new since the failure/);
  assert.equal(retryAfterSizeFailure({...failed,eventKeys:['level:rev-1']},{trigger:'Price movement trigger',evidence,state:RG.decisionState(base),config:{eventTolerancePct:3}}).retry,false,'the same crossing again is not new');
  // Through the review path.
  const small={...base,environment:'local-paper'};const {a,events,calls}=harness([over(base),{...over(base),triggerEvidence:evidence},{...over(base),triggerEvidence:evidence},small]);
  const scope=a.watchScope();watchRow(a,scope,{symbol:cand,direction:'above',price:level,percent:null,reason:'entry',baseline:then,updatedAt:1,revision:'rev-1',priceFired:true});
  await assert.rejects(a.review('Scheduled review'));assert.equal(a.lastError,'CONTEXT_OVER_BUDGET');
  await assert.rejects(a.review('Price movement trigger'));
  assert.ok(events.some(e=>e.title==='Retrying after a size failure'&&/crossed its entry level/.test(e.body)),'retried, saying it was the level');
  const watch=()=>a.watches.list(scope).find(w=>w.symbol===cand);
  assert.equal(watch().priceFired,false,'no decision completed: the level is put back');assert.deepEqual([...a.heldEvents(scope)],['level:rev-1'],'held while the failure stands');
  assert.equal((await a.review('Price movement trigger')).skipped,true,'the same crossing does not retry');assert.equal(watch().priceFired,false,'still pending');
  // While held, the tick does not rebuild it, and it does not hide another symbol's move.
  const now=Date.now(),q=price=>({symbol:cand,price,timestamp:now});
  assert.equal(a.watches.detect(scope,[q(crossed)],new Map(),3,now,a.heldEvents(scope)),null,'held, not rebuilt every minute');
  const other=base.quotes.find(x=>x.symbol!==cand);assert.equal(a.watches.detect(scope,[q(crossed),{symbol:other.symbol,price:other.price*1.05,timestamp:now}],new Map([[other.symbol,other.price]]),3,now,a.heldEvents(scope)).symbol,other.symbol);
  assert.equal(calls.length,0,'no AI call while over budget');
  // A decision completes (the context fits again): the failure clears and the level fires for a review of its own.
  await a.review('User request');assert.equal(a.failedInput,null);assert.equal(a.heldEvents(scope).size,0);
  const again=a.watches.detect(scope,[q(crossed)],new Map(),3,now,a.heldEvents(scope));assert.equal(again?.kind,'price');assert.equal(again.watchRevision,'rev-1');
});
test('after a size failure, a newly met agent trigger retries with unchanged account state, and stays pending while no decision completes',async()=>{
  const {retryAfterSizeFailure}=require('../electron/size-retry.cjs');const RG=require('../electron/review-gate.cjs');const base=fixture();
  const evidence={kind:'agent-trigger',trigger:{id:'T-ab12cd',name:'MAX under 9.50',reason:'entry'},results:[{expr:'price(NYSE:MAX)',op:'<',value:9.5,actual:9.48,met:true}]};
  const failed={at:Date.now()-60000,code:'CONTEXT_OVER_BUDGET',version:'1.5.46',state:RG.decisionState(base),seen:[]};
  const v=retryAfterSizeFailure(failed,{trigger:'Agent trigger',evidence,state:RG.decisionState(base),config:{eventTolerancePct:3}});
  assert.equal(v.retry,true,'not judged as a scheduled review');assert.match(v.why,/agent trigger MAX under 9.50 met, new since the failure/);
  assert.equal(retryAfterSizeFailure(failed,{trigger:'Agent trigger',evidence:null,state:RG.decisionState(base),config:{eventTolerancePct:3}}).retry,false,'without its evidence it would have been dropped');
  const small={...base,environment:'local-paper'};const {a,events}=harness([over(base),{...over(base),triggerEvidence:evidence},{...over(base),triggerEvidence:evidence},small]);
  const scope=a.watchScope(),now=Date.now();
  a.desk.write('agent_triggers',{id:'T-ab12cd',scope,status:'fired',name:'MAX under 9.50',conditions:[{expr:'price(NYSE:MAX)',op:'<',value:9.5}],symbols:['NYSE:MAX'],combine:'all',reason:'entry',createdAt:now-3600000,expiresAt:now+3600000,firedAt:now,results:evidence.results});
  await assert.rejects(a.review('Scheduled review'));await assert.rejects(a.review('Agent trigger'));
  assert.ok(events.some(e=>e.title==='Retrying after a size failure'&&/agent trigger MAX under 9\.50 met/.test(e.body)));
  const active=()=>a.desk.triggers(scope).map(t=>t.id);assert.deepEqual(active(),['T-ab12cd'],'no decision completed: active again');assert.ok(a.heldEvents(scope).has('agent:T-ab12cd'));
  assert.ok(!('firedAt' in a.desk.triggers(scope)[0]),'its firing is not left on it');
  assert.equal((await a.review('Agent trigger')).skipped,true,'the same trigger does not retry');assert.deepEqual(active(),['T-ab12cd'],'still pending');
  await a.review('User request');assert.equal(a.heldEvents(scope).size,0,'a completed decision clears the hold: the trigger is checked again');
  // An expired trigger is not brought back.
  a.desk.write('agent_triggers',{id:'T-old',scope,status:'fired',name:'old',conditions:[],symbols:[],combine:'all',reason:'',createdAt:now-7200000,expiresAt:now-1000,firedAt:now-2000});
  assert.equal(a.desk.reopenTrigger(scope,'T-old'),false);
});
test('selective alerts: a held level is skipped (its side unchanged), and a put-back level crosses again',()=>{
  const {WatchAlerts}=require('../electron/watch-alerts.cjs');const w=new WatchAlerts(),now=Date.now();const watch={symbol:'NYSE:MAX',direction:'above',price:10.01,revision:'r9',baseline:10,priceFired:false};
  const check=(price,skip=new Set())=>w.check({quotes:[{symbol:'NYSE:MAX',price,timestamp:now}],held:new Set(),baselines:new Map(),watches:[watch],tolerance:3,wide:6,now,skipLevels:skip});
  const first=check(10.02);assert.equal(first.trigger.alerts[0].kind,'entry-level');assert.equal(first.trigger.alerts[0].watchRevision,'r9');first.deliver();
  assert.equal(check(10.02).trigger,null,'fired once');w.restore('r9');
  assert.equal(check(10.02,new Set(['level:r9'])).trigger,null,'held while the failure stands');
  assert.equal(check(10.02).trigger.alerts[0].kind,'entry-level','put back: a crossing again once no longer held');
});

// Through the scheduler (tick): the trigger evidence reaches the review as in production (assembleReviewContext attaches
// this.triggerEvidence for price, news, agent and order triggers).
function scheduler(sequence,{alerts='observe'}={}){const h=harness([]);const a=h.a;let i=0;const started=[];
  a.assembleReviewContext=async({trigger})=>{const c=structuredClone(sequence[Math.min(i++,sequence.length-1)]);if(['Price movement trigger','News event trigger','Agent trigger','Order update'].includes(trigger))c.triggerEvidence=a.triggerEvidence;else delete c.triggerEvidence;
    return {context:c,emergency:{active:false},execution:null,usValue:null,lessonIds:[]};};
  a.configure({scope:'both',enabled:true,watchlistAlerts:alerts,newsTrigger:'off'});a.sessionArmed=true;a.schedulerStatus=()=>({label:'Monitoring'});a.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});
  a.sessionOpen=()=>true;a.watchScope=()=>'both:acct';a.marketQuotes=()=>[];a.deferForPendingOrder=()=>null;
  const review=a.review.bind(a);a.review=async(trigger,...rest)=>{started.push(trigger);return review(trigger,...rest);};
  const tick=async()=>{a.lastRun=Date.now()-120000;a.lastDeskCheck=0;a.tick();await new Promise(r=>setTimeout(r,40));};
  return {...h,a,tick,started};}
for(const alerts of ['observe','on'])test(`scheduler (${alerts}): a level reached by a 0.2% move after a size failure retries, is held without masking other symbols, and fires again once a decision completes`,async()=>{
  const base=fixture();const cand=base.quotes.map(q=>q.symbol).find(s=>/:/.test(s)&&!(s in base.positions))??'NASD:T002';const then=100,level=100.1;
  const big={...over(base),quotes:[...base.quotes.filter(q=>q.symbol!==cand),{symbol:cand,price:then,timestamp:Date.now()}]};const small={...big,agentDesk:{notes:[]}};
  const {a,tick,started,events}=scheduler([big,big,big,small,small]);const scope='both:acct';
  watchRow(a,scope,{symbol:cand,direction:'above',price:level,percent:null,reason:'entry',baseline:then,updatedAt:1,revision:'rev-7',priceFired:false});
  await assert.rejects(a.review('Scheduled review'));assert.equal(a.lastError,'CONTEXT_OVER_BUDGET');
  const quote=(symbol,price)=>({symbol,price,timestamp:Date.now(),retrievedAt:Date.now()});
  a.lastPrices=new Map([[cand,then]]);a.usQuotes=[quote(cand,100.2)];
  // In 'on' the candidate's earlier side is needed for a crossing: one check below the level first.
  if(alerts==='on'){a.usQuotes=[quote(cand,99.9)];await tick();a.usQuotes=[quote(cand,100.2)];}
  await tick();assert.equal(started.at(-1),'Price movement trigger','the 0.2% level is rebuilt into a review');
  assert.ok(events.some(e=>e.title==='Retrying after a size failure'&&/new since the failure/.test(e.body)),'and retried as a new event');
  const watch=()=>a.watches.list(scope).find(w=>w.symbol===cand);assert.equal(watch().priceFired,false,'the review failed again: the level is put back');assert.ok(a.heldEvents(scope).has('level:rev-7'));
  const n=started.length;await tick();await tick();assert.equal(started.length,n,'held: not rebuilt every minute');assert.equal(watch().priceFired,false);
  // Another symbol's move is not hidden by the held level.
  const other=base.quotes.find(q=>/:/.test(q.symbol)&&q.symbol!==cand&&q.symbol in base.positions)??base.quotes.find(q=>q.symbol!==cand);
  a.lastPrices=new Map([[cand,then],[other.symbol,other.price]]);a.usQuotes=[quote(cand,100.2),quote(other.symbol,other.price*1.06)];
  await tick();assert.equal(started.length,n+1,'the other symbol starts its own price review');a.usQuotes=[quote(cand,100.2)];a.lastPrices=new Map([[cand,then]]);
  // A completed decision clears the failure; the held level then fires for a review of its own, which decides and uses it up.
  await a.review('User request');assert.equal(a.failedInput,null);
  await tick();assert.equal(started.at(-1),'Price movement trigger');assert.equal(a.failedInput,null,'decided');assert.equal(watch().priceFired,true,'used up only by a completed decision');
});
test('scheduler: a newly met agent trigger after a size failure retries with unchanged account state, is held, survives a restart and fires again',async()=>{
  const base=fixture();const big=over(base),small={...big,agentDesk:{notes:[]}};const {a,tick,started,events}=scheduler([big,big,small,small]);const scope='both:acct';
  a.usQuotes=[{symbol:'NASD:GOOGL',price:280,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.desk.setTrigger(scope,{action:'add',id:'',name:'GOOGL under 285',conditions:[{expr:'price("NASD:GOOGL")',op:'<=',value:285}],combine:'all',expiresInHours:4,reason:'re-entry'},{universe:['NASD:GOOGL']});
  const id=a.desk.triggers(scope)[0].id;
  await assert.rejects(a.review('Scheduled review'));
  await tick();assert.equal(started.at(-1),'Agent trigger');assert.ok(events.some(e=>e.title==='Retrying after a size failure'&&/agent trigger GOOGL under 285 met/.test(e.body)));
  assert.deepEqual(a.desk.triggers(scope).map(t=>t.id),[id],'failed again: active');const n=started.length;await tick();assert.equal(started.length,n,'held while the failure stands');
  // A restart loses the in-memory failure; the trigger is still active in the database and fires.
  a.failedInput=null;await tick();assert.equal(started.at(-1),'Agent trigger');assert.equal(a.failedInput,null,'decided');assert.equal(a.desk.triggers(scope).length,0,'used up by the completed decision');
});
test('scheduler: observation state is not changed by a live-rule size failure',async()=>{
  const base=fixture();const cand='NASD:T902';const big={...over(base),quotes:[...base.quotes,{symbol:cand,price:100,timestamp:Date.now()}]};
  const {a,tick}=scheduler([big,big,big],{alerts:'observe'});const scope='both:acct';
  watchRow(a,scope,{symbol:cand,direction:'above',price:100.1,percent:null,reason:'entry',baseline:100,updatedAt:1,revision:'rev-8',priceFired:false});
  await assert.rejects(a.review('Scheduled review'));a.lastPrices=new Map([[cand,100]]);
  const quote=p=>({symbol:cand,price:p,timestamp:Date.now(),retrievedAt:Date.now()});a.usQuotes=[quote(99.9)];await tick();a.usQuotes=[quote(100.2)];
  const fired=[...a.watchAlerts.fired],sides=[...a.watchAlerts.sides];await tick();
  assert.ok(a.watchAlerts.fired.has('rev-8'),'the observer recorded its own crossing');const after=[...a.watchAlerts.fired];
  await tick();assert.deepEqual([...a.watchAlerts.fired],after,'the live review failing and the level being held do not reset the observer');void fired;void sides;
});

// Stage 1 (2026-10-30): a suppressed or failed review must not silently consume a signal, whatever the failure.
test('scheduler: a review that fails for another reason keeps its agent trigger, holds it five minutes, then tries again',async()=>{
  const base=fixture();const small={...base,environment:'local-paper'};const {a,tick,started,events}=scheduler([small]);const scope='both:acct';
  a.usQuotes=[{symbol:'NASD:GOOGL',price:280,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.desk.setTrigger(scope,{action:'add',id:'',name:'GOOGL under 285',conditions:[{expr:'price("NASD:GOOGL")',op:'<=',value:285}],combine:'all',expiresInHours:4,reason:'re-entry'},{universe:['NASD:GOOGL']});
  const id=a.desk.triggers(scope)[0].id;let fail=true;const request=a.provider.request.bind(a.provider);a.provider.request=async(...x)=>{if(fail)throw new Error('PROVIDER_REQUEST_FAILED');return request(...x);};
  await tick();assert.equal(started.at(-1),'Agent trigger');assert.equal(a.lastError,'PROVIDER_REQUEST_FAILED');
  assert.deepEqual(a.desk.triggers(scope).map(t=>t.id),[id],'no decision: the trigger is active again');assert.ok(events.some(e=>e.title==='Trigger kept for a later review'&&/agent trigger GOOGL under 285 met/.test(e.body)));
  const n=started.length;await tick();assert.equal(started.length,n,'held for five minutes: the failing provider is not called every minute');
  a.eventHold.until=Date.now()-1;fail=false;await tick();assert.equal(started.at(-1),'Agent trigger');assert.equal(a.lastError,null,'decided');assert.equal(a.desk.triggers(scope).length,0,'used up by the completed decision');assert.equal(a.eventHold,null);
});
test('scheduler: a news review marks only the filings it shows, and a failed one leaves them pending',async()=>{
  const base=fixture();const small={...base,environment:'local-paper'};const {a,tick,started}=scheduler([small]);a.configure({newsTrigger:'disclosures',unlimitedCalls:true,unlimitedBudget:true});const now=Date.now();
  const sym=Object.keys(base.positions)[0];for(let i=0;i<7;i++)a.newsEvents.save({id:'F'+i,source:'DART',kind:'disclosure',title:'Filing '+i,url:'F'+i,published:new Date(now).toISOString(),symbols:[sym],importance:'high',firstSeenAt:now-i*1000,triggeredAt:null});
  let fail=true;const request=a.provider.request.bind(a.provider);a.provider.request=async(...x)=>{if(fail)throw new Error('PROVIDER_REQUEST_FAILED');return request(...x);};
  a.lastNewsTrigger=0;await tick();assert.equal(started.at(-1),'News event trigger');assert.equal(a.triggerEvidence.events.length,5);assert.ok(a.triggerEvidence.events.every(e=>e.id),'each filing named by id');
  const pending=()=>a.newsEvents.pending('disclosures').map(e=>e.id).sort();
  assert.deepEqual(pending(),['F0','F1','F2','F3','F4','F5','F6'],'the review failed: the five shown are pending again, and the two not shown were never used up');
  // The next news review (after its ten-minute spacing) takes the two not held, then the held five once their hold ends.
  a.lastNewsTrigger=0;await tick();assert.deepEqual(a.triggerEvidence.events.map(e=>e.id).sort(),['F5','F6']);
  assert.deepEqual([...a.heldEvents('both:acct')].sort(),['news:F0','news:F1','news:F2','news:F3','news:F4','news:F5','news:F6'],'a second failure adds to the hold, not replaces it');
  fail=false;a.eventHold.until=Date.now()-1;a.lastNewsTrigger=0;await tick();assert.equal(a.lastError,null);assert.deepEqual(a.triggerEvidence.events.map(e=>e.id).sort(),['F0','F1','F2','F3','F4']);
  assert.deepEqual(pending(),['F5','F6'],'the two from the failed review still wait');a.lastNewsTrigger=0;await tick();assert.equal(a.lastError,null);assert.deepEqual(pending(),[],'every filing reached a completed decision');
});
