// M-4 (multi-order, artifacts/reviews/2026-11-16-multi-order/m4-plan.md, condition A): at one order per review, every
// byte the app sends the AI and every record it writes stay today's. Pinned before M-4's code, and never changed after:
// the OpenAI decision schema (every variant), the Claude flat forms (their hashes; the forms themselves are
// tests/fixtures/claude-flat-schemas.json, checked by tests/claude-enforced.test.cjs), the Claude form's format text and
// its text parts, and a single-order review's record shape (no moreOrders, no orders list). The instruction text and its
// versions are pinned by tests/review-instructions.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const C=require('../electron/ai-client.cjs'),A=require('../electron/anthropic-client.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const sha=t=>crypto.createHash('sha256').update(t).digest('hex').slice(0,16);
const variants=f=>{const out={};for(const b of [false,true])for(const p of [false,true])for(const t of [false,true])out[[b,p,t].map(Number).join('')]=sha(JSON.stringify(f(b,p,t)));return out;};
test('pin: the OpenAI decision schema, every variant (brief, plan verdicts, trailing), byte for byte',()=>{
  assert.deepEqual(variants((b,p,t)=>C.decisionSchema(b,p,t)),{'000':'d6e603f3890f7716','001':'98f9b0b056bef575','010':'08c200836eb7d292','011':'bf46639a5b431370','100':'096628d3e4bd4f31','101':'2600a555dc1e171d','110':'a1b465d47e5ef0c4','111':'2a2c72acf7be7f7d'});
});
test('pin: the Claude flat forms, every variant, and the format text and its text parts, byte for byte',()=>{
  assert.deepEqual(variants((b,p,t)=>A.flatDecisionSchema(b,p,t)),{'000':'1bbd4abf7a607551','001':'6255b9c2cda3356d','010':'00e91e050431f807','011':'d68e17b3d89ac8c9','100':'d7f93ea00714fac5','101':'006bcbe7b69c69ce','110':'050deaa7335b632e','111':'001ca82a0ac2f846'});
  assert.equal(sha(A.FORMAT_TEXT),'2d35248e49647faa');assert.deepEqual([...A.TEXT_PARTS],['strategyCheck','scoutBrief','planVerdicts']);
});
test('pin: a single-order review\'s record has today\'s fields: no moreOrders, no orders list',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();h.automation();
  h.decide({action:'Buy',symbol:'005930',quantity:10,plan:null});await h.a.review('User request').catch(()=>{});
  const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);
  assert.deepEqual(Object.keys(r).sort(),['account','alerts','assessed','contextEvidence','decision','emergency','executionNote','formulaUse','id','instructions','marketSession','model','orderId','proposalId','provider','research','scope','timestamp','trigger','triggerSymbols','usage','vendor']);
  assert.deepEqual(Object.keys(r.decision).sort(),['action','explanation','plan','quantity','symbol']);
});
