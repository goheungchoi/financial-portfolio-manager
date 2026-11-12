// Replacing a stop loss in one step (step A-R, artifacts/reviews/2026-11-12-engine-settings/plan.md). On 2026-11-12 a
// review cancelled a stop in its last tool round and the next review armed the new one, leaving a share without a stop
// for about 32 minutes, twice. set_conditional_order add now takes replaces:<id>: the new stop is written and the old
// one closed in one transaction; on any refusal or failure the old stop stays armed exactly as it was.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const formula=require('../electron/formula.cjs');const {AgentDesk,ORDER_TOOL,COND_DEFAULTS}=require('../electron/agent-desk.cjs');
const S='both:LIVE',SYM='NYSE:PNR',U=[SYM,'NYSE:RDDT','005930'];
const CONFIG={...COND_DEFAULTS,conditionalOrders:true,conditionalAutoSubmit:true,autoSubmit:true,conditionalMaxActive:5};
const QUOTES=[{symbol:SYM,price:68.5},{symbol:'NYSE:RDDT',price:104.5},{symbol:'005930',price:200000}];
const stop=(value,extra={})=>({action:'add',id:'',symbol:SYM,side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value}],combine:'all',purpose:'stop_loss',expiresInHours:120,reason:'protect',replaces:null,credit:null,...extra});
function world({held=1,config=CONFIG}={}){let now=Date.parse('2026-11-11T15:00:00Z');const db=new DatabaseSync(':memory:');const desk=new AgentDesk(db,()=>now);
  const positions={[SYM]:{quantity:held},'NYSE:RDDT':{quantity:1}};
  const arm=(args,opts={})=>desk.setOrder(opts.scope??S,args,{config:opts.config??config,universe:U,quotes:QUOTES,reviewId:'r',positions:opts.positions??positions,link:opts.link??null});
  const row=id=>{const r=db.prepare('SELECT status,payload FROM conditional_orders WHERE id=?').get(id);return r?{...JSON.parse(r.payload),status:r.status}:null;};
  const count=()=>db.prepare('SELECT COUNT(*) n FROM conditional_orders').get().n;
  return {db,desk,arm,row,count,positions,tick:ms=>{now+=ms;}};}

test('a replace arms the new stop and closes the old one together; the reply names both ids',()=>{
  const w=world();const old=w.arm(stop(58.1));assert.equal(old.status,'armed');w.tick(60000);
  const r=w.arm(stop(64.3,{replaces:old.id}));
  assert.equal(r.status,'armed');assert.equal(r.replaced,old.id);assert.notEqual(r.id,old.id);assert.match(r.note,new RegExp(`${old.id} was cancelled in the same step\\.$`));
  const was=w.row(old.id),now=w.row(r.id);
  assert.equal(was.status,'cancelled');assert.equal(was.closedBy,'agent');assert.equal(was.outcome,`Replaced by ${r.id}`);assert.equal(was.replacedBy,r.id);assert.equal(was.closedAt,now.createdAt,'closed at the same moment');
  assert.equal(now.status,'armed');assert.equal(now.replaces,old.id);assert.equal(now.conditions[0].value,64.3);
  assert.deepEqual(w.desk.orders(S).map(o=>o.id),[r.id],'one armed stop, never two and never none');
  assert.equal(w.desk.recentOrders(S)[0].outcome,`Replaced by ${r.id}`,'Orders and triggers shows the outcome on the old order');
});

