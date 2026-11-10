// Settlement simplification S1a (artifacts/reviews/2026-11-10-settlement-simplify, S0 reviewed): a filled U.S. order is
// in flight for at most 3 business days of its market; after that it is settled by age. The close is a cash-free
// correction (InFlight.explained), both sides close, and a settled U.S. buy, by evidence or by age, releases its
// funding commitment's filled part.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const B=require('../electron/business-days.cjs');const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const DAY=86400000,MIN=60000,ny=(day,h=11)=>Date.parse(`${day}T00:00:00Z`)+(h+5)*3600000;// about h:00 New York (EST; an hour later in EDT)

test('business days: NYSE holidays match the session calendar; Korea follows the KIS calendar, else weekdays',()=>{
  const {usSession}=require('../electron/kis-overseas.cjs');
  // Every weekday of 2025-2028 at 11:00 New York: open in the session calendar exactly when it is a business day here.
  for(let t=Date.parse('2025-01-01T16:00:00Z');t<Date.parse('2029-01-01T00:00:00Z');t+=DAY){const day=B.dateIn('US',t);if([0,6].includes(new Date(day+'T00:00:00Z').getUTCDay()))continue;
    assert.equal(B.isBusinessDay('US',day),usSession(new Date(t)).open,day);}
  for(const h of ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'])assert.ok(B.usHolidays(2026).has(h),h);
  // Korea: the calendar decides when it has the day; otherwise weekdays count.
  const kr={'2026-10-09':false,'2026-10-10':true};const krOpen=d=>Object.hasOwn(kr,d)?kr[d]:null;
  assert.equal(B.isBusinessDay('KR','2026-10-09',{krOpen}),false,'a weekday holiday');assert.equal(B.isBusinessDay('KR','2026-10-10',{krOpen}),true,'the calendar overrides the weekend');
  assert.equal(B.isBusinessDay('KR','2026-10-12',{krOpen}),true,'not in the calendar: a weekday');assert.equal(B.isBusinessDay('KR','2026-10-11'),false);
});
test('the age rule: 3 business days after the trade date, at least 3 calendar days, in the market\'s time zone',()=>{
  // Thu 10-23 New York: Fri 24, Mon 27, Tue 28.
  const fill=ny('2026-10-23',15);
  assert.equal(B.agedOut('US',{fillAt:fill,now:ny('2026-10-27',20)}).aged,false);assert.deepEqual(B.agedOut('US',{fillAt:fill,now:ny('2026-10-28',9)}),{aged:true,days:3,tradeDay:'2026-10-23'});
  // A fill at 20:00 New York is still that New York day, though it is the next day in Seoul.
  assert.equal(B.agedOut('US',{fillAt:ny('2026-10-23',20),now:ny('2026-10-28',1)}).tradeDay,'2026-10-23');
  // Thanksgiving (Thu 11-26) does not count: Wed 25 → Fri 27, Mon 30, Tue 12-01.
  assert.equal(B.agedOut('US',{fillAt:ny('2026-11-25'),now:ny('2026-11-30')}).aged,false);assert.equal(B.agedOut('US',{fillAt:ny('2026-11-25'),now:ny('2026-12-01')}).aged,true);
  // Korea, by the order's recorded trade day; a calendar that opens a weekend cannot make it fewer than 3 calendar days.
  const all=()=>true;assert.equal(B.agedOut('KR',{tradeDay:'2026-10-23',now:Date.parse('2026-10-25T03:00:00Z'),krOpen:all}).aged,false,'two calendar days');
  assert.equal(B.agedOut('KR',{tradeDay:'2026-10-23',now:Date.parse('2026-10-28T03:00:00Z')}).aged,true);
  assert.deepEqual(B.agedOut('US',{fillAt:null,now:Date.now()}),{aged:false,days:0,tradeDay:null},'no time: never aged');
});
// A tracker with a clock, as the app reads it.
function tracker(start,{settled=[]}={}){let t=start;const db=new DatabaseSync(':memory:');const f=new InFlight(db,()=>t);f.onSettled=(a,x)=>settled.push(x);
  return {f,db,see:(us,orders=[])=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),pendingSaleProceeds:0,holdings:[],...us},orders,fx:1300});t+=MIN;return r;},later:ms=>{t+=ms;},now:()=>t};}
