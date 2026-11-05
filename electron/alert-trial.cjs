// A bounded trial of the selective watchlist alerts (audit 2026-11-04, Stage 5). Off unless the user turns the setting
// alertTrial on; the saved watchlistAlerts preference is never changed. While it runs, price reviews come from the
// selective rules (electron/watch-alerts.cjs) and the current rule is computed beside them in shadow, without its side
// effects, and logged, so what each rule alone would have done stays on record. Only the choice of which price moves
// start a review changes: risk, emergency, order, session, news and agent triggers, the review interval and backstop,
// conditional orders and every protection stay as they are.
// The question it answers: what do the selective rules' own alerts cause (the 27 new-only episodes of the observation
// period could not be observed, since the rule in force did not alert).
// It ends by itself on any rollback condition (ROLLBACK), on the added-cost limit, or when it has run its trading days.
const {sessionOf}=require('./watch-alerts.cjs');
const LIMITS={respondMinutes:5,checkGapMinutes:15,priceReviewsPerDay:10,priceReviewUSDPerDay:1.2,addedUSD:2.5,tradingDays:5,calendarDays:14};
// A trading day counts toward the trial only when the trial watched it: at least 95% of that market's regular-session
// minutes covered (auto trading running and a price check within the last 5 minutes) and no uncovered stretch longer
// than 15 minutes. Korea and the U.S. are counted apart, each by its own trading date; a holiday has no session minutes.
const COVERAGE={minShare:0.95,maxGapMinutes:15,checkFreshMinutes:5};
const ROLLBACK={
  'held-no-review':'A held position moved past its review threshold or level and no completed review assessed it within 5 minutes.',
  'shadow-held-no-review':'The current rule (in shadow) alerted on a held position and no completed review assessed it within 5 minutes.',
  'entry-no-review':'A stock not held crossed an entry level set by a review and no completed review assessed it within 5 minutes.',
  'price-reviews-per-day':'More than 10 price-movement reviews in one trading day.',
  'price-review-cost-per-day':'Price-review cost above $1.20 in one trading day.',
  'added-cost':'Reviews the current rule would not have started cost more than $2.50 in total.',
  'check-error':'The alert check failed.','check-gap':'More than 15 minutes without a price check while a market in scope was open.','shadow-log':'The shadow log could not be written.'};
