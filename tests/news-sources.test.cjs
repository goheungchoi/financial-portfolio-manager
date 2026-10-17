const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const news=require('../electron/news.cjs');
test('feed text decodes named and numeric references once, without creating markup',()=>{
  assert.equal(news.decode('&apos;Dead money&#x2019; &amp;lt;b&amp;gt; &#39;x&#39; &hellip;'),"'Dead money’ &lt;b&gt; 'x' …");
  const items=news.parseFeed('<rss><channel><item><title><![CDATA[AI stocks plunge &amp; inflation heats up]]></title><link>https://cnbc.example/a</link><pubDate>Sat, 17 Oct 2026 15:42:34 GMT</pubDate></item></channel></rss>','cnbc.example');
  assert.equal(items[0].title,'AI stocks plunge & inflation heats up');
});
test('KIS headlines keep their stock codes, source and Seoul time; they have no link',()=>{
  const rows=[{cntt_usiq_srno:'2026101623580608010',data_dt:'20261016',data_tm:'235806',hts_pbnt_titl_cntt:'[美특징주] 엔비디아 3% 하락',dorg:'이데일리',iscd1:'005930',iscd2:'000660',iscd3:''},{cntt_usiq_srno:'',data_dt:'20261016',hts_pbnt_titl_cntt:'x'}];
  const [item,...rest]=news.kisNews(rows);assert.equal(rest.length,0);
  assert.deepEqual(item,{title:'[美특징주] 엔비디아 3% 하락',url:'kis-news:2026101623580608010',published:'2026-10-16T23:58:06+09:00',source:'이데일리',symbols:['005930','000660']});
  assert.equal(news.yahooFeed('NYSE:BRK.B'),'https://feeds.finance.yahoo.com/rss/2.0/headline?s=BRK-B&region=US&lang=en-US');assert.equal(news.yahooFeed('005930'),null);
  assert.ok(news.SUGGESTED_FEEDS.every(f=>/^https:\/\//.test(f.url)&&f.label));
});
test('tagged stock codes match news to holdings even when the title does not name them',()=>{
  const {NewsEvents}=require('../electron/news-events.cjs');const events=new NewsEvents(new DatabaseSync(':memory:'));
  const created=events.ingest([{title:'반도체 업황 우려 확산',url:'kis-news:1',published:'2026-10-16T09:00:00+09:00',source:'KIS',symbols:['000660','035420']}],[{symbol:'000660',name:'SK하이닉스'}]);
  assert.deepEqual(created[0].symbols,['000660'],'only codes you hold or watch');
});
test('index history covers the global indices through KIS; settings accept several feeds',async()=>{
  const {indexHistory}=require('../electron/kis-index.cjs');const asked=[];
  const client={quotation:async(path,tr,params)=>{asked.push(params.FID_INPUT_ISCD);return {output2:[{stck_bsop_date:'20261016',bstp_nmix_prpr:'878.16'}]};},overseasRequest:async(path,tr,params)=>{asked.push(params.FID_INPUT_ISCD);return {body:{output2:[{stck_bsop_date:'20261016',ovrs_nmix_prpr:'11137.29'}]}};}};
  assert.deepEqual(await indexHistory(client,{index:'SOX',start:'2026-10-16',end:'2026-10-16'}),[{day:'2026-10-16',close:11137.29}]);
  await indexHistory(client,{index:'KOSPI200',start:'2026-10-16',end:'2026-10-16'});await indexHistory(client,{index:'DJI',start:'2026-10-16',end:'2026-10-16'});assert.deepEqual(asked,['SOX','2001','.DJI']);
  await assert.rejects(indexHistory(client,{index:'NIKKEI',start:'2026-10-16',end:'2026-10-16'}),/INVALID_REQUEST/);
  const {SERIES}=require('../electron/macro.cjs');assert.ok(['US_WTI','US_BRENT','US_DOLLAR','US_HY_SPREAD'].every(id=>SERIES.some(s=>s.id===id)));
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>null},()=>{});
  a.configure({newsFeeds:news.SUGGESTED_FEEDS});assert.equal(a.config.newsFeeds.length,6);
  assert.throws(()=>a.configure({newsFeeds:[{url:'http://insecure.example/rss'}]}),/INVALID_SETTINGS/);assert.throws(()=>a.configure({newsFeeds:Array.from({length:11},(_,i)=>({url:'https://x.example/'+i}))}),/INVALID_SETTINGS/);
});
