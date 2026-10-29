const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {resolve}=require('../electron/order-chain.cjs');
const row=(orderId,extra={})=>({orderId,originalOrderId:null,kind:'order',quantity:1,filled:0,remaining:1,orderPrice:287.64,fillPrice:null,status:'Pending',...extra});

test('a revision made in KIS is followed: tonight’s GOOGL sell filled at $280 under a new order number',()=>{
  // 2026-10-29: the app's 0030715248 at $287.64 was revised in the KIS app and filled at $280.
  const order={brokerOrderId:'0030715248',quantity:1};
  const rows=[row('0030715248',{remaining:0}),row('0030716001',{originalOrderId:'0030715248',kind:'revision',orderPrice:280,filled:1,remaining:0,fillPrice:280,status:'Filled'})];
  const r=resolve(order,rows);assert.equal(r.status,'Filled');assert.equal(r.filled,1);assert.equal(r.fillPrice,280);assert.equal(r.current,'0030716001');assert.deepEqual(r.chain,['0030715248','0030716001']);
  assert.deepEqual(r.outside,[{orderId:'0030716001',from:'0030715248',kind:'revision',price:280}],'not made by the app: you took it over');
  assert.deepEqual(resolve({...order,brokerOrderIds:['0030715248','0030716001']},rows).outside,[],'a revision the app made is its own');
});
test('cancellations, partial fills across revisions, an unknown order and a still-open revision',()=>{
  const order={brokerOrderId:'A',quantity:10};
  assert.equal(resolve(order,[row('A',{quantity:10,remaining:0}),row('C',{originalOrderId:'A',kind:'cancel',quantity:10,status:'Canceled'})]).status,'Canceled','cancelled in KIS');
  const partial=resolve(order,[row('A',{quantity:10,filled:4,remaining:0,fillPrice:100}),row('B',{originalOrderId:'A',kind:'revision',quantity:6,filled:6,fillPrice:95,status:'Filled'})]);
  assert.equal(partial.status,'Filled');assert.equal(partial.filled,10);assert.equal(partial.fillPrice,97,'weighted: 4 at 100 and 6 at 95');
  const open=resolve(order,[row('A',{quantity:10,filled:4,remaining:0,fillPrice:100}),row('B',{originalOrderId:'A',kind:'revision',quantity:6,remaining:6,orderPrice:99})]);
  assert.equal(open.status,'Partially filled');assert.equal(open.current,'B');assert.equal(open.currentPrice,99);assert.equal(open.remaining,6);
  const twice=resolve(order,[row('A',{quantity:10,remaining:0}),row('B',{originalOrderId:'A',kind:'revision',quantity:10,remaining:0}),row('D',{originalOrderId:'B',kind:'revision',quantity:10,filled:10,averagePrice:98,status:'Filled'})]);
  assert.equal(twice.status,'Filled');assert.deepEqual(twice.chain,['A','B','D']);assert.equal(twice.fillPrice,98,'Korean history gives averagePrice');
  assert.equal(resolve({brokerOrderId:'Z',quantity:1},[row('A')]),null,'not in the history yet');
  assert.equal(resolve(order,[row('A',{quantity:10,filled:3,remaining:0,fillPrice:100,status:'Partially filled / canceled'})]).status,'Canceled','partly filled then cancelled keeps its fills');
  assert.equal(resolve(order,[row('A',{quantity:10,filled:3,remaining:0,fillPrice:100,status:'Partially filled / canceled'})]).filled,3);
});
test('the engine keeps every KIS order, closes the stuck order from its revision and stops tracking what you took over',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct:US',environment:'live',reportedTotal:600,cash:0,holdings:[]};
  const history={orders:[row('0030715248',{remaining:0}),row('0030716001',{originalOrderId:'0030715248',kind:'revision',orderPrice:280,filled:1,remaining:0,fillPrice:280,status:'Filled'}),row('0030799999',{orderPrice:150,status:'Pending',symbol:'NASD:NVDA'})]};
  const e=new LiveEngine(db,{request:async op=>op==='orders'?history:{}},()=>({status:'connected',snapshot}),{market:'US'});
  const order={id:'o1',accountKey:'acct:US',symbol:'NASD:GOOGL',side:'Sell',quantity:1,limitPrice:287.64,status:'Accepted',brokerOrderId:'0030715248',day:e.day(),market:'US'};e.save(order);
  await e.reconcile();const saved=e.orders().find(o=>o.id==='o1');
  assert.equal(saved.status,'Filled');assert.equal(saved.fillPrice,280);assert.equal(saved.currentBrokerOrderId,'0030716001');assert.ok(saved.handsOff,'revised outside the app');assert.ok(Number.isFinite(saved.filledObservedAt));
  assert.deepEqual(e.history().map(r=>r.orderId),['0030715248','0030716001','0030799999'],'every order KIS lists, the app’s or not');
  history.orders.push(row('0030800000',{orderPrice:149}));await e.syncHistory();assert.equal(e.history().length,4,'synced without an open app order');
});
test('U.S. order history carries the original order number and marks revisions and cancellations',async()=>{
  const {OverseasClient}=require('../electron/kis-overseas.cjs');const c=Object.create(OverseasClient.prototype);c.identity=()=>({environment:'live'});c.clock=()=>Date.parse('2026-10-29T14:00:00Z');
  const base={ovrs_excg_cd:'NASD',pdno:'GOOGL',sll_buy_dvsn_cd:'01',ft_ord_qty:'1',ft_ccld_qty:'0',nccs_qty:'0',ft_ord_unpr3:'287.64',ft_ccld_unpr3:'0',rjct_rson:'',rvse_cncl_dvsn:'00',orgn_odno:''};
  c.pages=async()=>[{...base,odno:'0030715248'},{...base,odno:'0030716001',orgn_odno:'0030715248',rvse_cncl_dvsn:'01',ft_ord_unpr3:'280',ft_ccld_qty:'1',ft_ccld_unpr3:'280'},{...base,odno:'0030716002',orgn_odno:'0030716001',rvse_cncl_dvsn:'02'}];
  const {orders}=await c.orders('2026-10-29');
  assert.deepEqual(orders.map(o=>[o.orderId,o.originalOrderId,o.kind,o.status]),[['0030715248',null,'order','Pending'],['0030716001','0030715248','revision','Filled'],['0030716002','0030716001','cancel','Canceled']]);
});
const reply=body=>new Response(JSON.stringify(body));
test('Korean revise and cancel send order-rvsecncl for all unfilled shares; a refusal and an unclear reply are told apart',async()=>{
  const {KisReadOnlyClient}=require('../electron/kis-client.cjs');let answer={rt_cd:'0',output:{ODNO:'0000123457',KRX_FWDG_ORD_ORGNO:'06010'}};const calls=[];
  const client=env=>new KisReadOnlyClient({environment:env,appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async(url,options)=>{calls.push({url,options});if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('order-rvsecncl'))return reply(answer);throw new Error('Unexpected '+url);},async()=>{});
  const live=client('live');const r=await live.reviseOrder({originalOrderId:'0000123456',organization:'06010',price:60100});
  const sent=calls.find(c=>c.url.includes('order-rvsecncl'));const body=JSON.parse(sent.options.body);
  assert.equal(sent.options.headers.tr_id,'TTTC0013U');assert.deepEqual([body.ORGN_ODNO,body.KRX_FWDG_ORD_ORGNO,body.RVSE_CNCL_DVSN_CD,body.ORD_UNPR,body.QTY_ALL_ORD_YN,body.ORD_QTY,body.ORD_DVSN,body.EXCG_ID_DVSN_CD],['0000123456','06010','01','60100','Y','0','00','KRX']);
  assert.deepEqual([r.brokerOrderId,r.organization],['0000123457','06010']);
  calls.length=0;await client('mock').reviseOrder({originalOrderId:'0000123456',organization:'06010',cancel:true});const c=calls.find(x=>x.url.includes('order-rvsecncl'));
  assert.equal(c.options.headers.tr_id,'VTTC0013U');assert.deepEqual([JSON.parse(c.options.body).RVSE_CNCL_DVSN_CD,JSON.parse(c.options.body).ORD_UNPR],['02','0']);
  await assert.rejects(live.reviseOrder({originalOrderId:'x',price:1}),/INVALID_REQUEST/);await assert.rejects(live.reviseOrder({originalOrderId:'1',price:100.5}),/INVALID_REQUEST/,'Korean prices are whole won');
  answer={rt_cd:'1',msg1:'already filled'};await assert.rejects(live.reviseOrder({originalOrderId:'1',organization:'1',price:100}),/BROKER_REJECTED/);
  answer={rt_cd:'0',output:{}};await assert.rejects(live.reviseOrder({originalOrderId:'1',organization:'1',price:100}),/ORDER_UNCERTAIN/);
});
test('U.S. revise and cancel send order-rvsecncl for the unfilled shares, in the regular session only',async()=>{
  const {OverseasClient}=require('../electron/kis-overseas.cjs');const calls=[];let fail=null;
  const c=new OverseasClient({overseasRequest:async(path,tr,params,options)=>{calls.push({path,tr,params,options});if(fail){const e=new Error(fail);e.code=fail;throw e;}return {body:{rt_cd:'0',output:{ODNO:'0030716001'}}};},overseasIdentity:()=>({environment:'live'})});
  c.identity=()=>({environment:'live'});c.clock=()=>Date.parse('2026-10-29T14:00:00Z');
  const r=await c.revise({symbol:'NASD:GOOGL',originalOrderId:'0030715248',quantity:1,price:279.5});assert.equal(r.brokerOrderId,'0030716001');
  assert.match(calls[0].path,/order-rvsecncl$/);assert.equal(calls[0].tr,'TTTT1004U');assert.deepEqual(calls[0].options,{post:true});
  assert.deepEqual([calls[0].params.OVRS_EXCG_CD,calls[0].params.PDNO,calls[0].params.ORGN_ODNO,calls[0].params.RVSE_CNCL_DVSN_CD,calls[0].params.ORD_QTY,calls[0].params.OVRS_ORD_UNPR],['NASD','GOOGL','0030715248','01','1','279.50']);
  await c.revise({symbol:'NASD:GOOGL',originalOrderId:'0030715248',quantity:1,cancel:true});assert.deepEqual([calls[1].params.RVSE_CNCL_DVSN_CD,calls[1].params.OVRS_ORD_UNPR],['02','0']);
  c.identity=()=>({environment:'mock'});await c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:1,price:280});assert.equal(calls[2].tr,'VTTT1004U');
  await assert.rejects(c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:1,price:280.123}),/INVALID_ORDER/);await assert.rejects(c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:0,price:280}),/INVALID_ORDER/);
  fail='BROKER_REJECTED';await assert.rejects(c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:1,price:280}),/BROKER_REJECTED/);fail='REQUEST_FAILED';await assert.rejects(c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:1,price:280}),/ORDER_UNCERTAIN/);
  fail=null;c.clock=()=>Date.parse('2026-10-29T12:00:00Z');await assert.rejects(c.revise({symbol:'NASD:GOOGL',originalOrderId:'1',quantity:1,price:280}),/SESSION_CLOSED/);
});
function engine({market='US',history={orders:[]},revise}={}){const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const sent=[];
  const snapshot={accountKey:market==='US'?'acct:US':'acct',environment:'mock',reportedTotal:1e6,cash:1e6,holdings:[]};
  const e=new LiveEngine(db,{request:async(op,data)=>{sent.push([op,data]);if(op==='orders')return history;if(op==='revise-order')return revise?revise(data.command):{brokerOrderId:'R'+sent.filter(s=>s[0]==='revise-order').length,organization:'06010'};return {};}},()=>({status:'connected',snapshot}),{market});
  const add=(extra={})=>{const o={id:'o1',accountKey:snapshot.accountKey,symbol:market==='US'?'NASD:GOOGL':'005930',side:'Sell',quantity:3,limitPrice:market==='US'?287.64:60000,status:'Accepted',brokerOrderId:'B1',organization:'06010',day:e.day(),market,...extra};e.save(o);return o;};
  return {e,sent,add,history};}
