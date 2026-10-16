// Two-way scout feedback: briefs the trading reviews leave for the scout, and a scorecard of the scout's own picks.
const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
const BRIEF_LIMITS={open:6,days:3};
const VERDICTS=['acted','passed','waiting'];
const validSymbol=s=>typeof s==='string'&&(/^\d{6}$/.test(s)||/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(s));
const cut=(text,limit)=>{const t=String(text??'').trim().replace(/\s+/g,' ');return t.length<=limit?t:t.slice(0,limit-1).trimEnd()+'…';};
// A brief needs something for the scout to act on; empty fields are left out.
function normalizeBrief(args){
  if(!args||typeof args!=='object')return null;const request=args.request==='run'?'run':'note';
  const brief={request,reason:cut(args.reason,300),lookingFor:cut(args.lookingFor,300),avoid:cut(args.avoid,300),questions:cut(args.questions,300),
    feedback:(Array.isArray(args.feedback)?args.feedback:[]).filter(f=>f&&validSymbol(f.symbol)&&VERDICTS.includes(f.verdict)).slice(0,8).map(f=>({symbol:f.symbol,verdict:f.verdict,reason:cut(f.reason,200)}))};
  if(!brief.lookingFor&&!brief.avoid&&!brief.questions&&!brief.feedback.length&&!(request==='run'&&brief.reason))return null;
  return brief;
}
// One line per brief, for the scout's answers and the console.
function asked(brief){
  return [brief.lookingFor&&'Looking for: '+brief.lookingFor,brief.avoid&&'Avoid: '+brief.avoid,brief.questions&&'Questions: '+brief.questions,
    brief.feedback.length&&'Feedback: '+brief.feedback.map(f=>`${f.symbol} ${f.verdict}${f.reason?' ('+f.reason+')':''}`).join('; '),!brief.lookingFor&&!brief.avoid&&!brief.questions&&!brief.feedback.length&&brief.reason&&'Run requested: '+brief.reason].filter(Boolean).join(' · ');
}
class BriefStore {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS scout_briefs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,timestamp INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');}
  rows(scope,status){return this.db.prepare('SELECT payload FROM scout_briefs WHERE scope=? AND status=? ORDER BY timestamp').all(scope,status).map(r=>JSON.parse(r.payload));}
  write(record){this.db.prepare('INSERT INTO scout_briefs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(record.id,record.scope,record.timestamp,record.status,JSON.stringify(record));}
  // Briefs older than a few days expire, so stale requests do not pile up.
  open(scope){const now=this.clock();const rows=this.rows(scope,'open');for(const row of rows.filter(r=>now-r.timestamp>BRIEF_LIMITS.days*86400000))this.write({...row,status:'expired'});return rows.filter(r=>now-r.timestamp<=BRIEF_LIMITS.days*86400000);}
  add(scope,brief,meta={}){
    const open=this.open(scope);for(const row of open.slice(0,Math.max(0,open.length-BRIEF_LIMITS.open+1)))this.write({...row,status:'expired'});
    const record={id:'B-'+randomUUID().slice(0,6),scope,timestamp:this.clock(),status:'open',...meta,...brief,asked:asked(brief)};this.write(record);return record;
  }
  // The scout's answers close the briefs they name; unknown ids are ignored.
  answer(scope,answers){
    const open=new Map(this.open(scope).map(r=>[r.id,r]));const done=[];
    for(const a of answers??[]){const row=open.get(a.briefId);if(!row||!a.answer)continue;open.delete(row.id);const answered={...row,status:'answered',answer:a.answer,answeredAt:this.clock()};this.write(answered);done.push({briefId:row.id,asked:row.asked,answer:a.answer});}
    return done;
  }
  recent(scope,limit=10){return this.db.prepare('SELECT payload FROM scout_briefs WHERE scope=? ORDER BY timestamp DESC LIMIT ?').all(scope,limit).map(r=>JSON.parse(r.payload));}
  // The latest feedback on each symbol since a time, from any brief.
  feedback(scope,since){const out=new Map();for(const row of this.db.prepare('SELECT payload FROM scout_briefs WHERE scope=? AND timestamp>=? ORDER BY timestamp').all(scope,since).map(r=>JSON.parse(r.payload)))for(const f of row.feedback??[])out.set(f.symbol,{verdict:f.verdict,reason:f.reason,at:row.timestamp});return out;}
}
// Scout picks: a candidate or add target is tracked from the first plan that names it until a plan drops it.
const HORIZONS=[5,20];const PICK_ROLES=['candidate','add'];const KEEP_ROLES=['candidate','add','hold'];const MIN_SAMPLE=10;
const isUS=symbol=>/^(NASD|NYSE|AMEX):/.test(symbol);
const nyDate=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const pickDay=(symbol,at)=>isUS(symbol)?nyDate(at):seoulDate(at);
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
const round=v=>v==null?null:Math.round(v*10000)/10000;
class ScoutScorecard {
  constructor(db,prices,clock=Date.now){this.db=db;this.prices=prices;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS scout_picks(id TEXT PRIMARY KEY,scope TEXT NOT NULL,symbol TEXT NOT NULL,pickedAt INTEGER NOT NULL,endedAt INTEGER,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS symbol_close_fetches(symbol TEXT PRIMARY KEY,at INTEGER NOT NULL)');}
  record(scope,plan,at=this.clock()){
    const active=new Map(this.db.prepare('SELECT id,symbol FROM scout_picks WHERE scope=? AND endedAt IS NULL').all(scope).map(r=>[r.symbol,r.id]));
    const kept=new Set(plan.targets.filter(t=>KEEP_ROLES.includes(t.role)).map(t=>t.symbol));
    for(const [symbol,id] of active)if(!kept.has(symbol))this.db.prepare('UPDATE scout_picks SET endedAt=? WHERE id=?').run(at,id);
    for(const t of plan.targets.filter(t=>PICK_ROLES.includes(t.role)&&!active.has(t.symbol)))this.db.prepare('INSERT INTO scout_picks VALUES(?,?,?,?,NULL,?)').run(randomUUID(),scope,t.symbol,at,JSON.stringify({name:t.name,role:t.role,targetWeightPct:t.targetWeightPct,thesis:t.thesis}));
  }
  rows(scope,limit=40){return this.db.prepare('SELECT id,symbol,pickedAt,endedAt,payload FROM scout_picks WHERE scope=? ORDER BY pickedAt DESC LIMIT ?').all(scope,limit).map(r=>({id:r.id,symbol:r.symbol,pickedAt:r.pickedAt,endedAt:r.endedAt,...JSON.parse(r.payload)}));}
  // Whether a trading review recommended, proposed or bought the pick after it was made.
  acted(symbol,since,reviews){const buys=reviews.filter(r=>r.decision?.symbol===symbol&&r.decision.action==='Buy'&&r.timestamp>=since);return buys.some(r=>r.orderId)?'bought':buys.some(r=>r.proposalId)?'proposed':buys.length?'recommended':'not yet';}
  build(scope,feedback=new Map()){
    const reviews=this.prices.reviews?.()??[];const benches={KOSPI:this.prices.benchmark('KOSPI'),SPX:this.prices.benchmark('SPX')};const cache=new Map();
    const picks=this.rows(scope).map(pick=>{
      if(!cache.has(pick.symbol))cache.set(pick.symbol,this.prices.closes(pick.symbol));const series=cache.get(pick.symbol);const bench=benches[isUS(pick.symbol)?'SPX':'KOSPI'];
      const day=pickDay(pick.symbol,pick.pickedAt),base=series.filter(c=>c.day<=day).at(-1),after=series.filter(c=>c.day>day),benchBase=bench.filter(c=>c.day<=day).at(-1);
      const horizons=Object.fromEntries(HORIZONS.map(days=>{const target=after[days-1];if(!base||!target)return [days,null];const benchTarget=bench.filter(c=>c.day<=target.day).at(-1);const stock=target.close/base.close-1;const market=benchBase&&benchTarget&&benchTarget.day>benchBase.day?benchTarget.close/benchBase.close-1:null;return [days,{stockReturn:round(stock),benchmarkReturn:round(market),excess:market==null?null:round(stock-market)}];}));
      const fb=feedback.get(pick.symbol);
      return {...pick,day,benchmark:isUS(pick.symbol)?'S&P 500':'KOSPI',horizons,acted:this.acted(pick.symbol,pick.pickedAt,reviews),...(fb&&fb.at>=pick.pickedAt?{feedback:{verdict:fb.verdict,reason:fb.reason}}:{})};
    });
    const summary=Object.fromEntries(HORIZONS.map(days=>{const values=picks.map(p=>p.horizons[days]?.excess).filter(v=>v!=null);return [days,{scored:values.length,beatBenchmark:values.filter(v=>v>0).length,meanExcess:round(mean(values))}];}));
    return {picks,summary,minSample:MIN_SAMPLE};
  }
  // Compact view for the scout: summary plus the latest picks.
  context(scope,feedback){
    const board=this.build(scope,feedback);if(!board.picks.length)return null;
    return {tradingDayHorizons:HORIZONS,summary:board.summary,picks:board.picks.slice(0,12).map(p=>({symbol:p.symbol,name:p.name,role:p.role,pickedOn:p.day,active:!p.endedAt,thesis:cut(p.thesis,140),excess5:p.horizons[5]?.excess??null,excess20:p.horizons[20]?.excess??null,tradingReviews:p.acted,...(p.feedback?{feedback:p.feedback}:{})})),
      note:`Excess return after 5 and 20 trading days versus KOSPI or the S&P 500, from the close on the pick day; null means not enough days yet. Fewer than ${MIN_SAMPLE} scored picks is mostly noise.`};
  }
  // Symbols whose 20-day result is still open, least recently fetched first; shares the decision scoreboard's price table.
  pendingSymbols(limit=10,minAgeMs=6*3600000){
    const now=this.clock();const last=new Map(this.db.prepare("SELECT symbol,at FROM symbol_close_fetches").all().map(r=>[r.symbol,r.at]));
    const rows=this.db.prepare('SELECT symbol,pickedAt FROM scout_picks WHERE pickedAt>?').all(now-60*86400000);
    const open=[...new Set(rows.filter(r=>{const day=pickDay(r.symbol,r.pickedAt);return this.prices.closes(r.symbol).filter(c=>c.day>day).length<HORIZONS.at(-1);}).map(r=>r.symbol))];
    return open.filter(s=>!(now-(last.get(s)??0)<minAgeMs)).sort((a,b)=>(last.get(a)??0)-(last.get(b)??0)).slice(0,limit);
  }
}
module.exports={BRIEF_LIMITS,VERDICTS,normalizeBrief,asked,BriefStore,ScoutScorecard,HORIZONS};
