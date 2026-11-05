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
const ROLLBACK={
  'held-no-review':'A held position moved past its review threshold or level and no review started within 5 minutes.',
  'shadow-held-no-review':'The current rule (in shadow) alerted on a held position and no review started within 5 minutes.',
  'entry-no-review':'A stock not held crossed an entry level set by a review and no review started within 5 minutes.',
  'price-reviews-per-day':'More than 10 price-movement reviews in one trading day.',
  'price-review-cost-per-day':'Price-review cost above $1.20 in one trading day.',
  'added-cost':'Reviews the current rule would not have started cost more than $2.50 in total.',
  'check-error':'The alert check failed.','check-gap':'More than 15 minutes without a price check while a market in scope was open.','shadow-log':'The shadow log could not be written.'};
const MIN=60000,DAY=86400000;
const kstDay=t=>sessionOf('KR',t);
class AlertTrial {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;this.obligations=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS alert_trials(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL)');}
  save(t){this.db.prepare('UPDATE alert_trials SET payload=? WHERE id=?').run(JSON.stringify(t),t.id);return t;}
  all(){return this.db.prepare('SELECT id,payload FROM alert_trials ORDER BY id').all().map(r=>({...JSON.parse(r.payload),id:r.id}));}
  current(){return this.all().find(t=>t.status==='running')??null;}
  // scope: the account scope; markets: the markets in the review scope.
  start({scope,markets}){if(this.current())return this.current();const now=this.clock();const id=Number(this.db.prepare('INSERT INTO alert_trials(payload) VALUES(?)').run('{}').lastInsertRowid);
    this.obligations.clear();return this.save({id,status:'running',scope,markets,startedAt:now,limits:LIMITS,days:{KR:[],US:[]},lastCheckAt:now,attempts:[],events:[]});}
  end(reason,detail=null){const t=this.current();if(!t)return null;this.obligations.clear();return this.save({...t,status:reason==='completed'?'completed':reason==='turned off'?'stopped':'rolled back',endedAt:this.clock(),endReason:reason,...(detail?{endDetail:detail}:{})});}
  // Each price check while the trial runs. shadow: the current rule's trigger; proposed: the selective rules' trigger;
  // held: held symbols; watches: the review levels as they were before the check. Opens an obligation for each alert that
  // must be answered by a review within respondMinutes: a holding's move or level under either rule, and a crossing of an
  // entry level on a stock not held. The current rule alerts whenever a price is beyond an unfired level, so its level
  // alert counts as a crossing only when the level was not already passed when it was set (the MAX level of Oct 30 was
  // set below the price and is no crossing). Returns nothing; monitor() decides.
  check({now=this.clock(),shadow,proposed,held,quotes=[],watches=[]}){const t=this.current();if(!t)return;
    for(const m of ['KR','US'])if(quotes.some(q=>(/:/.test(q.symbol)?'US':'KR')===m)){const d=sessionOf(m,now);if(!t.days[m].includes(d))t.days[m].push(d);}
    const items=x=>!x?[]:x.kind==='watchlist'?x.alerts:[x,...(x.alongside??[])];const open=(kind,symbol)=>{const k=`${kind}|${symbol}`;if(!this.obligations.has(k))this.obligations.set(k,{kind,symbol,since:now});};
    for(const a of items(proposed)){if(held.has(a.symbol)&&['percent','price'].includes(a.kind))open('held-no-review',a.symbol);else if(a.kind==='entry-level')open('entry-no-review',a.symbol);}
    const passedWhenSet=s=>{const w=watches.find(x=>x.symbol===s);return Boolean(w&&w.baseline>0&&(w.direction==='above'?w.baseline>=w.price:w.baseline<=w.price));};
    for(const a of items(shadow)){if(held.has(a.symbol))open('shadow-held-no-review',a.symbol);else if(a.kind==='price'&&!passedWhenSet(a.symbol))open('entry-no-review',a.symbol);}
    this.save({...t,lastCheckAt:now,checks:(t.checks??0)+1});}
  // A review started: it answers every open obligation. trigger, reviewId; shadowFired: whether the current rule also
  // alerted at the check that started a price review (when it did not, the review is one the current rule would not
  // have started: an added review).
  attempt({now=this.clock(),trigger,reviewId,shadowFired=null}){const t=this.current();if(!t)return;this.obligations.clear();
    const a={at:now,trigger,reviewId,...(trigger==='Price movement trigger'?{added:shadowFired===false}:{})};this.save({...t,attempts:[...t.attempts,a].slice(-500)});}
  // The price reviews of a trading day (Seoul's date) and their cost; the added reviews' cost over the whole trial.
  cost(reviewIds){if(!reviewIds.length)return 0;const set=new Set(reviewIds);let micro=0;
    for(const r of this.db.prepare('SELECT payload FROM ai_calls WHERE json_extract(payload,\'$.timestamp\')>=?').all(this.current()?.startedAt??0)){const c=JSON.parse(r.payload);if(set.has(c.reviewId))micro+=c.cost?.micro??0;}return micro/1e6;}
  // Rollback and completion, checked every few seconds while auto trading runs. busy: a review is running (its own
  // duration never counts against the 5 minutes); held: a failure hold (a size failure holding price triggers) or an
  // emergency, during which the trial cannot be the cause; marketsOpen: whether a market in scope is open; since: when
  // auto trading last started running (checks cannot run before it). Returns {end:reason, detail} or null.
  monitor({now=this.clock(),busy=false,held=false,marketsOpen=false,since=0}={}){const t=this.current();if(!t)return null;const L=t.limits;
    if(busy||held){for(const o of this.obligations.values())o.since=now;}else for(const o of this.obligations.values())if(now-o.since>L.respondMinutes*MIN)return {end:o.kind,detail:`${o.symbol}: ${ROLLBACK[o.kind]}`};
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
      days:{KR:t.days.KR.length,US:t.days.US.length},checks:t.checks??0,reviewsStarted:t.attempts.length,priceReviews:price.length,addedReviews:added.length,addedUSD:+this.cost(added.map(a=>a.reviewId)).toFixed(3),episodes};}
}
module.exports={AlertTrial,LIMITS,ROLLBACK};
