// Episode library: large market moves saved with the narrative and signals of the day and what prices did afterwards,
// so reviews can read how similar past situations played out. Episodes are retrieved by shared drivers, not by wording.
const {randomUUID}=require('node:crypto');
// An index day counts as an episode when it moves this much in a day, or the five days to it move this much.
const TRIGGERS={KOSPI:{d1:3,d5:6},KOSPI200:{d1:3,d5:6},SPX:{d1:2.5,d5:5},COMP:{d1:3,d5:6},SOX:{d1:4.5,d5:9}};
const OUTCOME_INDEXES=['KOSPI','SPX','SOX'];const HORIZONS=[1,5,20];
const pct=(a,b)=>a>0&&b>0?Math.round((a/b-1)*10000)/100:null;
// Episodes the user described before the app tracked them; merged into the detected episode in the date window.
const SEEDS=[{from:'2026-10-12',to:'2026-10-16',title:'Semiconductor and AI selloff',kind:'selloff',drivers:[
  {kind:'background',title:'High interest rates',themes:['rates','inflation'],direction:'negative'},
  {kind:'background',title:'Geopolitical risk',themes:['geopolitics'],direction:'negative'},
  {kind:'background',title:'High oil prices',themes:['oil_energy','inflation'],direction:'negative'},
  {kind:'trigger',title:'Doubts about AI profitability after unofficial OpenAI financials',themes:['ai_profitability','ai_demand'],direction:'negative'},
  {kind:'trigger',title:'Worries about Chinese semiconductor companies\' growth',themes:['china_competition','semiconductor_cycle'],direction:'negative'}],
  note:'Described by the user: fragile conditions (rates, geopolitics, oil) plus triggers (AI profitability doubts, Chinese chip competition) set off a sharp selloff in AI and semiconductor stocks, hitting Korean chipmakers hard.'}];
