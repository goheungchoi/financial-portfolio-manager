// Activity step 3 (artifacts/reviews/2026-11-18-activity-tab): the Today strip, from the app's records only. Counts by
// what happened to each order today (Seoul day), the latest five with origin, not-sent reasons in words; no KIS request.
// Origin is named only on a positive mark; an order with none is "The app" (planner, 2026-11-19).
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {today,stateOf}=require('../electron/activity-today.cjs');const {originOf,reviewIdRows}=require('../electron/order-origin.cjs');
const NOW=Date.parse('2026-11-12T05:00:00Z');// 14:00 KST
const at=hhmm=>Date.parse(`2026-11-12T${hhmm}:00+09:00`);
const o=(id,status,extra={})=>({id,symbol:'005930',side:'Buy',quantity:2,filled:0,status,createdAt:at('10:00'),market:'KR',...extra});

test('what happened to each order, in words',()=>{
  const s=x=>stateOf(x,NOW);
  assert.deepEqual(s(o('a','Filled',{filled:2})),{kind:'filled',label:'Filled'});
  assert.deepEqual(s(o('b','Accepted')),{kind:'open',label:'Open'});
  assert.deepEqual(s(o('c','Partially filled',{filled:1})),{kind:'partly',label:'Partly filled (1 of 2), open'});
  assert.deepEqual(s(o('d','Canceled',{filled:1})),{kind:'partly',label:'Partly filled (1 of 2)'});
  assert.deepEqual(s(o('e','Canceled')),{kind:'canceled',label:'Canceled'});
  assert.deepEqual(s(o('f','Rejected',{reason:'BROKER_REJECTED'})),{kind:'rejected',label:'Rejected by KIS'});
  assert.deepEqual(s(o('g','Rejected',{reason:'ORDER_NOT_SENT',notSentCause:'ticket-expired'})),{kind:'notSent',label:'Not sent',reason:'the check with KIS expired before it was sent'},'a ticket that expired');
  assert.deepEqual(s(o('h','Rejected',{reason:'SESSION_CLOSED'})),{kind:'notSent',label:'Not sent',reason:'the market was closed'});
  assert.deepEqual(s(o('i','Ready',{expiresAt:NOW+60000})),{kind:'waiting',label:'Waiting for your approval'});
  assert.deepEqual(s(o('j','Ready',{expiresAt:NOW-1,reason:'APPROVAL_REQUIRED'})),{kind:'notSent',label:'Not sent',reason:'it needed your approval'});
  assert.equal(s(o('k','Rejected',{reason:'LOSS_LIMIT_REACHED'})).reason,'loss limit reached','an unknown reason in plain words');});

test('origin: only a positive mark names it; an order with none is "The app", never "You"',()=>{
  const reviews=[{id:'R1',orderId:'a',decision:{action:'Buy'}}],conditionals=[{id:'C-1',purpose:'stop_loss',proposalId:'b'},{id:'C-2',purpose:'take_profit',orderId:'c'}];
  // Marked where it is made (order-origin.cjs): a review's order, a conditional order's, an order ticket.
  assert.deepEqual(originOf({id:'n1',madeBy:'review',reviewId:'R9'},{reviews,conditionals}),{origin:'review',label:'AI review',ref:'R9'});
  assert.deepEqual(originOf({id:'n2',madeBy:'conditional',conditionalId:'C-2'},{reviews,conditionals}),{origin:'conditional',label:'Take profit',ref:'C-2'});
  assert.deepEqual(originOf({id:'n3',madeBy:'conditional',conditionalId:'C-gone'},{reviews,conditionals}),{origin:'conditional',label:'Conditional order'},'its conditional order no longer stored');
  assert.deepEqual(originOf({id:'n4',madeBy:'ticket'},{reviews,conditionals}),{origin:'you',label:'You, in the app'});
  // Older orders without a mark: by the records.
  assert.deepEqual(originOf({id:'a'},{reviews,conditionals}),{origin:'review',label:'AI review',ref:'R1'});
  assert.deepEqual(originOf({id:'b'},{reviews,conditionals}),{origin:'conditional',label:'Stop',ref:'C-1'});
  assert.equal(originOf({id:'c'},{reviews,conditionals}).label,'Take profit');
  assert.deepEqual(originOf({id:'z'},{reviews,conditionals}),{origin:'app',label:'The app'},'no mark and no record: no claim');
  assert.deepEqual(originOf({},{}),{origin:'app',label:'The app'});});