test('each refusal of the named order leaves the old stop armed exactly as it was',()=>{
  const w=world();const old=w.arm(stop(58.1));const before=JSON.stringify(w.row(old.id));
  // A closed one, a firing one, another symbol's, a take-profit, another account's, an expired one.
  const closed=w.arm(stop(50,{quantity:1}),{positions:{[SYM]:{quantity:2}}});w.desk.setOrder(S,{action:'cancel',id:closed.id});
  const rddt=w.arm(stop(80,{symbol:'NYSE:RDDT',conditions:[{expr:'price("NYSE:RDDT")',op:'<=',value:80}]}));
  const firing=w.arm(stop(51),{positions:{[SYM]:{quantity:3}}});w.desk.update(w.desk.orders(S).find(o=>o.id===firing.id),{status:'firing',firingAt:Date.parse('2026-11-11T15:00:00Z')});
  const tp=w.arm(stop(90,{purpose:'take_profit',conditions:[{expr:`price("${SYM}")`,op:'>=',value:90}]}));
  const other=w.arm(stop(55),{scope:'both:MOCK'});
  const cases=[
    ['unknown id',stop(64.3,{replaces:'C-nope'}),/No conditional order C-nope on this account/],
    ['closed',stop(64.3,{replaces:closed.id}),/is cancelled, not armed/],
    ['firing',stop(64.3,{replaces:firing.id}),/is being placed now/],
    ['other symbol',stop(64.3,{replaces:rddt.id}),/same symbol and side/],
    ['other side',stop(64.3,{replaces:old.id,side:'Buy'}),/same symbol and side/],
    ['old is not a stop loss',stop(64.3,{replaces:tp.id}),/only from a stop loss to a stop loss/],
    ['new is not a stop loss',stop(64.3,{replaces:old.id,purpose:'exit'}),/only from a stop loss to a stop loss/],
    ['another account',stop(64.3,{replaces:other.id}),/on this account/],
    ['a credit order',stop(64.3,{replaces:old.id,credit:{kind:'margin-sell',loanDate:'2026-11-01',source:'self'}}),/./],
  ];
  for(const [name,args,why] of cases){const n=w.count();const r=w.arm(args);assert.equal(r.status,'rejected',name);assert.match(r.reason,why,name);assert.equal(w.count(),n,`${name}: nothing written`);assert.equal(JSON.stringify(w.row(old.id)),before,`${name}: the old stop is unchanged`);}
  assert.equal(w.row(other.id).status,'armed','the other account\'s order is untouched');assert.equal(w.row(firing.id).status,'firing');
  // Expired by time: closed by the expiry pass, so there is nothing to replace.
  w.tick(121*3600000);const r=w.arm(stop(64.3,{replaces:old.id}));assert.equal(r.status,'rejected');assert.match(r.reason,/is expired, not armed/);
});

test('the new order failing any of its own checks leaves the old stop armed unchanged',()=>{
  const w=world();const old=w.arm(stop(58.1));const before=JSON.stringify(w.row(old.id));
  const cases=[
    ['bad formula',stop(64.3,{replaces:old.id,conditions:[{expr:'foo()',op:'<=',value:1}]})],
    ['symbol outside the universe',stop(64.3,{replaces:old.id,conditions:[{expr:'price("035420")',op:'<=',value:1}]})],
    ['expiry too long',stop(64.3,{replaces:old.id,expiresInHours:9999})],
    ['limit far from the price',stop(64.3,{replaces:old.id,limitPrice:10})],
    ['more than held',stop(64.3,{replaces:old.id,quantity:2})],
    ['quantity zero',stop(64.3,{replaces:old.id,quantity:0})],
  ];
  for(const [name,args] of cases){const n=w.count();const r=w.arm(args);assert.equal(r.status,'rejected',name);assert.equal(w.count(),n,name);assert.equal(JSON.stringify(w.row(old.id)),before,name);}
  const off=w.arm(stop(64.3,{replaces:old.id}),{config:{...CONFIG,conditionalOrders:false}});assert.equal(off.status,'rejected');assert.equal(JSON.stringify(w.row(old.id)),before,'conditional orders off');
});