test('the engine revises its own order: the new number joins its chain, so history keeps it as the app’s',async()=>{
  const {e,sent,add,history}=engine();add();
  const r=await e.revise('o1',{price:279.5});assert.deepEqual(sent[0],['revise-order',{command:{originalOrderId:'B1',organization:'06010',symbol:'NASD:GOOGL',side:'Sell',quantity:3,price:279.5,cancel:false}}]);
  assert.deepEqual(r.brokerOrderIds,['B1','R1']);assert.equal(r.currentBrokerOrderId,'R1');assert.equal(r.currentPrice,279.5);assert.equal(r.revisions.length,1);
  await e.revise('o1',{price:278.9});assert.equal(sent[1][1].command.originalOrderId,'R1','the next revision starts from the latest number');
  history.orders=[row('B1',{quantity:3,remaining:0}),row('R1',{originalOrderId:'B1',kind:'revision',quantity:3,remaining:0}),row('R2',{originalOrderId:'R1',kind:'revision',quantity:3,remaining:3,orderPrice:278.9})];
  await e.reconcile();const o=e.orders()[0];assert.equal(o.handsOff,undefined,'its own revisions are not a takeover');assert.equal(o.status,'Accepted');assert.equal(o.currentBrokerOrderId,'R2');
});
test('partial fills revise only what is left; cancel; refusals and unclear replies; your takeover, busy and extended sessions',async()=>{
  const {e,sent,add}=engine();add({status:'Partially filled',filled:1});await e.revise('o1',{price:280});assert.equal(sent[0][1].command.quantity,2,'2 of 3 left');
  const c=await e.revise('o1',{cancel:true});assert.equal(sent[1][1].command.cancel,true);assert.ok(c.cancelRequestedAt);assert.equal(c.revisions.at(-1).cancel,true);
  const x=engine({revise:()=>{throw new Error('BROKER_REJECTED');}});x.add();await assert.rejects(x.e.revise('o1',{price:280}),/BROKER_REJECTED/);assert.equal(x.e.orders()[0].trackingStopped,undefined,'already filled, say: history will tell');
  const u=engine({revise:()=>{throw new Error('ORDER_UNCERTAIN');}});u.add();await assert.rejects(u.e.revise('o1',{price:280}),/ORDER_UNCERTAIN/);assert.match(u.e.orders()[0].trackingStopped.reason,/did not confirm/);
  await assert.rejects(u.e.revise('o1',{price:279}),/TRACKING_STOPPED/,'not revised again until history shows what happened');
  const h=engine();h.add({handsOff:{at:1,changes:[]}});await assert.rejects(h.e.revise('o1',{price:280}),/ORDER_TAKEN_OVER/);assert.equal(h.sent.length,0);
  const b=engine();b.add();b.e.busy=true;await assert.rejects(b.e.revise('o1',{price:280}),/KIS_ORDER_BUSY/);
  const s=engine();s.add({session:'us-pre'});await assert.rejects(s.e.revise('o1',{price:280}),/FEATURE_UNAVAILABLE/);
  const p=engine();p.add();await assert.rejects(p.e.revise('o1',{price:280.123}),/INVALID_ORDER/);const k=engine({market:'KR'});k.add();await assert.rejects(k.e.revise('o1',{price:60050.5}),/INVALID_ORDER/,'whole won');
  const f=engine();f.add({status:'Filled'});await assert.rejects(f.e.revise('o1',{price:280}),/ORDER_NOT_OPEN/);await assert.rejects(f.e.revise('nope',{price:280}),/UNKNOWN_ORDER/);
});
test('orders that end unfilled close instead of blocking: expired at the session end, or left open from an earlier day',async()=>{
  // The stuck GOOGL order blocked every later U.S. order and delayed reviews; an order must never stay open by mistake.
  const {e,add,history}=engine();add();history.orders=[row('B1',{quantity:3,remaining:0})];await e.reconcile();
  assert.deepEqual([e.orders()[0].status,e.orders()[0].closedReason],['Canceled','expired unfilled']);
  const y=engine();y.add({day:'2026-10-28'});y.history.orders=[row('B1',{quantity:3,remaining:3})];await y.e.reconcile();
  assert.deepEqual([y.e.orders()[0].status,y.e.orders()[0].closedReason],['Canceled','expired at the session end']);
  const n=engine();n.add();n.history.orders=[];await n.e.reconcile();assert.equal(n.e.orders()[0].status,'Accepted','not in today’s history yet: unchanged');
  const g=engine();g.add();g.e.broker.request=async()=>{throw new Error('REQUEST_FAILED');};await assert.rejects(g.e.reconcile());assert.equal(g.e.orderReconciliation().status,'unconfirmed','a failed read is reported, not guessed');
});
test('the U.S. engine sends revisions as us-revise-order',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');assert.match(src,/usBroker=\{request:\(operation,payload\)=>kisService\.request\(operation==='live-context'\?'us-context':'us-'\+operation,payload\)\}/);
  const worker=require('node:fs').readFileSync(require.resolve('../electron/kis-worker.cjs'),'utf8');assert.match(worker,/operation==='us-revise-order'/);assert.match(worker,/operation==='revise-order'/);
});
test('after an unclear reply, history settles it: the asked-for revision is adopted, nothing happened resumes, anything else is your takeover',async()=>{
  const mk=()=>{const t=engine({revise:()=>{throw new Error('ORDER_UNCERTAIN');}});t.add();return t;};
  const a=mk();await assert.rejects(a.e.revise('o1',{price:279.5}));a.history.orders=[row('B1',{quantity:3,remaining:0}),row('X9',{originalOrderId:'B1',kind:'revision',quantity:3,remaining:3,orderPrice:279.5})];
  await a.e.reconcile();let o=a.e.orders()[0];assert.equal(o.handsOff,undefined,'the revision it asked for went through');assert.equal(o.trackingStopped,undefined);assert.deepEqual(o.brokerOrderIds,['B1','X9']);assert.equal(o.currentBrokerOrderId,'X9');
  const b=mk();await assert.rejects(b.e.revise('o1',{price:279.5}));b.history.orders=[row('B1',{quantity:3,remaining:3})];await b.e.reconcile();o=b.e.orders()[0];assert.equal(o.trackingStopped,undefined,'nothing happened: tracking resumes');assert.equal(o.handsOff,undefined);
  const c=mk();await assert.rejects(c.e.revise('o1',{price:279.5}));c.history.orders=[row('B1',{quantity:3,remaining:0}),row('Y1',{originalOrderId:'B1',kind:'revision',quantity:3,remaining:3,orderPrice:275})];await c.e.reconcile();o=c.e.orders()[0];assert.ok(o.handsOff,'a different price: you changed it');
  const d=mk();await assert.rejects(d.e.revise('o1',{cancel:true}));d.history.orders=[row('B1',{quantity:3,remaining:0}),row('C1',{originalOrderId:'B1',kind:'cancel',quantity:3,status:'Canceled'})];await d.e.reconcile();o=d.e.orders()[0];assert.equal(o.status,'Canceled');assert.equal(o.handsOff,undefined,'its own cancellation');
});
test('order numbers match without their leading zeros, as the KIS mock account lists them',async()=>{
  // 2026-10-30 mock test: placed 0000040476, revised to 0000040478, cancelled as 0000040479; history listed 40476,
  // 40478 (original 40476) and 40479 (original 40478), with the first two still marked Pending.
  const rows=[{orderId:'40476',originalOrderId:null,kind:'order',quantity:1,filled:0,remaining:1,orderPrice:174.58,status:'Pending'},{orderId:'40478',originalOrderId:'40476',kind:'revision',quantity:1,filled:0,remaining:1,orderPrice:157.12,status:'Pending'},{orderId:'40479',originalOrderId:'40478',kind:'cancel',quantity:1,filled:0,remaining:0,orderPrice:0,status:'Canceled'}];
  const mine=resolve({brokerOrderId:'0000040476',brokerOrderIds:['0000040476','0000040478','0000040479'],quantity:1},rows);
  assert.equal(mine.status,'Canceled');assert.deepEqual(mine.chain,['0000040476','0000040478','0000040479'],'in the form KIS gave the app');assert.deepEqual(mine.outside,[]);assert.equal(mine.current,'0000040479');
  const yours=resolve({brokerOrderId:'0000040476',quantity:1},rows);assert.deepEqual(yours.outside.map(o=>[o.orderId,o.from,o.kind]),[['0000040478','0000040476','revision'],['0000040479','0000040478','cancel']],'padded like the app’s numbers');
  assert.equal(resolve({brokerOrderId:'0000040476',quantity:1},rows.slice(0,1)).current,'0000040476');
  const {e,add,history}=engine();add({brokerOrderId:'0000040476',quantity:1});history.orders=rows;await e.reconcile();assert.equal(e.orders()[0].status,'Canceled','the engine matches it too');
});
