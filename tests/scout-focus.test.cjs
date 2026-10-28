const test=require('node:test');const assert=require('node:assert/strict');
const {researchFocus,carryForward,runScout}=require('../electron/scout.cjs');
const kst=s=>Date.parse(s+'+09:00');const both=['KR','US'];
test('research focuses on markets within 30 minutes of their regular open or close',()=>{
  assert.deepEqual(researchFocus(both,kst('2026-10-20T09:10')).markets,['KR'],'Korea just opened; the U.S. closed hours ago');
  assert.deepEqual(researchFocus(both,kst('2026-10-20T22:40')).markets,['US'],'U.S. open (22:30 KST in October)');
  assert.deepEqual(researchFocus(both,kst('2026-10-20T08:35')).markets,['KR'],'Korea opens within 30 minutes');
  assert.deepEqual(researchFocus(both,kst('2026-10-20T15:55')).markets,['KR'],'Korea closed 25 minutes ago');
  assert.deepEqual(researchFocus(both,kst('2026-10-21T05:20')).markets,['US'],'U.S. closed 20 minutes ago');
  const quiet=researchFocus(both,kst('2026-10-20T18:00'));assert.deepEqual(quiet.markets,both,'nothing open and no extended trading: everything');
  assert.deepEqual(researchFocus(both,kst('2026-10-20T18:00'),{environment:'live',enabled:{usPre:true}}).markets,['US'],'an extended session the app trades');
  assert.deepEqual(researchFocus(both,kst('2026-10-20T09:10')).deferred,['US']);
});
test('deferred markets keep the previous plan targets with their date, until three days old',()=>{
  const now=kst('2026-10-20T22:40');const prevAt=kst('2026-10-20T09:10');
  const previous={timestamp:prevAt,plan:{targets:[{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:30,thesis:'t',risks:'r'},{symbol:'NASD:OLD',name:'Old',role:'candidate',targetWeightPct:5,thesis:'t',risks:'r'}]}};
  const plan={summary:'s',targets:[{symbol:'NASD:NVDA',name:'Nvidia',role:'candidate',targetWeightPct:10,thesis:'t',risks:'r'}]};
  const merged=carryForward(plan,previous,['KR'],now);assert.deepEqual(merged.targets.map(t=>t.symbol),['NASD:NVDA','005930']);assert.equal(merged.targets[1].carriedFrom,new Date(prevAt).toISOString());
  assert.deepEqual(carryForward({...plan,targets:[...plan.targets,{symbol:'000270',name:'Kia',role:'candidate',targetWeightPct:5,thesis:'t',risks:'r'}]},previous,['KR'],now).targets.map(t=>t.symbol),['NASD:NVDA','000270'],'a plan that covers Korea keeps its own targets');
  const stale={timestamp:prevAt,plan:{targets:[{...previous.plan.targets[0],carriedFrom:new Date(kst('2026-10-16T09:10')).toISOString()}]}};assert.equal(carryForward(plan,stale,['KR'],now).targets.length,1,'older than three days');
  assert.equal(carryForward(plan,previous,[],now),plan);
});
test('a scout run allows two research rounds, then must answer',async()=>{
  let rounds=0;const finals=[];await assert.rejects(runScout({request:async({final})=>{rounds++;finals.push(final);return {toolCalls:[{name:'x',callId:String(rounds),args:{}}],continuation:[]};},tools:{},log:()=>{}}),/INVALID_AI_RESPONSE/);
  assert.equal(rounds,3);assert.deepEqual(finals,[false,false,true]);
});
// Review of 7dc8395, P2: during U.S. trading Korea is deferred, and every Korean company read was refused, so a
// next-session sector ETF could be searched for but its fund details, holdings and leverage could not be checked.
test('review P2: a closed market allows a few read-only company reads for next-session candidates, labeled as awaiting the open',async()=>{
  const {focusTools,NEXT_SESSION_LABEL,INSTRUCTIONS}=require('../electron/scout.cjs');const calls=[];const added=[];
  const discovery={research:async args=>{calls.push(args.symbol);return {status:'ok',symbol:args.symbol,fund:{leverage:2}};},screen_market:()=>({rows:[]}),search_securities:()=>({rows:[]}),marketOverview:()=>({status:'ok'}),update_watchlist:args=>{added.push(...args.entries);return {status:'ok'};}};
  let stale=false;const tools=focusTools(discovery,{markets:['US'],deferred:['KR']},{guard:()=>{if(stale)throw new Error('STALE_DECISION');}});
  const us=await tools.get_company_research({symbol:'NASD:NVDA',sections:['quote']});assert.equal(us.nextSession,undefined,'an open market is read as before');
  const reads=[];for(const symbol of ['233740','091170','462330','005930'])reads.push(await tools.get_company_research({symbol,sections:['fund','holdings']}));
  assert.deepEqual(reads.slice(0,3).map(r=>[r.status,r.nextSession.market,r.nextSession.awaitingOpen,r.nextSession.readsLeft]),[['ok','KR',true,2],['ok','KR',true,1],['ok','KR',true,0]]);
  assert.match(reads[0].nextSession.note,/last session.*confirmation at the open/);assert.equal(reads[3].status,'skipped','bounded: the fourth read is refused');
  assert.deepEqual(calls,['NASD:NVDA','233740','091170','462330']);
  assert.equal(tools.screen_market({market:'KR'}).status,'skipped','screening a closed market stays refused');assert.equal(tools.get_market_overview().status,'skipped');
  tools.update_watchlist({action:'add',entries:[{symbol:'233740',reason:'KODEX semiconductor leveraged on the U.S. chip rally'},{symbol:'NASD:AMD',reason:'open market'}]});
  assert.deepEqual(added.map(e=>e.reason.startsWith(NEXT_SESSION_LABEL)),[true,false],'only the closed-market candidate is labeled');
  stale=true;assert.throws(()=>tools.update_watchlist({action:'add',entries:[]}),/STALE_DECISION/);
  assert.match(INSTRUCTIONS,/up to three such reads per run, marked nextSession/);assert.doesNotMatch(INSTRUCTIONS,/company research for other markets are refused/);
});
