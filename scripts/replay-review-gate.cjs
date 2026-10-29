// Replays one day's saved review contexts through the review gate, read-only, and reports what it would have done:
//   node scripts/replay-review-gate.cjs [YYYY-MM-DD] [path to portfolio.sqlite]
// Reviews the gate would skip (with the AI cost they recorded and the decision each made), the reasons the rest ran,
// backstops, and closed-market Buy/Sell decisions the pending-decision store would have kept as one. A replay shows
// which recorded reviews would be skipped; it cannot show that skipping them was right, nor what later reviews would
// have decided, so treat its savings as estimates until observation in the app confirms them.
const {DatabaseSync}=require('node:sqlite');const path=require('node:path');
const RG=require('../electron/review-gate.cjs');
const day=process.argv[2]??new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const file=process.argv[3]??path.join(process.env.APPDATA??'','Financial Portfolio Manager','portfolio.sqlite');
const db=new DatabaseSync(file,{readOnly:true});const from=Date.parse(day+'T00:00:00+09:00'),to=from+86400000;
const config=JSON.parse(db.prepare('SELECT payload FROM automation_settings').get().payload);
const reviews=new Map(db.prepare('SELECT id,payload FROM reviews').all().map(r=>[r.id,JSON.parse(r.payload)]));
const cost=new Map();for(const r of db.prepare('SELECT payload FROM ai_calls').all()){const c=JSON.parse(r.payload);if(c.reviewId)cost.set(c.reviewId,(cost.get(c.reviewId)??0)+(c.cost?.micro??0));}
const events=db.prepare("SELECT name FROM sqlite_master WHERE name='news_events'").get()?db.prepare('SELECT payload FROM news_events').all().map(r=>JSON.parse(r.payload)):[];
const rows=db.prepare('SELECT id,payload FROM review_contexts').all().map(r=>{const p=JSON.parse(r.payload);const id=p.reviewId??r.id;return {id,context:p.context??p,review:reviews.get(id)};})
  .filter(r=>r.review&&r.review.timestamp>=from&&r.review.timestamp<to).sort((a,b)=>a.review.timestamp-b.review.timestamp);
const kst=t=>new Date(t+9*3600000).toISOString().slice(11,16),usd=m=>Math.round(m/1e4)/100;
let base=null;const out={day,reviews:rows.length,scheduled:0,wouldSkip:0,skippedUSD:0,totalUSD:0,skippedDecisions:{},skippedWithOrders:0,backstops:0,reasons:{},closedMarketRepeats:0};const lines=[];const pending=new Map();
for(const r of rows){const at=r.review.timestamp,trigger=r.review.trigger,state=RG.decisionState(r.context),micro=cost.get(r.id)??0;out.totalUSD+=micro;if(trigger==='Scheduled review')out.scheduled++;
  const known=events.filter(e=>e.firstSeenAt<=at);const g=RG.compare(base,state,{trigger,now:at,config,events:known});
  const d=r.review.decision??{},label=`${d.action??'?'}${d.symbol?' '+d.symbol:''}`;
  // Closed-market Buy/Sell repeats: the same trade while its market stays closed.
  if((d.action==='Buy'||d.action==='Sell')&&d.symbol){const m=/:/.test(d.symbol)?'US':'KR';const open=state.markets[m]?.open;const k=`${d.action}|${d.symbol}`;if(!open){if(pending.has(k))out.closedMarketRepeats++;else pending.set(k,at);}else pending.delete(k);}
  for(const [k] of pending){const m=/:/.test(k.split('|')[1])?'US':'KR';if(state.markets[m]?.open)pending.delete(k);}
  if(!g.needsReview){out.wouldSkip++;out.skippedUSD+=micro;out.skippedDecisions[label]=(out.skippedDecisions[label]??0)+1;if(r.review.orderId||r.review.proposalId)out.skippedWithOrders++;lines.push(`${kst(at)} skip  $${usd(micro).toFixed(2)} ${trigger} → ${label}`);continue;}
  for(const x of g.reasons)out.reasons[x.kind]=(out.reasons[x.kind]??0)+1;if(g.reasons.some(x=>x.kind==='backstop'))out.backstops++;
  lines.push(`${kst(at)} run   $${usd(micro).toFixed(2)} ${trigger} → ${label} · ${g.reasons.map(x=>x.kind+(x.symbols.length?':'+x.symbols.join('/'):'')).join(', ')}`);
  if(r.review.decision)base={...state,at,contextAt:at,decision:{action:d.action,symbol:d.symbol,orderId:r.review.orderId??r.review.proposalId??null},seen:known.map(RG.newsKey)};}
console.log(lines.join('\n'));console.log(JSON.stringify({...out,skippedUSD:usd(out.skippedUSD),totalUSD:usd(out.totalUSD)},null,2));
