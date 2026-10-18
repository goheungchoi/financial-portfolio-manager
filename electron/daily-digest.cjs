const {seoulDate}=require('./kis-activity.cjs');
// Local end-of-day summary of what the engine did. No AI or broker calls.
const seoulHour=now=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',hourCycle:'h23'}).format(now));
const money=(value,currency)=>currency==='USD'?(value<0?'-':'')+'$'+Math.abs(value).toFixed(2):(value<0?'-':'')+'₩'+Math.round(Math.abs(value)).toLocaleString('en-US');
const signed=(value,currency)=>(value>0?'+':'')+money(value,currency);
function buildDigest(a,now=Date.now()){
  const day=seoulDate(now),onDay=timestamp=>Number.isFinite(timestamp)&&seoulDate(timestamp)===day;
  const reviews=a.db.prepare('SELECT payload FROM reviews ORDER BY rowid').all().map(row=>JSON.parse(row.payload)).filter(row=>onDay(row.timestamp));
  const decisions={Buy:0,Sell:0,Hold:0};for(const row of reviews){const action=row.decision?.action;if(Object.hasOwn(decisions,action))decisions[action]++;}
  const markets=[];const add=(label,currency,loss)=>{if(loss&&Number.isFinite(loss.baseline)&&Number.isFinite(loss.equity)&&loss.baseline>0)markets.push({label,currency,baseline:loss.baseline,equity:loss.equity,change:loss.equity-loss.baseline,changePct:(loss.equity-loss.baseline)/loss.baseline*100});};
  if(a.config.scope==='paper')add('Paper','KRW',a.paper.getState().loss);
  if(['kis','both'].includes(a.config.scope))add('Korea','KRW',a.live?.getState().loss);
  if(['us','both'].includes(a.config.scope))add('U.S.','USD',a.usLive?.getState().loss);
  // Without an active trading session there is no loss baseline; fall back to recorded daily account values.
  if(!markets.length&&a.config.scope!=='paper')for(const row of a.accountValues?.(day)??[])if((row.market==='KR'&&a.config.scope!=='us')||(row.market==='US'&&a.config.scope!=='kis'))add(row.label,row.currency,{baseline:row.baseline,equity:row.equity});
  const orders=[...a.paper.orders(),...(a.live?.orders()??[]),...(a.usLive?.orders()??[])].filter(row=>row.status!=='Ready'&&onDay(row.createdAt));
  const count=statuses=>orders.filter(row=>statuses.includes(row.status)).length;
  const summary={total:orders.length,filled:count(['Filled']),partial:count(['Partially filled']),rejected:count(['Rejected','Risk stopped']),uncertain:count(['Uncertain','Cancellation uncertain']),open:count(['Pending','Accepted','Submitting'])};
  const usage=a.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
  const guardrails=a.guardrails.eventsOn(day).map(event=>event.kind),failedReviews=a.guardrails.failuresOn(day);
  const lines=[`Daily digest ${day}`,
    markets.length?markets.map(m=>`${m.label} ${money(m.equity,m.currency)} (${signed(m.change,m.currency)}, ${m.changePct>=0?'+':''}${m.changePct.toFixed(2)}% today)`).join(' · '):'No account valuation for the selected scope today.',
    `${reviews.length} reviews (${decisions.Buy} Buy, ${decisions.Sell} Sell, ${decisions.Hold} Hold)${failedReviews?`, ${failedReviews} failed`:''}`,
    `Orders: ${summary.total} submitted, ${summary.filled} filled${summary.partial?`, ${summary.partial} partly filled`:''}${summary.open?`, ${summary.open} open`:''}${summary.rejected?`, ${summary.rejected} rejected`:''}${summary.uncertain?`, ${summary.uncertain} need reconciliation`:''}`,
    `AI: ${usage.calls} calls, $${(usage.reservedMicro/1e6).toFixed(2)} accounted`,
    `Guardrails: ${guardrails.length?[...new Set(guardrails)].join(', '):'none triggered'}`];
  return {day,generatedAt:now,markets,reviews:reviews.length,decisions,failedReviews,orders:summary,ai:{calls:usage.calls,usd:usage.reservedMicro/1e6},guardrails,text:lines.join('\n')};
}
class DailyDigest {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS daily_digests(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  list(limit=7){return this.db.prepare('SELECT payload FROM daily_digests ORDER BY day DESC LIMIT ?').all(limit).map(row=>JSON.parse(row.payload));}
  // Sends once per Seoul day, at or after the chosen hour, while the app is open. Missed days are not backfilled.
  tick(a,now=Date.now()){
    if(!a.config.digestEnabled||seoulHour(now)<a.config.digestHour)return null;const day=seoulDate(now);
    if(this.db.prepare('SELECT day FROM daily_digests WHERE day=?').get(day))return null;
    const digest=buildDigest(a,now);this.db.prepare('INSERT INTO daily_digests VALUES(?,?)').run(day,JSON.stringify(digest));a.notify?.('digest:'+day,digest.text);return digest;
  }
}
module.exports={DailyDigest,buildDigest,seoulHour};
