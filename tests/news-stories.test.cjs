const test=require('node:test');const assert=require('node:assert/strict');
const {topStories,terms}=require('../electron/news-stories.cjs');const n=require('../electron/narrative.cjs');
const now=Date.parse('2026-10-21T16:30:00+09:00');const H=3600000;
const item=(title,source,hoursAgo,extra={})=>({title,source,kind:'headline',published:new Date(now-hoursAgo*H).toISOString(),symbols:[],...extra});
// A week of ordinary AI and earnings coverage, then one day where many outlets cover a SpaceX earnings surprise.
function corpus(){
  const out=[];const outlets=['연합뉴스','파이낸셜','이데일리','머니투데이','뉴스핌','헤럴드경제','매일경제','서울경제','한국경제신문','이투데이'];
  for(let d=0;d<6;d++)for(const [i,o] of outlets.entries()){out.push(item(`AI 데이터센터 투자 확대 ${d}-${i}`,o,d*24+2+i*0.1));out.push(item(`3분기 매출 영업이익 발표 ${d}-${i}`,o,d*24+3+i*0.1));}
  for(const [i,o] of outlets.slice(0,8).entries())out.push(item(i%2?`스페이스X 3분기 깜짝 실적에 코스피 반도체주 강세`:`스페이스X가 살린 AI 투자 심리…코스피 상승`,o,1+i*0.2));
  for(const [i,o] of outlets.slice(0,7).entries())out.push(item(`역삼 연쇄방화범 검거 ${i}`,o,2+i*0.1));
  for(let i=0;i<30;i++)out.push(item(`스페이스X 관련 자동 시세 알림 ${i}`,'인포스탁',1),item(`스페이스X 공시 ${i}`,'DART',1,{kind:'disclosure'}));
  return out;
}
test('a story many outlets suddenly cover ranks first; everyday topics, non-market news and automated feeds do not count',()=>{
  const s=topStories(corpus(),now);
  assert.equal(s[0].terms[0],'스페이스x');assert.equal(s[0].outlets,8,'automated feeds and filings are not coverage');assert.ok(s[0].timesUsual>=5);
  assert.ok(!s.some(x=>x.terms.includes('ai')||x.terms.includes('데이터센터')&&x.timesUsual<5),'a topic covered every day is not a story');
  assert.ok(!s.some(x=>x.terms.includes('역삼')),'non-market news is left out');
  assert.match(s[0].headlines[0].title,/스페이스X/);
});
test('Korean particles are stripped and numbers, brackets and stop words are ignored',()=>{
  assert.deepEqual([...terms('[마켓뷰] 스페이스X가 살린 AI 투자 심리…코스피 3% 상승')].sort(),['살린','스페이스x','심리'].sort());
});
test('the narrative reads story headlines first and keeps causal chains honest',()=>{
  const list=n.headlines([{title:'story headline',source:'a',published:new Date(now).toISOString(),story:0},...Array.from({length:200},(_,i)=>({title:'filler '+i,source:'b',published:new Date(now).toISOString()}))],now);
  assert.equal(list[0].story,0);assert.equal(list.length,n.LIMITS.headlines);
  const driver={kind:'trigger',title:'SpaceX lifts AI sentiment',summary:'s',direction:'positive',themes:['ai_demand'],affects:['Korean chips'],confirmedBy:[{signal:'KOSPI',observation:'+3.3%'}],confidence:'medium',continues:'',sources:[0],
    chain:[{step:'SpaceX earnings surprise',support:'headline',ref:'0'},{step:'AI sentiment improves',support:'hypothesis',ref:''},{step:'Foreign buying of Korean chips',support:'signal',ref:'FOREIGN_CHIPS'},{step:'KOSPI rises',support:'signal',ref:'KOSPI'}]};
  const v=n.validate({regime:'neutral',summary:'s',drivers:[driver]},{signalIds:['KOSPI'],headlineList:list,now});
  assert.deepEqual(v.drivers[0].chain.map(c=>c.support),['headline','hypothesis','hypothesis','signal'],'a step citing a signal that does not exist becomes a hypothesis');
  assert.equal(v.drivers[0].chain[0].ref,'story headline');
  const strict=s=>{if(s.type==='object'){assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort());assert.equal(s.additionalProperties,false);Object.values(s.properties).forEach(strict);}if(s.items)strict(s.items);};strict(n.SCHEMA);
  assert.deepEqual(n.agentView({...v,timestamp:now,drivers:v.drivers.map(d=>({...d,confirmed:true}))},now).drivers[0].chain.length,4);
});
test('a new top story stops a review from being skipped; growing coverage of the same story does not',()=>{
  const {fingerprint}=require('../electron/token-saver.cjs');const base={universe:[],quotes:[],topStories:[{terms:['스페이스x'],outlets:8}]};
  assert.equal(fingerprint(base).exact,fingerprint({...base,topStories:[{terms:['스페이스x'],outlets:17}]}).exact);
  assert.notEqual(fingerprint(base).exact,fingerprint({...base,topStories:[{terms:['스페이스x'],outlets:8},{terms:['사이드카'],outlets:12}]}).exact);
});
