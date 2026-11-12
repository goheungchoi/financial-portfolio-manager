// Step A3, review F1: the Engine settings draft never leaves an agent on a model and effort the engine refuses, and
// the Effort lists offer exactly what the engine accepts. src/agentDraft.mjs is checked against
// electron/agent-models.cjs, the engine's own resolver and validation.
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {AGENT_KEYS,correctAgents,effortOptions,resolved} from '../src/agentDraft.mjs';
const require=createRequire(import.meta.url);const engine=require('../electron/agent-models.cjs');
const base={openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none',scoutModel:'same',scoutEffort:'same',narrativeModel:'same',narrativeEffort:'same',reflectionModel:'same',reflectionEffort:'same'};
const apply=c=>({...c,...correctAgents(c)});
const valid=c=>{try{engine.validate(c);return true;}catch(e){if(e.message==='INVALID_MODEL_SETTINGS'||e.message==='INVALID_SETTINGS')return false;throw e;}};

test('the keys are the engine\'s',()=>{assert.deepEqual(AGENT_KEYS,engine.KEYS);});

test('F1 case 1: an agent on "Same" model with its own effort None, and the trading model set to Astra',()=>{
  for(const [agent,mk,ek] of [['compacting','routineModel','routineEffort'],['reflection','reflectionModel','reflectionEffort']]){
    const before={...base,[mk]:'same',[ek]:'none'};assert.ok(valid(before));
    // setModel moves the trading effort off None only when it was None; here it is Medium and stays.
    const changed={...before,openaiModel:'gpt-6-astra'};assert.equal(valid(changed),false,'the engine would refuse it');
    assert.deepEqual(correctAgents(changed),{[ek]:'low'},agent);
    const after=apply(changed);assert.ok(valid(after));assert.deepEqual(engine.agentModel(after,agent),{openaiModel:'gpt-6-astra',reasoningEffort:'low'});
    assert.ok(effortOptions(after,agent).includes(after[ek]),'the row can show the corrected value');
  }
});

test('F1 case 2: an agent on Astra with effort "Same", and the trading effort set to None',()=>{
  for(const [agent,mk,ek] of [['compacting','routineModel','routineEffort'],['reflection','reflectionModel','reflectionEffort']]){
    const before={...base,openaiModel:'gpt-6-luna',reasoningEffort:'low',[mk]:'gpt-6-astra',[ek]:'same'};assert.ok(valid(before));
    const changed={...before,reasoningEffort:'none'};assert.equal(valid(changed),false);
    assert.deepEqual(correctAgents(changed),{[ek]:'low'},agent);assert.ok(valid(apply(changed)));
  }
});

test('the scout and the narrative are never corrected: the engine raises their None itself',()=>{
  const c={...base,openaiModel:'gpt-6-luna',reasoningEffort:'none',scoutModel:'gpt-6-astra',narrativeModel:'gpt-6-astra'};
  assert.deepEqual(correctAgents(c),{});assert.ok(valid(c));assert.equal(engine.agentModel(c,'scout').reasoningEffort,'low');
});

test('nothing changes when every pair is valid, including the live profile\'s values',()=>{
  assert.deepEqual(correctAgents(base),{});
  assert.deepEqual(correctAgents({...base,openaiModel:'gpt-6-astra',reasoningEffort:'low'}),{},'compacting on its own Luna/None stays');
});

test('every combination: after the correction the engine accepts the draft, and each row\'s value is in its list or marked',()=>{
  const models=['same','gpt-6-luna','gpt-6-sol','gpt-6-astra'],efforts=['same','none','low','medium','high'];
  const trading=[['gpt-6-luna','none'],['gpt-6-luna','high'],['gpt-6-sol','none'],['gpt-6-sol','medium'],['gpt-6-astra','low'],['gpt-6-astra','high']];
  let n=0;
  for(const [tm,te] of trading)for(const m of models)for(const e of efforts)for(const agent of ['compacting','reflection','scout','narrative']){
    const [mk,ek]=AGENT_KEYS[agent];
    if((agent==='scout'||agent==='narrative')&&e==='none')continue; // refused as a choice (INVALID_SETTINGS), never offered
    const c=apply({...base,openaiModel:tm,reasoningEffort:te,[mk]:m,[ek]:e});n++;
    assert.ok(valid(c),JSON.stringify([tm,te,agent,m,e]));
    // After the correction the stored effort is always one the list offers, so the row never needs the marked option.
    assert.ok(effortOptions(c,agent).includes(c[ek]),JSON.stringify([tm,te,agent,m,e,c[ek]]));
    // The correction changes only that agent's own effort, and only when its pair was invalid.
    const fix=correctAgents({...base,openaiModel:tm,reasoningEffort:te,[mk]:m,[ek]:e});
    const r=resolved({...base,openaiModel:tm,reasoningEffort:te,[mk]:m,[ek]:e},agent);
    assert.deepEqual(Object.keys(fix).filter(k=>k===ek).length>0,agent!=='scout'&&agent!=='narrative'&&r.model==='gpt-6-astra'&&r.effort==='none');
  }
  assert.ok(n>400,String(n));
});

test('the Effort lists: no None for the scout, the narrative or Astra; "same" first',()=>{
  assert.deepEqual(effortOptions(base,'compacting'),['same','none','low','medium','high']);
  assert.deepEqual(effortOptions(base,'scout'),['same','low','medium','high']);
  assert.deepEqual(effortOptions({...base,reflectionModel:'gpt-6-astra'},'reflection'),['same','low','medium','high']);
  assert.deepEqual(effortOptions({...base,openaiModel:'gpt-6-astra',reasoningEffort:'low',reflectionModel:'same'},'reflection'),['same','low','medium','high']);
});
