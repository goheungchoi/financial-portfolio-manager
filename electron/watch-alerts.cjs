// Selective price alerts: what starts a price review for each kind of symbol (setting watchlistAlerts: 'off' keeps the
// one rule for every quoted symbol, 'observe' logs what these rules would do beside it, 'on' uses them).
// - Holdings: as before, a move of the review watch's percent (default the price-move trigger) from the price at the
//   last review, or a review-watch price level reached.
// - Candidates with an entry level (a review-watch price on a symbol not held): only when the price crosses the level
//   from the other side. A level set while the price is already beyond it waits until the price comes back first.
// - Other quoted symbols: a wider move (watchlistMovePct, default twice the price-move trigger) from an anchor, the
//   price at the symbol's last alert (first: the price at the last review, else the first fresh quote). An alert moves
//   the anchor to its price, so a price staying beyond the threshold never alerts again; each symbol alerts at most
//   once per COOLDOWN_MS. Alerts in the same check go into one review.
// 2026-10-29: of 16 price reviews since 2026-10-20, eight were 3-5% moves in symbols not held, five of them in two
// leveraged ETFs on the watchlist.
const COOLDOWN_MS=60*60000;const {levelEvent}=require('./review-watches.cjs');
const met=(watch,price)=>watch.direction==='above'?price>=watch.price:price<=watch.price;
// A price level as the AI set it: setting it again (even at the same price) makes a new one, and a review moving its
// baseline does not. Watches saved before revisions existed are named by when they were set.
const levelKey=w=>w.revision??`${w.symbol}|${w.direction}|${w.price}|${w.updatedAt??''}`;
class WatchAlerts {
  constructor(){this.anchors=new Map();this.alertedAt=new Map();this.sides=new Map();this.fired=new Set();}
  // quotes: fresh quotes in sessions that are open. held: Set of held symbols. baselines: Map of prices at the last review.
  // watches: review watches as they were before this check. ownFired: judge whether an entry level already fired by
  // this object's own record instead of the watch's priceFired flag, so observation is not changed by what the rule in
  // force did (a holding's level fires the same way under both rules, so an earlier firing by either counts).
  // What each check sees is saved at once, alert or not: the side of each level (a crossing needs the earlier side) and a
  // symbol's first anchor. Returns {trigger, deliver}: trigger is null or the review to start; deliver() records it as
  // sent (anchors move to the alert prices, cooldowns start, levels are fired) and returns the symbols whose level fired.
  // skipLevels: level events held while a size failure stands (electron/size-retry.cjs); their symbols are checked as if
  // they had no level.
  check({quotes,held,baselines,watches,tolerance,wide,now=Date.now(),ownFired=false,skipLevels=new Set()}){
    const holding=[],alerts=[],levels=new Map(),open=(w,isHeld)=>w?.price!=null&&!skipLevels.has(levelEvent(w))&&!(ownFired?this.fired.has(levelKey(w))||isHeld&&w.priceFired:w.priceFired);
    for(const q of quotes){const watch=watches.find(w=>w.symbol===q.symbol);
      if(held.has(q.symbol)){
        if(open(watch,true)&&met(watch,q.price)){levels.set(q.symbol,levelKey(watch));holding.push({kind:'price',symbol:q.symbol,price:q.price,threshold:watch.price,direction:watch.direction,timestamp:q.timestamp,...(watch.revision?{watchRevision:watch.revision}:{})});}
        else{const base=watch?.baseline??baselines.get(q.symbol),limit=watch?.percent??tolerance;if(base>0&&Math.abs(q.price/base-1)*100>=limit)holding.push({kind:'percent',symbol:q.symbol,price:q.price,baseline:base,changePct:(q.price/base-1)*100,threshold:limit,timestamp:q.timestamp});}
        continue;}
      if(open(watch)){const key=levelKey(watch);
        const before=this.sides.get(key)??(watch.baseline>0?met(watch,watch.baseline):null),isMet=met(watch,q.price);this.sides.set(key,isMet);
        if(before===false&&isMet){levels.set(q.symbol,key);alerts.push({kind:'entry-level',symbol:q.symbol,price:q.price,threshold:watch.price,direction:watch.direction,timestamp:q.timestamp,...(watch.revision?{watchRevision:watch.revision}:{})});}
        continue;}
      if(!this.anchors.has(q.symbol))this.anchors.set(q.symbol,baselines.get(q.symbol)??q.price);
      const anchor=this.anchors.get(q.symbol),limit=watch?.percent??wide,change=(q.price/anchor-1)*100;
      if(Math.abs(change)>=limit&&now-(this.alertedAt.get(q.symbol)??-Infinity)>=COOLDOWN_MS)alerts.push({kind:'watchlist-move',symbol:q.symbol,price:q.price,baseline:anchor,changePct:change,threshold:limit,timestamp:q.timestamp});}
    const trigger=holding.length?{...holding[0],...(holding.length>1||alerts.length?{alongside:[...holding.slice(1),...alerts]}:{})}:alerts.length?{kind:'watchlist',alerts}:null;
    const deliver=()=>{if(!trigger)return [];const sent=trigger.kind==='watchlist'?trigger.alerts:[trigger,...trigger.alongside??[]];
      for(const a of sent)if(a.kind==='watchlist-move'){this.anchors.set(a.symbol,a.price);this.alertedAt.set(a.symbol,now);}
      const fired=sent.filter(a=>a.kind==='entry-level'||a.kind==='price').map(a=>a.symbol);for(const s of fired)this.fired.add(levels.get(s));return fired;};
    return {trigger,deliver};
  }
  // A level fired for a review that made no decision (a size failure) is put back: not fired, and on its earlier side,
  // so the price still beyond it is a crossing again once the level is no longer held.
  restore(key){this.fired.delete(key);this.sides.set(key,false);}
  // Anchors of symbols not held do not move with reviews, only with their own alerts; clear() is for an account change.
  clear(){this.anchors.clear();this.alertedAt.clear();this.sides.clear();this.fired.clear();}
}
// Observation log: each check where the current rule or these rules would start a price review.
class AlertObservations {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS alert_observations(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,payload TEXT NOT NULL)');}
  record(at,{current,proposed,held}){if(!current&&!proposed)return;const brief=t=>t?{kind:t.kind,symbols:t.kind==='watchlist'?t.alerts.map(a=>a.symbol):[t.symbol,...(t.alongside??[]).map(a=>a.symbol)],...(t.changePct!=null?{changePct:Math.round(t.changePct*100)/100}:{})}:null;
    this.db.prepare('INSERT INTO alert_observations(at,payload) VALUES(?,?)').run(at,JSON.stringify({current:brief(current),proposed:brief(proposed),currentHeld:current?held.has(current.symbol):null}));}
  // Since a time: price reviews under the current rule and under these rules, the reviews avoided, and for each symbol
  // not held that the current rule alerted on, when these rules first alerted on it the same day (delayed, earlier, or
  // not at all).
  summary(since){const rows=this.db.prepare('SELECT at,payload FROM alert_observations WHERE at>=? ORDER BY at').all(since).map(r=>({at:r.at,...JSON.parse(r.payload)}));
    const day=t=>new Date(t+9*3600000).toISOString().slice(0,10),first=new Map(),key=(s,t)=>`${s}|${day(t)}`;
    for(const r of rows){if(r.current&&!r.currentHeld){const k=key(r.current.symbols[0],r.at);if(!first.has(k))first.set(k,{symbol:r.current.symbols[0],day:day(r.at),currentAt:r.at,proposedAt:null});}}
    for(const r of rows)for(const s of r.proposed?.symbols??[]){const f=first.get(key(s,r.at));if(f&&f.proposedAt==null)f.proposedAt=r.at;}
    const current=rows.filter(r=>r.current).length,proposed=rows.filter(r=>r.proposed).length;
    const candidates=[...first.values()].map(f=>({...f,currentAt:new Date(f.currentAt).toISOString(),proposedAt:f.proposedAt==null?null:new Date(f.proposedAt).toISOString(),delayMinutes:f.proposedAt==null?null:Math.round((f.proposedAt-f.currentAt)/60000)}));
    return {since:new Date(since).toISOString(),currentReviews:current,proposedReviews:proposed,avoided:current-proposed,notHeldAlerts:candidates,
      delayed:candidates.filter(c=>c.delayMinutes>0).length,notAlerted:candidates.filter(c=>c.proposedAt==null).length};}
}
module.exports={WatchAlerts,AlertObservations,COOLDOWN_MS};
