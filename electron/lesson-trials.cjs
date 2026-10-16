const {randomUUID}=require('node:crypto');
// Forward-only shadow experiments. No broker, provider or execution capability.
class LessonTrials {
  constructor(db,memory){this.db=db;this.memory=memory;db.exec('CREATE TABLE IF NOT EXISTS lesson_trials(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  list(){return this.db.prepare('SELECT payload FROM lesson_trials ORDER BY rowid DESC LIMIT 200').all().map(r=>JSON.parse(r.payload));}
  save(t){this.db.prepare('INSERT INTO lesson_trials VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(t.id,JSON.stringify(t));}
  start(id,v,now=Date.now()){
    const state=this.memory.lifecycle(id),e=this.memory.describe(id);
    if(!state||!e?.assessment?.eligible||state.status==='retired'||state.signature!==v?.signature)throw Error('LESSON_CHANGED');
    if(!v||Object.keys(v).some(k=>!['signature','rule','threshold','activation','feePct','sellTaxPct','slippagePct','days','hypothesis'].includes(k))||!['loss-exit','trailing-profit'].includes(v.rule)||typeof v.hypothesis!=='string'||!v.hypothesis.trim()||v.hypothesis.length>2000||!Number.isFinite(v.threshold)||v.threshold<=0||v.threshold>100||!Number.isFinite(v.activation)||v.activation<0||v.activation>100||![v.feePct,v.sellTaxPct,v.slippagePct].every(n=>Number.isFinite(n)&&n>=0&&n<=10)||!Number.isInteger(v.days)||v.days<1||v.days>365)throw Error('INVALID_TRIAL');
    if(this.list().some(t=>t.lessonId===id&&t.status==='collecting'))throw Error('TRIAL_ACTIVE');
    const t={id:randomUUID(),lessonId:id,signature:state.signature,symbol:e.symbol,source:e.source,market:e.market,environment:e.environment,createdAt:now,endAt:now+v.days*86400000,status:'collecting',parameters:{...v},samples:0,lastTimestamp:now,baseline:null,candidate:null,signalAt:null,exitAt:null,gaps:0,maxGapMs:0};this.save(t);return t;
  }
  stop(id){const t=this.list().find(t=>t.id===id);if(!t)throw Error('TRIAL_NOT_FOUND');if(t.status==='collecting'){t.status='stopped';this.save(t);}return t;}
  observe(quotes,source,accountKey=null,now=Date.now()){
    for(const t of this.list().filter(t=>t.status==='collecting')){
      const life=this.memory.lifecycle(t.lessonId);
      if(life?.signature!==t.signature||life.status==='retired'){t.status='superseded';this.save(t);continue;}
      // Deadline is fixed at proposal time; never backfill old or post-deadline prices.
      if(now>=t.endAt){t.status=t.samples>=2?'completed':'insufficient-data';this.save(t);continue;}
      if(t.source!==source)continue;
      if(source==='broker'){
        const row=this.db.prepare('SELECT payload FROM lesson_evidence WHERE id=?').get(t.lessonId);
        if(!row||JSON.parse(row.payload).accountKey!==accountKey)continue;
      }
      const q=quotes.find(q=>q.symbol===t.symbol),stamp=q?.timestamp??q?.retrievedAt;
      if(!q||q.stale||!Number.isFinite(q.price)||q.price<=0||!Number.isFinite(stamp)||stamp<=t.lastTimestamp||stamp>now||now-stamp>120000)continue;
      const p=t.parameters,fee=p.feePct/100,slip=p.slippagePct/100,sale=(p.feePct+p.sellTaxPct)/100;
      if(!t.baseline){
        const quantity=100/(q.price*(1+slip)*(1+fee));
        const entryCost=quantity*q.price*((1+slip)*(1+fee)-1);
        const arm={quantity,cash:0,peak:100,maxDrawdownPct:0,returnPct:0,costs:entryCost,held:true};
        t.baseline={...arm};t.candidate={...arm};t.entry=q.price;t.pricePeak=q.price;t.startedAt=stamp;
      }else{const gap=stamp-t.lastTimestamp;t.maxGapMs=Math.max(t.maxGapMs,gap);if(gap>120000)t.gaps++;}
      // A signal can execute only on a later observed quote, never on its own price.
      if(t.signalAt&&t.candidate.held){const a=t.candidate;a.cash=a.quantity*q.price*(1-slip)*(1-sale);a.costs+=a.quantity*q.price-a.cash;a.held=false;t.exitAt=stamp;}
      for(const a of [t.baseline,t.candidate]){
        const exitCost=a.held?a.quantity*q.price*(1-(1-slip)*(1-sale)):0;
        const equity=a.held?a.quantity*q.price-exitCost:a.cash;
        a.peak=Math.max(a.peak,equity);a.maxDrawdownPct=Math.max(a.maxDrawdownPct,(a.peak-equity)/a.peak*100);a.returnPct=equity-100;a.totalCosts=a.costs+exitCost;
      }
      t.pricePeak=Math.max(t.pricePeak,q.price);
      if(t.candidate.held&&!t.signalAt&&(p.rule==='loss-exit'?q.price<=t.entry*(1-p.threshold/100):t.pricePeak>=t.entry*(1+p.activation/100)&&q.price<=t.pricePeak*(1-p.threshold/100)))t.signalAt=stamp;
      t.lastTimestamp=stamp;t.lastPrice=q.price;t.samples++;this.save(t);
    }
  }
}
module.exports={LessonTrials};