test('the replaced order\'s shares and cap slot are counted free; more than held is still refused',()=>{
  const w=world({config:{...CONFIG,conditionalMaxActive:2}});const old=w.arm(stop(58.1));w.arm(stop(80,{symbol:'NYSE:RDDT',conditions:[{expr:'price("NYSE:RDDT")',op:'<=',value:80}]}));
  assert.match(w.arm(stop(64.3)).reason,/already cover 1/,'without replaces: refused by the no-stacking rule, as before');
  const r=w.arm(stop(64.3,{replaces:old.id}));assert.equal(r.status,'armed','cap full (2 of 2) and shares covered: the replaced order frees both');
  // Cap: the replaced slot is the only one freed.
  const v=world({config:{...CONFIG,conditionalMaxActive:2}});const a=v.arm(stop(58.1),{positions:{[SYM]:{quantity:3}}});v.arm(stop(57),{positions:{[SYM]:{quantity:3}}});v.arm(stop(80,{symbol:'NYSE:RDDT',conditions:[{expr:'price("NYSE:RDDT")',op:'<=',value:80}]}),{config:{...CONFIG,conditionalMaxActive:3}});
  const capped=v.arm(stop(64.3,{replaces:a.id}),{positions:{[SYM]:{quantity:3}}});assert.equal(capped.status,'rejected');assert.match(capped.reason,/Up to 2 armed/);assert.equal(v.row(a.id).status,'armed');
  // Shares: two stops cover two of three shares; replacing one with two shares is fine, with three is not.
  const x=world({held:3});const s1=x.arm(stop(58.1));x.arm(stop(57));
  assert.match(x.arm(stop(64.3,{replaces:s1.id,quantity:3})).reason,/already cover 1.*would cover 4/);assert.equal(x.row(s1.id).status,'armed');
  assert.equal(x.arm(stop(64.3,{replaces:s1.id,quantity:2})).status,'armed');
});

test('a replace never renews another identical order instead',()=>{
  const w=world({held:1});const old=w.arm(stop(58.1));
  const twin=w.arm(stop(64.3),{positions:{[SYM]:{quantity:2}}});assert.equal(twin.status,'armed');
  const r=w.arm(stop(64.3,{replaces:old.id}));assert.equal(r.status,'rejected','covered by the twin: refused, not renewed');assert.equal(w.row(old.id).status,'armed');assert.equal(w.row(twin.id).renewals,undefined);
});

test('a stop tied to its purchase passes the link on and still covers only what the purchase bought',()=>{
  const w=world({held:0});const link={id:'P-1',market:'US',quantity:1};const old=w.arm(stop(58.1),{link});assert.equal(old.status,'armed');
  assert.match(w.arm(stop(64.3,{replaces:old.id,quantity:2})).reason,/0 shares of NYSE:PNR are held and 1 are being bought/);assert.equal(w.row(old.id).status,'armed');
  const r=w.arm(stop(64.3,{replaces:old.id}));assert.equal(r.status,'armed');assert.deepEqual(w.row(r.id).linkedBuy,{id:'P-1',market:'US',quantity:1});
  assert.equal(w.desk.context(S,CONFIG,[SYM]).conditionalOrders.armed[0].protectsPurchase,'P-1');
});

test('a write failing halfway, or at the start, leaves the old stop armed and no new order',()=>{
  for(const failAt of [1,2]){const w=world();const old=w.arm(stop(58.1));const before=JSON.stringify(w.row(old.id));const n=w.count();
    const write=w.desk.write.bind(w.desk);let calls=0;w.desk.write=(table,item)=>{calls++;if(calls===failAt)throw new Error('SQLITE_IOERR');return write(table,item);};
    const r=w.arm(stop(64.3,{replaces:old.id}));w.desk.write=write;
    assert.equal(r.status,'rejected');assert.match(r.reason,new RegExp(`${old.id} stays armed unchanged`));
    assert.equal(w.count(),n,`failure at write ${failAt}: the new row was rolled back`);assert.equal(JSON.stringify(w.row(old.id)),before);
    assert.equal(w.arm(stop(64.3,{replaces:old.id})).status,'armed','the savepoint was released: the next replace works');}
});

