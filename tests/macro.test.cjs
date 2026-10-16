const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {parseFredCsv,parseEcos,summarize,fetchMacro,calendarRows,MacroStore,SERIES}=require('../electron/macro.cjs');
const NOW=Date.parse('2026-10-16T03:00:00Z');
test('FRED CSV skips missing values; ECOS rows map periods to dates',()=>{
  assert.deepEqual(parseFredCsv('observation_date,DGS10\n2026-10-13,5.10\n2026-10-14,.\n2026-10-15,\n2026-10-16,5.19\n'),[{date:'2026-10-13',value:5.1},{date:'2026-10-16',value:5.19}]);
  assert.throws(()=>parseFredCsv('<html>error</html>'),/INVALID_RESPONSE/);
  assert.deepEqual(parseEcos({StatisticSearch:{list_total_count:2,row:[{TIME:'202609',DATA_VALUE:'3'},{TIME:'20261016',DATA_VALUE:'1348.5'}]}}),{total:2,rows:[{date:'2026-09-01',value:3},{date:'2026-10-16',value:1348.5}]});
  assert.deepEqual(parseEcos({RESULT:{CODE:'INFO-200',MESSAGE:'no data'}}),{total:0,rows:[]});assert.throws(()=>parseEcos({RESULT:{CODE:'INFO-100'}}),/ECOS_INFO-100/);
});
test('year-over-year inflation uses the same month a year earlier',()=>{
  const spec=SERIES.find(s=>s.id==='US_CPI');const rows=[['2025-08-01',100],['2025-09-01',101],['2026-08-01',103],['2026-09-01',104.03]].map(([date,value])=>({date,value}));
  const s=summarize(spec,rows);assert.equal(s.date,'2026-09-01');assert.equal(s.value,3);assert.equal(s.previous,3);assert.equal(s.change,0);assert.equal(s.frequency,'monthly');assert.equal(s.unit,'% y/y');
});
function fakeFetch(log){
  return async url=>{log.push(url);const u=new URL(url);
    if(u.host==='fred.stlouisfed.org'){const id=u.searchParams.get('id');if(id==='VIXCLS')return {ok:false,status:500};const monthly=['CPIAUCSL','UNRATE'].includes(id);const rows=monthly?['2025-09-01,100','2025-10-01,100','2026-08-01,102','2026-09-01,103']:['2026-10-14,4.10','2026-10-15,4.20'];return {ok:true,text:async()=>'observation_date,'+id+'\n'+rows.join('\n')};}
    if(u.host==='ecos.bok.or.kr'){const parts=u.pathname.split('/');const [from,to]=[Number(parts[6]),Number(parts[7])];const total=25;const rows=Array.from({length:total},(_,i)=>({TIME:new Date(Date.UTC(2026,8,20+i)).toISOString().slice(0,10).replaceAll('-',''),DATA_VALUE:String(i)})).slice(from-1,to);return {ok:true,json:async()=>({StatisticSearch:{list_total_count:total,row:rows}})};}
    if(u.host==='api.stlouisfed.org')return {ok:true,json:async()=>({release_dates:[{release_name:'Consumer Price Index',date:'2026-10-20'},{release_name:'Consumer Price Index',date:'2026-10-20'},{release_name:'Some Regional Survey',date:'2026-10-21'},{release_name:'FOMC Press Release',date:'2026-10-28'},{release_name:'Employment Situation',date:'2026-10-01'}]})};
    throw new Error('unexpected '+url);};
}
test('fetching works without keys, reads the newest ECOS sample rows and isolates failures',async()=>{
  const log=[];const result=await fetchMacro(fakeFetch(log),{now:NOW});
  assert.equal(result.ecosAccess,'sample');assert.equal(result.calendar,null);assert.ok(!log.some(u=>u.includes('api.stlouisfed.org')),'no calendar call without a key');
  const ecos=log.filter(u=>u.includes('ecos.bok.or.kr'));assert.ok(ecos.every(u=>u.includes('/sample/')));assert.ok(ecos.some(u=>u.includes('/json/kr/16/25/')),'the second sample request reads the last 10 rows');
  const fx=result.series.find(s=>s.id==='KR_USDKRW');assert.equal(fx.value,24);assert.equal(fx.change,1);
  assert.deepEqual(result.errors.map(e=>e.id),['US_VIX']);assert.ok(result.series.find(s=>s.id==='US_10Y').value===4.2);
});
test('a FRED key adds the filtered release calendar; an ECOS key reads up to 100 rows at once',async()=>{
  const log=[];const result=await fetchMacro(fakeFetch(log),{now:NOW,ecosKey:'MYECOSKEY123',fredKey:'a'.repeat(32)});
  assert.ok(log.filter(u=>u.includes('ecos.bok.or.kr')).every(u=>u.includes('/MYECOSKEY123/json/kr/1/100/')));
  assert.deepEqual(result.calendar.map(e=>e.date+' '+e.event),['2026-10-20 U.S. CPI','2026-10-28 FOMC decision'],'deduplicated, past and untracked releases removed');
  assert.deepEqual(calendarRows([{release_name:'Gross Domestic Product',date:'2026-10-29'}],'2026-10-16')[0].event,'U.S. GDP');
});
test('the store keeps the last good value of a failed series and gives the AI the next two weeks of releases',async()=>{
  const store=new MacroStore(new DatabaseSync(':memory:'),()=>NOW);
  store.save(await fetchMacro(fakeFetch([]),{now:NOW,fredKey:'a'.repeat(32)}));
  const failing=await fetchMacro(async url=>{if(url.includes('DGS10'))return {ok:false,status:503};return fakeFetch([])(url);},{now:NOW,fredKey:'a'.repeat(32)});
  const saved=store.save(failing);const ten=saved.series.find(s=>s.id==='US_10Y');assert.equal(ten.value,4.2);assert.equal(ten.stale,true);
  assert.equal(saved.series.map(s=>s.id).join(),SERIES.filter(s=>s.id!=='US_VIX').map(s=>s.id).join(),'series stay in a fixed order');
  const context=store.context();assert.equal(context.asOf,'2026-10-16');assert.deepEqual(context.upcoming,[{date:'2026-10-20',event:'U.S. CPI'},{date:'2026-10-28',event:'FOMC decision'}]);
  assert.deepEqual(new MacroStore(store.db,()=>Date.parse('2026-10-21T03:00:00Z')).context().upcoming,[{date:'2026-10-28',event:'FOMC decision'}],'past releases drop out');assert.ok(context.indicators.find(i=>i.name==='U.S. 10-year Treasury').stale);
});
