// A trade's strategy as four axes (audit 2026-11-04, Stage 4): the review gives the horizon; direction, funding and the
// instrument come from the validated order and the security master; every axis is checked against the permissions.
const test=require('node:test');const assert=require('node:assert/strict');const SA=require('../electron/strategy-axes.cjs');const {validateDecision,REVIEW_INSTRUCTIONS}=require('../electron/ai-client.cjs');
const products=[{symbol:'122630',factor:2,kind:'leveraged'},{symbol:'114800',factor:-1,kind:'inverse'}];
const risk=(over={})=>({productRisk:{leveragedEtps:{allowed:true,maxHoldingDays:10},products,credit:{margin:{allowed:true},short:{allowed:true}},...over}});
const order=(action,symbol,credit='none',plan={horizon:'swing',horizonDays:20})=>({action,symbol,quantity:1,credit,plan});
test('direction and funding come from the order; the instrument from the security master, with its factor',()=>{
  assert.deepEqual(SA.axesOf(order('Buy','005930'),risk()),{horizon:'swing',direction:'long',effect:'OPEN_LONG',funding:'cash',instrument:'unleveraged',leverageFactor:1,inverse:false});
  const lev=SA.axesOf(order('Buy','122630'),risk());assert.equal(lev.instrument,'leveraged');assert.equal(lev.leverageFactor,2);assert.equal(lev.inverse,false);
  const inv=SA.axesOf(order('Buy','114800'),risk());assert.equal(inv.instrument,'inverse');assert.equal(inv.inverse,true,'an inverse ETF is long the fund, short the index');assert.equal(inv.direction,'long');
  const cover=SA.axesOf(order('Buy','005930','cover'),risk());assert.equal(cover.direction,'short','a Buy to cover closes a short; it is not a long trade');assert.equal(cover.effect,'CLOSE_SHORT');assert.equal(cover.funding,'borrowed');
  assert.equal(SA.axesOf(order('Sell','005930','short'),risk()).direction,'short');assert.equal(SA.axesOf(order('Buy','005930','margin-buy'),risk()).funding,'margin');
  assert.equal(SA.axesOf({action:'Hold'},risk()),null);
  // A combined review keeps product risk per market.
  assert.equal(SA.axesOf(order('Buy','122630'),{markets:[{market:'KR',productRisk:risk().productRisk},{market:'US'}]}).instrument,'leveraged');
});
test('the compatibility label is derived; an ambiguous combination is unknown, never guessed',()=>{
  assert.equal(SA.label({horizon:'swing',instrument:'unleveraged'}),'swing');assert.equal(SA.label({horizon:'short-term',instrument:'leveraged'}),'leveraged-tactical');
  assert.equal(SA.label({horizon:'long-term',instrument:'inverse'}),'unknown');assert.equal(SA.label({horizon:null,instrument:'unleveraged'}),'unknown');
});
test('every axis of an opening is checked against the permissions; a reduction never is',()=>{
  assert.equal(SA.gap(order('Buy','005930'),risk()),null);
  assert.match(SA.gap(order('Buy','122630'),risk({leveragedEtps:{allowed:false,maxHoldingDays:10}})),/leveraged product \(2x daily\) is not permitted/);
  assert.match(SA.gap(order('Buy','122630','none',{horizon:'swing',horizonDays:30}),risk()),/horizonDays 30 is longer than the 10-day limit/);
  assert.match(SA.gap(order('Buy','005930','margin-buy'),risk({credit:{margin:{allowed:false},short:{allowed:true}}})),/margin buying is not permitted/);
  assert.match(SA.gap(order('Sell','005930','short'),{productRisk:{products:[]}}),/short selling is not permitted/);
  assert.match(SA.gap(order('Buy','005930','none',{horizonDays:20}),risk()),/no horizon/);
  for(const d of [order('Sell','122630'),order('Buy','005930','cover'),order('Sell','005930','margin-sell')])assert.equal(SA.gap(d,{productRisk:{products}}),null,`${d.action} ${d.credit}: a reduction`);
});
const full=(symbol,extra={})=>({action:'Buy',symbol,quantity:1,explanation:'x',credit:'none',loanDate:'',plan:{horizon:'short-term',thesis:'t',invalidation:'i',stopPrice:9000,targetPrice:null,horizonDays:3,confidence:'medium',
  portfolioImpact:{weightBeforePct:0,weightAfterPct:5,related:[],relatedBeforePct:0,relatedAfterPct:5,equityReliable:true,why:'small'},evidence:[{claim:'c',source:'s',verified:true}],valuation:null,uncertainty:null,...extra}});
test('a validated plan carries its axes and derived label; an opening the account does not permit is held back without a repair round',()=>{
  const ok=validateDecision(full('122630'),['122630'],{requirePlan:true,context:risk()});assert.equal(ok.action,'Buy');assert.equal(ok.plan.axes.instrument,'leveraged');assert.equal(ok.plan.strategy,'leveraged-tactical');
  const no=validateDecision(full('122630'),['122630'],{requirePlan:true,context:risk({leveragedEtps:{allowed:false,maxHoldingDays:10}})});
  assert.equal(no.action,'Hold');assert.equal(no.withheld.kind,'permission');assert.match(no.explanation,/not permitted for this account/);
  // The review cannot name the instrument: a plan field for it is not in the schema and is ignored.
  assert.equal(validateDecision(full('122630',{instrument:'unleveraged'}),['122630'],{requirePlan:true,context:risk()}).plan.axes.instrument,'leveraged');
});
test('the instructions state the precedence and the derived axes',()=>{
  assert.match(REVIEW_INSTRUCTIONS,/Precedence: app and broker constraints define what is permitted\. userGuidelines define objectives and preferences within those constraints\. The defaults in these instructions fill gaps where userGuidelines are silent\. Current, reliable evidence determines whether an action is justified; instructions and preferences never override facts\./);
  assert.match(REVIEW_INSTRUCTIONS,/a Buy to cover closes a short and is not a long trade, and a short holding period is not a short position/);assert.doesNotMatch(REVIEW_INSTRUCTIONS,/plan\.strategy/);
});
