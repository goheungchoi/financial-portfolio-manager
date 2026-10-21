// Top stories: what many outlets are covering now, so a market-moving story outside the portfolio is not lost among
// thousands of headlines. A term (a word in headlines, Korean particles stripped) is "bursting" when far more distinct
// outlets use it in the last 24 hours than on an average earlier day; headlines sharing a bursting term form a story,
// stories with mostly the same headlines merge, and stories rank by how many distinct outlets covered them.
// Exchange filings and automated feeds do not count as coverage.
const WINDOW=24*3600000,BASELINE_DAYS=5,MIN_OUTLETS=5;
const NOT_COVERAGE=new Set(['DART','인포스탁']);
// Common market words and Korean particles: frequent every day, so they never mark a story on their own.
const STOP=new Set(['코스피','코스닥','증시','주가','주식','종목','투자','시장','기업','실적','상승','하락','급등','급락','외국인','기관','개인','매수','매도','특징주','마감','오늘','내일','전망','발표','공시','억원','조원','만원','달러','미국','한국','중국','일본','정부','대통령','매출','분기','1분기','2분기','3분기','4분기','영업이익','영업익','순이익','흑자','적자','전환','개최','성장','돌파','인수','매각','수주','선정','공개','출시','확대','국내','내년','올해','활용','혁신','데이터','솔루션','ai','포럼','ir','합류','강세','약세','신고가','목표가','상향','하향','최대','사상','기록','체결','계약','협약','지원','추진','강화','the','and','for','with','from','after','stock','stocks','market','shares','says','new','its','are','will','over','into','than','more','what','how','why','this','that','report','first']);
const PARTICLE=/(으로|에서|까지|부터|에게|이다|이며|와의|과의|으로는|에는|에도|은|는|이|가|을|를|의|에|와|과|도|로|만)$/;
function terms(title){
  const out=new Set();
  for(let w of String(title).replace(/\[[^\]]*\]/g,' ').split(/[^\p{L}\p{N}.]+/u)){
    w=w.replace(/\.+$/,'');if(/[\p{Script=Hangul}]/u.test(w))w=w.replace(PARTICLE,'');w=w.toLowerCase();
    if(w.length<2||/^\d+([.,]\d+)?$/.test(w)||STOP.has(w))continue;out.add(w);}
  return out;
}
const outletOf=e=>String(e.source??'').replace(/^www\./,'');
const timeOf=e=>{const t=Date.parse(e.published);return Number.isFinite(t)?t:(e.firstSeenAt??0);};
// A term bursts when its articles in the last 24 hours are at least BURST times its average day in the baseline (plus one)
// and at least MIN_OUTLETS distinct outlets used it. Everyday words (AI, earnings season vocabulary) have a high baseline.
const BURST=5;
// Market relevance: at least a quarter of a story's headlines are about markets, or it is linked to a listed symbol.
const MARKET=/주가|코스피|코스닥|증시|주식|종목|특징주|투자|실적|매출|영업이익|반도체|상장|나스닥|뉴욕증시|시황|금리|환율|유가|외국인|순매수|순매도|사이드카|stock|shares|earnings|nasdaq|s&p|dow|market|investor|rally|ipo|fed|yield/i;
function topStories(events,now=Date.now(),{limit=5}={}){
  const items=events.filter(e=>e.kind!=='disclosure'&&!NOT_COVERAGE.has(outletOf(e))&&e.title).map(e=>({e,t:timeOf(e),terms:terms(e.title),outlet:outletOf(e),id:e.id??e.title}));
  const recent=items.filter(x=>x.t<=now&&now-x.t<=WINDOW),earlier=items.filter(x=>now-x.t>WINDOW&&now-x.t<=WINDOW*(1+BASELINE_DAYS));
  const days=earlier.length?Math.max(1,Math.min(BASELINE_DAYS,(now-WINDOW-Math.min(...earlier.map(x=>x.t)))/WINDOW)):1;
  const count=list=>{const m=new Map();for(const x of list)for(const t of x.terms){const c=m.get(t)??{articles:0,outlets:new Set()};c.articles++;c.outlets.add(x.outlet);m.set(t,c);}return m;};
  const today=count(recent),before=count(earlier);
  const bursting=[...today].map(([t,c])=>({t,outlets:c.outlets.size,articles:c.articles,ratio:c.articles/((before.get(t)?.articles??0)/days+1)})).filter(x=>x.outlets>=MIN_OUTLETS&&x.ratio>=BURST).sort((a,b)=>b.outlets-a.outlets||b.ratio-a.ratio);
  const stories=[];
  for(const b of bursting){const members=recent.filter(x=>x.terms.has(b.t));const ids=new Set(members.map(x=>x.id));
    const same=stories.find(s=>{let common=0;for(const id of ids)if(s.ids.has(id))common++;return common>=0.5*Math.min(ids.size,s.ids.size);});
    if(same){for(const x of members)if(!same.ids.has(x.id)){same.ids.add(x.id);same.members.push(x);}same.terms.push(b.t);continue;}
    stories.push({terms:[b.t],ids,members:[...members],ratio:b.ratio});}
  return stories.filter(s=>s.members.some(x=>(x.e.symbols??[]).length)||s.members.filter(x=>MARKET.test(x.e.title)).length>=0.25*s.members.length).map(s=>{const out=new Set(s.members.map(x=>x.outlet));const byTime=[...s.members].sort((a,b)=>a.t-b.t);const seen=new Set();
      // Example headlines: those sharing the most of the story's terms first, then the newest.
      const shared=x=>s.terms.filter(t=>x.terms.has(t)).length;
      const headlines=[...s.members].sort((a,b)=>shared(b)-shared(a)||b.t-a.t).filter(x=>{const k=x.e.title.replace(/\s+/g,'').slice(0,40);if(seen.has(k))return false;seen.add(k);return true;}).slice(0,4).map(x=>({title:String(x.e.title).slice(0,160),source:x.outlet,published:new Date(x.t).toISOString()}));
      const symbols=[...new Set(s.members.flatMap(x=>x.e.symbols??[]))].slice(0,6);
      return {terms:s.terms.slice(0,4),outlets:out.size,articles:s.members.length,timesUsual:Math.round(s.ratio*10)/10,firstSeen:new Date(byTime[0].t).toISOString(),latest:new Date(byTime.at(-1).t).toISOString(),headlines,...(symbols.length?{symbols}:{})};})
    // Ranked by coverage, weighted by how unusual it is: a story ten times its usual volume beats a common word slightly up.
    .sort((a,b)=>b.outlets*Math.sqrt(Math.min(b.timesUsual,25))-a.outlets*Math.sqrt(Math.min(a.timesUsual,25))).slice(0,limit);
}
module.exports={topStories,terms,WINDOW,MIN_OUTLETS,BURST};
