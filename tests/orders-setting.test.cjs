// M-6 part 1 (multi-order, artifacts/reviews/2026-11-16-multi-order/m6-plan.md sections 1-2): the user's saved switch
// "Several open orders" (default off; on only through its confirmation; off at once) and "Orders per review" (default
// 1). n, the most orders a review may place, is 1 unless the switch is on for every engine the review can place in;
// then the setting, limited by the trading model's ceiling. The request asks for n - 1 further orders only when n > 1.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const bare=()=>{const db=new DatabaseSync(':memory:');return new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'A'}],()=>[]),{request:async()=>({})},()=>{});};
test('the settings: defaults, and the validator refuses what is out of range',()=>{
  const a=bare();assert.equal(a.config.ordersPerReview,1);assert.equal(a.config.severalOpenOrders,false);
  for(const bad of [{ordersPerReview:0},{ordersPerReview:23},{ordersPerReview:1.5},{ordersPerReview:'2'},{severalOpenOrders:'yes'}])assert.throws(()=>a.configure(bad),/INVALID_SETTINGS/,JSON.stringify(bad));
  a.configure({ordersPerReview:22,severalOpenOrders:true});assert.equal(a.config.ordersPerReview,22);assert.equal(a.config.severalOpenOrders,true);
});
test('n: 1 with the switch off whatever the setting; with it on, the setting within the model\'s ceiling; both engines in combined scope; paper is 1',()=>{
  const a=bare();let kr=false,us=false;a.live={allowsSeveralOpen:()=>kr};a.usLive={allowsSeveralOpen:()=>us};a.config={...a.config,scope:'kis',ordersPerReview:10};
  const opus={openaiModel:'claude-opus-5-5',reasoningEffort:'high'},sol={openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
  assert.equal(a.ordersFor(opus),1,'switch off');kr=true;assert.equal(a.ordersFor(opus),10,'on: the setting');
  a.config={...a.config,ordersPerReview:22};assert.equal(a.ordersFor(opus),22);a.config={...a.config,ordersPerReview:30};assert.equal(a.ordersFor(opus),22,'the ceiling limits it');
  assert.equal(a.ordersFor(sol),1,'GPT-6 Sol answers one');assert.equal(a.ordersFor({openaiModel:'gpt-6-luna',reasoningEffort:'none'}),1);
  a.config={...a.config,scope:'both',ordersPerReview:5};assert.equal(a.ordersFor(opus),1,'combined: the U.S. engine off');us=true;assert.equal(a.ordersFor(opus),5);
  a.config={...a.config,scope:'us'};kr=false;assert.equal(a.ordersFor(opus),5,'U.S. scope reads the U.S. engine');
  a.config={...a.config,scope:'paper'};assert.equal(a.ordersFor(opus),1,'paper: one');
});
test('the request asks for further orders only when n > 1; at n = 1 its options are today\'s',async()=>{
  for(const n of [1,3]){const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();const a=h.automation();
    const seen=[];const provider=a.provider;a.provider={...provider,request:async(op,payload)=>{if(op==='decision')seen.push(payload.options);return provider.request(op,payload);}};a.ordersFor=()=>n;
    await a.review('User request').catch(()=>{});assert.ok(seen.length,'a decision was requested');
    if(n===1)assert.ok(seen.every(o=>!('moreOrders' in o)),'no moreOrders at n = 1');else assert.ok(seen.every(o=>o.moreOrders===2),'n - 1 further orders');}
});
test('turning the switch off during a batch: the rest are not sent; the orders before stand',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'035720':50000}});const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  // The engine reads the user's saved switch, as the app wires it.
  let on=true;h.kr.severalOpenFixed=false;h.kr.severalOpenSetting=()=>on;const place=m.place.bind(m);m.place=(...x)=>{const r=place(...x);on=false;return r;};
  h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'two',moreOrders:[{item:1,action:'Buy',symbol:'035720',quantity:1,credit:'none',loanDate:''}],moreWithheld:[]});
  await a.review('User request').catch(()=>{});
  assert.deepEqual(m.book.KR.filter(r=>r.kind==='order').map(r=>r.symbol),['005930']);
  const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);
  assert.equal(r.orders[0].executionNote,'Not sent: Buy 1 035720: several open orders was turned off during the batch.');assert.deepEqual(r.orders[0].outcome,{class:'stop',code:'SEVERAL_OPEN_OFF'});
});
test('the screen: the switch opens its confirmation (with the planner\'s sentence) and turns off at once; the row needs the switch',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/EngineSettings.tsx'),'utf8');
  assert.match(src,/onChange=\{v=>v\?setAsking\(true\):edit\('severalOpenOrders',false\)\}/,'on asks; off is immediate');
  assert.match(src,/onClick=\{\(\)=>\{edit\('severalOpenOrders',true\);setAsking\(false\);\}\}>Turn on</,'only "Turn on" sets it');
  assert.match(src,/body:'Orders can be open for different stocks at the same time\. This applies even at one order per review: an open order no longer blocks every other order\. KIS\\'s handling of several open orders has not yet been seen on your live account\. You can turn it off again at any time\.'/);
  assert.match(src,/disabled=\{busy\|\|!on\|\|ceiling<=1\}/,'"Orders per review" disabled with the switch off or a ceiling of 1');
  assert.match(src,/if\(!on\)return 'Needs several open orders turned on\.';/);assert.match(src,/answers one order per review\./);assert.match(src,/ Using \$\{ceiling\} with \$\{model\}\./);
});
