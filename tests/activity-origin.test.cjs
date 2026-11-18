// Activity step 4 (artifacts/reviews/2026-11-18-activity-tab): each KIS row of the period says where its order came
// from; orders the app decided but did not send are listed with the reason and left out of the totals; a review's
// order records how it was sent (sentBy) from now on.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {labelRows}=require('../electron/activity-origin.cjs');const {originOf}=require('../electron/order-origin.cjs');
const at=s=>Date.parse(s+'+09:00');
const row=(orderId,extra={})=>({id:orderId,orderId,originalOrderId:null,symbol:'005930',name:'Samsung',side:'Buy',quantity:1,filled:1,executionAmount:60000,timestamp:at('2026-11-11T10:00'),market:'KR',currency:'KRW',...extra});

test('a review\'s order says how it was sent; older orders make no claim',()=>{
  assert.equal(originOf({id:'a',madeBy:'review',sentBy:'auto'}).label,'AI review · sent automatically');
  assert.equal(originOf({id:'a',madeBy:'review',sentBy:'you'}).label,'AI review · approved by you');
  assert.equal(originOf({id:'a',madeBy:'review'}).label,'AI review');
  assert.equal(originOf({id:'a',madeBy:'ticket',sentBy:'you'}).label,'You, in the app');});

test('KIS rows: the app\'s own numbers carry its origin; a revision made elsewhere and an unknown order are said so',()=>{
  const intents=[{id:'i1',market:'KR',quantity:1,brokerOrderId:'0001234500',brokerOrderIds:['0001234500','0001239900'],madeBy:'review',sentBy:'auto'},
    {id:'i2',market:'KR',quantity:1,brokerOrderId:'0000500',madeBy:'conditional',conditionalId:'C-1'}];
  const rows=[row('1234500',{filled:0,executionAmount:0}),row('1239900',{originalOrderId:'1234500'}),row('500',{side:'Sell'}),row('501',{originalOrderId:'500',side:'Sell',filled:0,executionAmount:0}),row('900'),
    row('77',{market:'US',currency:'USD',channel:'MTS'}),row('500',{market:'US',currency:'USD',id:'us500'})];
  const out=labelRows(rows,intents,{conditionals:[{id:'C-1',purpose:'stop_loss'}]});const by=id=>out.find(r=>r.id===id);
  assert.equal(by('1234500').origin,'AI review · sent automatically');assert.equal(by('1239900').origin,'AI review · sent automatically','the app\'s own revision');
  assert.equal(by('500').origin,'Stop');assert.equal(by('501').origin,'Changed outside the app');assert.match(by('501').originDetail,/a revision of the app's order \(Stop\)/);
  assert.equal(by('900').origin,'Outside the app');assert.equal(by('77').origin,'Outside the app');assert.equal(by('77').originDetail,'KIS channel: MTS');
  assert.equal(by('us500').origin,'Outside the app','another market\'s number is not the app\'s order');});

test('not-sent orders of the period are listed with their reason, newest first, and never counted',()=>{
  const intents=[{id:'n1',market:'KR',symbol:'990010',name:'Hanbit Foods',side:'Buy',quantity:2,status:'Rejected',reason:'ORDER_NOT_SENT',notSentCause:'ticket-expired',createdAt:at('2026-11-11T11:49'),madeBy:'review',limitPrice:150000},
    {id:'n2',market:'KR',symbol:'005930',side:'Buy',quantity:1,status:'Rejected',reason:'SESSION_CLOSED',createdAt:at('2026-10-01T09:00')},// before the period
    {id:'n3',market:'KR',symbol:'005930',side:'Buy',quantity:1,status:'Rejected',reason:'BROKER_REJECTED',createdAt:at('2026-11-11T12:00'),brokerOrderId:'1'}];// rejected by KIS: in KIS history
  const out=labelRows([row('900',{timestamp:at('2026-11-11T12:30')})],intents,{startDate:'2026-10-13',endDate:'2026-11-11'});
  assert.deepEqual(out.map(r=>r.id),['900','not-sent:n1']);const n=out[1];
  assert.deepEqual([n.status,n.notSent,n.reason,n.filled,n.executionAmount,n.origin,n.name],['Not sent',true,'the check with KIS expired before it was sent',0,0,'AI review','Hanbit Foods']);
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.match(src,/const counted=orders\.filter\(o=>!o\.notSent\);/);assert.match(src,/const summary=executionSummary\(counted\)/,'never in the totals');
  assert.match(src,/className=\{order\.notSent\?'muted not-sent':''\}/,'greyed');assert.match(src,/'Side \/ status','From'/);});

test('sentBy is written where the order goes out; main labels the period; review ids only for unmarked orders',()=>{
  assert.ok(fs.readFileSync(path.join(__dirname,'../electron/live-engine.cjs'),'utf8').includes("order={...order,status:'Submitting',sentBy:automatic?'auto':'you'};this.save(order);"));
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/require\('\.\/activity-origin\.cjs'\)\.labelRows\(data\.orders,intents,\{reviews:unmarked\?O\.reviewIdRows\(store\.db,since\):\[\],conditionals:O\.conditionalRows\(store\.db\),startDate,endDate\}\)/);
  assert.ok(main.indexOf('markChains(data.orders,intents)')<main.indexOf('labelRows(data.orders,intents'),'the guard marks first');});

// Step 5: one short line under the title; the explanation behind More; the old "origin is unknown" text is gone.
test('copy: one line, the rest behind More, nothing claims the origin is unknown',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.doesNotMatch(src,/origin is unknown/);
  assert.ok(src.includes("'Orders in both markets, newest first. Totals are what KIS reports.'"));assert.ok(src.includes("'Realized profit as KIS reports it, not total return.'"));
  assert.match(src,/<details className="inline-help" aria-label="About this report: more"><summary>More<\/summary>/);
  assert.match(src,/The app stores the last order history it read\./,'said where it is read');});
// The planner's remark on activity-rows-dark.png (run-BBUX3p): with From, "Ordered / executed" and "Remaining" touched.
test('the orders table: headers padded like the cells, and it scrolls in its card below 920 px',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../src/polish.css'),'utf8');
  assert.ok(src.includes('<div className="table-scroll"><table className="activity-orders">'));
  assert.match(css,/\.activity-orders\{min-width:920px\}/);assert.match(css,/\.activity-orders th\{padding-right:12px\}/);});
