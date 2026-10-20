const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {UsCalendar,parseEarnings,parseScreener,appSymbol,weekdays}=require('../electron/us-calendar.cjs');const {build}=require('../electron/event-calendar.cjs');
const reply=body=>({ok:true,status:200,text:async()=>JSON.stringify(body)});
const known=new Set(['NASD:META','NASD:TSLA','NYSE:BRK.B','NASD:NVDA']);
test('Nasdaq rows parse into report dates with timing, and tickers map to app symbols',()=>{
  const rows=parseEarnings({data:{rows:[{symbol:'META',name:'Meta Platforms, Inc.',time:'time-after-hours',fiscalQuarterEnding:'Sep/2026',epsForecast:'$6.54',noOfEsts:'11',marketCap:'$1,807,009,840,000'},{symbol:'XYZ',time:'time-pre-market',epsForecast:'($0.12)'},{symbol:'bad ticker!'}]}},'2026-10-21');
  assert.equal(rows.length,2);assert.deepEqual([rows[0].time,rows[0].epsForecast,rows[0].estimates,rows[0].marketCapUSD],['after-close',6.54,11,1807009840000]);assert.equal(rows[1].epsForecast,-0.12);
  assert.equal(appSymbol('META',s=>known.has(s)),'NASD:META');assert.equal(appSymbol('BRK/B',s=>known.has(s)),'NYSE:BRK.B');assert.equal(appSymbol('ZZZZ',s=>known.has(s)),null);
  assert.deepEqual(parseScreener({data:{table:{rows:[{symbol:'NVDA',marketCap:'5,231,869,000,000'},{symbol:'X',marketCap:''}]}}}),[{ticker:'NVDA',marketCapUSD:5231869000000}]);
  assert.deepEqual(weekdays('2026-10-23',3),['2026-10-23','2026-10-26'],'weekends skipped');
});
test('a refresh stores every listed company with its date, drops past dates and ranks the largest',async()=>{
  const db=new DatabaseSync(':memory:');const cal=new UsCalendar(db);const urls=[];
  const fetcher=async url=>{urls.push(url);if(url.includes('screener'))return reply({data:{table:{rows:[{symbol:'NVDA',marketCap:'5,000'},{symbol:'META',marketCap:'1,800'}]}}});
    if(url.endsWith('2026-10-21'))return reply({data:{rows:[{symbol:'META',name:'Meta',time:'time-after-hours'},{symbol:'TSLA',name:'Tesla',time:'time-after-hours'}]}});if(url.endsWith('2026-10-22'))return {ok:false,status:500,text:async()=>''};return reply({data:{rows:[]}});};
  db.prepare('INSERT INTO us_earnings VALUES(?,?,?)').run('NASD:NVDA','2026-08-26','{}');
  const r=await cal.refresh({fetcher,known:s=>known.has(s),today:'2026-10-20',days:3,pause:async()=>{}});
  assert.deepEqual(r,{read:3,failed:1});assert.equal(cal.next('NASD:META','2026-10-20').date,'2026-10-21');assert.equal(cal.next('NASD:META','2026-10-20').time,'after-close');assert.equal(cal.next('NASD:NVDA','2026-10-20'),null,'past dates are dropped');
  assert.deepEqual(cal.largest(),['NASD:NVDA','NASD:META']);assert.match(cal.status().error,/1 of 5 requests failed/);assert.ok(urls.every(u=>u.startsWith('https://api.nasdaq.com/')));
});
test('the event calendar shows a listed U.S. report date with its timing, and labels estimates',()=>{
  const events=build({today:'2026-10-20',symbols:[{symbol:'NASD:META',name:'Meta'},{symbol:'NASD:AMZN',name:'Amazon'}],sources:s=>s==='NASD:META'?{earnings:{nextExpected:'2026-10-21',scheduled:true,time:'after-close',source:'Nasdaq earnings calendar'}}:{earnings:{nextExpected:'2026-10-29',estimated:true}}});
  const meta=events.find(e=>e.symbol==='NASD:META');assert.equal(meta.estimated,false);assert.match(meta.title,/Meta earnings · after the U\.S\. close \(next morning KST\)/);
  const amzn=events.find(e=>e.symbol==='NASD:AMZN');assert.equal(amzn.estimated,true);assert.match(amzn.title,/\(estimated\)/);
});
test('SEC filings-only reads the submissions file, not company facts',async()=>{
  const {secFilings}=require('../electron/sec.cjs');const urls=[];
  const fetcher=async url=>{urls.push(url);if(url.includes('company_tickers'))return reply({0:{cik_str:1326801,ticker:'META',title:'Meta Platforms, Inc.'}});return reply({fiscalYearEnd:'1231',filings:{recent:{form:['8-K'],filingDate:['2026-07-29'],items:['2.02,9.01'],accessionNumber:['0001628280-26-050596'],primaryDocument:['m.htm'],primaryDocDescription:['8-K']}}});};
  const r=await secFilings(fetcher,'me@example.com','NASD:META','2026-10-20',{});
  assert.equal(r.earnings.lastRelease,'2026-07-29');assert.ok(urls.some(u=>u.includes('/submissions/CIK0001326801.json')));assert.ok(!urls.some(u=>u.includes('companyfacts')));
});
