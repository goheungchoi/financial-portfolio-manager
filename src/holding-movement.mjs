// The Holdings page's Movement cards (2026-11-11, artifacts/reviews/2026-11-11-holding-graphs): per holding, the price
// line from daily closes and the P/L line from the app's recorded daily positions (nav_history), never rebuilt from
// fills. The P/L line is for the position held now: a symbol that left the records and came back shows only its current
// run. Unknown stays unknown: a day without a close or a record is a gap, and every missing piece has a reason.

export const PERIODS=['1W','1M','3M','Since purchase'];
const DAYS={'1W':7,'1M':30,'3M':91};
const DAY=86400000;
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
/** The Seoul calendar day of a time (the records are kept per Seoul day). */
// Both return null for a time that is not a finite number, never throwing (release gate 1.5.52, G5: a text time blanked
// the window).
export const seoulDay=ms=>typeof ms==='number'&&Number.isFinite(ms)?new Date(ms+9*3600000).toISOString().slice(0,10):null;
const NY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
/** The New York calendar day of a time: U.S. daily closes are dated by it (review of step 1, change 2). */
export const newYorkDay=ms=>typeof ms==='number'&&Number.isFinite(ms)?NY.format(new Date(ms)):null;

/**
 * The current run of a symbol in the recorded days: the rows after the last recorded day on which the symbol was not
 * held. A day with no row at all (the app was not running), or a row whose market part has no positions list, is a gap,
 * not an end (review of step 1, change 1).
 * @param {{day:string,fx?:number|null,positions:{symbol:string,quantity:number,value:number,cost:number|null}[]|null}[]} days
 */
function currentRun(days,symbol){
  const known=days.filter(d=>Array.isArray(d.positions));
  let start=0;
  known.forEach((d,i)=>{if(!d.positions.some(p=>p.symbol===symbol&&p.quantity>0))start=i+1;});
  return known.slice(start).filter(d=>d.positions.some(p=>p.symbol===symbol));
}

/**
 * The Buy fill that opened the position held now, from the app's own fills: the latest Buy that took the running
 * quantity from zero, used only when the fills add up to the quantity held now (trades placed directly in KIS are
 * not in them).
 * @param {{side:string,filled:number,at:number}[]} fills this symbol's filled orders
 */
function openingFill(fills,quantity){
  let held=0,opened=null;
  for(const f of fills.filter(f=>typeof f?.at==='number'&&Number.isFinite(f.at)).sort((a,b)=>a.at-b.at)){if(!(f.filled>0))continue;
    if(f.side==='Buy'){if(held===0)opened=f;held+=f.filled;}else{held=Math.max(0,held-f.filled);if(held===0)opened=null;}}
  return opened&&held===quantity?opened:null;
}

/**
 * @param {object} input
 * @param {{symbol:string,name?:string,market:string,currency:string,quantity:number,price:number,cost:number|null,valueKRW?:number|null}} input.row  the holding now (state.rows)
 * @param {{date:string,close:number}[]|null} input.closes  daily closes (the research cache 'daily'); null when not loaded
 * @param {{day:string,fx?:number|null,positions:any[]}[]} input.days  recorded days for this holding's market, oldest first
 * @param {{side:string,filled:number,at:number}[]} [input.fills]  the app's filled orders for this symbol
 * @param {string} input.period  one of PERIODS
 * @param {string} input.today   the Seoul day (the P/L line's calendar)
 * @param {number|null} [input.now]  the time now; for a U.S. holding the price line's day is its New York day
 * @param {string|null} [input.closesReason]  why the closes are missing (a failed read), when they are
 * @param {string|null} [input.recordsReason]  why the daily records are missing (a failed read), when they are
 */
