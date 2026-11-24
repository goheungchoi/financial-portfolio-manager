'use strict';
// Start and Stop on a Claude trading model (artifacts/reviews/2026-11-18-claude-dry-run-start, cleared fixes 2, 1, 3a).
// 2026-11-18: the user's dry runs offered several orders and recorded the several-orders fingerprint, which the check did
// not count, so Start was refused with the bare code; in that state Stop was refused too and auto trading stayed on.
// No network: every provider is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const M=require('../electron/ai-models.cjs');const RI=require('../electron/review-instructions.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const L=require('../electron/auto-launch.cjs');
const SENTENCE='Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5.';
const record=fingerprint=>({id:'D',timestamp:Date.now(),model:'claude-opus-5-5',calls:3,costUSD:0.33,account:'KIS live',appVersion:'1.5.66',instructions:{version:'review 2026-11-10 orders',fingerprint},answerForm:'enforced'});
function harness(){const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
  a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};return a;}
// On Claude Opus 5.5 and running, with a dry run that counts at the switch.
function onClaude(){const a=harness();a.completedClaudeDryRun=()=>record(RI.fingerprint());
  a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true,enabled:true,autoSubmit:true});
  const stopped=[];a.live={stop:()=>stopped.push('KR'),getState:()=>({})};a.usLive={stop:()=>stopped.push('US'),getState:()=>({})};return {a,stopped};}

test('fix 2: the several-orders fingerprint counts as well as the single-order one; an older one does not',()=>{
  const a=harness();const use=r=>{a.completedClaudeDryRun=()=>r;return a.claudeTradingDryRun();};
  assert.equal(RI.fingerprint(undefined,{orders:true}),'36913349434ce621');assert.equal(RI.fingerprint(),'2e155a5b9452c226');
  assert.ok(use(record('36913349434ce621')),'a several-orders dry run under today\'s text');
  assert.ok(use(record('2e155a5b9452c226')),'a single-order dry run');
  // Risk-off text ('review 2026-11-25', the user's "Yes, both with dry run"): a dry run under 'review 2026-11-24' no longer
  // counts, so Start on Claude asks for a new one once after the update.
  assert.equal(use(record('bdfca4388d263737')),null,'a 2026-11-24 single-order dry run');assert.equal(use(record('ecd1189f47a389f2')),null,'a 2026-11-24 several-orders dry run');
  // S4 ('review 2026-11-24'): reviews are offered run_screen in place of compute, so a dry run under 'review 2026-11-21'
  // (its single and several-orders fingerprints) no longer counts: Start on Claude asks for a new one.
  assert.equal(use(record('56da3eb8fe72bacc')),null,'a 2026-11-21 single-order dry run');assert.equal(use(record('a5bc46e95c6a5a98')),null,'a 2026-11-21 several-orders dry run');
  assert.equal(use(record('d50342a570a47586')),null,'an older fingerprint: a new dry run is needed');
  assert.equal(use(record(RI.fingerprint('proposed',{orders:true}))),null,'the proposed set does not count');
  assert.equal(use(null),null);});

test('fix 2: the switch to Claude saves with a several-orders dry run on record; the advice uses the same check',()=>{
  // With a dry run stored under the 2026-11-24 text, the switch to Claude and Start on it are refused (a new dry run is
  // asked once after the update); one under today's text lets both through (below).
  M.setClaudeTradingForTests(true);try{const old=harness();old.completedClaudeDryRun=()=>record('ecd1189f47a389f2');
    assert.throws(()=>old.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true}),/CLAUDE_TRADING_DRY_RUN/);assert.notEqual(old.config.openaiModel,'claude-opus-5-5');
    assert.throws(()=>old.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true,enabled:true,autoSubmit:true}),/CLAUDE_TRADING_DRY_RUN/);assert.notEqual(old.config.enabled,true);}finally{M.setClaudeTradingForTests(false);}
  M.setClaudeTradingForTests(true);try{const a=harness();a.completedClaudeDryRun=()=>record('36913349434ce621');
    a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true});assert.equal(a.config.openaiModel,'claude-opus-5-5');
    a.configure({enabled:true,autoSubmit:true});assert.equal(a.config.enabled,true,'Start\'s save goes through');}finally{M.setClaudeTradingForTests(false);}
  // automation.cjs: the Review F1 advice is shown when claudeTradingDryRun() is null, so it follows fix 2.
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.match(src,/this\.claudeAdviceShown!==fp&&!this\.claudeTradingDryRun\(\)/);});

