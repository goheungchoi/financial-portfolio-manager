const TOOL={type:'function',name:'set_review_interval',description:'In Auto interval mode, choose the normal review interval from 1 to 60 minutes based on volatility, market hours and evidence. Explain the reason. An interval shorter than the user\'s needs a holding in an open session that has moved at least the price-movement threshold today, is at least 5 minutes, and lasts an hour. Waiting for a filing, results or the next session is not a reason to shorten: those start their own reviews. Does not enable automation, alter budgets, or delay emergency reviews.',strict:true,parameters:{type:'object',properties:{minutes:{type:'integer'},reason:{type:'string'}},required:['minutes','reason'],additionalProperties:false}};
// A shorter interval than the user's lasts this long, and is never under SHORTEST minutes.
const SHORT_FOR_MS=60*60000,SHORTEST=5;
// 2026-10-29: reviews ran every 5 to 10 minutes all day, each waiting on the same results presentation and the next U.S.
// quote. Neither arrives sooner with more reviews; filings, news, price moves, triggers, orders and session changes
// already start reviews of their own. So the agent may shorten the user's interval only for a holding that is moving.
class ReviewInterval{
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS review_intervals(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  get(scope,config){const row=this.db.prepare('SELECT payload FROM review_intervals WHERE scope=?').get(scope);let selected=row?JSON.parse(row.payload):null;
    const base=Math.min(60,config.intervalMinutes);const ended=config.autoReviewInterval&&selected?.until&&this.clock()>=selected.until;
    if(ended)selected={minutes:base,reason:'The shorter interval ended after an hour; back to your interval until the agent sets another.',updatedAt:selected.until};
    // A shorter interval saved without an end (before the rule above, or before the user raised their interval) never
    // passed the moving-holding check: the user's interval applies until the agent sets one that does.
    else if(config.autoReviewInterval&&selected&&!selected.until&&selected.minutes<base)selected={minutes:base,reason:'An earlier shorter interval no longer applies; back to your interval until the agent sets another.',updatedAt:selected.updatedAt};
    return {auto:config.autoReviewInterval===true,minutes:config.autoReviewInterval?selected?.minutes??base:config.intervalMinutes,reason:config.autoReviewInterval?selected?.reason??'Using your interval until the agent selects one.':'Fixed interval',updatedAt:selected?.updatedAt??null,...(config.autoReviewInterval&&selected?.until&&!ended?{until:new Date(selected.until).toISOString()}:{})};}
  // heldMoves: today's change of each holding whose market has a session open, [{symbol, changePct}].
  set(scope,value,config,{heldMoves=[]}={}){if(!config.autoReviewInterval)return {status:'rejected',reason:'AUTO_INTERVAL_DISABLED'};if(!value||Object.keys(value).sort().join()!=='minutes,reason'||!Number.isInteger(value.minutes)||value.minutes<1||value.minutes>60||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>500)return {status:'rejected',reason:'INVALID_INTERVAL'};
    const now=this.clock();let extra={};
    if(value.minutes<config.intervalMinutes){const tolerance=config.eventTolerancePct??3;const moving=heldMoves.filter(m=>Math.abs(m.changePct)>=tolerance);
      if(!moving.length)return {status:'rejected',reason:'SHORTER_NEEDS_A_MOVING_HOLDING',note:`An interval under the user's ${config.intervalMinutes} minutes needs a holding in an open session that has moved ${tolerance}% or more today; none has. More reviews do not bring a filing, results or the next session sooner: important filings and news, price moves of ${tolerance}% since the last review, your review triggers, order changes and market opens and closes each start a review. Set a review trigger for a price level, and give an awaited event's date as the verdict's recheck.`};
      if(value.minutes<SHORTEST)return {status:'rejected',reason:'INVALID_INTERVAL',note:`A shorter interval is at least ${SHORTEST} minutes.`};
      extra={until:now+SHORT_FOR_MS,moving:moving.slice(0,5)};}
    this.db.prepare('INSERT OR REPLACE INTO review_intervals VALUES(?,?)').run(scope,JSON.stringify({...value,...extra,updatedAt:now}));return {status:'saved',...this.get(scope,config)};}
}
module.exports={ReviewInterval,TOOL,SHORT_FOR_MS,SHORTEST};
