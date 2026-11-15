// Trailing stops, step T1: the recorder (artifacts/reviews/2026-11-15-trailing-stops: t0/note.md sections 2 and 3,
// review.md condition A). Level math, the two-check rule, the regular-session filter, the write rule, and the level as
// the condition value read by the 5 s check and the fire path.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const T=require('../electron/trailing-stops.cjs');const {AgentDesk,COND_DEFAULTS}=require('../electron/agent-desk.cjs');const {regularOpen}=require('../electron/market-hours.cjs');
const KR_OPEN=Date.parse('2026-11-09T01:00:00Z');// Monday 10:00 KST
const US_OPEN=Date.parse('2026-11-09T15:00:00Z');// Monday 10:00 New York
const regular=market=>t=>regularOpen(market,t,new Set());
const order=(trail,{symbol='005930',value=trail.level}={})=>({id:'C-1',symbol,side:'Sell',purpose:'stop_loss',conditions:[{expr:`price("${symbol}")`,op:'<=',value}],trail});
// Runs quotes [price, seconds after start] through step, applying each patch, as trackTrailing does.
function run(o,quotes,{start=KR_OPEN,market='KR',extra={}}={}){const memory=new Map(),writes=[],events=[];
  for(const [price,s,q={}] of quotes){const now=start+s*1000;const r=T.step(o,{symbol:o.symbol,price,timestamp:now,...extra,...q},{now,regular:regular(market),memory});if(r){o={...o,...r.patch};writes.push(s);events.push(...r.events);}}
  return {o,writes,events};}

test('T1: a new trail starts at the price, its level is the higher of the floor and the trailing level, rounded down to the tick',()=>{
  const pct=T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'});
  assert.equal(pct.kind,'pct');assert.equal(pct.high,81200);assert.equal(pct.level,76300,'81,200 × 0.94 = 76,328, down to the 100-won tick');assert.equal(pct.floor,70000);assert.equal(pct.active,true);
  assert.equal(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:78000,price:81200,now:KR_OPEN,market:'KR'}).level,78000,'the floor when it is higher');
  const atr=T.create({pct:null,atrMultiple:1.5,activateAt:null},{floor:70000,price:81200,atr:1213,atrDate:'2026-11-06',now:KR_OPEN,market:'KR'});
  assert.equal(atr.distance,1819.5);assert.equal(atr.level,79300,'81,200 − 1,819.5 = 79,380.5, down to the tick');assert.equal(atr.pct,null);
  const us=T.create({pct:5,atrMultiple:null,activateAt:null},{floor:250,price:301.37,now:US_OPEN,market:'US'});assert.equal(us.level,286.3,'301.37 × 0.95 = 286.3015, down to the cent');
  const waiting=T.create({pct:6,atrMultiple:null,activateAt:85000},{floor:70000,price:81200,now:KR_OPEN,market:'KR'});assert.equal(waiting.active,false);assert.equal(waiting.high,null);assert.equal(waiting.level,70000,'the fixed floor until activation');
  assert.equal(T.roundDown(19999,'KR'),19990);assert.equal(T.roundDown(250400,'KR'),250000);assert.equal(T.roundDown(12.349,'US'),12.34);
});