const buy=(id,usd,at)=>({id,side:'Buy',filled:1,fillPrice:usd,createdAt:at,filledObservedAt:at}),sell=(id,usd,at)=>({id,side:'Sell',filled:1,fillPrice:usd,createdAt:at,filledObservedAt:at});
test('the live case: five pre-tracking fills (buys and a sale) close by age as corrections; a new remainder waits its own 3 days',()=>{
  const settled=[];const x=tracker(Date.parse('2026-11-09T00:00:00Z'),{settled});
  const orders=[buy('GOOGL',324.44,ny('2026-10-23')),buy('NVDA',213.26,ny('2026-10-23')),buy('PNR',61.71,ny('2026-10-27')),sell('GOOGLs',279.85,ny('2026-10-29')),buy('RDDT',97.66,ny('2026-10-30'))];
  const first=x.see({cash:182.19},orders);assert.equal(first.open.length,5,'the first reading never settles by age (bootstrap)');
  const r=x.see({cash:182.19},orders);assert.equal(r.open.length,0);assert.equal(r.notes.filter(n=>/settled by age/.test(n)).length,5);
  assert.deepEqual(settled.map(s=>[s.orderId,s.why]).sort(),[['GOOGL','age'],['GOOGLs','age'],['NVDA','age'],['PNR','age'],['RDDT','age']]);
  // Each close is an age event with its side and amount; explained counts them: +buys −sale, no cash.
  const ev=x.f.evidence.events('a').filter(e=>e.kind==='piece-closed');assert.ok(ev.every(e=>e.why==='age'&&Number.isFinite(e.usd)&&['Buy','Sell'].includes(e.side)));
  const opened=x.f.explained('a',{until:first.open.length?Date.parse('2026-11-09T00:00:30Z'):0}).usd;const after=x.f.explained('a').usd;
  assert.equal(Math.round((after-opened)*100)/100,Math.round((324.44+213.26+61.71+97.66-279.85)*100)/100,'the closes undo the openings');assert.equal(Math.round(after*100),0,'net zero over open and close');
  // The value is a single figure again.
  const v=value({us:{cash:182.19,pendingSaleProceeds:0,holdings:[],timestamp:new Date(x.now()).toISOString()},fx:{usdKRW:1300},inFlight:x.f.current('a'),now:x.now()}).markets.US;assert.equal(v.exact,true);assert.ok(!v.reasons.some(r=>/overdue|awaiting/.test(r)));
  // A sale remainder opened today ("evidence short", no fill time) waits 3 business days from its opening.
  // The NVDA sale (release gate H1): the app's net $171.90 against KIS's $171.39 is a $0.51 fee difference, within the
  // bound (the larger of $1.00 and 0.5%): it settles with its evidence, the difference recorded on the close.
  const y=tracker(ny('2026-11-10',9));y.see({cash:500});const o=sell('S',171.9,y.now()-MIN);y.see({cash:500},[o]);const short=y.see({cash:671.39},[o]);assert.equal(short.sellsUSD,0);
  assert.deepEqual(y.f.evidence.events('a').filter(e=>e.kind==='piece-closed').map(e=>[e.why,e.feeUSD]),[['evidence',0.51]]);
  // A shortfall beyond the bound ($5 on $171.90) stays in flight and waits its own 3 business days.
  const z=tracker(ny('2026-11-10',9));z.see({cash:500});const q=sell('Q',171.9,z.now()-MIN);z.see({cash:500},[q]);assert.equal(z.see({cash:666.9},[q]).sellsUSD,5);
  z.later(2*DAY);assert.equal(z.see({cash:666.9},[q]).sellsUSD,5,'two days: still in flight');z.later(DAY);assert.equal(z.see({cash:666.9},[q]).sellsUSD,0,'third business day: settled by age');
});
test('an evidence close reports why:evidence; onSettled fires once the order has no open piece; it runs in the reading\'s transaction',()=>{
  const settled=[];const x=tracker(ny('2026-11-10',9),{settled});x.see({cash:500});const a=buy('A',100,x.now()-MIN);x.see({cash:500},[a]);
  x.see({cash:400},[a]);assert.deepEqual(settled,[{orderId:'A',why:'evidence'}]);const ev=x.f.evidence.events('a').filter(e=>e.kind==='piece-closed');assert.deepEqual(ev.map(e=>[e.why,e.side]),[['evidence','Buy']]);
  assert.equal(x.f.explained('a').usd,0,'an evidence close is a cash move, not a correction');
  // A fill in two pieces: onSettled only when the last one closes.
  const s2=[];const y=tracker(ny('2026-11-10',9),{settled:s2});y.see({cash:1000});const p1={id:'P',side:'Buy',filled:1,fillPrice:100,createdAt:y.now()-MIN};y.see({cash:1000},[p1]);const p2={...p1,filled:2};y.see({cash:1000},[p2]);
  y.see({cash:900},[p2]);assert.deepEqual(s2,[],'one piece of two settled');y.later(4*DAY);y.see({cash:900},[p2]);assert.deepEqual(s2,[{orderId:'P',why:'age'}]);
  // A failing release rolls the reading back: the piece is still open, nothing is lost.
  const z=tracker(ny('2026-11-02',9));const old=buy('O',50,ny('2026-10-20'));assert.equal(z.see({cash:500},[old]).open.length,1,'bootstrap');z.f.onSettled=()=>{throw new Error('LEDGER_DOWN');};
  assert.throws(()=>z.see({cash:500},[old]),/LEDGER_DOWN/);assert.equal(z.f.state('a').open.length,1);z.f.onSettled=null;assert.equal(z.see({cash:500},[old]).open.length,0);
  // The age rule off (only the tests of code S3/S4 remove): nothing closes by age.
  const off=new InFlight(new DatabaseSync(':memory:'),()=>ny('2026-11-10'),{settleDays:null});off.observe('a',{us:{cash:1,pendingSaleProceeds:0,holdings:[]},orders:[buy('Q',5,ny('2026-10-01'))],fx:1300});assert.equal(off.observe('a',{us:{cash:1,pendingSaleProceeds:0,holdings:[]},orders:[buy('Q',5,ny('2026-10-01'))],fx:1300}).open.length,1);
});
test('funding: a settled U.S. buy releases its filled part once, by age or by evidence; sales, unknown orders and repeats release nothing',()=>{
  const db=new DatabaseSync(':memory:');let t=ny('2026-11-10');const L=new FundingLedger(db,{clock:()=>t});L.init();
  const o=(id,extra={})=>({id,accountKey:'acct:US',symbol:'NYSE:X',side:'Buy',quantity:1,filled:1,fillPrice:97.42,limitPrice:97.42,status:'Filled',resultCosts:{netCash:-97.66},...extra});
  L.track(o('R'));const c0=L.commitments('acct').usd,cents=require('../electron/funding-ledger.cjs').FundingLedger.filledCents(L.row('R'));assert.ok(c0>0&&cents===Math.round(c0*100),`${c0} ${cents}`);
  assert.deepEqual(L.releaseSettled({orderId:'R',why:'age'}),{cents});assert.equal(L.commitments('acct').usd,0,'no longer reduces funds for new buys');
  assert.deepEqual(L.releaseSettled({orderId:'R',why:'age'}),{cents:0},'a repeat releases nothing');assert.deepEqual(L.releaseSettled({orderId:'R',why:'evidence'}),{cents:0});
  const rows=db.prepare('SELECT * FROM funding_releases').all();assert.deepEqual(rows.map(r=>[r.id,r.reconciliationId,r.cents,r.route,r.reason,r.citationId]),[['age:R:release','age:R',cents,null,'settled by age',null]]);
  assert.ok(db.prepare('SELECT payload FROM funding_events WHERE orderId=?').all('R').some(r=>JSON.parse(r.payload).kind==='released by age'));
  L.track(o('E'));assert.deepEqual(L.releaseSettled({orderId:'E',why:'evidence'}),{cents});assert.equal(db.prepare("SELECT reason FROM funding_releases WHERE orderId='E'").get().reason,'settled by evidence');
  // A partly filled live order: only the filled part is released; the unfilled remainder stays committed (U8).
  L.track(o('P',{quantity:3,filled:1,status:'Partially filled',fillPrice:100,limitPrice:100,resultCosts:{netCash:-100.25}}));const before=L.commitments('acct').usd;L.releaseSettled({orderId:'P',why:'age'});const afterP=L.commitments('acct').usd;
  assert.ok(afterP>0&&afterP<before,`remainder stays: ${before} → ${afterP}`);
  assert.deepEqual(L.releaseSettled({orderId:'nope',why:'age'}),{cents:0});assert.throws(()=>L.releaseSettled({orderId:'R',why:'manual'}),/INVALID_RELEASE/);
  // The table stays append-only.
  assert.throws(()=>db.prepare("DELETE FROM funding_releases WHERE orderId='R'").run(),/append-only/);
  // The app wires it for U.S. commitments only (Korean ones are S1b).
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');assert.ok(main.includes("inFlight.onSettled=(account,{orderId,why})=>{const market=fundingLedger.row(String(orderId))?.market;if(market==='US')fundingLedger.releaseSettled({orderId,why});};"));
});
// S1b: Korean filled buys have no tracker piece; their funding is released by age from the order's trade day.
function krLedger(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE kr_calendar(day TEXT PRIMARY KEY,open INTEGER NOT NULL,fetchedAt INTEGER NOT NULL)');
  const L=new FundingLedger(db,{clock:()=>Date.parse('2026-11-05T03:00:00Z')});L.init();
  const add=o=>{db.prepare('INSERT INTO live_intents VALUES(?,?)').run(o.id,JSON.stringify(o));L.track(o);return o;};
  const kr=(id,won,extra={})=>({id,accountKey:'acct',market:'KR',symbol:'028050',side:'Buy',quantity:1,filled:1,fillPrice:won,limitPrice:won,status:'Filled',resultCosts:{netCash:-won},day:'2026-11-05',createdAt:Date.parse('2026-11-05T01:00:00Z'),...extra});
  return {db,L,add,kr,at:(day,h=3)=>Date.parse(`${day}T${String(h).padStart(2,'0')}:00:00Z`)};}