const MIN=60000,DAY=86400000;
const kstDay=t=>sessionOf('KR',t);
class AlertTrial {
  // Open alerts are part of the trial record (release review 2026-11-05, P2): a restart restores them. Their five minutes
  // count only while auto trading runs and no review is running (monitor), so time the app was closed or paused is not
  // counted, and an alert already overdue before a restart rolls the trial back as soon as monitoring resumes.
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;
    db.exec('CREATE TABLE IF NOT EXISTS alert_trials(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL)');}
  save(t){this.db.prepare('UPDATE alert_trials SET payload=? WHERE id=?').run(JSON.stringify(t),t.id);return t;}
  all(){return this.db.prepare('SELECT id,payload FROM alert_trials ORDER BY id').all().map(r=>({...JSON.parse(r.payload),id:r.id}));}
  current(){return this.all().find(t=>t.status==='running')??null;}
  // scope: the account scope; markets: the markets in the review scope.
  start({scope,markets}){if(this.current())return this.current();const now=this.clock();const id=Number(this.db.prepare('INSERT INTO alert_trials(payload) VALUES(?)').run('{}').lastInsertRowid);
    return this.save({id,status:'running',scope,markets,startedAt:now,limits:LIMITS,coverageRule:COVERAGE,days:{KR:[],US:[]},partialDays:{KR:[],US:[]},coverage:{},lastCheckAt:now,attempts:[],obligations:[],answered:[],events:[]});}
  // Coverage, every monitor call while auto trading runs: each regular-session minute of each market in the trial with a
  // fresh price check is covered. A day is judged once its session is over (judge()).
  cover({now=this.clock(),regularOpen,closedDays}={}){const t=this.current();if(!t||!regularOpen)return;const minute=Math.floor(now/MIN);let changed=false;
    for(const m of t.markets){if(!regularOpen(m,now,closedDays))continue;const key=`${m}|${sessionOf(m,now)}`,c=t.coverage[key]??[];
      if(now-t.lastCheckAt<=COVERAGE.checkFreshMinutes*MIN&&c.at(-1)!==minute){c.push(minute);t.coverage[key]=c;changed=true;}else if(!t.coverage[key]){t.coverage[key]=c;changed=true;}}
    if(changed)this.save(t);}
  // Days whose regular session has ended: qualifying ones count, others are kept as partial with their coverage.
  judge({now=this.clock(),regularOpen,closedDays}={}){const t=this.current();if(!t||!regularOpen)return;let changed=false;
    for(const [key,covered] of Object.entries(t.coverage)){const [m,day]=key.split('|');const from=Date.parse(`${day}T00:00:00Z`)-15*3600000,to=from+40*3600000;
      this.sessions??=new Map();if(!this.sessions.has(key)){const s=[];for(let x=Math.ceil(from/MIN);x*MIN<to;x++)if(sessionOf(m,x*MIN)===day&&regularOpen(m,x*MIN,closedDays))s.push(x);this.sessions.set(key,s);}const session=this.sessions.get(key);
      if(session.length&&now<=(session.at(-1)+1)*MIN)continue;const set=new Set(covered);let gap=0,longest=0;for(const x of session){if(set.has(x))gap=0;else longest=Math.max(longest,++gap);}
      const share=session.length?session.filter(x=>set.has(x)).length/session.length:0;const ok=session.length>0&&share>=COVERAGE.minShare&&longest<=COVERAGE.maxGapMinutes;
      if(ok){if(!t.days[m].includes(day))t.days[m].push(day);}else t.partialDays[m].push({day,sessionMinutes:session.length,coveredPct:Math.round(share*1000)/10,longestGapMinutes:longest});
      delete t.coverage[key];this.sessions.delete(key);changed=true;}
    if(changed)this.save(t);}
  end(reason,detail=null){const t=this.current();if(!t)return null;return this.save({...t,status:reason==='completed'?'completed':reason==='turned off'?'stopped':'rolled back',endedAt:this.clock(),endReason:reason,...(detail?{endDetail:detail}:{})});}
  // Each price check while the trial runs. shadow: the current rule's trigger; proposed: the selective rules' trigger;
  // held: held symbols; watches: the review levels as they were before the check. Opens an obligation for each alert that
  // must be answered by a review within respondMinutes: a holding's move or level under either rule, and a crossing of an
  // entry level on a stock not held. The current rule alerts whenever a price is beyond an unfired level, so its level
  // alert counts as a crossing only when the level was not already passed when it was set (the MAX level of Oct 30 was
  // set below the price and is no crossing). Returns nothing; monitor() decides.
  check({now=this.clock(),shadow,proposed,held,quotes=[],watches=[]}){const t=this.current();if(!t)return;
    const items=x=>!x?[]:x.kind==='watchlist'?x.alerts:[x,...(x.alongside??[])];t.obligations??=[];
    const open=(kind,symbol)=>{const k=`${kind}|${symbol}`;if(!t.obligations.some(o=>o.key===k))t.obligations.push({key:k,kind,symbol,since:now,elapsedMs:0,lastAt:now,rules:require('./watch-alerts.cjs').RULES_VERSION,trialId:t.id,scope:t.scope});};
    for(const a of items(proposed)){if(held.has(a.symbol)&&['percent','price'].includes(a.kind))open('held-no-review',a.symbol);else if(a.kind==='entry-level')open('entry-no-review',a.symbol);}
    const passedWhenSet=s=>{const w=watches.find(x=>x.symbol===s);return Boolean(w&&w.baseline>0&&(w.direction==='above'?w.baseline>=w.price:w.baseline<=w.price));};
    for(const a of items(shadow)){if(held.has(a.symbol))open('shadow-held-no-review',a.symbol);else if(a.kind==='price'&&!passedWhenSet(a.symbol))open('entry-no-review',a.symbol);}
    this.save({...t,lastCheckAt:now,checks:(t.checks??0)+1});}
  // A review started (for the counts and costs; it answers nothing yet). shadowFired: whether the current rule also
  // alerted at the check that started a price review (when it did not, the review is one the current rule would not have
  // started: an added review).
  attempt({now=this.clock(),trigger,reviewId,shadowFired=null}){const t=this.current();if(!t)return;
    const a={at:now,trigger,reviewId,...(trigger==='Price movement trigger'?{added:shadowFired===false}:{})};this.save({...t,attempts:[...t.attempts,a].slice(-500)});}
  // A review completed and assessed these symbols (triggered by them, gave verdicts on them or held them): it answers the
  // open alerts on them. A review that failed, or one that did not assess the symbol, answers nothing.
  answered({now=this.clock(),reviewId,assessed=[]}){const t=this.current();if(!t)return;const set=new Set(assessed);const done=(t.obligations??[]).filter(o=>set.has(o.symbol));if(!done.length)return;
    this.save({...t,obligations:t.obligations.filter(o=>!set.has(o.symbol)),answered:[...(t.answered??[]),...done.map(o=>({kind:o.kind,symbol:o.symbol,since:o.since,answeredAt:now,reviewId,waitedMs:o.elapsedMs}))].slice(-200)});}
  // The price reviews of a trading day (Seoul's date) and their cost; the added reviews' cost over the whole trial.
  cost(reviewIds){if(!reviewIds.length)return 0;const set=new Set(reviewIds);let micro=0;
    for(const r of this.db.prepare('SELECT payload FROM ai_calls WHERE json_extract(payload,\'$.timestamp\')>=?').all(this.current()?.startedAt??0)){const c=JSON.parse(r.payload);if(set.has(c.reviewId))micro+=c.cost?.micro??0;}return micro/1e6;}
  // Rollback and completion, checked every few seconds while auto trading runs. busy: a review is running (its own
  // duration never counts against the 5 minutes); held: a failure hold (a size failure holding price triggers) or an
  // emergency, during which the trial cannot be the cause; marketsOpen: whether a market in scope is open; since: when
  // auto trading last started running (checks cannot run before it). Returns {end:reason, detail} or null.
  monitor({now=this.clock(),busy=false,held=false,marketsOpen=false,since=0}={}){const t=this.current();if(!t)return null;const L=t.limits;
    // Unanswered time accrues only now and from when monitoring last ran or resumed, and not while a review runs or a
    // failure hold or emergency applies.
    let changed=false;for(const o of t.obligations??[]){const from=Math.max(o.lastAt??now,since);if(!busy&&!held&&now>from)o.elapsedMs=(o.elapsedMs??0)+(now-from);o.lastAt=now;changed=true;}
    if(changed)this.save(t);const late=(t.obligations??[]).find(o=>o.elapsedMs>L.respondMinutes*MIN);if(late)return {end:late.kind,detail:`${late.symbol}: ${ROLLBACK[late.kind]}`};
    if(marketsOpen&&!busy&&!held&&now-Math.max(t.lastCheckAt,since)>L.checkGapMinutes*MIN)return {end:'check-gap',detail:ROLLBACK['check-gap']};
    const today=t.attempts.filter(a=>a.trigger==='Price movement trigger'&&kstDay(a.at)===kstDay(now));
    if(today.length>L.priceReviewsPerDay)return {end:'price-reviews-per-day',detail:`${today.length} price reviews on ${kstDay(now)}.`};
    const dayUSD=this.cost(today.map(a=>a.reviewId));if(dayUSD>L.priceReviewUSDPerDay)return {end:'price-review-cost-per-day',detail:`$${dayUSD.toFixed(2)} on ${kstDay(now)}.`};
    const addedUSD=this.cost(t.attempts.filter(a=>a.added).map(a=>a.reviewId));if(addedUSD>L.addedUSD)return {end:'added-cost',detail:`$${addedUSD.toFixed(2)} on added reviews.`};
    if(t.markets.every(m=>t.days[m].length>=L.tradingDays))return {end:'completed',detail:`${L.tradingDays} trading days in ${t.markets.join(' and ')}.`};
    if(now-t.startedAt>L.calendarDays*DAY)return {end:'completed',detail:`${L.calendarDays} calendar days.`};
    return null;}
  // The trial so far, in the common terms: checks, reviews started, added reviews and their cost, days run, and the
  // trial's checks grouped into episodes (alert_observations rows with mode trial).
  report(){const t=this.current()??this.all().at(-1);if(!t)return null;const price=t.attempts.filter(a=>a.trigger==='Price movement trigger'),added=price.filter(a=>a.added);
    let episodes=null;try{const O=new (require('./watch-alerts.cjs').AlertObservations)(this.db);const eps=O.episodes(t.startedAt).filter(e=>e.detail);episodes={total:eps.length,oldOnly:eps.filter(e=>e.detail.condition==='old-only').length,newOnly:eps.filter(e=>e.detail.condition==='new-only').length,both:eps.filter(e=>e.detail.condition==='both').length};}catch{}
    return {status:t.status,startedAt:new Date(t.startedAt).toISOString(),...(t.endedAt?{endedAt:new Date(t.endedAt).toISOString(),endReason:t.endReason,endDetail:t.endDetail??null}:{}),limits:t.limits,
      days:{KR:t.days.KR.length,US:t.days.US.length},qualifyingDays:t.days,partialDays:t.partialDays??{KR:[],US:[]},checks:t.checks??0,reviewsStarted:t.attempts.length,priceReviews:price.length,addedReviews:added.length,addedUSD:+this.cost(added.map(a=>a.reviewId)).toFixed(3),episodes};}
}
module.exports={AlertTrial,LIMITS,ROLLBACK,COVERAGE};
