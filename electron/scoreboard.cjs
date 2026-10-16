const {seoulDate}=require('./kis-activity.cjs');
// Learning scoreboard: forward decision scores against the market benchmark, lesson with/without
// comparisons and keyword contradiction checks. Local only; no broker or provider calls.
const HORIZONS=[1,5,20];const PRIMARY=5;const MIN_SAMPLE=5;
const nyDate=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const isUS=symbol=>/^(NASD|NYSE|AMEX):/.test(symbol);
const benchmarkOf=symbol=>isUS(symbol)?'SPX':'KOSPI';
const decisionDay=(symbol,at)=>isUS(symbol)?nyDate(at):seoulDate(at);
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
function stats(values){const sorted=[...values].sort((a,b)=>a-b);return {count:values.length,hitRate:values.length?values.filter(v=>v>0).length/values.length:null,meanExcess:mean(values),medianExcess:sorted.length?(sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2):null};}
// Stances come from user-written notes and applicability, never from the generated outcome text.
const NEGATED=[[/\b(avoid|don'?t|do not|never|stop|no)\s+(buying|buy|adding|add|entering|enter|chasing|chase)\b|매수\s*(금지|자제|피하|하지)|추격\s*매수|진입\s*(금지|자제)/gi,'avoid'],[/\b(avoid|don'?t|do not|never|stop|no)\s+(selling|sell|trimming|trim|cutting|cut|exiting|exit)\b|매도\s*(금지|자제|하지)|손절\s*(금지|하지)/gi,'hold']];
const POSITIVE=[[/\b(buy|buying|add|adding|accumulate|enter|increase)\b|매수|비중\s*확대|추가\s*매입/i,'enter'],[/\b(sell|selling|trim|take profits?|cut losses|cut|exit|reduce)\b|매도|손절|익절|비중\s*축소/i,'exit'],[/\b(hold|keep|stay invested|let (it|winners) run)\b|보유|유지|홀딩/i,'hold'],[/\b(avoid|stay away|skip)\b|회피|관망/i,'avoid']];
const OPPOSITE=[['enter','avoid'],['exit','hold']];
function stances(text){
  let rest=String(text??'');const found=new Set();
  for(const [pattern,stance] of NEGATED){if(rest.match(pattern))found.add(stance);rest=rest.replace(pattern,' ');}
  for(const [pattern,stance] of POSITIVE)if(pattern.test(rest))found.add(stance);
  return [...found];
}
class Scoreboard {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS symbol_closes(symbol TEXT NOT NULL,day TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(symbol,day));CREATE TABLE IF NOT EXISTS symbol_close_fetches(symbol TEXT PRIMARY KEY,at INTEGER NOT NULL)');}
  table(name){return Boolean(this.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name));}
  saveCloses(symbol,rows){const insert=this.db.prepare('INSERT INTO symbol_closes VALUES(?,?,?) ON CONFLICT(symbol,day) DO UPDATE SET close=excluded.close');for(const row of rows)if(/^\d{4}-\d{2}-\d{2}$/.test(row.day)&&Number.isFinite(row.close)&&row.close>0)insert.run(symbol,row.day,row.close);this.db.prepare('INSERT INTO symbol_close_fetches VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET at=excluded.at').run(symbol,this.clock());}
  closes(symbol){return this.db.prepare('SELECT day,close FROM symbol_closes WHERE symbol=? ORDER BY day').all(symbol).map(r=>({day:r.day,close:r.close}));}
  benchmark(index){return this.table('benchmark_closes')?this.db.prepare('SELECT day,close FROM benchmark_closes WHERE idx=? ORDER BY day').all(index).map(r=>({day:r.day,close:r.close})):[];}
  reviews(){return this.table('reviews')?this.db.prepare('SELECT payload FROM reviews ORDER BY rowid').all().map(r=>JSON.parse(r.payload)):[];}
  // Broker-account Buy/Sell recommendations; paper decisions use synthetic prices and are not scored.
  candidates(){return this.reviews().filter(r=>['Buy','Sell'].includes(r.decision?.action)&&typeof r.decision.symbol==='string'&&r.contextEvidence?.environment&&r.contextEvidence.environment!=='local-paper');}
  // Symbols whose horizons are not complete yet, least recently fetched first.
  pendingSymbols(limit=10,minAgeMs=6*3600000){
    const scored=this.decisions(),last=new Map(this.db.prepare('SELECT symbol,at FROM symbol_close_fetches').all().map(r=>[r.symbol,r.at]));const now=this.clock();
    const symbols=[...new Set(scored.filter(d=>d.horizons.some(h=>h.status==='waiting')&&now-d.timestamp<120*86400000).map(d=>d.symbol))];
    return symbols.filter(s=>!(now-(last.get(s)??0)<minAgeMs)).sort((a,b)=>(last.get(a)??0)-(last.get(b)??0)).slice(0,limit);
  }
  decisions(){
    const cache=new Map(),closes=symbol=>{if(!cache.has(symbol))cache.set(symbol,this.closes(symbol));return cache.get(symbol);};const benches={KOSPI:this.benchmark('KOSPI'),SPX:this.benchmark('SPX')};
    return this.candidates().map(review=>{
      const {symbol,action}=review.decision,day=decisionDay(symbol,review.timestamp),series=closes(symbol),bench=benches[benchmarkOf(symbol)],sign=action==='Buy'?1:-1;
      const base=series.filter(c=>c.day<=day).at(-1),after=series.filter(c=>c.day>day),benchBase=bench.filter(c=>c.day<=day).at(-1);const quote=review.contextEvidence?.quote?.price;
      const horizons=HORIZONS.map(days=>{
        const target=after[days-1];if(!base)return {days,status:series.length?'no-base':'waiting'};if(!target)return {days,status:'waiting'};
        const stock=target.close/base.close-1,benchTarget=bench.filter(c=>c.day<=target.day).at(-1);
        const benchmark=benchBase&&benchTarget&&benchTarget.day>benchBase.day?benchTarget.close/benchBase.close-1:null;
        return {days,status:benchmark==null?'no-benchmark':'scored',endDay:target.day,stockReturn:stock,benchmarkReturn:benchmark,signedReturn:sign*stock,excess:benchmark==null?null:sign*(stock-benchmark)};
      });
      const ids=Array.isArray(review.contextEvidence?.lessonIds)?review.contextEvidence.lessonIds:null;
      return {id:review.id,timestamp:review.timestamp,day,symbol,action,quantity:review.decision.quantity??0,provider:review.provider,model:review.model??null,executed:Boolean(review.orderId),benchmark:benchmarkOf(symbol),decisionPrice:Number.isFinite(quote)?quote:null,baseClose:base?.close??null,baseDay:base?.day??null,horizons,lessonIds:ids,lessonTexts:review.contextEvidence?.reviewedLessons??[]};
    });
  }
  summary(decisions,filter=()=>true){return Object.fromEntries(HORIZONS.map(days=>[days,stats(decisions.filter(filter).map(d=>d.horizons.find(h=>h.days===days)).filter(h=>h?.status==='scored').map(h=>h.excess))]));}
  lessonRows(){
    if(!this.table('lessons')||!this.table('lesson_lifecycle'))return [];
    return this.db.prepare('SELECT lessons.id,lessons.text,lesson_lifecycle.payload AS life,lesson_evidence.payload AS evidence FROM lessons JOIN lesson_lifecycle ON lessons.id=lesson_lifecycle.id LEFT JOIN lesson_evidence ON lessons.id=lesson_evidence.id').all().map(r=>({id:r.id,text:r.text,lifecycle:JSON.parse(r.life),evidence:r.evidence?JSON.parse(r.evidence):null}));
  }
  approvalHistory(id){return this.table('lesson_history')?this.db.prepare('SELECT payload FROM lesson_history WHERE id=? ORDER BY seq').all(id).map(r=>JSON.parse(r.payload)).filter(h=>h.action==='approve'):[];}
  // A review used a lesson when it recorded the lesson id, or (older reviews) its text as a prefix of a supplied lesson.
  used(decision,lesson){return decision.lessonIds?decision.lessonIds.includes(lesson.id):decision.lessonTexts.some(text=>typeof text==='string'&&text.startsWith(lesson.text));}
  lessonImpact(decisions){
    const trials=this.table('lesson_trials')?this.db.prepare('SELECT payload FROM lesson_trials').all().map(r=>JSON.parse(r.payload)):[];
    return this.lessonRows().filter(l=>l.lifecycle.status==='approved'||l.lifecycle.approvedAt||this.approvalHistory(l.id).length).map(lesson=>{
      const symbol=lesson.evidence?.symbol??null,scoped=decisions.filter(d=>symbol&&d.symbol===symbol&&lesson.evidence?.source==='broker');
      const metric=d=>d.horizons.find(h=>h.days===PRIMARY);const scoredOf=list=>list.map(metric).filter(h=>h?.status==='scored').map(h=>h.excess);
      const withLesson=stats(scoredOf(scoped.filter(d=>this.used(d,lesson)))),without=stats(scoredOf(scoped.filter(d=>!this.used(d,lesson))));
      const enough=withLesson.count>=MIN_SAMPLE&&without.count>=MIN_SAMPLE,difference=withLesson.meanExcess!=null&&without.meanExcess!=null?withLesson.meanExcess-without.meanExcess:null;
      const verdict=!symbol||lesson.evidence?.source!=='broker'?'Not scored (paper lesson)':!enough?'Too few decisions':difference>0?'Higher with lesson':difference<0?'Lower with lesson':'No difference';
      const done=trials.filter(t=>t.lessonId===lesson.id&&t.status==='completed'&&t.baseline&&t.candidate);
      return {id:lesson.id,symbol,status:lesson.lifecycle.status,approvedAt:lesson.lifecycle.approvedAt??null,expiresAt:lesson.lifecycle.expiresAt??null,note:lesson.lifecycle.note??'',applicability:lesson.lifecycle.applicability??'',horizon:PRIMARY,withLesson,without,difference,verdict,trials:{completed:done.length,meanRuleMinusHold:mean(done.map(t=>t.candidate.returnPct-t.baseline.returnPct))}};
    });
  }
  // Approved, unexpired lessons with the same symbol and account scope whose user notes point in opposite directions.
  conflicts(now=this.clock()){
    const active=this.lessonRows().filter(l=>l.lifecycle.status==='approved'&&l.lifecycle.expiresAt>now&&l.evidence).map(l=>({...l,stances:stances(`${l.lifecycle.note??''} ${l.lifecycle.applicability??''}`)}));const found=[];
    for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
      const a=active[i],b=active[j];if(a.evidence.symbol!==b.evidence.symbol||a.evidence.source!==b.evidence.source||(a.evidence.accountKey??null)!==(b.evidence.accountKey??null))continue;
      for(const [x,y] of OPPOSITE)if((a.stances.includes(x)&&b.stances.includes(y))||(a.stances.includes(y)&&b.stances.includes(x)))found.push({a:a.id,b:b.id,symbol:a.evidence.symbol,stances:a.stances.includes(x)?[x,y]:[y,x],reason:`One lesson says ${a.stances.includes(x)?x:y}, the other says ${a.stances.includes(x)?y:x}.`});
    }
    return found;
  }
  // Realized broker sales against the benchmark over the holding period. The entry is the latest earlier app buy
  // of the same symbol and account; this is an approximation, not tax-lot matching.
  realized(){
    if(!this.table('trade_outcomes'))return [];const outcomes=this.db.prepare('SELECT payload FROM trade_outcomes').all().map(r=>JSON.parse(r.payload)).filter(o=>o.source==='broker'&&o.status!=='Retracted');const benches={KOSPI:this.benchmark('KOSPI'),SPX:this.benchmark('SPX')};
    return outcomes.filter(o=>o.side==='Sell'&&o.assessment?.eligible&&Number.isFinite(o.assessment.netReturnPct)).map(sale=>{
      const entry=outcomes.filter(o=>o.side==='Buy'&&o.symbol===sale.symbol&&o.accountKey===sale.accountKey&&o.timestamp<sale.timestamp).sort((a,b)=>b.timestamp-a.timestamp)[0];
      const bench=benches[benchmarkOf(sale.symbol)],from=entry?bench.filter(c=>c.day<=decisionDay(sale.symbol,entry.timestamp)).at(-1):null,to=bench.filter(c=>c.day<=decisionDay(sale.symbol,sale.timestamp)).at(-1);
      const benchmark=from&&to&&to.day>from.day?to.close/from.close-1:null,net=sale.assessment.netReturnPct/100;
      return {id:sale.id,symbol:sale.symbol,currency:sale.currency,soldAt:sale.timestamp,boughtAt:entry?.timestamp??null,holdingDays:entry?Math.max(0,Math.round((sale.timestamp-entry.timestamp)/86400000)):null,netReturn:net,benchmark:benchmarkOf(sale.symbol),benchmarkReturn:benchmark,excess:benchmark==null?null:net-benchmark};
    }).sort((a,b)=>b.soldAt-a.soldAt);
  }
  build(){
    const decisions=this.decisions(),reviews=this.reviews();
    const groups=[...new Set(decisions.map(d=>d.model??d.provider))].map(key=>({key,summary:this.summary(decisions,d=>(d.model??d.provider)===key)}));
    return {horizons:HORIZONS,primary:PRIMARY,minSample:MIN_SAMPLE,generatedAt:this.clock(),counts:{reviews:reviews.length,holds:reviews.filter(r=>r.decision?.action==='Hold').length,paper:reviews.filter(r=>r.contextEvidence?.environment==='local-paper'&&r.decision?.action!=='Hold').length,scoredDecisions:decisions.length},
      summary:this.summary(decisions),byAction:{Buy:this.summary(decisions,d=>d.action==='Buy'),Sell:this.summary(decisions,d=>d.action==='Sell')},withLessons:this.summary(decisions,d=>(d.lessonIds?.length??d.lessonTexts.length)>0),withoutLessons:this.summary(decisions,d=>(d.lessonIds?.length??d.lessonTexts.length)===0),groups,
      decisions:decisions.slice(-100).reverse(),lessons:this.lessonImpact(decisions),conflicts:this.conflicts(),realized:this.realized().slice(0,50)};
  }
  // Compact form for the AI review context.
  context(){const board=this.build(),s=board.summary[PRIMARY];if(!s.count&&!board.conflicts.length)return null;return {horizonTradingDays:PRIMARY,scoredDecisions:s.count,hitRateVsBenchmark:s.hitRate,meanExcessReturn:s.meanExcess,note:'Excess return of past Buy/Sell recommendations versus KOSPI or S&P 500 from the decision-day close. Small samples are noisy.'};}
}
// Daily closes for a symbol from the KIS chart evidence response.
function closesFromCandles(symbol,candles){return (candles??[]).map(c=>({day:c.date??(isUS(symbol)?nyDate(c.timestamp):seoulDate(c.timestamp)),close:c.close})).filter(r=>Number.isFinite(r.close)&&r.close>0);}
module.exports={Scoreboard,stances,closesFromCandles,HORIZONS,PRIMARY};
