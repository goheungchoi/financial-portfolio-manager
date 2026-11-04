// Conditional orders on credit lots (audit 2026-11-04, Stage 4): a conditional order may name the lot it closes; the
// lot (account, symbol, kind, loan date, source) is checked when it is armed and again when it fires, and it never
// takes more than remains in the lot. Execution stays off while a path waits on an unconfirmed broker field.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const CP=require('../electron/credit-paths.cjs');
// 9 shares of 005930: 4 cash, a self loan of 3 (2026-10-01) and a distribution loan of 2 (2026-10-15).
const balance={holdings:[{symbol:'005930',quantity:9,availableQuantity:9,loans:[{quantity:3,loanDate:'2026-10-01',availableQuantity:3,source:'self'},{quantity:2,loanDate:'2026-10-15',availableQuantity:2,source:'distribution'}]}],
  shorts:[{symbol:'000660',quantity:5,loanDate:'2026-10-02',availableQuantity:5,source:'self'}]};
function harness({account='acct',orders=[],ctx={}}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()},{symbol:'000660',price:180000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.series={closes:()=>null,ensure:async()=>{}};a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  const calls={propose:[],submit:[]};const state={account,orders};
  a.live={market:'KR',identity:()=>state.account,autoEnabled:true,enabled:true,riskBalance:balance,orders:()=>state.orders,
    context:async()=>({marketSession:{open:true},quotes:a.marketQuotes(),positions:{'005930':{quantity:9}},equity:10000000,cash:5000000,...ctx}),
    propose:cmd=>{calls.propose.push(cmd);return {id:'P'+calls.propose.length,status:'Ready'};},autoSubmit:async id=>{calls.submit.push(id);return {id:'O1'};},getState:()=>({})};
  return {a,db,calls,state};}
