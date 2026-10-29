const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const {decisionSchema,validateDecision}=require('../electron/ai-client.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const base={action:'Sell',symbol:'NASD:GOOGL',quantity:1,credit:'none',loanDate:'',explanation:'Exit.'};

test('execution is a strict, nullable field of every decision; it is kept for Buy and Sell only',()=>{
  const schema=decisionSchema(false);assert.ok(schema.required.includes('execution'));const e=schema.properties.execution.anyOf;assert.deepEqual(e[1],{type:'null'});
  assert.deepEqual(e[0].required,['bound','cancelAfter','cancelIf']);assert.equal(e[0].additionalProperties,false);assert.deepEqual(e[0].properties.cancelIf.items.properties.op.enum,['>','>=','<','<=']);
  const d=validateDecision({...base,execution:{bound:280,cancelAfter:'2026-10-30T05:00:00+09:00',cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]}},['NASD:GOOGL']);
  assert.deepEqual(d.execution,{bound:280,cancelAfter:'2026-10-30T05:00:00+09:00',cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]});
  assert.equal(validateDecision({...base,execution:null},['NASD:GOOGL']).execution,undefined,'null: none');
  assert.equal(validateDecision({...base,execution:{bound:null,cancelAfter:'',cancelIf:[]}},['NASD:GOOGL']).execution,undefined,'all empty: none');
  assert.equal(validateDecision({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.',execution:{bound:280,cancelAfter:'',cancelIf:[]}},['NASD:GOOGL']).execution,undefined,'Hold carries none');
  assert.deepEqual(validateDecision({...base,execution:{bound:-5,cancelAfter:'',cancelIf:[{expr:'x',op:'=',value:1},{expr:'price("A")',op:'<',value:'1'}]}},['NASD:GOOGL']).execution,undefined,'a negative bound and malformed conditions are dropped');
});
function auto(){const db=new DatabaseSync(':memory:');const events=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));return {a,events};}
test('the app checks the bounds before use: what is out of range or malformed is dropped and logged, never used',()=>{
  const {a,events}=auto();const soon=new Date(Date.now()+3600000).toISOString();
  assert.deepEqual(a.executionBounds({...base,execution:{bound:280,cancelAfter:soon,cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]}},285,'R'),{bound:280,cancelAfter:soon,cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]});
  assert.equal(a.executionBounds({...base,execution:{bound:100,cancelAfter:'',cancelIf:[]}},285,'R'),null,'65% away: a typo, not a bound');
  assert.equal(a.executionBounds({...base,execution:{bound:null,cancelAfter:new Date(Date.now()-60000).toISOString(),cancelIf:[]}},285,'R'),null,'already past');
  assert.equal(a.executionBounds({...base,execution:{bound:null,cancelAfter:new Date(Date.now()+8*86400000).toISOString(),cancelIf:[]}},285,'R'),null,'over 7 days');
  assert.equal(a.executionBounds({...base,execution:{bound:null,cancelAfter:'tomorrow',cancelIf:[]}},285,'R'),null);
  assert.equal(a.executionBounds({...base,execution:{bound:null,cancelAfter:'',cancelIf:[{expr:'foo(',op:'>',value:1}]}},285,'R'),null,'unparseable condition');
  assert.equal(events.filter(e=>e.title==='Execution bounds dropped').length,5,'each drop is logged');assert.equal(a.executionBounds(base,285,'R'),null);
});
// Both-market review with fake KIS engines that record proposals, annotations and submissions in order.
async function review(decision,{bid=278.4,ask=278.6,usOpen=true}={}){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);const log=[];
  const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{'NASD:GOOGL':{quantity:1}},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),
    propose:command=>{log.push(['propose',command]);return {id:'P1',status:'Ready'};},annotate:(id,patch)=>{log.push(['annotate',id,patch]);},autoSubmit:async id=>{log.push(['submit',id]);return {id:'O1'};},autoEnabled:true,identity:()=>'acct'+market});
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision})},()=>{});a.live=make('KR',false,'005930',70000);a.usLive=make('US',usOpen,'NASD:GOOGL',285);a.refreshUS=async()=>{};a.fx=()=>({usdKRW:1400,source:'fixture'});a.providerStatus.aiConnected=true;
  a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid,ask}});a.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true});await a.review();db.close();return log;}
test('a Sell with a floor above the bid goes in at the floor, and its bounds are on the order before it is submitted',async()=>{
  const soon=new Date(Date.now()+3600000).toISOString();const log=await review({...base,execution:{bound:280,cancelAfter:soon,cancelIf:[]}});
  assert.deepEqual(log.map(x=>x[0]),['propose','annotate','submit'],'annotated before submission');assert.equal(log[0][1].limitPrice,280,'held at the floor, not the $278.40 bid');
  assert.deepEqual(log[1][2],{tracking:{bound:280,cancelAfter:soon}});
  const plain=await review(base);assert.equal(plain[0][1].limitPrice,278.4,'no bound: the bid');assert.deepEqual(plain.map(x=>x[0]),['propose','submit'],'nothing to annotate');
  const typo=await review({...base,execution:{bound:28,cancelAfter:'',cancelIf:[]}});assert.equal(typo[0][1].limitPrice,278.4,'a bound 90% away is dropped');
});
test('a conditional order carries its limitPrice to the tracker as its bound',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.match(src,/if\(order\.limitPrice>0\)engine\.annotate\?\.\(proposal\.id,\{tracking:\{bound:order\.limitPrice\}\}\)/);
});
