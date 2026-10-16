const TOOL={type:'function',name:'set_review_watch',description:'Adjust when to request another AI portfolio review for a review-universe symbol. This does not place trades or change loss limits, approvals, scheduler enablement or API budgets. percent overrides the default movement threshold (0.1–50%); null uses default. price is a one-shot native-currency level; null removes it. A reached level triggers after cooldown. Explain why.',strict:true,parameters:{type:'object',properties:{symbol:{type:'string'},percent:{type:['number','null']},price:{type:['number','null']},direction:{type:'string',enum:['above','below']},reason:{type:'string'}},required:['symbol','percent','price','direction','reason'],additionalProperties:false}};
class ReviewWatches {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS review_watches(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol))');}
  list(scope){return this.db.prepare('SELECT payload FROM review_watches WHERE scope=?').all(scope).map(row=>JSON.parse(row.payload));}
  set(scope,value,context){
    if(!value||Object.keys(value).sort().join(',')!=='direction,percent,price,reason,symbol'||!context.universe.some(row=>row.symbol===value.symbol)||!['above','below'].includes(value.direction)||typeof value.reason!=='string'||value.reason.length>500||value.percent!==null&&(!Number.isFinite(value.percent)||value.percent<.1||value.percent>50)||value.price!==null&&(!Number.isFinite(value.price)||value.price<=0||value.price>1e9))return {status:'rejected',reason:'INVALID_WATCH'};
    const quote=context.quotes.find(row=>row.symbol===value.symbol);
    const watch={...value,baseline:Number.isFinite(quote?.price)&&quote.price>0?quote.price:null,updatedAt:Date.now(),priceFired:false};
    this.db.prepare('INSERT INTO review_watches VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,value.symbol,JSON.stringify(watch));return {status:'saved',watch};
  }
  reset(scope){this.db.prepare('DELETE FROM review_watches WHERE scope=?').run(scope);}
  fired(scope,symbol){const watch=this.list(scope).find(row=>row.symbol===symbol);if(watch)this.db.prepare('UPDATE review_watches SET payload=? WHERE scope=? AND symbol=?').run(JSON.stringify({...watch,priceFired:true}),scope,symbol);}
  rebase(scope,quotes){for(const watch of this.list(scope)){const quote=quotes.find(row=>row.symbol===watch.symbol);if(quote?.price>0)this.db.prepare('UPDATE review_watches SET payload=? WHERE scope=? AND symbol=?').run(JSON.stringify({...watch,baseline:quote.price}),scope,watch.symbol);}}
  detect(scope,quotes,baselines,defaultPercent,now=Date.now()){
    const watches=this.list(scope);
    for(const quote of quotes){
      const timestamp=quote.timestamp??quote.retrievedAt;
      if(quote.stale||!Number.isFinite(timestamp)||timestamp>now+1000||now-timestamp>90000||!Number.isFinite(quote.price)||quote.price<=0)continue;
      const watch=watches.find(row=>row.symbol===quote.symbol);
      if(watch?.price!=null&&!watch.priceFired&&(watch.direction==='above'?quote.price>=watch.price:quote.price<=watch.price))return {kind:'price',symbol:quote.symbol,price:quote.price,threshold:watch.price,direction:watch.direction,timestamp};
      const baseline=watch?.baseline??baselines.get(quote.symbol),threshold=watch?.percent??defaultPercent;
      if(baseline>0&&Math.abs(quote.price/baseline-1)*100>=threshold)return {kind:'percent',symbol:quote.symbol,price:quote.price,baseline,changePct:(quote.price/baseline-1)*100,threshold,timestamp};
    }
    return null;
  }
}
module.exports={ReviewWatches,TOOL};