test('inside a caller\'s transaction the replace nests and rolls back only itself',()=>{
  const w=world();const old=w.arm(stop(58.1));w.db.exec('BEGIN');const r=w.arm(stop(64.3,{replaces:old.id}));w.db.exec('COMMIT');assert.equal(r.status,'armed');assert.equal(w.row(old.id).status,'cancelled');
});

test('an add without replaces behaves as before: absent and null give the same rows and replies',()=>{
  const run=extra=>{const w=world({held:1});const out=[w.arm({...stop(58.1),...extra}),w.arm({...stop(58.1),...extra}),w.arm({...stop(60),...extra})];
    return {out:out.map(({id,...r})=>({...r,...(r.reason?{reason:r.reason.replace(/C-[0-9a-f]{6}/g,'C-id')}:{})})),rows:w.desk.orders(S).map(({id,createdAt,expiresAt,...o})=>o)};};
  const {replaces:_,...absent}=stop(0);const a=run({replaces:undefined}),b=run({replaces:null}),c=run({replaces:''});
  assert.deepEqual(a,b);assert.deepEqual(a,c);
  assert.equal(a.out[0].status,'armed');assert.equal(a.out[1].renewed,true,'the identical order is renewed');assert.match(a.out[2].reason,/Cancel one first, or send the identical order again to extend it\./);
  assert.equal(a.rows.length,1);assert.equal(a.rows[0].replaces,undefined,'no replaces field on a plain add');assert.ok(absent);
});

test('the stop fires at the new level and not at the old one',()=>{
  const w=world();const old=w.arm(stop(58.1));const r=w.arm(stop(64.3,{replaces:old.id}));
  // The firing loop (automation.cjs, tick): every armed order of the scope, checked against the latest prices.
  const fires=price=>w.desk.orders(S).filter(o=>formula.checkConditions(o.conditions,o.combine,{price:s=>s===SYM?price:null,closes:()=>null,previousClose:()=>null}).met).map(o=>o.id);
  assert.deepEqual(fires(66),[]);assert.deepEqual(fires(64),[r.id],'between the levels: the new stop fires');assert.deepEqual(fires(58),[r.id],'below both: only the new one, once');
});

test('the tool: replaces is a required nullable field and the description says what it does, neutrally',()=>{
  const p=ORDER_TOOL.parameters;assert.deepEqual(p.properties.replaces,{type:['string','null']});assert.ok(p.required.includes('replaces'));
  assert.ok(ORDER_TOOL.description.includes('replaces is null, or with action "add" the id of an armed stop loss for the same symbol and side: the new stop loss is armed and that order cancelled together, and if the new one is refused, that order stays armed unchanged.'));
  assert.ok(!/should|prefer|always use/i.test(ORDER_TOOL.description.match(/replaces is null[^.]*\.[^.]*\./)[0]));
  assert.equal(require('../electron/ai-client.cjs').INSTRUCTIONS_VERSION,'review 2026-11-12');
});

test('the console gets one entry with both ids and both levels',()=>{
  const w=world();const old=w.arm(stop(58.1));const r=w.arm(stop(64.3,{replaces:old.id}));const logs=[];
  require('../electron/automation.cjs').Automation.prototype.logStopReplaced.call({desk:w.desk,log:(...a)=>logs.push(a)},S,'rev-1',old.id,r.id);
  assert.deepEqual(logs,[['rev-1','System',`Stop loss replaced: ${old.id} → ${r.id}`,`${SYM} Sell 1: <= 58.1 → <= 64.3`]]);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.match(src,/if\(reply\.replaced\)this\.logStopReplaced\(scope,reviewId,reply\.replaced,reply\.id\);/);
  assert.doesNotThrow(()=>require('../electron/automation.cjs').Automation.prototype.logStopReplaced.call({desk:null,log:()=>{throw new Error('x');}},S,'r','a','b'));
});