test('Korea: a filled buy\'s funding is released 3 Korean business days after its order\'s day, by the KIS calendar, once',()=>{
  const {db,L,add,kr,at}=krLedger();add(kr('K1',180927));add(kr('K2',106016,{day:undefined,acceptedAt:Date.parse('2026-11-05T00:30:00Z')}));
  add({...kr('K3',95114),quantity:3,status:'Partially filled'});add(kr('K4',50000,{day:'2026-11-09'}));
  // A U.S. commitment is never touched here (the tracker releases it).
  L.track({id:'U',accountKey:'acct:US',symbol:'NYSE:X',side:'Buy',quantity:1,filled:1,fillPrice:10,limitPrice:10,status:'Filled',resultCosts:{netCash:-10}});
  const k0=L.commitments('acct').krw,u0=L.commitments('acct').usd;
  // Thu 11-05: Fri 6, Mon 9, Tue 10. Monday Seoul: nothing yet.
  assert.deepEqual(L.releaseAgedKR('acct',{now:at('2026-11-09')}),[]);
  const r=L.releaseAgedKR('acct',{now:at('2026-11-10')});assert.deepEqual(r.map(x=>[x.orderId,x.tradeDay]),[['K1','2026-11-05'],['K2','2026-11-05'],['K3','2026-11-05']],'K2 timed from its acceptance in Seoul; K4 (11-09) not yet');
  assert.deepEqual(r.map(x=>x.cents),['K1','K2','K3'].map(id=>FundingLedger.filledCents(L.row(id))),'the filled part with its fee estimate; K3 without its 2 unfilled shares');assert.ok(r[0].cents>=18092700);
  const k1=L.commitments('acct');assert.ok(k1.krw<k0&&k1.krw>50000,`the remainder of K3 and K4 stay: ${k0} → ${k1.krw}`);assert.equal(k1.usd,u0,'U.S. untouched');
  assert.deepEqual(L.releaseAgedKR('acct',{now:at('2026-11-20')}).map(x=>x.orderId),['K4'],'once each');assert.deepEqual(L.releaseAgedKR('acct',{now:at('2026-11-20')}),[]);
  assert.ok(db.prepare("SELECT reason FROM funding_releases WHERE orderId='K1'").all().every(x=>x.reason==='settled by age'));
});
test('Korea: the KIS calendar decides the business days; an order with no date is never released by age; a failure releases nothing',()=>{
  const {db,L,add,kr,at}=krLedger();add(kr('K1',180927));add(kr('K2',1000));
  // 11-06 a market holiday in the calendar: Mon 9, Tue 10, Wed 11.
  db.prepare('INSERT INTO kr_calendar VALUES(?,?,?)').run('2026-11-06',0,0);
  assert.deepEqual(L.releaseAgedKR('acct',{now:at('2026-11-10')}),[]);
  // One savepoint: the second release fails, so the first is undone too.
  const real=L.releaseSettled.bind(L);let n=0;L.releaseSettled=x=>{if(++n===2)throw new Error('LEDGER_DOWN');return real(x);};
  assert.throws(()=>L.releaseAgedKR('acct',{now:at('2026-11-11')}),/LEDGER_DOWN/);assert.equal(db.prepare('SELECT COUNT(*) n FROM funding_releases').get().n,0);
  L.releaseSettled=real;assert.equal(L.releaseAgedKR('acct',{now:at('2026-11-11')}).length,2);
  const {L:L2,db:db2}=krLedger();const o={...kr('N',1000),day:undefined,createdAt:undefined};db2.prepare('INSERT INTO live_intents VALUES(?,?)').run('N',JSON.stringify(o));L2.track(o);
  assert.deepEqual(L2.releaseAgedKR('acct',{now:at('2026-12-31')}),[]);
});
test('a failing reading leaves one System line with the error code only, at most once a minute per kind; the app wires both readings',()=>{
  let t=0;const lines=[];const failed=require('../electron/reading-failures.cjs').readingFailures((title,m)=>lines.push([title,m]),{clock:()=>t});
  assert.equal(failed('U.S. settlement tracking',new Error('LEDGER_DOWN')),true);t+=30000;assert.equal(failed('U.S. settlement tracking',new Error('LEDGER_DOWN')),false);
  assert.equal(failed('Korean settlement',Object.assign(new Error('account 12345678 secret detail'),{code:'ERR_SQLITE_ERROR'})),true);t+=30001;failed('U.S. settlement tracking',new Error('the token abc was rejected'));
  assert.deepEqual(lines,[['U.S. settlement tracking','A reading failed (LEDGER_DOWN); it is tried again at the next balance reading.'],['Korean settlement','A reading failed (ERR_SQLITE_ERROR); it is tried again at the next balance reading.'],['U.S. settlement tracking','A reading failed (READ_FAILED); it is tried again at the next balance reading.']]);
  assert.ok(!lines.flat().some(m=>/12345678|secret|token|abc/.test(m)),'never the message or its data');
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.ok(main.includes("catch(e){readingFailed('U.S. settlement tracking',e);}"));assert.ok(main.includes("fundingLedger.releaseAgedKR(s.accountKey)"));assert.ok(main.includes("catch(e){readingFailed('Korean settlement',e);}"));
  assert.ok(!/inFlight\.observe\([^\n]*overdueNotice\([^\n]*\)\);\}catch\{\}/.test(main),'no silent catch around the tracker\'s reading');
});
// Release gate H1 (1.5.50): the fee bound. A remainder within the larger of $1.00 and 0.5% of its fill is the app's fee
// estimate against what KIS charged; it closes with its evidence as a cash-free difference.
test('H1: a remainder left open from before the fee bound closes at the next reading; the difference is explained, not a flow',()=>{
  const t0=ny('2026-11-10',9);let t=t0;const db=new DatabaseSync(':memory:');const old=new InFlight(db,()=>t,{feeBound:false});
  const read=(f,cash,orders)=>{const r=f.observe('a',{us:{cash,pendingSaleProceeds:0,holdings:[],timestamp:new Date(t).toISOString()},orders,fx:1300});t+=MIN;return r;};
  read(old,500,[]);const o=sell('S',171.9,t-MIN);read(old,500,[o]);assert.equal(read(old,671.39,[o]).sellsUSD,0.51,'before the rule: open');
  const before=new InFlight(db,()=>t).explained('a').usd;
  const now=new InFlight(db,()=>t);const r=read(now,671.39,[o]);assert.equal(r.sellsUSD,0);assert.ok(r.notes.some(n=>/\$0\.51 left after its evidence is within the fee bound/.test(n)));
  assert.equal(Math.round((now.explained('a').usd-before)*100)/100,-0.51,'a sale leaving the obligation with no cash: explained, the same sign as an age close');
  // A buy within the bound, after a day's baseline: the baseline moves with it (rule B9), so no P/L appears.
  const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const db2=new DatabaseSync(':memory:');let u=ny('2026-11-10',9);const f=new InFlight(db2,()=>u);const sb=new SettlementBaseline(db2,{inFlight:f,clock:()=>u});
  const rd=(cash,orders)=>{f.observe('a',{us:{cash,pendingSaleProceeds:0,holdings:[],timestamp:new Date(u).toISOString()},orders,fx:1300});u+=MIN;};
  rd(500,[]);const b=buy('B',100,u-MIN);rd(500,[b]);const at=u;sb.take('a','2026-11-10',at);u+=MIN;rd(400.4,[b]);
  const adj=sb.adjustments('a',{day:'2026-11-10',baselineAt:at});assert.equal(adj.certain.low,0.4);assert.deepEqual(adj.items.map(i=>[i.kind,i.usd]),[['fee difference',0.4]]);
});
