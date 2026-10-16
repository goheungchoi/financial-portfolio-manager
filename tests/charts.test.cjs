const test=require('node:test');const assert=require('node:assert/strict');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {fetchEvidence}=require('../electron/kis-evidence.cjs');
const compact=date=>date.toISOString().slice(0,10).replaceAll('-','');
// Weekdays ending on or before the given YYYYMMDD, newest first, like KIS.
function weekdays(end,count){const rows=[];let day=new Date(Date.UTC(+end.slice(0,4),+end.slice(4,6)-1,+end.slice(6,8)));while(rows.length<count){if(day.getUTCDay()%6)rows.push(compact(day));day=new Date(day.getTime()-86400000);}return rows;}
test('Korean daily history pages backwards for charts and deduplicates days',async()=>{
  const client=Object.create(KisReadOnlyClient.prototype);const calls=[];
  client.quotation=async(_path,_tr,params)=>{calls.push([params.FID_INPUT_DATE_1,params.FID_INPUT_DATE_2]);return {output2:weekdays(params.FID_INPUT_DATE_2,100).map((d,i)=>({stck_bsop_date:d,stck_oprc:'100',stck_hgpr:'101',stck_lwpr:'99',stck_clpr:'100',acml_vol:String(i)}))};};
  const one=await client.getDailyHistory('005930');assert.equal(one.length,100);assert.equal(calls.length,1);
  const two=await client.getDailyHistory('005930',2);assert.equal(calls.length,3);assert.equal(two.length,200);
  const firstOldest=weekdays(calls[1][1],100).at(-1);assert.ok(calls[2][1]<firstOldest,'second page ends before the first page starts');
  assert.ok(two.every((c,i)=>i===0||c.timestamp>two[i-1].timestamp),'sorted and unique');
});
test('U.S. daily chart bars page with BYMD; AI evidence keeps one page',async()=>{
  const calls=[];const today='20261016';
  const client={overseasRequest:async(_path,tr,params)=>{calls.push({tr,bymd:params.BYMD});return {body:{output2:weekdays(params.BYMD||today,100).map((d,i)=>({xymd:d,open:'200.5',high:'201.25',low:'199.75',clos:String(200+i/100),tvol:'1000'}))}};}};
  const chart=await fetchEvidence(client,{symbol:'NASD:NVDA',dataset:'daily_technicals'},true);
  assert.equal(calls.length,2);assert.equal(calls[0].bymd,'');const oldest=weekdays(today,100).at(-1);assert.equal(calls[1].bymd,compact(new Date(Date.parse(oldest.slice(0,4)+'-'+oldest.slice(4,6)+'-'+oldest.slice(6,8)+'T00:00:00Z')-86400000)),'the day before the oldest bar');
  assert.equal(chart.candles.length,200);assert.equal(chart.candles.at(-1).date,'2026-10-16');assert.ok(chart.candles.every((c,i)=>i===0||c.timestamp>chart.candles[i-1].timestamp));
  assert.equal(chart.candles.at(-1).close,200,'cents are kept');
  const nyDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(chart.candles.at(-1).timestamp));assert.equal(nyDay,'2026-10-16','a U.S. daily bar falls on its own trading date in New York time');
  calls.length=0;const evidence=await fetchEvidence(client,{symbol:'NASD:NVDA',dataset:'daily_technicals'});assert.equal(calls.length,1);assert.equal(evidence.candles,undefined);
});
