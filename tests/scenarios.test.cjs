// M-7 (a): the worked scenarios (tests/fixtures/m7/, one per outcome class, and the template) run as injected reviews
// through the real AI client (tests/helpers/scenario.cjs). The planner's own set is run by tests/run-scenarios.cjs
// against its folder. A scenario with a field the runner does not know fails.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {checkScenario,validate}=require('./helpers/scenario.cjs');
const dir=path.join(__dirname,'fixtures','m7');const read=f=>fs.readFileSync(f,'utf8').replace(/^﻿/,'');
for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){const s=JSON.parse(read(path.join(dir,file)));
  test(`scenario ${file}: ${s.name}`,async()=>{await checkScenario(s);});}
// The planner's set (its own folder under artifacts/, which is never committed), copied here so it runs as a regression
// suite in every checkout.
const planner=path.join(dir,'planner'),theirs=path.join(__dirname,'..','artifacts','reviews','2026-11-16-multi-order','m7','scenarios');
for(const file of fs.readdirSync(planner).filter(f=>f.endsWith('.json')).sort()){const s=JSON.parse(read(path.join(planner,file)));
  test(`planner scenario ${file}: ${s.name}`,async()=>{await checkScenario(s);});}
test('the copy of the planner\'s set is its folder exactly, when that folder is present',{skip:!fs.existsSync(theirs)&&'the planner\'s folder is not in this checkout'},()=>{
  const list=d=>fs.readdirSync(d).filter(f=>f.endsWith('.json')).sort(),same=t=>t.replace(/\r\n/g,'\n');
  assert.deepEqual(list(planner),list(theirs),'the same files: copy the folder again');
  for(const f of list(theirs))assert.equal(same(read(path.join(planner,f))),same(read(path.join(theirs,f))),`${f} differs: copy the folder again`);
});
test('a scenario with a field the runner does not know fails, wherever it is',()=>{
  const s=JSON.parse(fs.readFileSync(path.join(dir,'TEMPLATE.json'),'utf8'));
  for(const [where,bad] of [['top',{...s,extra:1}],['expect',{...s,expect:{...s.expect,orderCount:3}}],['expect.first',{...s,expect:{...s.expect,first:{action:'Buy',qty:1}}}],
    ['expect.orders',{...s,expect:{...s.expect,orders:[{item:1,status:'x'}]}}],['config',{...s,config:{ordersPerReview:3,model:'x'}}],['broker',{...s,broker:[{op:'place-order',call:1,fault:'lost',when:'x'}]}],
    ['broker op',{...s,broker:[{op:'buy',call:1,fault:'lost'}]}],['broker fault',{...s,broker:[{op:'place-order',call:1,fault:'boom'}]}],
    ['config.scope',{...s,config:{ordersPerReview:3,scope:'asia'}}],['config.model',{...s,config:{ordersPerReview:3,model:'claude-haiku-5-5'}}]])
    assert.throws(()=>validate(bad),/unknown field|one of|unknown or separate/,where);
  // Steps: each field of each step kind, the during events, and the expect fields inside them.
  const {answers,expect,...base}=s;const steps=st=>({...base,steps:st});
  for(const [where,bad] of [['step kind',steps([{trade:{}}])],['two kinds in one step',steps([{wait:{minutes:1},check:{expect:{}}}])],['review',steps([{review:{answers,when:1}}])],
    ['during',steps([{review:{answers,during:[{before:2,event:'restart'}]}}])],['during field',steps([{review:{answers,during:[{before:2,event:'settingSaved',why:'x'}]}}])],
    ['review expect',steps([{review:{answers,expect:{sentCount:1}}}])],['fill',steps([{fill:{symbol:'005930',when:'now'}}])],['check',steps([{check:{expect:{openOrders:[{symbol:'A',side:'Buy',status:'Accepted',age:1}]}}}])],
    ['counted',steps([{check:{expect:{counted:[{symbol:'A',side:'Buy',quantity:1,price:1}]}}}])],['steps with top-level answers',{...s,steps:[{wait:{minutes:1}}]}]])
    assert.throws(()=>validate(bad),/unknown field|one of|exactly one|replace/,where);
});
test('the batch seam (beforeBatchOrder) is set only by tests: nothing in electron/ or src/ assigns it',()=>{
  const files=dir=>fs.readdirSync(path.join(__dirname,'..',dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):/\.(c|m)?[jt]sx?$/.test(e.name)?[path.join(dir,e.name)]:[]);
  const app=[...files('electron'),...files('src')];const hits=app.filter(f=>/beforeBatchOrder\s*=(?!=)/.test(fs.readFileSync(path.join(__dirname,'..',f),'utf8')));
  assert.deepEqual(hits,[],'assigned in the app');assert.ok(app.some(f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8').includes('this.beforeBatchOrder?.(')),'the scan sees the call (it reads the right files)');
});
test('a scenario whose expectation does not hold fails, naming the scenario and the field',async()=>{
  const s=JSON.parse(fs.readFileSync(path.join(dir,'TEMPLATE.json'),'utf8'));
  await assert.rejects(checkScenario({...s,expect:{sent:['Buy 005930']}}),/TEMPLATE.*expect\.sent/);
});
