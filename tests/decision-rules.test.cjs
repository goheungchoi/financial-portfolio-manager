// Every refusal of a final decision names the rule it broke (2026-11-10 incident: two live reviews at 09:01 and 09:04
// failed as INVALID_AI_RESPONSE with no reason, so the cause could not be found afterwards). The detail carries the rule
// and the decision's action, symbol, quantity and credit, never its explanation; it reaches the review log through the
// provider worker and ai-errors.ruleDetail.
const test=require('node:test');const assert=require('node:assert/strict');
const {validateDecision}=require('../electron/ai-client.cjs');const E=require('../electron/ai-errors.cjs');
const base={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'private reasoning that must not be logged'};
const refusal=(v,symbols=['005930'])=>{try{validateDecision(v,symbols);}catch(e){assert.equal(e.message,'INVALID_AI_RESPONSE');return {detail:e.detail,line:E.ruleDetail(e)};}assert.fail('accepted: '+JSON.stringify(v));};
test('each decision rule is named, with the trade fields and never the explanation',()=>{
  const cases=[
    [{...base,quantity:1},/a Hold with a quantity other than 0/,/Decision: Hold 1\./],
    [{...base,action:'Buy',symbol:'999999',quantity:1},/a Buy of a symbol outside this review's tradable list \(1 symbols\)/,/Decision: Buy 1 999999\./],
    [{...base,action:'Sell',symbol:'005930',quantity:0},/a Sell quantity outside 1 to 1,000/,/Decision: Sell 0 005930/],
    [{...base,action:'Buy',symbol:'005930',quantity:1001},/a Buy quantity outside 1 to 1,000/,/Buy 1001 005930/],
    [{...base,action:'Buy',symbol:'005930',quantity:1.5},/a quantity that is not a whole number/,/Buy 1.5 005930/],
    [{...base,action:'Wait'},/an action other than Hold, Buy or Sell/,/Wait/],
    [{...base,symbol:5},/a symbol that is not text/,/./],
    [{...base,explanation:7},/an explanation that is not text/,/./],
    [{...base,loanDate:'2026-11-10T09'},/a loanDate that is not text of at most 10 characters/,/./],
    [{...base,credit:'short'},/credit short with the action Hold \(it needs Sell\)/,/credit short/],
    [{...base,action:'Buy',symbol:'005930',quantity:1,credit:'cash'},/a credit value other than none, margin-buy, margin-sell, short or cover/,/credit cash/],
    [{...base,action:'Sell',symbol:'005930',quantity:1,credit:'margin-sell'},/credit margin-sell without a loanDate in YYYY-MM-DD form/,/Sell 1 005930, credit margin-sell/],
    [{...base,extra:1},/decision fields unexpected extra/,/./],
    [(({loanDate,...r})=>r)({...base,credit:'short'}),/decision fields missing loanDate/,/./],
    ['Hold',/a decision that is not an object/,/^ Rule: a decision that is not an object\.$/],
  ];
  for(const [v,rule,line] of cases){const r=refusal(v);assert.match(r.detail.rule,rule,JSON.stringify(v));assert.match(r.line,rule);assert.match(r.line,line);assert.ok(!r.line.includes('private reasoning'),'no explanation text');assert.ok(!JSON.stringify(r.detail).includes('private reasoning'));}
  // What passes still passes.
  assert.equal(validateDecision(base,['005930']).action,'Hold');assert.equal(validateDecision({...base,action:'Sell',symbol:'005930',quantity:1},['005930']).quantity,1);
  assert.equal(validateDecision({...base,action:'Sell',symbol:'005930',quantity:1,credit:'margin-sell',loanDate:'2026-11-01'},['005930']).credit,'margin-sell');
});
test('a symbol from the model is reduced to symbol characters in the detail',()=>{
  const r=refusal({...base,action:'Buy',symbol:'<b>005930 + "x"</b>',quantity:1});assert.equal(r.detail.decision.symbol,'b005930xb');assert.ok(!/[<>"]/.test(r.line));
});
test('the provider worker forwards the decision summary with the rule; the review log line carries both',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/provider-worker.cjs'),'utf8');
  assert.match(src,/error\.detail\.decision&&typeof error\.detail\.decision==='object'\?\{decision:Object\.fromEntries\(\['action','symbol','quantity','credit'\]/);
  const e=Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule:'a Hold with a quantity other than 0',decision:{action:'Hold',symbol:'',quantity:3,credit:'none'}}});
  assert.equal(E.detail('INVALID_AI_RESPONSE','AI research and decision',e),'The model returned an invalid decision. No order was submitted. Stage: AI research and decision. Rule: a Hold with a quantity other than 0. Decision: Hold 3.');
});
test('the other unexplained refusals name themselves too',()=>{
  const fs=require('node:fs'),path=require('node:path');const client=fs.readFileSync(path.join(__dirname,'../electron/ai-client.cjs'),'utf8'),rr=fs.readFileSync(path.join(__dirname,'../electron/research-review.cjs'),'utf8');
  assert.match(client,/above the 100 KB limit/);assert.match(rr,/throw protocolError\(`no decision after \$\{ROUNDS\} research rounds`/);
  assert.equal((rr.match(/throw new Error\('INVALID_AI_RESPONSE'\)/g)??[]).length,0,'research-review has no bare refusal left');
  const body=client.slice(client.indexOf('function checkDecision'),client.indexOf('return value;',client.indexOf('function checkDecision')));assert.equal((body.match(/new Error\('INVALID_AI_RESPONSE'\)\)/g)??[]).length,0,'checkDecision has no bare refusal left');
});