function moves(closes,day){
  const out={};for(const [index,series] of Object.entries(closes)){const c=(series??[]).filter(r=>r.close>0);const i=c.findIndex(r=>r.day===day);if(i<1)continue;out[index]={d1:pct(c[i].close,c[i-1].close),d5:i>=5?pct(c[i].close,c[i-5].close):null};}
  return out;
}
// Index returns from the episode day's close over the next 1, 5 and 20 trading days, filled in as days pass.
function outcomes(closes,day){
  const out={};for(const index of OUTCOME_INDEXES){const c=(closes[index]??[]).filter(r=>r.close>0);const i=c.findIndex(r=>r.day===day);if(i<0)continue;out[index]=Object.fromEntries(HORIZONS.map(h=>[`d${h}`,c[i+h]?pct(c[i+h].close,c[i].close):null]));}
  return out;
}
function triggered(m){return Object.entries(TRIGGERS).filter(([index,t])=>m[index]&&(Math.abs(m[index].d1??0)>=t.d1||Math.abs(m[index].d5??0)>=t.d5)).map(([index])=>index);}
class EpisodeLibrary {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS market_episodes(id TEXT PRIMARY KEY,day TEXT NOT NULL UNIQUE,payload TEXT NOT NULL)');}
  list(){return this.db.prepare('SELECT payload FROM market_episodes ORDER BY day DESC').all().map(r=>JSON.parse(r.payload));}
  write(e){this.db.prepare('INSERT INTO market_episodes VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(e.id,e.day,JSON.stringify(e));return e;}
  // Scans recent index days for large moves. A run of qualifying days within a week becomes one episode at its largest move.
  detect(closes,{narrativeAt,signalsAt,since}={}){
    const days=[...new Set(Object.values(closes).flatMap(c=>(c??[]).map(r=>r.day)))].sort().filter(d=>!since||d>=since);
    const hits=days.map(day=>({day,m:moves(closes,day)})).map(x=>({...x,by:triggered(x.m)})).filter(x=>x.by.length);
    const existing=this.list();const created=[];
    for(const hit of hits){
      const near=existing.concat(created).find(e=>Math.abs(Date.parse(e.day)-Date.parse(hit.day))<=6*86400000);
      const size=x=>Math.max(...x.by.map(i=>Math.abs(x.m[i].d1??0)));
      if(near){if(near.auto&&size(hit)>Math.max(...(near.triggeredBy??[]).map(i=>Math.abs(near.moves[i]?.d1??0)),0)){near.day=hit.day;near.moves=hit.m;near.triggeredBy=hit.by;this.db.prepare('DELETE FROM market_episodes WHERE id=?').run(near.id);this.write(near);}continue;}
      const drop=hit.by.some(i=>(hit.m[i].d1??0)<0||(hit.m[i].d5??0)<0);const n=narrativeAt?.(hit.day);
      const e={id:'E-'+randomUUID().slice(0,6),day:hit.day,auto:true,kind:drop?'selloff':'rally',title:`${drop?'Selloff':'Rally'}: ${hit.by.map(i=>`${i} ${hit.m[i].d1>0?'+':''}${hit.m[i].d1}%`).join(', ')}`,triggeredBy:hit.by,moves:hit.m,
        drivers:n?n.drivers.filter(d=>d.confirmed).map(({kind,title,themes,direction})=>({kind,title,themes,direction})):[],regime:n?.regime??null,signals:signalsAt?.(hit.day)??null,createdAt:this.clock()};
      created.push(e);
    }
    for(const e of created){const seed=SEEDS.find(s=>e.day>=s.from&&e.day<=s.to);if(seed){e.title=seed.title;e.kind=seed.kind;e.drivers=seed.drivers;e.note=seed.note;e.seeded=true;}this.write(e);}
    // Refresh outcomes of every episode as later closes arrive.
    for(const e of this.list()){const o=outcomes(closes,e.day);if(Object.keys(o).length){e.outcomes=o;this.write(e);}}
    return created;
  }
  // Similar past episodes for the current narrative: shared themes (triggers count double), same direction, similar stress level.
  similar(narrative,{vix=null,limit=2,minScore=0.3}={}){
    if(!narrative?.drivers?.length)return [];const now=new Map();for(const d of narrative.drivers.filter(d=>d.confirmed!==false&&!d.hidden))for(const t of d.themes??[])now.set(t,Math.max(now.get(t)??0,d.kind==='trigger'?2:1));
    const negative=narrative.drivers.filter(d=>d.direction==='negative').length>=narrative.drivers.filter(d=>d.direction==='positive').length;
    return this.list().map(e=>{
      const then=new Map();for(const d of e.drivers??[])for(const t of d.themes??[])then.set(t,Math.max(then.get(t)??0,d.kind==='trigger'?2:1));
      const keys=new Set([...now.keys(),...then.keys()]);let shared=0,total=0;for(const k of keys){const a=now.get(k)??0,b=then.get(k)??0;shared+=Math.min(a,b);total+=Math.max(a,b);}
      let score=total?shared/total:0;if((e.kind==='selloff')!==negative)score*=0.6;const thenVix=e.signals?.VIX;if(vix!=null&&thenVix!=null)score*=1-Math.min(0.3,Math.abs(vix-thenVix)/100);
      return {e,score:Math.round(score*100)/100,shared:[...keys].filter(k=>now.has(k)&&then.has(k))};
    }).filter(x=>x.score>=minScore).sort((a,b)=>b.score-a.score).slice(0,limit).map(({e,score,shared})=>({day:e.day,title:e.title,kind:e.kind,similarity:score,sharedThemes:shared,drivers:(e.drivers??[]).map(d=>d.title),moves:e.moves,outcomes:e.outcomes??null,...(e.note?{note:e.note}:{})}));
  }
}
module.exports={EpisodeLibrary,TRIGGERS,SEEDS,moves,outcomes,triggered};
