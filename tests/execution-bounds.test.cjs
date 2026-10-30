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
  // Review of 8ef1be1, P1: supplied but malformed is not "none": it is kept as invalid so the order is withheld.
  assert.deepEqual(validateDecision({...base,execution:{bound:-5,cancelAfter:'',cancelIf:[{expr:'x',op:'=',value:1},{expr:'price("A")',op:'<',value:'1'}]}},['NASD:GOOGL']).execution,{bound:null,cancelAfter:'',cancelIf:[],invalid:['bound -5','cancelIf 1 (malformed)','cancelIf 2 (malformed)']},'a negative bound and malformed conditions are invalid, not dropped');
  const six=Array.from({length:6},(_,i)=>({expr:'price("NASD:GOOGL")',op:'>=',value:290+i}));assert.deepEqual(validateDecision({...base,execution:{bound:null,cancelAfter:'',cancelIf:six}},['NASD:GOOGL']).execution.invalid,['cancelIf (6 conditions, at most 5)'],'a sixth condition is not cut off silently');
});
function auto(){const db=new DatabaseSync(':memory:');const events=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));return {a,events};}
test('the app checks the restrictions before use: what is out of range or malformed is invalid and withholds the order, never dropped',()=>{
  const {a,events}=auto();const soon=new Date(Date.now()+3600000).toISOString();const bad=(execution,price=285)=>a.executionBounds({...base,execution},price,'R');
  assert.deepEqual(bad({bound:280,cancelAfter:soon,cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]}),{bounds:{bound:280,cancelAfter:soon,cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]},invalid:[]});
  assert.deepEqual(bad({bound:100,cancelAfter:'',cancelIf:[]}),{bounds:null,invalid:['bound 100 (more than 50% from 285)']},'65% away: a typo, not a bound');
  assert.match(bad({bound:null,cancelAfter:new Date(Date.now()-60000).toISOString(),cancelIf:[]}).invalid[0],/already passed/);
  assert.match(bad({bound:null,cancelAfter:new Date(Date.now()+8*86400000).toISOString(),cancelIf:[]}).invalid[0],/more than 7 days ahead/);
  assert.match(bad({bound:null,cancelAfter:'tomorrow',cancelIf:[]}).invalid[0],/not a time/);
  assert.equal(bad({bound:null,cancelAfter:'',cancelIf:[{expr:'foo(',op:'>',value:1}]}).invalid.length,1,'unparseable condition');
  assert.match(bad({bound:280,cancelAfter:'',cancelIf:[]},null).invalid[0],/no current price/,'a bound cannot be checked without a price');
  assert.deepEqual(bad({bound:null,cancelAfter:'',cancelIf:[],invalid:['bound -5']}).invalid,['bound -5'],'what the parser found invalid stays invalid');
  assert.equal(events.filter(e=>e.title==='Execution withheld · invalid restrictions').length,7,'each is logged');assert.deepEqual(a.executionBounds(base,285,'R'),{bounds:null,invalid:[]},'none supplied: no restriction');
});
// Both-market review with fake KIS engines that record proposals, annotations and submissions in order.
async function review(decision,{bid=278.4,ask=278.6,usOpen=true,book=null,wait=null}={}){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);const log=[];
  const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{'NASD:GOOGL':{quantity:1}},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),
    propose:command=>{log.push(['propose',command]);return {id:'P1',status:'Ready'};},annotate:(id,patch)=>{log.push(['annotate',id,patch]);},autoSubmit:async id=>{log.push(['submit',id]);return {id:'O1'};},autoEnabled:true,identity:()=>'acct'+market});
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision})},()=>{});a.live=make('KR',false,'005930',70000);a.usLive=make('US',usOpen,'NASD:GOOGL',285);a.refreshUS=async()=>{};a.fx=()=>({usdKRW:1400,source:'fixture'});a.providerStatus.aiConnected=true;
  a.orderBook=book??(async()=>({status:'available',retrievedAt:Date.now(),data:{bid,ask}}));if(wait)a.wait=wait;a.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true});await a.review();db.close();return log;}
test('a Sell with a floor above the bid goes in at the floor, and its bounds are on the order before it is submitted',async()=>{
  const soon=new Date(Date.now()+3600000).toISOString();const log=await review({...base,execution:{bound:280,cancelAfter:soon,cancelIf:[]}});
  assert.deepEqual(log.map(x=>x[0]),['propose','annotate','submit'],'annotated before submission');assert.equal(log[0][1].limitPrice,280,'held at the floor, not the $278.40 bid');
  assert.deepEqual(log[1][2],{tracking:{bound:280,cancelAfter:soon}});
  const plain=await review(base);assert.equal(plain[0][1].limitPrice,278.4,'no bound: the bid');assert.deepEqual(plain.map(x=>x[0]),['propose','submit'],'nothing to annotate');
});
// Review of 8ef1be1, P1: a Sell whose stop time had passed produced a proposal and was submitted at the current bid.
test('restrictions supplied but invalid, or already stopping the order, produce no proposal and no submission',async()=>{
  const past=new Date(Date.now()-60000).toISOString();
  for(const [why,execution] of [['a stop time already past',{bound:null,cancelAfter:past,cancelIf:[]}],['a bound 90% away',{bound:28,cancelAfter:'',cancelIf:[]}],['a malformed bound',{bound:-5,cancelAfter:'',cancelIf:[]}],
    ['an unparseable condition',{bound:null,cancelAfter:'',cancelIf:[{expr:'foo(',op:'>',value:1}]}],['six conditions',{bound:null,cancelAfter:'',cancelIf:Array.from({length:6},(_,i)=>({expr:'price("NASD:GOOGL")',op:'>=',value:290+i}))}],
    ['a cancel condition already met',{bound:null,cancelAfter:'',cancelIf:[{expr:'price("NASD:GOOGL")',op:'<=',value:1000}]}],
    ['a cancel condition that cannot be checked',{bound:null,cancelAfter:'',cancelIf:[{expr:'price("NASD:AMZN")',op:'<=',value:1}]}]]){
    const d=validateDecision({...base,execution},['NASD:GOOGL']);const log=await review(d);assert.deepEqual(log,[],`${why}: nothing proposed or submitted`);}
});
test('a stop time that passes while the order book is awaited withholds the order',async()=>{
  const soon=new Date(Date.now()+400).toISOString();let reads=0;
  const log=await review({...base,execution:{bound:null,cancelAfter:soon,cancelIf:[]}},{book:async()=>{reads++;return {status:'unavailable',reason:'no book yet'};},wait:()=>new Promise(r=>setTimeout(r,250))});
  assert.deepEqual(log,[],'no proposal, no submission');assert.ok(reads>=2&&reads<21,'waiting stopped at the stop time, not after a minute: '+reads);
  // The book arrives just after the stop time: still withheld (checked again after pricing).
  const late=new Date(Date.now()+300).toISOString();const log2=await review({...base,execution:{bound:null,cancelAfter:late,cancelIf:[]}},{book:async()=>{await new Promise(r=>setTimeout(r,450));return {status:'available',retrievedAt:Date.now(),data:{bid:278.4,ask:278.6}};}});
  assert.deepEqual(log2,[],'priced after the stop time: nothing proposed');
});
test('a conditional order carries its limitPrice to the tracker as its bound',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.match(src,/if\(order\.limitPrice>0\)engine\.annotate\?\.\(proposal\.id,\{tracking:\{bound:order\.limitPrice\}\}\)/);
});
