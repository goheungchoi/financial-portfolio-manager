const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {NewsEvents,matcher,importance,englishTerm}=require('../electron/news-events.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const securities=[{symbol:'005930',name:'삼성전자',englishName:''},{symbol:'001680',name:'대상',englishName:''},{symbol:'035420',name:'NAVER',englishName:''},{symbol:'NASD:AAPL',name:'애플',englishName:'APPLE INC'},{symbol:'NASD:ON',name:'온 세미컨덕터',englishName:'ON SEMICONDUCTOR CORP'}];
const dart=(code,title,receipt)=>({source:'DART',symbol:code,title,url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='+receipt,published:'20261016'});
const headline=(title,n=1)=>({source:'example.com',title,url:'https://example.com/'+n,published:'Fri, 16 Oct 2026 09:00:00 GMT'});

test('disclosure importance follows report types that usually move a stock',()=>{
  assert.equal(importance(dart('005930','삼성전자 · 주요사항보고서(자기주식취득결정)','20261016000001')),'high');
  assert.equal(importance(dart('005930','삼성전자 · 단일판매ㆍ공급계약체결','20261016000002')),'high');
  assert.equal(importance(dart('005930','삼성전자 · 임원ㆍ주요주주특정증권등소유상황보고서','20261016000003')),'normal');
  assert.equal(importance(headline('삼성전자 유상증자 검토')),'normal','headlines are never high importance by keyword');
});

test('matcher links disclosures by code and headlines by name, ticker or code without loose matches',()=>{
  const match=matcher(securities);
  assert.deepEqual(match(dart('005930','삼성전자 · 공시','1')),['005930']);assert.deepEqual(match(dart('000660','SK하이닉스 · 공시','2')),[],'unrelated disclosures stay unmatched');
  assert.deepEqual(match(headline('삼성전자가 신규 투자를 발표')),['005930'],'long Korean names match before particles');
  assert.deepEqual(match(headline('정부, 중소기업 대상으로 지원 확대')),[],'two-letter names need a word boundary');
  assert.deepEqual(match(headline('대상, 3분기 실적 개선')),['001680']);
  assert.deepEqual(match(headline('Apple unveils new chips')),['NASD:AAPL']);assert.deepEqual(match(headline('Pineapple prices rise')),[]);
  assert.deepEqual(match(headline('Chipmakers rally (NASDAQ: ON) after guidance')),['NASD:ON']);assert.deepEqual(match(headline('Markets turn on rate hopes')),[],'short tickers need a $ or exchange prefix');
  assert.deepEqual(match(headline('NAVER 웹툰 성장')),['035420']);assert.deepEqual(match(headline('Code 005930 tops volume')),['005930']);
  assert.equal(englishTerm('ALPHABET INC-CL A'),'ALPHABET');assert.equal(englishTerm('CO'),'');
});

test('event store ingests once, filters pending by mode and window, and prunes old events',()=>{
  const db=new DatabaseSync(':memory:');const store=new NewsEvents(db);let now=Date.UTC(2026,9,16,1);
  const created=store.ingest([dart('005930','삼성전자 · 주요사항보고서(유상증자결정)','20261016000010'),dart('005930','삼성전자 · 임원ㆍ주요주주특정증권등소유상황보고서','20261016000011'),headline('삼성전자 신제품'),headline('Unrelated market wrap',2)],securities,now);
  assert.equal(created.length,4);assert.equal(store.ingest([headline('삼성전자 신제품')],securities,now).length,0,'already-seen URLs are ignored');
  assert.equal(store.ingest([headline('삼성전자 신제품',9)],securities,now).length,0,'the same title from another feed is ignored');
  assert.equal(store.latestReceipt(),'20261016000011');
  assert.deepEqual(store.pending('disclosures',now).map(e=>e.receipt),['20261016000010']);assert.equal(store.pending('all',now).length,3);assert.deepEqual(store.pending('off',now),[]);
  store.markTriggered(store.pending('all',now).map(e=>e.id),now);assert.equal(store.pending('all',now).length,0);
  store.ingest([dart('005930','삼성전자 · 합병결정','20261016000012')],securities,now);assert.equal(store.pending('disclosures',now+7*3600000).length,0,'events older than six hours do not trigger');
  assert.equal(store.relevant(10).length,4);store.ingest([],securities,now+15*86400000);assert.equal(store.list().length,0,'events are kept for 14 days');
});

test('news triggers batch relevant disclosures into one review per ten minutes and feed matched items to context',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'삼성전자',price:100}],()=>[]);paper.saveAccount({...paper.account(),paused:false});const contexts=[];const triggers=[];
  const automation=new Automation(db,paper,{request:async(_op,{context})=>{contexts.push(context);return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'Fixture.'}};}},()=>{});
  const review=automation.review.bind(automation);automation.review=trigger=>{triggers.push(trigger);return review(trigger);};
  automation.providerStatus.aiConnected=true;automation.configure({enabled:true,provider:'openai',intervalMinutes:60});
  assert.equal(automation.config.newsTrigger,'disclosures');assert.throws(()=>automation.configure({newsTrigger:'everything'}),/INVALID_SETTINGS/);
  const settle=async()=>{while(automation.busy)await new Promise(resolve=>setImmediate(resolve));};
  automation.newsEvents.ingest([dart('005930','삼성전자 · 주요사항보고서(자기주식취득결정)','20261016000020'),dart('005930','삼성전자 · 단일판매ㆍ공급계약체결','20261016000021'),headline('삼성전자 신제품 공개')],automation.relevantSecurities());
  automation.lastRun=Date.now()-61000;automation.tick();await settle();
  assert.deepEqual(triggers,['News event trigger']);const context=contexts[0];assert.equal(context.triggerEvidence.kind,'news');assert.equal(context.triggerEvidence.events.length,2,'only important disclosures in the default mode');
  assert.deepEqual(context.news[0].symbols,['005930']);assert.equal(automation.getState().newsEvents.filter(e=>e.triggeredAt).length,2);
  automation.newsEvents.ingest([dart('005930','삼성전자 · 합병결정','20261016000022')],automation.relevantSecurities());automation.lastRun=Date.now()-61000;automation.tick();await settle();
  assert.equal(triggers.length,1,'a second news review waits ten minutes');
  automation.lastNewsTrigger=Date.now()-601000;automation.lastRun=Date.now()-61000;automation.tick();await settle();assert.deepEqual(triggers,['News event trigger','News event trigger']);
  automation.configure({newsTrigger:'off'});automation.newsEvents.ingest([dart('005930','삼성전자 · 감자결정','20261016000023')],automation.relevantSecurities());automation.lastNewsTrigger=0;automation.lastRun=Date.now()-61000;automation.tick();await settle();assert.equal(triggers.length,2);
});