test('each path that creates an order marks it: review (first and further orders), conditional, ticket (Korea and U.S.)',()=>{
  const auto=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8'),main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.ok(auto.includes("execution.annotate?.(proposal.id,{madeBy:'review',reviewId:id,...(bounds?{tracking:bounds}:{})});"),'placeOrder, which a batch calls for each order');
  assert.ok(auto.includes("engine.annotate?.(proposal.id,{madeBy:'conditional',conditionalId:order.id"),'fireConditional');
  assert.ok(main.includes("ipcMain.handle('live:propose',liveAction(command=>{const p=live.propose(command);return (p?.id&&live.annotate(p.id,{madeBy:'ticket'}))||p;}));"));
  assert.ok(main.includes("if(name==='propose'&&data?.id)data=usLive.annotate(data.id,{madeBy:'ticket'})??data;"));
  // Every live order creation in electron/: these four, no other (paper and the agent bridge make no live order).
  const callers=fs.readdirSync(path.join(__dirname,'../electron')).filter(f=>f.endsWith('.cjs')).flatMap(f=>(fs.readFileSync(path.join(__dirname,'../electron',f),'utf8').match(/\b(?:live|usLive|execution|engine)\.propose\(|usLive\[name\]/g)??[]).map(m=>f+' '+m)).sort();
  assert.deepEqual(callers,['automation.cjs engine.propose(','automation.cjs execution.propose(','main.cjs live.propose(','main.cjs usLive[name]']);});

test('the review ids for origin are read in SQL, cached, and still match the first and a further order',()=>{
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const big='x'.repeat(60000);const put=(id,p)=>db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify({timestamp:NOW-3600000,context:big,...p}));
  for(let i=0;i<38;i++)put('R'+i,{orderId:'o'+i,proposalId:'p'+i,decision:{action:'Hold',explanation:big}});
  put('R-first',{orderId:'a',proposalId:'a',decision:{action:'Buy'}});
  put('R-batch',{orderId:'q0',proposalId:'q0',decision:{action:'Buy',moreOrders:[{item:1}]},orders:[{item:1,action:'Sell',symbol:'X',quantity:1,proposalId:'q1',orderId:'q1',outcome:big}]});
  const t0=process.hrtime.bigint();const rows=reviewIdRows(db,NOW-2*86400000);const ms=Number(process.hrtime.bigint()-t0)/1e6;
  assert.equal(rows.length,40);assert.ok(!JSON.stringify(rows).includes('xxxx'),'no payload text read');
  assert.deepEqual(originOf({id:'a'},{reviews:rows}),{origin:'review',label:'AI review',ref:'R-first'});
  assert.deepEqual(originOf({id:'q1'},{reviews:rows}),{origin:'review',label:'AI review',ref:'R-batch'},'a further order of a batch');
  const t1=process.hrtime.bigint();assert.equal(reviewIdRows(db,NOW-2*86400000),rows,'cached while the reviews are unchanged');const cachedMs=Number(process.hrtime.bigint()-t1)/1e6;
  put('R-new',{orderId:'n',proposalId:'n',decision:{action:'Buy'}});assert.equal(reviewIdRows(db,NOW-2*86400000).length,41,'a new review is read');
  console.log(`reviewIdRows, 40 reviews of about 120 KB: ${ms.toFixed(1)} ms read, ${cachedMs.toFixed(2)} ms cached`);});

