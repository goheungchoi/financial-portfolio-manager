// M-7 (a): the worked scenarios (tests/fixtures/m7/, one per outcome class, and the template) run as injected reviews
// through the real AI client (tests/helpers/scenario.cjs). The planner's own set is run by tests/run-scenarios.cjs
// against its folder. A scenario with a field the runner does not know fails.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {checkScenario,validate}=require('./helpers/scenario.cjs');
const dir=path.join(__dirname,'fixtures','m7');
for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){const s=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  test(`scenario ${file}: ${s.name}`,async()=>{await checkScenario(s);});}
test('a scenario with a field the runner does not know fails, wherever it is',()=>{
  const s=JSON.parse(fs.readFileSync(path.join(dir,'TEMPLATE.json'),'utf8'));
  for(const [where,bad] of [['top',{...s,extra:1}],['expect',{...s,expect:{...s.expect,orderCount:3}}],['expect.first',{...s,expect:{...s.expect,first:{action:'Buy',qty:1}}}],
    ['expect.orders',{...s,expect:{...s.expect,orders:[{item:1,status:'x'}]}}],['config',{...s,config:{ordersPerReview:3,model:'x'}}],['broker',{...s,broker:[{op:'place-order',call:1,fault:'lost',when:'x'}]}],
    ['broker op',{...s,broker:[{op:'buy',call:1,fault:'lost'}]}],['broker fault',{...s,broker:[{op:'place-order',call:1,fault:'boom'}]}]])
    assert.throws(()=>validate(bad),/unknown field|one of/,where);
});
test('a scenario whose expectation does not hold fails, naming the scenario and the field',async()=>{
  const s=JSON.parse(fs.readFileSync(path.join(dir,'TEMPLATE.json'),'utf8'));
  await assert.rejects(checkScenario({...s,expect:{sent:['Buy 005930']}}),/TEMPLATE.*expect\.sent/);
});