export function holdingMovement({row,closes,days,fills=[],period,today,now=null,closesReason=null,recordsReason=null}){
  const symbol=row.symbol,native=row.currency,us=row.market==='US';
  // Two calendars (review of step 1, change 2): the P/L line uses the Seoul days the records are kept by; the price line
  // uses the market's own day, as its closes are dated (New York for a U.S. holding).
  const marketDay=ms=>us?newYorkDay(ms):seoulDay(ms);
  const marketToday=(us&&now!=null?newYorkDay(now):null)??today;
  // When the position started: the opening fill, else the first day of the current run in the records. day is the
  // Seoul day (for the P/L line); marketDay is the market's day (for the price line's marker). A "first recorded" day is
  // a Seoul record day and is used as it is on both.
  const run=currentRun(days,symbol);
  const fill=openingFill(fills,row.quantity);
  // A fill whose day cannot be read is an unknown purchase day: the "first recorded" path.
  const fillDay=fill?seoulDay(fill.at):null,fillMarketDay=fill?marketDay(fill.at):null;
  const purchase=fill&&fillDay&&fillMarketDay?{day:fillDay,marketDay:fillMarketDay,source:'fill'}:run.length?{day:run[0].day,marketDay:run[0].day,source:'first recorded'}:{day:null,marketDay:null,source:null};
  const since=period==='Since purchase';
  const from=since?purchase.day??run[0]?.day??today:shift(today,-(DAYS[period]??30));
  const priceFrom=since?purchase.marketDay??from:shift(marketToday,-(DAYS[period]??30));

  // Price line: the closes inside the period; today's point is the holdings table's price (as the design says), dated
  // by the market's day.
  let price;
  if(!closes){price={points:[],from:priceFrom,to:marketToday,start:null,end:null,changePct:null,purchaseMarked:false,reason:closesReason??'Daily prices are not loaded yet.'};}
  else{
    const points=closes.filter(c=>c.date>=priceFrom&&c.date<=marketToday&&Number.isFinite(c.close)&&c.close>0).map(c=>({day:c.date,close:c.close}));
    if(Number.isFinite(row.price)&&row.price>0){const i=points.findIndex(p=>p.day===marketToday);const live={day:marketToday,close:row.price,live:true};if(i>=0)points[i]=live;else points.push(live);}
    const start=points[0]?.close??null,end=points.at(-1)?.close??null;
    price={points,from:priceFrom,to:marketToday,start,end,changePct:start&&end&&points.length>1?end/start-1:null,
      // Marked only for a purchase known from a fill: a "first recorded" day is not a purchase (step 2 review prep).
      purchaseMarked:Boolean(purchase.source==='fill'&&purchase.marketDay&&purchase.marketDay>=priceFrom&&purchase.marketDay<=marketToday&&points.length>1),
      reason:points.length<2?'Not enough daily prices for this period.':null};
  }

  // P/L line: value minus cost as recorded each day of the current run, inside the period.
  let pl;
  if(!run.length)pl={points:[],start:null,end:null,startsAt:null,startsLate:false,reason:recordsReason??'P/L history unavailable: this holding is not in the daily records yet.'};
  else{
    const recorded=run.filter(d=>d.day>=from&&d.day<=today).map(d=>{const p=d.positions.find(x=>x.symbol===symbol);const known=Number.isFinite(p.value)&&Number.isFinite(p.cost)&&p.cost>0;
      const pnl=known?p.value-p.cost:null;const rate=Number.isFinite(d.fx)&&d.fx>0?d.fx:null;
      return {day:d.day,pnl,pct:known?pnl/p.cost:null,averageCost:known&&p.quantity>0?p.cost/p.quantity:null,quantity:p.quantity,...(native==='KRW'?{}:{pnlKRW:pnl!=null&&rate?pnl*rate:null})};});
    // A calendar day between two recorded days with no record (the app was not running, or the day's part had no
    // positions list) is a gap: a point with no value, so the line breaks there instead of joining across it. Every
    // day is recorded while the app runs, weekends included.
    const points=[];for(const p of recorded){const prev=points.at(-1);if(prev)for(let d=shift(prev.day,1);d<p.day;d=shift(d,1))points.push({day:d,pnl:null,pct:null,averageCost:null,quantity:null,gap:true});points.push(p);}
    const known=points.filter(p=>p.pnl!=null);
    const startsAt=points[0]?.day??null;
    // Later than the purchase: the records begin after it (or the app was not running that day).
    const startsLate=Boolean(startsAt&&purchase.source==='fill'&&purchase.day<startsAt&&purchase.day>=from);
    pl={points,start:known[0]?.pnl??null,end:known.at(-1)?.pnl??null,endPct:known.at(-1)?.pct??null,startsAt,startsLate,
      reason:!points.length?'No recorded day in this period.':!known.length?'P/L history unavailable: the average cost was not recorded.':null};
  }
  return {symbol,name:row.name??symbol,market:row.market,currency:native,period,from,to:today,purchase,price,pl};
}

/**
 * Every open holding, largest position first (by KRW value, then native value).
 * @param {{rows:any[],closesBySymbol:Record<string,{closes:{date:string,close:number}[]|null,reason?:string|null}>,days:{KR:any[],US:any[]},fillsBySymbol?:Record<string,any[]>,period:string,today:string,now?:number|null,recordsReason?:string|null}} input
 */
export function movementCards({rows,closesBySymbol={},days,fillsBySymbol={},period,today,now=null,recordsReason=null}){
  return rows.filter(r=>r.quantity>0).sort((a,b)=>(b.valueKRW??b.quantity*b.price)-(a.valueKRW??a.quantity*a.price))
    .map(row=>holdingMovement({row,closes:closesBySymbol[row.symbol]?.closes??null,closesReason:closesBySymbol[row.symbol]?.reason??null,days:days[row.market]??[],fills:fillsBySymbol[row.symbol]??[],period,today,now,recordsReason}));
}

/**
 * nav_history rows as recorded (performance.cjs record()) split into each market's days, oldest first.
 * @param {{day:string,fx?:number|null,KRW?:{positions?:any[]}|null,USD?:{positions?:any[]}|null}[]} rows
 */
export function recordedDays(rows){
  const sorted=[...rows].sort((a,b)=>a.day.localeCompare(b.day));
  // A market part without a positions list is kept as null: a gap for every symbol, never "not held".
  const list=m=>Array.isArray(m?.positions)?m.positions:null;
  return {KR:sorted.filter(r=>r.KRW).map(r=>({day:r.day,fx:r.fx??null,positions:list(r.KRW)})),US:sorted.filter(r=>r.USD).map(r=>({day:r.day,fx:r.fx??null,positions:list(r.USD)}))};
}
