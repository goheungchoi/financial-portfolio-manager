const test=require('node:test');const assert=require('node:assert/strict');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {fetchBars}=require('../electron/kis-evidence.cjs');
// Bars for the Charts technical summary: today's Korean minute bars by page, weekly and monthly bars, U.S. intraday intervals.
const kst=(day,hhmm)=>Date.parse(`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00+09:00`);
const hhmmss=t=>new Date(t+9*3600000).toISOString().slice(11,19).replaceAll(':','');
test('today\'s Korean minute bars page back from now to the open',async()=>{
  const client=Object.create(KisReadOnlyClient.prototype);const asked=[];
  // Like KIS: up to 30 bars ending at the requested time, from 09:00.
  client.quotation=async(_p,tr,params)=>{assert.equal(tr,'FHKST03010200');asked.push(params.FID_INPUT_HOUR_1);const end=kst('20261029',params.FID_INPUT_HOUR_1.slice(0,4)),rows=[];
    for(let t=end;rows.length<30&&t>=kst('20261029','0900');t-=60000)rows.push({stck_bsop_date:'20261029',stck_cntg_hour:hhmmss(t),stck_oprc:'100',stck_hgpr:'101',stck_lwpr:'99',stck_prpr:'100',cntg_vol:'5'});return {output2:rows};};
  const bars=await client.getMinuteDay('005930',14,new Date('2026-10-29T03:00:00Z'));
  assert.equal(bars.length,181,'09:00 to 12:00');assert.equal(bars[0].timestamp,kst('20261029','0900'));assert.equal(bars.at(-1).timestamp,kst('20261029','1200'));
  assert.deepEqual(asked.slice(0,3),['120000','113000','110000']);assert.equal(asked.length,7);assert.ok(bars.every((b,i)=>!i||b.timestamp>bars[i-1].timestamp));
  // The page limit caps the calls; earlier days are left out.
  asked.length=0;const capped=await client.getMinuteDay('005930',2,new Date('2026-10-29T03:00:00Z'));assert.equal(capped.length,60);assert.equal(asked.length,2);
  client.quotation=async()=>({output2:[{stck_bsop_date:'20261028',stck_cntg_hour:'153000',stck_oprc:'1',stck_hgpr:'1',stck_lwpr:'1',stck_prpr:'1',cntg_vol:'1'}]});
  assert.deepEqual(await client.getMinuteDay('005930',14,new Date('2026-10-28T23:00:00Z')),[],'before the open: nothing from today');
});
test('weekly and monthly Korean bars ask KIS for that period over a long enough window',async()=>{
  const client=Object.create(KisReadOnlyClient.prototype);const asked=[];
  client.quotation=async(_p,_tr,params)=>{asked.push(params);return {output2:[{stck_bsop_date:'20261023',stck_oprc:'100',stck_hgpr:'110',stck_lwpr:'90',stck_clpr:'105',acml_vol:'1000'}]};};
  const weeks=await client.getDailyHistory('005930',2,'W');assert.equal(weeks.length,1);assert.equal(asked[0].FID_PERIOD_DIV_CODE,'W');
  const span=p=>(Date.parse(p.FID_INPUT_DATE_2.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'))-Date.parse(p.FID_INPUT_DATE_1.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')))/86400000;
  assert.ok(span(asked[0])>=700,'about 100 weeks');await client.getDailyHistory('005930',1,'M');assert.equal(asked[1].FID_PERIOD_DIV_CODE,'M');assert.ok(span(asked[1])>=3000);
  await client.getDailyHistory('005930');assert.equal(asked[2].FID_PERIOD_DIV_CODE,'D');assert.ok(span(asked[2])<=181,'daily unchanged');
});
test('Korean chart bars: one-minute, weekly and monthly; a failed timeframe is reported on its own',async()=>{
  const bar=t=>({timestamp:t,open:1,high:2,low:1,close:2,volume:1});
  const client={getMinuteDay:async()=>[bar(2),bar(1)],getDailyHistory:async(_s,pages,period)=>{if(period==='M')throw Object.assign(new Error('x'),{code:'RATE_LIMITED'});return [bar(pages)];}};
  const out=await fetchBars(client,{symbol:'005930'});assert.equal(out.market,'KR');assert.deepEqual(out.frames['1m'].map(b=>b.timestamp),[1,2],'sorted');assert.equal(out.frames['1w'].length,1);
  assert.equal(out.frames['1M'],undefined);assert.deepEqual(out.errors,{'1M':'RATE_LIMITED'});await assert.rejects(fetchBars(client,{symbol:'bad'}),/INVALID_REQUEST/);
});
test('U.S. chart bars: each intraday interval directly, weekly and monthly by period',async()=>{
  const asked=[];const client={overseasRequest:async(path,tr,params)=>{asked.push({path,tr,...params});
    if(tr==='HHDFS76950200')return {body:{output2:[{kymd:'20261029',khms:'003000',open:'295',high:'296',low:'294',last:'295.5',evol:'10'},{kymd:'20261029',khms:'003000',open:'1',high:'1',low:'1',last:'1',evol:'1'},{kymd:'20261029',khms:'002500',open:'294',high:'295',low:'293',last:'295',evol:'8'}]}};
    return {body:{output2:[{xymd:'20261023',open:'300',high:'330',low:'290',clos:'324.89',tvol:'1000'},{xymd:'20261016',open:'290',high:'305',low:'285',clos:'300',tvol:'900'}]}};}};
  const out=await fetchBars(client,{symbol:'NASD:GOOGL'});assert.equal(out.market,'US');assert.deepEqual(out.errors,{});
  assert.deepEqual(asked.filter(a=>a.tr==='HHDFS76950200').map(a=>a.NMIN),['5','15','30','60']);assert.ok(asked.filter(a=>a.tr==='HHDFS76950200').every(a=>a.PINC==='1'&&a.EXCD==='NAS'&&a.SYMB==='GOOGL'));
  assert.deepEqual(asked.filter(a=>a.tr==='HHDFS76240000').map(a=>a.GUBN),['1','2']);
  assert.equal(out.frames['5m'].length,2,'a repeated bar is kept once');assert.equal(out.frames['5m'][1].close,295.5);assert.ok(out.frames['5m'][0].timestamp<out.frames['5m'][1].timestamp);
  assert.deepEqual(out.frames['1w'].map(b=>b.close),[300,324.89]);assert.equal(out.frames['1M'].length,2);
});
