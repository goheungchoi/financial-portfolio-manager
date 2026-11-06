// Stage 2b.6 review: the gate report (scripts/stage2b-gate.cjs) passes only on whole, passing runs. Its test processes
// are replaced by fixed TAP output: one run covering every required id passes; each fault fails the gate.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=path.join(__dirname,'../scripts/stage2b-gate.cjs'),source=fs.readFileSync(script,'utf8');
const IDS=['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12','T13','T14','T15','T16','T17','T18','T25a','T25b','T26','T27','T28','T29','T30','T34','T35','T36','T38','T39','T42','T43','T44','T45','T46'];
const tap=(lines,{plan=lines.length,cancelled=0}={})=>['TAP version 13',...lines.map((l,i)=>`${l.startsWith('not ')?'not ok':'ok'} ${i+1} - ${l.replace(/^not /,'')}`),...(plan==null?[]:[`1..${plan}`]),`# tests ${lines.length}`,`# cancelled ${cancelled}`].join('\n')+'\n';
const good=IDS.map(id=>`${id}: covered`);
// Runs the gate with every test process answering reply(file) and returns its exit code and report.
function gate(reply){let written='';const proc={execPath:process.execPath,argv:[process.execPath,script],stdout:{write:t=>{written+=t;}},exitCode:undefined};
  const req=name=>name==='node:child_process'?{spawnSync:(exe,args)=>reply(args.at(-1))}:require(name);
  vm.runInNewContext(source,{require:req,__dirname:path.dirname(script),process:proc});return {code:proc.exitCode,report:written};}
const ok=(stdout)=>({status:0,stdout,stderr:''});
test('control: whole, passing runs covering every id pass the gate',()=>{const r=gate(()=>ok(tap(good)));assert.equal(r.code,0,r.report);assert.match(r.report,/covered and passing: 35/);});
test('a failed process fails the gate, even when every line says ok',()=>{const r=gate(f=>f.endsWith('settlement-panel.test.cjs')?{...ok(tap(good)),status:1}:ok(tap(good)));assert.equal(r.code,1);assert.match(r.report,/Run failed: tests\/settlement-panel\.test\.cjs\*\*: exit 1/);assert.match(r.report,/\| T1 \| \*\*FAIL\*\*/);});
test('a spawn error, or a process killed by a signal, fails the gate',()=>{
  assert.equal(gate(f=>f.endsWith('valuation.test.cjs')?{status:null,signal:'SIGTERM',stdout:tap(good)}:ok(tap(good))).code,1);
  assert.equal(gate(f=>f.endsWith('valuation.test.cjs')?{status:null,error:new Error('ENOENT'),stdout:''}:ok(tap(good))).code,1);});
test('a skipped or todo required test is not a pass',()=>{
  for(const d of ['# SKIP not now','# TODO later','# skip lower case']){const r=gate(()=>ok(tap(good.map(l=>l.startsWith('T26:')?`${l} ${d}`:l))));assert.equal(r.code,1,d);assert.match(r.report,/\| T26 \| \*\*FAIL\*\*/,d);}
  // A name holding an escaped "#" is not a directive.
  assert.equal(gate(()=>ok(tap(good.map(l=>l.startsWith('T26:')?`${l} \\# SKIP is part of the name`:l)))).code,0);});
test('incomplete output fails the gate: fewer results than planned, no plan, no results, a cancelled test',()=>{
  assert.equal(gate(()=>ok(tap(good,{plan:good.length+1}))).code,1,'a result missing');
  assert.equal(gate(()=>ok(tap(good,{plan:null}))).code,1,'no plan');
  assert.equal(gate(f=>f.endsWith('trade-history.test.cjs')?ok(''):ok(tap(good))).code,1,'no output');
  assert.equal(gate(()=>ok(tap(good,{cancelled:1}))).code,1,'cancelled');});
test('a failed test fails the gate, and a missing id is reported',()=>{
  const r=gate(()=>ok(tap(good.map(l=>l.startsWith('T39:')?`not ${l}`:l))));assert.equal(r.code,1);assert.match(r.report,/\| T39 \| \*\*FAIL\*\*/);
  const m=gate(()=>ok(tap(good.filter(l=>!l.startsWith('T45:')))));assert.equal(m.code,1);assert.match(m.report,/\| T45 \| \*\*MISSING\*\*/);});