test('today: counts by state, the Seoul day only, the latest five newest first with origin',()=>{
  const intents=[o('a','Filled',{filled:2,brokerOrderId:'1',createdAt:at('09:05'),madeBy:'review',reviewId:'R1'}),o('b','Accepted',{brokerOrderId:'2',createdAt:at('09:10'),madeBy:'ticket'}),
    o('g','Rejected',{reason:'ORDER_NOT_SENT',notSentCause:'ticket-expired',createdAt:at('11:49'),madeBy:'review',reviewId:'R2'}),
    o('f','Rejected',{reason:'BROKER_REJECTED',createdAt:at('12:00')}),o('c','Partially filled',{filled:1,brokerOrderId:'3',createdAt:at('13:00')}),o('i','Ready',{expiresAt:NOW+60000,createdAt:at('13:30')}),
    o('y','Filled',{filled:2,createdAt:Date.parse('2026-11-11T14:59:00Z')}),// 23:59 KST yesterday
    o('x','Filled',{filled:2,createdAt:Date.parse('2026-11-11T15:00:00Z')})];// 00:00 KST today
  const t=today({intents,reviews:[],conditionals:[{id:'C-1',purpose:'stop_loss',proposalId:'c'}],now:NOW});
  assert.equal(t.day,'2026-11-12');
  assert.deepEqual(t.counts,{orders:7,sent:3,filled:2,partly:1,open:1,notSent:1,rejected:1,waiting:1,canceled:0},'yesterday 23:59 is out, today 00:00 is in');
  assert.deepEqual(t.latest.map(r=>r.id),['i','c','f','g','b'],'five, newest first');
  assert.deepEqual(t.latest.map(r=>r.origin),['The app','Stop','The app','AI review','You, in the app'],'unmarked: no claim');
  assert.equal(t.latest.find(r=>r.id==='g').reason,'the check with KIS expired before it was sent');
  assert.equal(today({intents:[],now:NOW}).counts.orders,0);});

test('the IPC reads the app\'s records only, never KIS, and review ids only for unmarked orders; the screen shows the strip on Activity only',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');const h=main.slice(main.indexOf("ipcMain.handle('activity:today'"),main.indexOf("ipcMain.handle('kis:activity-cached'"));
  assert.ok(h.length>0);assert.doesNotMatch(h,/kisService|getActivity|SELECT payload FROM reviews/,'no KIS request, no full review payloads');assert.match(h,/map\(\(\{accountKey,\.\.\.o\}\)=>o\)/,'no account key to the screen');
  assert.match(h,/reviews:unmarked\?O\.reviewIdRows\(store\.db,Date\.now\(\)-2\*86400000\):\[\]/);
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.match(src,/\{mode==='orders'&&connected&&<TodayStrip\/>\}/);assert.match(src,/if\(Date\.now\(\)-last\.current>=10000\)void read\(\)/,'at most every 10 seconds, on the shared feed');
  assert.match(src,/'No orders from the app today\.'/);
  assert.match(fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8'),/getActivityToday: \(\) => ipcRenderer\.invoke\('activity:today'\)/);});

// The origin fields on order records (madeBy, reviewId, conditionalId) never reach a model: every builder of what a
// review is given maps named fields (checked 2026-11-19: live-engine context().orders, automation compact openOrders,
// openOrderView for orderFollowUp/openOrders, the order-update triggerEvidence, note-staleness, position memory view()).
test('origin marks are not passed to a model: the order views reviews are given name their fields',()=>{
  const {Automation}=require('../electron/automation.cjs');const view=Automation.prototype.openOrderView.call({config:{orderTracking:true}},{symbol:'005930',side:'Buy',quantity:1,status:'Accepted',limitPrice:100,madeBy:'review',reviewId:'R1',conditionalId:'C-1',tracking:{bound:99}});
  for(const k of ['madeBy','reviewId','conditionalId'])assert.equal(k in view,false,k);
  const live=fs.readFileSync(path.join(__dirname,'../electron/live-engine.cjs'),'utf8'),auto=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.ok(live.includes("orders:this.orders().filter(row=>['Accepted','Uncertain','Submitting','Partially filled'].includes(row.status)).map(({symbol,side,quantity,filled,status,brokerOrderId,createdAt,reconciledAt})=>"),'review context: named fields');
  assert.ok(auto.includes('openOrders:(c.orders??[]).map(({symbol,side,quantity,filled,status,orderId,placedAt,lastConfirmedAt})=>'),'compact context: named fields');
  assert.ok(auto.includes("this.triggerEvidence={kind:'order',orders:list.map(o=>({id:o.id,symbol:o.symbol,"),'order-update evidence: named fields');});
// 2026-11-19 A(c): a U.S. buy the automatic send refused reads as not sent, in plain words.
test('a purchase refused by the U.S. block reads "automatic U.S. purchases are off"',()=>{
  assert.deepEqual(stateOf({id:'u',symbol:'NASD:NVDA',side:'Buy',quantity:2,filled:0,status:'Rejected',reason:'INTEGRATED_MARGIN_AUTOMATION_BLOCKED',createdAt:Date.now()},Date.now()),
    {kind:'notSent',label:'Not sent',reason:'automatic U.S. purchases are off (integrated margin not verified)'});});
