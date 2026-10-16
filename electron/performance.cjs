const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
// Daily account value history, user-recorded deposits/withdrawals and benchmark closes.
// Returns are time-weighted: flows are applied at the start of their day, so deposits do not count as gains.
const INDEXES={KOSPI:{market:'KR',label:'KOSPI'},SPX:{market:'US',label:'S&P 500'}};
const PERIODS=[['1W',7],['1M',30],['3M',91],['YTD','ytd'],['All',null]];
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
    const row={day,at:this.clock(),KRW:KRW==null?prior.KRW??null:{equity:KRW,cash:state.cash?.KRW??null},USD:USD==null?prior.USD??null:{equity:USD,cash:state.cash?.USD??null},fx:state.fx?.usdKRW??prior.fx??null,equityKRW:equityKRW??prior.equityKRW??null};
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
      if(dailyReturn!=null)index*=1+dailyReturn;points.push({day:row.day,value,flow:netFlow,dailyReturn,index});previous={day:row.day,value};
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
    return {kind,benchmark,start:points[0].day,end:end.day,points,periods};
  }
}
function benchmarkFor(kind){return kind==='USD'?'SPX':'KOSPI';}
module.exports={PerformanceHistory,INDEXES,benchmarkFor};