test('T1: the high takes a price only after two consecutive distinct quotes at or above it; one spike or one quote read twice does not count',()=>{
  const o=order(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'}));
  const spike=run(o,[[81200,0],[90000,5],[81300,10]]);assert.equal(spike.o.trail.high,81300,'the spike pairs with its neighbours: min(81,200, 90,000) then min(90,000, 81,300)');
  assert.equal(spike.o.trail.level,76400);
  const memory=new Map();const now=KR_OPEN+5000;const q={symbol:'005930',price:95000,timestamp:KR_OPEN};
  assert.equal(T.step(o,q,{now,regular:regular('KR'),memory}),null,'the first quote only seeds');assert.equal(T.step(o,q,{now:now+5000,regular:regular('KR'),memory}),null,'the same quote (same timestamp) is not a second check');
  const two=run(o,[[90000,0],[90000,5]]);assert.equal(two.o.trail.high,90000);assert.equal(two.o.trail.level,84600);assert.equal(two.o.conditions[0].value,84600,'the condition value is the level');
  const down=run(two.o,[[60000,10],[60000,15]]);assert.equal(down.o.trail.level,84600,'never down');assert.deepEqual(down.writes,[],'nothing to write on a fall');
});

test('T1: only regular-session, fresh quotes move the high; U.S. quotes must be from the regular venue and not stale',()=>{
  const kr=order(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'}));
  const evening=Date.parse('2026-11-09T09:00:00Z');// 18:00 KST: Nextrade after-market
  assert.deepEqual(run(kr,[[90000,0],[90000,5]],{start:evening}).writes,[],'outside the regular session');
  const memory=new Map();const old={symbol:'005930',price:90000,timestamp:KR_OPEN};T.step(kr,old,{now:KR_OPEN,regular:regular('KR'),memory});
  assert.equal(T.step(kr,{...old,timestamp:KR_OPEN+1000},{now:KR_OPEN+120000,regular:regular('KR'),memory}),null,'a quote older than a minute');
  const iso=run(kr,[[90000,0,{timestamp:new Date(KR_OPEN).toISOString()}],[90000,5,{timestamp:new Date(KR_OPEN+5000).toISOString()}]]);assert.equal(iso.o.trail.high,90000,'ISO timestamps (the REST fallback) are read');
  const us=order(T.create({pct:5,atrMultiple:null,activateAt:null},{floor:250,price:300,now:US_OPEN,market:'US'}),{symbol:'NASD:AAPL'});
  assert.equal(run(us,[[320,0],[320,60]],{start:US_OPEN,market:'US'}).o.trail.high,320);
  assert.deepEqual(run(us,[[320,0],[320,60]],{start:US_OPEN,market:'US',extra:{venue:'after'}}).writes,[],'an extended-session venue');
  assert.deepEqual(run(us,[[320,0],[320,60]],{start:US_OPEN,market:'US',extra:{stale:true}}).writes,[],'a stale quote');
  assert.deepEqual(run(us,[[320,0],[320,60]],{start:Date.parse('2026-11-09T12:00:00Z'),market:'US'}).writes,[],'07:00 New York, pre-market');
});

test('T1: the row is written only on a tick move, on activation, on a new exchange day, or every 5 minutes for watchedAt',()=>{
  const o=order(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'}));
  const sub=run(o,[[81250,0],[81250,5],[81260,10]]);assert.deepEqual(sub.writes,[],'81,250 × 0.94 = 76,375: still 76,300, no write');
  const tick=run(o,[[81300,0],[81300,5]]);assert.deepEqual(tick.writes,[5],'76,422 → 76,400');
  const below=order(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:78000,price:81200,now:KR_OPEN,market:'KR'}));
  const raw=run(below,[[81300,0],[81300,5]]);assert.deepEqual(raw.writes,[5],'the high-based level moved under the floor: kept for a restart');assert.equal(raw.o.trail.level,78000);assert.equal(raw.o.trail.high,81300);
  const quiet=run(o,[[81000,0],[81000,5],[81000,301]]);assert.deepEqual(quiet.writes,[301],'watchedAt after 5 minutes');assert.equal(quiet.o.trail.high,81200,'that write keeps the high it had');
  // Review F1: a confirmed high that moves the level by less than a tick is kept in memory and written with the next row write.
  const f1=order(T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:80000,now:KR_OPEN,market:'KR'}));
  const probe=run(f1,[[80000,0],[80100,5],[80100,10],[80100,15],[79000,20],[79000,301]]);
  assert.deepEqual(probe.writes,[301],'nothing until the 5-minute write');assert.equal(probe.o.trail.high,80100,'the confirmed high is stored');assert.equal(probe.o.trail.level,75200,'the level is unchanged (80,100 × 0.94 = 75,294)');
  const later=run(f1,[[80000,0],[80100,5],[80100,10],[80700,15],[80700,20]]);assert.deepEqual(later.writes,[20],'a later tick move');assert.equal(later.o.trail.high,80700);assert.equal(later.o.trail.level,75800);
  const next=Date.parse('2026-11-10T01:00:00Z');const day=run({...o,trail:{...o.trail,watchedAt:next-1000}},[[81000,0],[81000,5]],{start:next});assert.deepEqual(day.writes,[5],'a new exchange day');assert.equal(day.o.trail.watchedDay,'2026-11-10');
  const act=order(T.create({pct:6,atrMultiple:null,activateAt:85000},{floor:70000,price:81200,now:KR_OPEN,market:'KR'}));
  const before=run(act,[[84000,0],[90000,5]]);assert.deepEqual(before.writes,[],'84,000 / 90,000: the candidate 84,000 is below activateAt');
  const on=run(act,[[85500,0],[86000,5]]);assert.equal(on.o.trail.active,true);assert.equal(on.o.trail.high,85500);assert.equal(on.o.trail.level,80300);
  assert.deepEqual(on.events,[{title:'Trailing stop active · 005930',body:'85,500 reached activateAt 85,000; stop now 80,300.'}]);
  const atr=order(T.create({pct:null,atrMultiple:2,activateAt:null},{floor:70000,price:81200,atr:1000,now:KR_OPEN,market:'KR'}));assert.equal(run(atr,[[82000,0],[82000,5]]).o.trail.level,80000,'82,000 − 2,000');
});