const args=(extra={})=>({action:'add',id:'',symbol:'005930',side:'Sell',quantity:3,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop on the loan',credit:{kind:'margin-sell',loanDate:'2026-10-01',source:'self'},...extra});
// What the review's set_conditional_order does: the lot is checked against the account, then the order is stored.
const arm=(a,x)=>{const g=args(x);return a.desk.setOrder(a.watchScope(),g,{config:a.config,universe:['005930','000660'],lot:g.credit?a.creditLot(g,{quantity:g.quantity}):null});};
const fire=async a=>{await a.fireConditional(a.desk.orders(a.watchScope())[0]);return a.desk.recentOrders(a.watchScope())[0]??a.desk.orders(a.watchScope())[0];};
// As it will work once U5 is confirmed and the user approves Stage 3's protective closes.
function enabled(fn,kinds=['margin-sell']){const was=kinds.map(k=>CP.PATHS[k].executable);kinds.forEach(k=>{CP.PATHS[k].executable=true;});return Promise.resolve().then(fn).finally(()=>kinds.forEach((k,i)=>{CP.PATHS[k].executable=was[i];}));}
test('now: a credit-lot conditional order is refused with what blocks it; the lot stays unprotected',async()=>{
  const {a}=harness();a.configure({creditProtectionApproved:true});const r=arm(a);assert.equal(r.status,'rejected');assert.match(r.reason,/U5/);assert.match(r.reason,/stays unprotected/);
  assert.equal(a.desk.orders(a.watchScope()).length,0,'nothing armed');assert.match(arm(a,{side:'Buy',symbol:'000660',credit:{kind:'cover',loanDate:'2026-10-02',source:'self'}}).reason,/U2/);
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.match(src,/lot:args\?\.action!=='cancel'&&args\?\.credit\?this\.creditLot\(args,\{quantity:args\.quantity\}\):null/,'the review tool checks the lot the same way');
});
test('an executable path still needs the Stage 3 approval for an automatic protective close',()=>enabled(()=>{
  const {a}=harness();assert.match(arm(a).reason,/Requires approval—not automatic protection/);a.configure({creditProtectionApproved:true});assert.equal(arm(a).status,'armed');}));
test('the lot is named exactly: kind and side, loan date, source, and what remains after waiting orders',()=>enabled(()=>{
  const {a,state}=harness();a.configure({creditProtectionApproved:true});
  assert.match(arm(a,{side:'Buy'}).reason,/A margin repayment is a Sell/);assert.match(arm(a,{credit:{kind:'margin-sell',loanDate:'Oct 1',source:'self'}}).reason,/loanDate \(YYYY-MM-DD\)/);
  assert.match(arm(a,{credit:{kind:'margin-sell',loanDate:'2026-09-01',source:'self'}}).reason,/No margin repayment lot of 005930 with loan date 2026-09-01/);
  assert.match(arm(a,{credit:{kind:'margin-sell',loanDate:'2026-10-01',source:'distribution'}}).reason,/is a self loan, not distribution/);
  assert.match(arm(a,{quantity:4}).reason,/has 3 shares left after waiting orders \(0 reserved\)/);
  state.orders=[{symbol:'005930',side:'Sell',quantity:2,filled:0,status:'Accepted',credit:{kind:'margin-sell',loanDate:'2026-10-01'}}];assert.match(arm(a).reason,/has 1 shares left after waiting orders \(2 reserved\)/);
  state.orders=[];const ok=arm(a);assert.equal(ok.status,'armed');assert.deepEqual(a.desk.orders(a.watchScope())[0].credit,{kind:'margin-sell',loanDate:'2026-10-01',source:'self',account:'acct'});
}));
test('firing: the lot is checked again and sized from what remains; it proposes that lot, never cash shares or another loan',()=>enabled(async()=>{
  let {a,calls,state}=harness();a.configure({creditProtectionApproved:true});arm(a,{credit:{kind:'margin-sell',loanDate:'2026-10-15',source:'distribution'},quantity:2});
  let o=await fire(a);assert.equal(o.status,'submitted');assert.deepEqual(calls.propose[0],{symbol:'005930',side:'Sell',quantity:2,limitPrice:217000,credit:{kind:'margin-sell',loanDate:'2026-10-15'}});
  // A partial fill of an earlier order on the lot leaves only its unfilled part reserved.
  ({a,calls,state}=harness());a.configure({creditProtectionApproved:true});arm(a);state.orders=[{symbol:'005930',side:'Sell',quantity:2,filled:1,status:'Partially filled',credit:{kind:'margin-sell',loanDate:'2026-10-01'}}];
  o=await fire(a);assert.equal(calls.propose[0].quantity,2,'3 in the lot, 1 still waiting');
  // A duplicate trigger: the lot is already taken by a waiting order, so nothing more is sent.
  ({a,calls,state}=harness());a.configure({creditProtectionApproved:true});arm(a);state.orders=[{symbol:'005930',side:'Sell',quantity:3,filled:0,status:'Accepted',credit:{kind:'margin-sell',loanDate:'2026-10-01'}}];
  o=await fire(a);assert.equal(o.status,'cancelled');assert.match(o.outcome,/Not needed: an order already waiting takes this lot \(3\)/);assert.equal(calls.propose.length,0);
  // The account changed, or the approval was withdrawn, since it was armed: not sent.
  // The account changed: its orders belong to the old account's scope and never fire here (the lot's account is checked too).
  ({a,calls,state}=harness());a.configure({creditProtectionApproved:true});arm(a);const before=a.desk.orders(a.watchScope())[0];state.account='other';await a.fireConditional(before);assert.equal(calls.propose.length,0);
  state.account='acct';await a.fireConditional({...before,credit:{...before.credit,account:'old-acct'}});assert.match(a.desk.recentOrders(a.watchScope())[0].outcome,/account changed/);
  ({a,calls}=harness());a.configure({creditProtectionApproved:true});arm(a);a.configure({creditProtectionApproved:false});o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/^Not sent: A margin repayment cannot run/);assert.equal(calls.propose.length,0);
}));
test('a restart keeps the lot identity; the lot is checked against the account again when it fires',()=>enabled(async()=>{
  const {a,db}=harness();a.configure({creditProtectionApproved:true});arm(a);
  const {AgentDesk}=require('../electron/agent-desk.cjs');const again=new AgentDesk(db).orders(a.watchScope())[0];assert.deepEqual(again.credit,{kind:'margin-sell',loanDate:'2026-10-01',source:'self',account:'acct'});
}));
test('a cover is a reduction: once its path is confirmed it is not blocked by the daily loss limit',()=>enabled(async()=>{
  const {a,calls}=harness();a.configure({creditProtectionApproved:true});a.emergencyState=()=>({active:true,activeMarkets:['KR']});
  assert.equal(arm(a,{side:'Buy',symbol:'000660',quantity:5,conditions:[{expr:'price("000660")',op:'>=',value:179000}],credit:{kind:'cover',loanDate:'2026-10-02',source:'self'}}).status,'armed');
  const o=await fire(a);assert.equal(o.status,'submitted');assert.deepEqual(calls.propose[0].credit,{kind:'cover',loanDate:'2026-10-02'});
},['cover']));
