const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
// Daily account value history, user-recorded deposits/withdrawals and benchmark closes.
// Returns are time-weighted: flows are applied at the start of their day, so deposits do not count as gains.
const INDEXES={KOSPI:{market:'KR',label:'KOSPI'},SPX:{market:'US',label:'S&P 500'}};
const PERIODS=[['1W',7],['1M',30],['3M',91],['YTD','ytd'],['1Y',365],['All',null]];
const isDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
const shift=(day,days)=>new Date(Date.parse(day+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
class PerformanceHistory {
  constructor(db,clock=Date.now){
    this.db=db;this.clock=clock;
    db.exec('CREATE TABLE IF NOT EXISTS nav_history(account TEXT NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,day));CREATE TABLE IF NOT EXISTS cash_flows(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS benchmark_closes(idx TEXT NOT NULL,day TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(idx,day))');
  }
  // Keeps the latest valuation of each Seoul day; a market missing from this refresh keeps its earlier value for the day.
  record(account,state){
    if(typeof account!=='string'||!account||!state?.totals)return null;const {KRW,USD,equityKRW}=state.totals;if(KRW==null&&USD==null)return null;
    const day=seoulDate(this.clock()),existing=this.db.prepare('SELECT payload FROM nav_history WHERE account=? AND day=?').get(account,day);const prior=existing?JSON.parse(existing.payload):{};
    // Each market keeps the day's first, highest and lowest observed value and a snapshot of its holdings.
    const holdings=market=>(state.rows??[]).filter(r=>r.market===market&&Number.isFinite(r.quantity)&&Number.isFinite(r.price)).slice(0,80).map(r=>({symbol:r.symbol,name:r.name??r.symbol,quantity:r.quantity,value:r.quantity*r.price,cost:Number.isFinite(r.cost)?r.quantity*r.cost:null}));
    const band=(old,equity,cash,market)=>({equity,cash,open:old?.open??equity,high:Math.max(old?.high??equity,equity),low:Math.min(old?.low??equity,equity),positions:holdings(market)});
    const combined=equityKRW??prior.equityKRW??null;
    const row={day,at:this.clock(),KRW:KRW==null?prior.KRW??null:band(prior.KRW,KRW,state.cash?.KRW??null,'KR'),USD:USD==null?prior.USD??null:band(prior.USD,USD,state.cash?.USD??null,'US'),fx:state.fx?.usdKRW??prior.fx??null,equityKRW:combined,
      equityKRWHigh:combined==null?null:Math.max(prior.equityKRWHigh??combined,combined),equityKRWLow:combined==null?null:Math.min(prior.equityKRWLow??combined,combined)};
    this.db.prepare('INSERT INTO nav_history VALUES(?,?,?) ON CONFLICT(account,day) DO UPDATE SET payload=excluded.payload').run(account,day,JSON.stringify(row));return row;
  }
  history(account){return this.db.prepare('SELECT payload FROM nav_history WHERE account=? ORDER BY day').all(account).map(row=>JSON.parse(row.payload));}
  flows(account){return this.db.prepare('SELECT payload FROM cash_flows WHERE account=?').all(account).map(row=>JSON.parse(row.payload)).sort((a,b)=>a.day.localeCompare(b.day)||a.createdAt-b.createdAt);}
  addFlow(account,value){
    const today=seoulDate(this.clock());
    if(typeof account!=='string'||!account||!value||!isDay(value.day)||value.day>today||!['KR','US'].includes(value.market)||!Number.isFinite(value.amount)||value.amount===0||Math.abs(value.amount)>1e12||typeof(value.note??'')!=='string'||String(value.note??'').length>200)throw new Error('INVALID_FLOW');
    const flow={id:randomUUID(),day:value.day,market:value.market,currency:value.market==='US'?'USD':'KRW',amount:value.market==='US'?Math.round(value.amount*100)/100:Math.round(value.amount),note:String(value.note??'').trim(),createdAt:this.clock()};
    this.db.prepare('INSERT INTO cash_flows VALUES(?,?,?)').run(flow.id,account,JSON.stringify(flow));return flow;
  }
  removeFlow(account,id){this.db.prepare('DELETE FROM cash_flows WHERE id=? AND account=?').run(id,account);}
  saveCloses(index,rows){if(!INDEXES[index])throw new Error('INVALID_INDEX');const insert=this.db.prepare('INSERT INTO benchmark_closes VALUES(?,?,?) ON CONFLICT(idx,day) DO UPDATE SET close=excluded.close');for(const row of rows)if(isDay(row.day)&&Number.isFinite(row.close)&&row.close>0)insert.run(index,row.day,row.close);}
  closes(index){return this.db.prepare('SELECT day,close FROM benchmark_closes WHERE idx=? ORDER BY day').all(index).map(row=>({day:row.day,close:row.close}));}
  // series: 'KRW' (Korea account), 'USD' (U.S. account) or 'COMBINED' (KRW, U.S. flows converted at that day's rate).
  series(account,kind){
    const history=this.history(account),flows=this.flows(account);let previous=null,index=1,lastFx=null;const points=[];
    for(const row of history){
      lastFx=row.fx??lastFx;const value=kind==='KRW'?row.KRW?.equity:kind==='USD'?row.USD?.equity:row.equityKRW;if(!Number.isFinite(value))continue;
      const flow=flows.filter(f=>f.day===row.day&&(kind==='COMBINED'||f.currency===kind)).reduce((sum,f)=>sum+(kind==='COMBINED'&&f.currency==='USD'?(lastFx==null?NaN:f.amount*lastFx):f.amount),0);
      // Flows recorded on days without a valuation are folded into the next valued day.
      const skipped=previous?flows.filter(f=>f.day>previous.day&&f.day<row.day&&(kind==='COMBINED'||f.currency===kind)).reduce((sum,f)=>sum+(kind==='COMBINED'&&f.currency==='USD'?(lastFx==null?NaN:f.amount*lastFx):f.amount),0):0;
      const netFlow=flow+skipped,base=previous?previous.value+netFlow:null;const dailyReturn=base>0&&Number.isFinite(base)?value/base-1:null;
      if(dailyReturn!=null)index*=1+dailyReturn;
      // Unrealized P/L and holdings: native for one market; the all-markets series converts U.S. values at the day's rate.
      const parts=kind==='COMBINED'?[[row.KRW,1],[row.USD,lastFx]]:[[kind==='KRW'?row.KRW:row.USD,1]];
      const positions=parts.every(([m,f])=>!m||m.positions&&Number.isFinite(f))?parts.flatMap(([m,f])=>(m?.positions??[]).map(p=>({...p,value:p.value*f,cost:p.cost==null?null:p.cost*f}))):null;
      const unrealized=positions&&positions.length&&positions.every(p=>p.cost!=null)?positions.reduce((sum,p)=>sum+p.value-p.cost,0):positions&&!positions.length?0:null;
      const cash=parts.reduce((sum,[m,f])=>sum==null||!m||m.cash==null||!Number.isFinite(f)?null:sum+m.cash*f,0);
      const high=kind==='COMBINED'?row.equityKRWHigh:(kind==='KRW'?row.KRW:row.USD)?.high,low=kind==='COMBINED'?row.equityKRWLow:(kind==='KRW'?row.KRW:row.USD)?.low;
      points.push({day:row.day,value,flow:netFlow,dailyReturn,index,pnl:previous?value-previous.value-netFlow:null,high:Number.isFinite(high)?high:value,low:Number.isFinite(low)?low:value,cash,unrealized,positions});previous={day:row.day,value};
    }
    return points;
  }
  // Period returns, money gain after flows and the matching benchmark change, all from the same start and end days.
  summary(account,kind,benchmark){
    const points=this.series(account,kind);if(points.length<1)return {kind,points,periods:[],start:null,end:null,benchmark};
    const end=points.at(-1),closes=benchmark?this.closes(benchmark):[];const closeOn=day=>closes.filter(c=>c.day<=day).at(-1)??null;
    const periods=PERIODS.map(([label,days])=>{
      const target=days==null?points[0].day:days==='ytd'?end.day.slice(0,4)+'-01-01':shift(end.day,days);
      const start=[...points].reverse().find(p=>p.day<=target)??points[0];const partial=start.day>target&&days!=null;
      if(start.day===end.day)return {label,start:start.day,end:end.day,partial,twr:null,gain:null,flows:0,benchmark:null};
      const flows=points.filter(p=>p.day>start.day&&p.day<=end.day).reduce((sum,p)=>sum+p.flow,0);
      const from=closeOn(start.day),to=closeOn(end.day);
      return {label,start:start.day,end:end.day,partial,twr:end.index/start.index-1,gain:end.value-start.value-flows,flows,benchmark:from&&to&&from.day!==to.day?to.close/from.close-1:null};
    });
    const analytics=Object.fromEntries(periods.map(p=>[p.label,analyze(points,p.start)]));
    return {kind,benchmark,start:points[0].day,end:end.day,points:points.map(({positions,...p})=>p),periods,analytics};
  }
}
// Risk and attribution for the points from a start day: peak, trough, drawdowns, volatility, best and worst days,
// daily P/L and the change in each holding's unrealized P/L.
function analyze(points,from){
  const pts=points.filter(p=>p.day>=from);if(!pts.length)return null;const first=pts[0],last=pts.at(-1);
  const days=pts.slice(1);const rets=days.map(p=>p.dailyReturn).filter(Number.isFinite);
  let top=-Infinity,maxDd=0;const drawdown=pts.map(p=>{top=Math.max(top,p.index);const dd=p.index/top-1;maxDd=Math.min(maxDd,dd);return {day:p.day,drawdownPct:dd*100};});
  const by=(list,key,dir)=>list.reduce((best,p)=>best==null||dir*(p[key]-best[key])>0?p:best,null);
  const mean=rets.length?rets.reduce((a,b)=>a+b,0)/rets.length:null;const sd=rets.length>=5?Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1)):null;
  const peak=by(pts,'value',1),trough=by(pts,'value',-1),high=by(pts,'high',1),low=by(pts,'low',-1);
  const best=by(days.filter(p=>Number.isFinite(p.dailyReturn)),'dailyReturn',1),worst=by(days.filter(p=>Number.isFinite(p.dailyReturn)),'dailyReturn',-1);
  let contributions=null;
  if(first.positions&&last.positions){const map=new Map();const add=(list,key)=>{for(const p of list){if(p.cost==null)continue;const row=map.get(p.symbol)??{symbol:p.symbol,name:p.name,start:0,end:0,held:{}};row[key]=p.value-p.cost;row.held[key]=true;map.set(p.symbol,row);}};
    add(first.positions,'start');add(last.positions,'end');contributions=[...map.values()].map(r=>({symbol:r.symbol,name:r.name,startUnrealized:r.start,endUnrealized:r.end,change:r.end-r.start,status:r.held.start&&r.held.end?'held':r.held.end?'new':'closed'})).sort((a,b)=>b.change-a.change);}
  const r2=v=>v==null?null:Math.round(v*100)/100;
  return {from:first.day,to:last.day,days:pts.length,startValue:first.value,endValue:last.value,twrPct:r2((last.index/first.index-1)*100),gain:last.value-first.value-days.reduce((a,p)=>a+p.flow,0),
    peak:{value:peak.value,day:peak.day},trough:{value:trough.value,day:trough.day},intradayHigh:{value:high.high,day:high.day},intradayLow:{value:low.low,day:low.day},
    maxDrawdownPct:r2(maxDd*100),currentDrawdownPct:r2(drawdown.at(-1).drawdownPct),volatilityPct:sd==null?null:r2(sd*Math.sqrt(252)*100),
    bestDay:best?{day:best.day,returnPct:r2(best.dailyReturn*100),pnl:best.pnl}:null,worstDay:worst?{day:worst.day,returnPct:r2(worst.dailyReturn*100),pnl:worst.pnl}:null,
    positiveDaysPct:rets.length?r2(rets.filter(v=>v>0).length/rets.length*100):null,unrealized:last.unrealized,cashSharePct:last.cash!=null&&last.value>0?r2(last.cash/last.value*100):null,
    dailyPnl:days.map(p=>({day:p.day,pnl:p.pnl,returnPct:p.dailyReturn==null?null:r2(p.dailyReturn*100)})),drawdown:drawdown.map(d=>({day:d.day,drawdownPct:r2(d.drawdownPct)})),contributions};
}
function benchmarkFor(kind){return kind==='USD'?'SPX':'KOSPI';}
module.exports={PerformanceHistory,INDEXES,benchmarkFor,analyze};