// Automation with a fake engine (the conditional-order harness of agent-desk.test.cjs, cut down).
function harness({ctxPrice=76000}={}){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const events=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({id,kind,title,body}));
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  const calls={propose:[],submit:[]};const ctx={price:ctxPrice};
  a.live={identity:()=>'acct',autoEnabled:true,enabled:true,context:async()=>({marketSession:{open:true},quotes:[{symbol:'005930',price:ctx.price}],positions:{'005930':{quantity:4}},equity:10000000,cash:5000000}),propose:cmd=>{calls.propose.push(cmd);return {id:'P1',status:'Ready'};},autoSubmit:async id=>{calls.submit.push(id);return {id:'O1'};},getState:()=>({})};
  a.series={closes:()=>null,ensure:async()=>{}};const quotes=[];a.marketQuotes=()=>quotes;
  const scope=a.watchScope();a.desk.setOrder(scope,{action:'add',id:'',symbol:'005930',side:'Sell',quantity:4,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:70000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:a.config,universe:['005930'],quotes:[{symbol:'005930',price:81200}]});
  const armed=()=>a.desk.orders(scope)[0];a.desk.update(armed(),{trail:T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'}),conditions:[{expr:'price("005930")',op:'<=',value:76300}]});
  return {a,db,events,calls,ctx,quotes,scope,armed};}

test('T1: trackTrailing moves the stored level only with the switch on; the condition value, priceAtCreation and the context follow',()=>{
  const {a,events,quotes,armed,scope}=harness();a.config.trailingStops=true;
  quotes.push({symbol:'005930',price:90000,timestamp:KR_OPEN});a.trackTrailing(scope,KR_OPEN);quotes[0]={symbol:'005930',price:90000,timestamp:KR_OPEN+5000};a.trackTrailing(scope,KR_OPEN+5000);
  assert.equal(armed().trail.level,84600);assert.equal(armed().conditions[0].value,84600);assert.equal(armed().trail.floor,70000,'the floor the AI gave is kept');assert.equal(armed().priceAtCreation,81200,'unchanged');
  assert.equal(a.desk.context(scope,a.config,['005930']).conditionalOrders.armed[0].conditions[0].value,84600,'the review sees the current level');
  assert.deepEqual(events.filter(e=>/Trailing/.test(e.title)),[],'no Journal line per move');
  // Condition A, the unprotected list: a trailing stop_loss is a stop loss.
  assert.deepEqual(a.desk.unprotected(scope,{'005930':{quantity:4}}),[]);
  // The 5 s loop tracks before the firing scan, only with the switch on and while monitoring is active.
  const b=harness();const seen=[];b.a.trackTrailing=s=>seen.push(['track',s]);const check=b.a.desk.orders.bind(b.a.desk);b.a.desk.orders=s=>{seen.push(['orders']);return check(s);};
  b.a.configure({enabled:true});b.a.sessionArmed=true;const tick=()=>{seen.length=0;b.a.lastDeskCheck=0;b.a.tick();return seen.filter(x=>x[0]==='track').length;};
  assert.equal(tick(),0,'trailingStops off: not tracked');b.a.config.trailingStops=true;assert.equal(tick(),1,'on: tracked once per 5 s check');
  assert.ok(seen.findIndex(x=>x[0]==='track')<seen.map(x=>x[0]).lastIndexOf('orders'),'before the orders are read for the firing scan');
  b.a.firing=true;assert.equal(tick(),0,'not while an order is firing');b.a.firing=false;b.a.sessionArmed=false;assert.equal(tick(),0,'not while monitoring is inactive');
});

test('T1: the fire path re-checks the stored level against the fresh quote, and the outcome says what the trail was',async()=>{
  const {a,calls,ctx,armed,db,quotes}=harness({ctxPrice:77000});quotes.push({symbol:'005930',price:76000,timestamp:Date.now()});// the order book's price (fixture)
  await a.fireConditional(armed());assert.equal(armed().status,'armed','77,000 is above the level 76,300: not met, stays armed');assert.equal(calls.propose.length,0);
  ctx.price=76000;await a.fireConditional({...armed(),nextCheckAt:0});const o=a.desk.recentOrders(a.watchScope())[0];
  assert.equal(o.status,'submitted');assert.equal(calls.propose[0].quantity,4);assert.match(o.outcome,/Trailing: high 81,200 on 11-09, trail 6%, stop 76,300\.$/);
  db.close();
});

test('T1: a trailing stop is never renewed as the twin of a fixed order with the same condition value (condition A)',()=>{
  const desk=new AgentDesk(new DatabaseSync(':memory:'));const on={...COND_DEFAULTS,conditionalOrders:true};const held={'005930':{quantity:4}};
  const args={action:'add',id:'',symbol:'005930',side:'Sell',quantity:4,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:76300}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r'};
  const first=desk.setOrder('kis:a',args,{config:on,positions:held});desk.update(desk.orders('kis:a')[0],{trail:T.create({pct:6,atrMultiple:null,activateAt:null},{floor:70000,price:81200,now:KR_OPEN,market:'KR'})});
  const again=desk.setOrder('kis:a',args,{config:on,positions:held});assert.equal(again.status,'rejected','not renewed: the shares are covered');assert.equal(again.renewed,undefined);assert.equal(desk.orders('kis:a')[0].id,first.id);
  const plain=new AgentDesk(new DatabaseSync(':memory:'));plain.setOrder('kis:a',args,{config:on,positions:held});assert.equal(plain.setOrder('kis:a',args,{config:on,positions:held}).renewed,true,'fixed orders still renew');
});

// ---- T2: the switch, the tool and schema variants, validation, twins, replaces, context (t0/note.md sections 1, 5 to 8; review.md C).
const D=require('../electron/agent-desk.cjs');const C=require('../electron/ai-client.cjs');
const ON={...COND_DEFAULTS,conditionalOrders:true,trailingStops:true,conditionalMaxActive:5};
const STOP={action:'add',id:'',symbol:'005930',side:'Sell',quantity:4,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:70000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r',replaces:null,credit:null,trail:{pct:6,atrMultiple:null,activateAt:null}};
const Q=[{symbol:'005930',price:81200}];const HELD={'005930':{quantity:4}};
const arm=(desk,args={},opts={})=>desk.setOrder('kis:a',{...STOP,...args},{config:ON,universe:['005930'],quotes:Q,positions:HELD,...opts});

test('T2: the trail tool and plan fields exist only as variants; with the switch off every schema and tool is unchanged',()=>{
  assert.ok(!('trail' in D.ORDER_TOOL.parameters.properties)&&!D.ORDER_TOOL.parameters.required.includes('trail'),'ORDER_TOOL is as before');
  const p=D.ORDER_TOOL_TRAIL.parameters;assert.deepEqual(p.required,[...D.ORDER_TOOL.parameters.required,'trail']);
  assert.deepEqual(p.properties.trail,{anyOf:[{type:'null'},{type:'object',properties:{pct:{type:['number','null']},atrMultiple:{type:['number','null']},activateAt:{type:['number','null']}},required:['pct','atrMultiple','activateAt'],additionalProperties:false}]});
  assert.equal(D.ORDER_TOOL_TRAIL.description,D.ORDER_TOOL.description+D.TRAIL_SENTENCE,'the one sentence, once, at the end');
  assert.match(D.TRAIL_SENTENCE,/while the app is closed, daily highs from the time it was closed are applied at its next check\./,'review C: the cut wording');
  assert.ok(!/should|prefer|recommend|typical|usually|consider/i.test(D.TRAIL_SENTENCE),'it says what trail does, not when or how far');
  for(const [a,b] of [[false,false],[true,false],[false,true],[true,true]])assert.deepEqual(C.decisionSchema(a,b,false),C.decisionSchema(a,b),'no trail: the old schema');
  const plan=C.decisionSchema(false,false,true).properties.plan;assert.deepEqual(plan.required.slice(-2),['trailPct','trailAtrMultiple']);assert.deepEqual(plan.properties.trailPct.type,['number','null']);
  const ctx=allowed=>({agentDesk:{conditionalOrders:{allowed:true,...(allowed?{trailing:{allowed:true}}:{})}}});
  assert.equal(C.deskTools(ctx(false)).at(-1),D.ORDER_TOOL);assert.equal(C.deskTools(ctx(true)).at(-1),D.ORDER_TOOL_TRAIL);
  const desk=new AgentDesk(new DatabaseSync(':memory:'));assert.equal(desk.context('kis:a',{...ON,trailingStops:false},['005930']).conditionalOrders.trailing,undefined,'off: nothing in the context');
  assert.deepEqual(desk.context('kis:a',ON,['005930']).conditionalOrders.trailing,{allowed:true});assert.equal(desk.context('kis:a',{...ON,conditionalOrders:false},['005930']).conditionalOrders.trailing,undefined);
  assert.equal(COND_DEFAULTS.trailingStops,false,'off by default');
});

test('T2: the OpenAI request carries the trail variants only while the context allows trailing stops',async()=>{
  const sent=[];const client=new C.AiClient('k'.repeat(20),async(url,init)=>{sent.push(JSON.parse(init.body));return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  const base={environment:'kis',universe:[{symbol:'005930'}],positions:{}};
  for(const trailing of [false,true]){try{await client.decide({...base,agentDesk:{conditionalOrders:{allowed:true,...(trailing?{trailing:{allowed:true}}:{})}}},{research:true});}catch{}}
  const [off,on]=sent;const plan=b=>b.text.format.schema.properties.plan.properties,tool=b=>b.tools.find(t=>t.name==='set_conditional_order');
  assert.ok(!('trailPct' in plan(off))&&!('trail' in tool(off).parameters.properties),'off: as before');assert.ok('trailPct' in plan(on)&&'trail' in tool(on).parameters.properties,'on: both variants');
  assert.equal(off.instructions,on.instructions,'no text changes');
});

test('T2: every refusal of a trail, in the order of the note',()=>{
  const desk=()=>new AgentDesk(new DatabaseSync(':memory:'));const why=(args,opts)=>arm(desk(),args,opts).reason;
  assert.equal(why({},{config:{...ON,trailingStops:false}}),'Trailing stops are turned off in Engine settings.');
  for(const bad of [{side:'Buy'},{purpose:'entry'}])assert.equal(why(bad),'trail is for a Sell stop_loss or take_profit on cash shares.',JSON.stringify(bad));
  assert.equal(why({credit:{kind:'margin-sell',loanDate:'2026-10-25',source:'self'}},{lot:{ok:true,lot:{},account:'a'}}),'trail is for a Sell stop_loss or take_profit on cash shares.','a credit lot');
  for(const conditions of [[{expr:'price("005930")',op:'<',value:70000}],[{expr:'sma("005930",5)',op:'<=',value:70000}],[{expr:'price("005930")',op:'<=',value:70000},{expr:'price("005930")',op:'>',value:1}]])assert.equal(why({conditions}),'With trail, give exactly one condition: price("SYM") <= the floor.');
  assert.equal(why({combine:'any'}),'With trail, give exactly one condition: price("SYM") <= the floor.');
  assert.equal(why({trail:{pct:6,atrMultiple:2,activateAt:null}}),'trail needs exactly one of pct and atrMultiple.');assert.equal(why({trail:{pct:null,atrMultiple:null,activateAt:null}}),'trail needs exactly one of pct and atrMultiple.');
  assert.equal(why({trail:{pct:0.4,atrMultiple:null,activateAt:null}}),'trail.pct must be 0.5 to 50.');assert.equal(why({trail:{pct:51,atrMultiple:null,activateAt:null}}),'trail.pct must be 0.5 to 50.');
  assert.equal(why({trail:{pct:null,atrMultiple:11,activateAt:null}},{atr:()=>({value:1000,date:'2026-11-06'})}),'trail.atrMultiple must be 0.5 to 10.');
  assert.equal(why({},{quotes:[]}),'The current price of 005930 is not known; nothing was armed.');
  assert.equal(why({trail:{pct:null,atrMultiple:2,activateAt:null}},{atr:()=>null}),'ATR(14) for 005930 could not be computed from its daily bars; nothing was armed.');
  assert.equal(why({trail:{pct:null,atrMultiple:0.5,activateAt:null}},{atr:()=>({value:300,date:'2026-11-06'})}),'The trail distance is 0.18% of the price; it must be 0.5% to 50%.');
  assert.equal(why({trail:{pct:6,atrMultiple:null,activateAt:81000}}),'trail.activateAt must be above the current price and the floor, or null.');
  assert.equal(arm(desk(),{trail:null}).status,'armed','trail null: an ordinary stop');assert.equal(arm(desk(),{trail:null},{config:{...ON,trailingStops:false}}).status,'armed','null is accepted while off');
});

test('T2: arming sets the trail and its level as the condition value; ATR from completed bars only',()=>{
  const desk=new AgentDesk(new DatabaseSync(':memory:'));const r=arm(desk);assert.equal(r.status,'armed');const o=desk.orders('kis:a')[0];
  assert.equal(o.trail.floor,70000);assert.equal(o.trail.level,76300);assert.equal(o.conditions[0].value,76300);assert.equal(o.trail.high,81200);assert.equal(o.priceAtCreation,81200);
  const view=desk.context('kis:a',ON,['005930']).conditionalOrders.armed[0].trail;assert.equal(view.distance,'6%');assert.equal(view.floor,70000);assert.equal(view.level,76300);assert.equal(view.tracking,true);assert.equal(view.active,true);
  assert.equal(desk.context('kis:a',{...ON,trailingStops:false},['005930']).conditionalOrders.armed[0].trail.tracking,false,'switched off: shown as not tracking');
  const summary=require('../electron/automation.cjs').dryRunSummary({agentDesk:desk.context('kis:a',ON,['005930'])});assert.deepEqual(summary.conditionalOrders.armed[0].trail,{level:76300,high:81200,floor:70000},'the dry-run summary');
  const atrDesk=new AgentDesk(new DatabaseSync(':memory:'));arm(atrDesk,{trail:{pct:null,atrMultiple:1.5,activateAt:null}},{atr:()=>({value:1213,date:'2026-11-06'})});const t=atrDesk.orders('kis:a')[0].trail;
  assert.equal(t.distance,1819.5);assert.equal(t.level,79300);assert.equal(atrDesk.context('kis:a',ON,['005930']).conditionalOrders.armed[0].trail.distance,'1819.5 (1.5 x ATR14 1213 on 2026-11-06)');
  // trailAtr: bars of the exchange's current day are left out.
  const {a}=harness();const today=T.dayOf(Date.now(),'KR');const bars=Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,open:100,high:110,low:90,close:100}));
  a.series={closes:()=>[...bars,{date:today,open:100,high:400,low:10,close:100}]};const v=a.trailAtr('005930');assert.equal(v.date,'2026-10-30');assert.equal(v.value,20,'the wide bar of today is not used');
  a.series={closes:()=>bars.slice(0,10)};assert.equal(a.trailAtr('005930'),null,'not enough bars');
});

test('T2: a trailing twin has the same floor and trail and keeps its high; a different trail is not a twin',()=>{
  const desk=new AgentDesk(new DatabaseSync(':memory:'));const first=arm(desk);const o=desk.orders('kis:a')[0];desk.update(o,{trail:{...o.trail,high:90000,level:84600},conditions:[{...o.conditions[0],value:84600}]});
  const again=arm(desk,{expiresInHours:48});assert.equal(again.renewed,true);assert.equal(again.id,first.id);const kept=desk.orders('kis:a')[0];assert.equal(kept.trail.high,90000);assert.equal(kept.trail.level,84600);
  assert.equal(arm(desk,{trail:{pct:7,atrMultiple:null,activateAt:null}}).status,'rejected','another distance: not a twin, and the shares are covered');
  assert.equal(arm(desk,{trail:null,conditions:[{expr:'price("005930")',op:'<=',value:84600}]}).status,'rejected','a fixed order at the current level is not a twin');
});

test('T2: replaces carries the high onto the same trail and starts afresh otherwise',()=>{
  const setup=()=>{const desk=new AgentDesk(new DatabaseSync(':memory:'));const first=arm(desk);const o=desk.orders('kis:a')[0];desk.update(o,{trail:{...o.trail,high:90000,highAt:1,level:84600},conditions:[{...o.conditions[0],value:84600}]});return {desk,id:first.id};};
  let {desk,id}=setup();const carried=arm(desk,{replaces:id,conditions:[{expr:'price("005930")',op:'<=',value:72000}]});assert.equal(carried.status,'armed');assert.equal(carried.replaced,id);
  let t=desk.orders('kis:a')[0].trail;assert.equal(t.high,90000);assert.equal(t.highAt,1);assert.equal(t.level,84600);assert.equal(t.floor,72000);assert.equal(t.startedFrom,'carried');
  ({desk,id}=setup());arm(desk,{replaces:id,conditions:[{expr:'price("005930")',op:'<=',value:86000}]});t=desk.orders('kis:a')[0].trail;assert.equal(t.level,86000,'a higher floor wins');
  ({desk,id}=setup());arm(desk,{replaces:id,trail:{pct:8,atrMultiple:null,activateAt:null}});t=desk.orders('kis:a')[0].trail;assert.equal(t.high,81200,'another distance: from the current price');assert.equal(t.level,74700);
  ({desk,id}=setup());arm(desk,{replaces:id,trail:null});const fixed=desk.orders('kis:a')[0];assert.equal(fixed.trail,undefined,'to a fixed stop');assert.equal(fixed.conditions[0].value,70000);
});

test('T2: switching trailing stops off says so once and keeps the stops armed; the two-check memory starts afresh',()=>{
  const {a,events,armed}=harness();a.configure({trailingStops:true});a.trailMemory=new Map([['x',{price:1,at:1}]]);a.configure({trailingStops:false});
  assert.equal(armed().status,'armed');assert.equal(armed().trail.level,76300);assert.deepEqual(events.filter(e=>e.title==='Trailing stops paused').map(e=>e.body),['1 trailing stop stays armed at its current level.']);
  assert.equal(a.trailMemory.size,0);a.configure({trailingStops:false});assert.equal(events.filter(e=>e.title==='Trailing stops paused').length,1,'not again without a change');
  assert.throws(()=>a.configure({trailingStops:'yes'}),/INVALID_SETTINGS/);
});

test('T2: plan trail fields survive normalizing, and the flat Claude answer rebuilds them (0 is none)',()=>{
  const A=require('../electron/anthropic-client.cjs');const schema=A.flatDecisionSchema(false,false,true);
  const flat=Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,v.type==='array'?[]:v.type==='number'||v.type==='integer'?0:v.enum?v.enum[0]:'']));
  const {decision}=A.rebuildDecision({...flat,plan_trailPct:6,plan_trailAtrMultiple:0},schema);assert.equal(decision.plan.trailPct,6);assert.equal(decision.plan.trailAtrMultiple,null);
  const plain=A.flatDecisionSchema(false,false);const {decision:d2}=A.rebuildDecision(Object.fromEntries(Object.keys(plain.properties).map(k=>[k,flat[k]])),plain);assert.ok(!('trailPct' in d2.plan),'off: no trail keys');
  assert.equal(C.normalizePlan({thesis:'t',stopPrice:90,trailPct:6,trailAtrMultiple:null}).trailPct,6);assert.ok(!('trailAtrMultiple' in C.normalizePlan({thesis:'t',stopPrice:90,trailPct:6,trailAtrMultiple:null})));
  assert.ok(!('trailPct' in C.normalizePlan({thesis:'t',stopPrice:90})),'no trail: as before');
});
