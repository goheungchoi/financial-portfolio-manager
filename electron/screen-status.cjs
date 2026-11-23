'use strict';
// What the Scout panel says about the screening history (S3 review, items 6 and 7): per market, the day screens are as
// of and how many stocks of the nightly set have that day (the rest older, or none yet), full depth, the stocks that
// stopped deepening and why, and why the refresh is not running when it waits. One query over the progress table, one
// population (the nightly set) for every figure. main.cjs caches the answer for a minute, also when it fails.
const {asOfDay,marketOf,KEEP}=require('./history-store.cjs');
function screenStatus({deps,refresher,enabled}){const {nightlySet}=require('./screen-universe.cjs');
  const now=deps.clock();const closed=deps.closedDays?.()??new Set();const asOf={KR:asOfDay('KR',now,closed),US:asOfDay('US',now,closed)};
  const set=nightlySet(deps);const rows=new Map(deps.store.db.prepare('SELECT symbol,newest,depth,complete,stopped FROM screen_progress').all().map(r=>[r.symbol,r]));
  const markets={};
  for(const m of ['KR','US']){const mine=set.filter(s=>marketOf(s)===m);if(!mine.length)continue;const got=mine.map(s=>rows.get(s)).filter(r=>r&&r.depth>0);const depths=got.map(r=>r.depth).sort((a,b)=>a-b);
    const current=asOf[m]?got.filter(r=>r.newest>=asOf[m]).length:0;
    markets[m]={stocks:mine.length,read:got.length,current,older:got.length-current,full:got.filter(r=>r.depth>=KEEP||r.complete).length,median:depths.length?depths[Math.floor(depths.length/2)]:0,stopped:mine.filter(s=>rows.get(s)?.stopped).length};}
  const reasons=[...new Set(set.map(s=>rows.get(s)?.stopped).filter(Boolean))];
  const r=refresher?.status??{};
  return {enabled:Boolean(enabled),asOf,markets,refresh:{state:r.state??'idle',why:r.why??null},stopped:{count:Object.values(markets).reduce((a,x)=>a+x.stopped,0),reasons},keep:KEEP};}
module.exports={screenStatus};