test('fix 1: a refused save carries the sentence; Start returns it, the save path keeps the code',()=>{
  M.setClaudeTradingForTests(true);try{const {a}=onClaude();a.configure({enabled:false,autoSubmit:false});a.completedClaudeDryRun=()=>record('d50342a570a47586');
    let caught;try{a.configure({enabled:true,autoSubmit:true});}catch(error){caught=error;}
    assert.equal(caught.message,'CLAUDE_TRADING_DRY_RUN','the code, as the save path and its tests read it');assert.equal(caught.text,SENTENCE);
    assert.equal(a.config.enabled,false,'nothing saved');}finally{M.setClaudeTradingForTests(false);}
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/ipcMain\.handle\('runtime:start'[^\n]*error:error\.text\?\?error\.message/,'Start shows the sentence');
  assert.match(main,/ipcMain\.handle\('runtime:configure'[^\n]*\?error\.message:'INVALID_SETTINGS'/,'the save path still returns the code');});

for(const [name,breakIt] of [
  ['no dry run that counts',a=>{a.completedClaudeDryRun=()=>record('d50342a570a47586');}],
  ['no dry run at all',a=>{a.completedClaudeDryRun=()=>null;}],
  ['the Anthropic key missing',a=>{a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:false};}],
  ['consent off',a=>{a.config={...a.config,shareKisWithAnthropic:false};}]])
  test(`fix 3a: Stop on Claude with ${name} turns auto trading off and stops the engines`,()=>{
    M.setClaudeTradingForTests(true);try{const {a,stopped}=onClaude();breakIt(a);
      assert.throws(()=>a.configure({enabled:true}),/CLAUDE_TRADING_/,'any other save is still refused');
      assert.equal(L.stop(a),'Auto trading stopped. Existing broker orders remain active.');
      assert.deepEqual([a.config.enabled,a.config.autoSubmit],[false,false]);assert.deepEqual(stopped,['KR','US']);
      assert.equal(a.config.openaiModel,'claude-opus-5-5','the trading model is unchanged');}finally{M.setClaudeTradingForTests(false);}});

test('fix 3a: only a save that turns both off, or one of them off, skips the Claude conditions',()=>{
  M.setClaudeTradingForTests(true);try{const {a}=onClaude();a.completedClaudeDryRun=()=>null;
    a.configure({autoSubmit:false});assert.equal(a.config.autoSubmit,false);a.configure({enabled:false});assert.equal(a.config.enabled,false);
    assert.throws(()=>a.configure({enabled:false,desktopAlerts:!a.config.desktopAlerts}),/CLAUDE_TRADING_DRY_RUN/,'another key with it');
    assert.throws(()=>a.configure({enabled:true}),/CLAUDE_TRADING_DRY_RUN/,'turning on');
    assert.throws(()=>a.configure({enabled:false,openaiModel:'claude-opus-5-5'}),/CLAUDE_TRADING_DRY_RUN/,'with the model');}finally{M.setClaudeTradingForTests(false);}});

test('fix 3a: the engines stop even if the save throws, and runtime:stop returns the error instead of rejecting',()=>{
  const stopped=[];const a={config:{scope:'kis'},configure(){throw Object.assign(new Error('X'),{text:'Why.'});},live:{stop:()=>stopped.push('KR')},usLive:{stop:()=>stopped.push('US')}};
  assert.throws(()=>L.stop(a),/^Error: X$/);assert.deepEqual(stopped,['KR','US']);
  assert.match(fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),/ipcMain\.handle\('runtime:stop',event=>\{authorize\(event\);try\{[^\n]*catch\(error\)\{return \{ok:false,error:error\.text\?\?error\.message/);});
