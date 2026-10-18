// Phone snapshots: when a buy or sell fills, a short post with the portfolio chart goes to the phone webhook.
// Discord gets an embed with a chart image; other webhooks get the same text. With amounts hidden, only percentages are sent.
const {seoulDate}=require('./kis-activity.cjs');
const UP=0x66d9c0,DOWN=0xd96c6c,FLAT=0x8a94a6;
// Equity samples during the day for the "Today" chart; daily history keeps only one value per day.
class IntradayValues {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS intraday_values(account TEXT NOT NULL,at INTEGER NOT NULL,equity REAL NOT NULL,PRIMARY KEY(account,at))');}
  record(account,equity,now=Date.now()){
    if(typeof account!=='string'||!account||!Number.isFinite(equity)||equity<=0)return false;
    const last=this.db.prepare('SELECT MAX(at) at FROM intraday_values WHERE account=?').get(account)?.at;if(last&&now-last<120000)return false;
    this.db.prepare('INSERT OR REPLACE INTO intraday_values VALUES(?,?,?)').run(account,now,equity);this.db.prepare('DELETE FROM intraday_values WHERE at<?').run(now-3*86400000);return true;
  }
  day(account,day=seoulDate()){return this.db.prepare('SELECT at,equity FROM intraday_values WHERE account=? AND at>=? ORDER BY at').all(account,Date.now()-3*86400000).filter(r=>seoulDate(r.at)===day);}
}
const won=v=>(v<0?'-':'')+'₩'+Math.round(Math.abs(v)).toLocaleString('en-US');
const pct=v=>v==null||!Number.isFinite(v)?'n/a':(v>0?'+':'')+v.toFixed(2)+'%';
const clip=(s,n)=>{s=String(s??'').replace(/[ \t]+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};
const seoulTime=t=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t);
// Account figures shared by review and scout posts. daily: performance series points; intraday: today's samples.
function portfolioFigures({portfolio,daily=[],intraday=[],previousClose=()=>null,amounts=true,today=seoulDate()}){
  const equity=portfolio?.totals?.equityKRW??portfolio?.totals?.KRW??null;
  const prior=daily.filter(p=>p.day<today).at(-1)?.value??null;const open=intraday[0]?.equity??null;const base=prior??open;
  const todayPct=equity!=null&&base>0?(equity/base-1)*100:null;
  const cash=(portfolio?.cash?.KRW??0)+(portfolio?.cash?.USD??0)*(portfolio?.fx?.usdKRW??0);
  const movers=(portfolio?.rows??[]).map(r=>{const prev=previousClose(r.symbol);const day=prev>0&&r.price>0?(r.price/prev-1)*100:null;const total=r.cost>0?(r.price/r.cost-1)*100:null;return {symbol:r.symbol,name:r.name||r.symbol,day,total,weight:equity>0&&r.valueKRW!=null?r.valueKRW/equity*100:null};})
    .filter(m=>m.day!=null||m.total!=null).sort((a,b)=>Math.abs(b.day??b.total)-Math.abs(a.day??a.total)).slice(0,4);
  const fields=[{name:'Portfolio',value:equity==null?'n/a':(amounts?won(equity)+' · ':'')+pct(todayPct)+' today',inline:true},
    {name:'Cash',value:equity>0?(amounts?won(cash)+' · ':'')+(cash/equity*100).toFixed(1)+'%':'n/a',inline:true}];
  if(movers.length)fields.push({name:'Holdings',value:movers.map(m=>`${clip(m.name,22)} ${m.day!=null?pct(m.day)+' today':pct(m.total)+' total'}${m.weight!=null?` · ${m.weight.toFixed(0)}%`:''}`).join('\n'),inline:false});
  // Chart lines: won values, or percent from the first point when amounts are hidden.
  const scale=(rows,key)=>{const first=rows[0]?.[key];return rows.map(r=>amounts||!(first>0)?r[key]:(r[key]/first-1)*100);};
  const days=daily.slice(-30);const todayRows=intraday.length?intraday:[];
  const chart={amounts,label:amounts?'KRW':'% change',headline:todayPct==null?null:(amounts&&equity!=null?won(equity)+'  ':'')+pct(todayPct),today:{t:todayRows.map(r=>r.at),v:scale(todayRows,'equity')},days:{t:days.map(p=>p.day),v:scale(days,'value')},up:todayPct==null||todayPct>=0};
  return {equity,todayPct,fields,chart};
}
const orderPrice=o=>{const price=o.fillPrice??o.limitPrice;return price?(/^\d{6}$/.test(o.symbol)?won(price):'$'+price):null;};
// order: the filled (or partly filled) order; review: the review that proposed it, when one did.
function tradeSnapshot({order,review=null,figures,regime=null,conditional=0,name=order.symbol,now=Date.now()}){
  const bought=order.side==='Buy',partial=order.status!=='Filled',price=orderPrice(order);
  const title=clip(`${bought?'Bought':'Sold'} ${order.filled??0}${partial?`/${order.quantity}`:''} ${name}${price?` @ ${price}`:''}`,200);
  const d=review?.decision??{};const lines=[clip(d.explanation||order.reason,380)];if(partial)lines.push('Partly filled so far.');
  const fields=[...figures.fields];
  if(d.plan&&bought)fields.push({name:'Trade plan',value:clip(`Stop ${d.plan.stopPrice??'n/a'} · target ${d.plan.targetPrice??'n/a'} · ${d.plan.horizonDays??'?'} days · confidence ${d.plan.confidence??'n/a'}\n${d.plan.invalidation??''}`,400),inline:false});
  const account=order.source==='kis'?String(order.environment??'').toUpperCase():'PAPER';
  const facts=[account&&`${account} account`,regime&&`Regime ${regime}`,conditional?`${conditional} conditional order${conditional>1?'s':''} armed`:null,review?.trigger&&`Trigger: ${clip(review.trigger,60)}`].filter(Boolean);
  if(facts.length)fields.push({name:'Agent',value:facts.join(' · '),inline:false});
  return finish({kind:'trade',id:`fill:${order.id}:${order.status}:${order.filled??0}`,title,description:lines.filter(Boolean).join('\n'),color:bought?UP:DOWN,fields,chart:figures.chart,now});
}
// A post on request from settings, to check the webhook and how the chart looks on the phone.
function testSnapshot({figures,now=Date.now()}){return finish({kind:'test',id:'test:'+now,title:'Test snapshot',description:'Snapshots will look like this after each buy or sell.',color:FLAT,fields:figures.fields,chart:figures.chart,now});}
function finish(s){
  const time=seoulTime(s.now);
  const text=[`${s.title} (${time} KST)`,s.description,...s.fields.map(f=>`${f.name}: ${f.value.replace(/\n/g,' | ')}`)].filter(Boolean).join('\n');
  return {...s,time,text:text.length>1500?text.slice(0,1499)+'…':text};
}
// Discord embed; the worker attaches the chart as portfolio.png when one was drawn.
function discordEmbed(s){return {title:clip(s.title,250),description:clip(s.description,3000),color:s.color,fields:s.fields.slice(0,10).map(f=>({name:clip(f.name,250),value:clip(f.value,1000)||'—',inline:Boolean(f.inline)})),footer:{text:`Financial Portfolio Manager · ${s.time} KST`}};}
// Webhook body: Discord gets an embed and the chart as an attachment; other services get plain text. Mentions are never parsed.
function pushRequest(url,data){
  const target=new URL(url),discord=/^(?:ptb\.|canary\.)?discord(?:app)?\.com$/.test(target.hostname)&&target.pathname.startsWith('/api/webhooks/');
  const text=String(data.message??'').slice(0,1500);
  if(discord&&data.embed&&typeof data.embed==='object'){
    const image=typeof data.image==='string'&&data.image.length<2800000?Buffer.from(data.image,'base64'):null;
    const payload={embeds:[{...data.embed,...(image?{image:{url:'attachment://portfolio.png'}}:{})}],allowed_mentions:{parse:[]}};
    const body=new FormData();body.append('payload_json',JSON.stringify(payload));if(image)body.append('files[0]',new Blob([image],{type:'image/png'}),'portfolio.png');
    return {discord,body,headers:undefined};
  }
  return {discord,body:JSON.stringify(discord?{content:text,allowed_mentions:{parse:[]}}:{content:text,text}),headers:{'content-type':'application/json'}};
}
module.exports={pushRequest,IntradayValues,portfolioFigures,tradeSnapshot,testSnapshot,discordEmbed};
