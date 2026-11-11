// The Home Result tile's figures (2026-11-11, artifacts/reviews/2026-11-11-home-result): the total result since the first
// daily record, the latest day, unrealized gain and the benchmark. Each figure is read from the same records the account
// value box (HomeTrend) and the old Unrealized tile read, never recomputed; an unknown figure is null with its reason,
// never a zero. Realized gain or loss is left out until a stored record covers both markets (the user's decision).
import {portfolioProfit} from './portfolio-profit.mjs';

const firstWhy=s=>String(s).replace(/^\d{4}-\d{2}-\d{2}: /,'').split('; ')[0].replace(/\.$/,'');
const TAG_SETTLEMENT='Includes days with U.S. buys awaiting settlement evidence, accounting corrections or restatements.';
const TAG_UNRESOLVED='Money changes awaiting you are left out; confirm or remove them on the Performance page.';

/**
 * The account value box's note for a period (HomeTrend), in order of what matters: no return at all; a return that is an
 * estimate; a figure that leaves out money changes awaiting the user. Shared so the box and the Result tile cannot drift.
 * @returns {{text:string,why:string,missing:boolean}|null}
 */
export function periodNote(period,summary){
  const missing=period?.unavailable?.length?period.unavailable:null;
  if(missing)return {text:`Investment return unavailable: ${firstWhy(missing[0])}${missing.length>1?` (${missing.length} days affected)`:''}.`,why:missing.slice(0,3).join(' · '),missing:true};
  if(period?.settlementAffected)return {text:'Return estimate: settlement not verified.',why:TAG_SETTLEMENT,missing:false};
  if(summary?.provisional?.unresolved?.length)return {text:'Provisional: money changes awaiting you are left out.',why:'Confirm or remove them on the Performance page.',missing:false};
  return null;
}

/** The summary the account value box shows: the combined one when it has points, otherwise Korea's (as HomeTrend). */
export function resultSummary(summaries){
  if(!summaries)return null;
  return summaries.COMBINED?.points?.length?summaries.COMBINED:summaries.KRW??null;
}

/**
 * @typedef {{low:number,high:number}} Range
 * @typedef {{gain:number|null,twr:number|null,twrRange:Range|null,reason:string|null,tag:{text:string,why:string}|null,start?:string,end?:string}} ResultTotal
 * @typedef {{day:string|null,pnl:number|null,dailyReturn:number|null,pnlRange:Range|null,returnRange:Range|null,correction:number|null,reason:string|null,unavailable?:boolean}} ResultToday
 * @typedef {{scope:'both'|'korea',since:string|null,benchmarkName:string,total:ResultTotal|null,today:ResultToday|null,
 *   unrealized:{amount:number|null,percent:number|null,reason:string|null},unrealizedUSD:{amount:number,percent:number|null}|null,
 *   benchmark:{benchmark:number,you:number}|null}} HomeResult
 */
/**
 * summary: getPerformance().state.summaries, picked by resultSummary(); rows: the portfolio rows (state.rows);
 * usLoaded: the U.S. account and an exchange rate are both loaded (as the Account value tile); equityKnown: the account
 * value is known (the old Unrealized tile's `loaded`); usdLoaded: the U.S. total is known, for the U.S. amount in USD.
 * @param {{summary:any,rows?:any[],usLoaded?:boolean,equityKnown?:boolean,usdLoaded?:boolean}} input
 * @returns {HomeResult}
 */
export function homeResult({summary,rows=[],usLoaded=false,equityKnown=true,usdLoaded=false}){
  const scope=usLoaded?'both':'korea';
  const points=summary?.points??[];
  /** @type {HomeResult} */
  const out={scope,since:points[0]?.day??null,benchmarkName:summary?.benchmark==='SPX'?'S&P 500':'KOSPI',
    total:null,today:null,unrealized:{amount:null,percent:null,reason:null},unrealizedUSD:null,benchmark:null};

  // Total: the "All" period, as the account value box shows it on "All".
  if(points.length<2)out.total={gain:null,twr:null,twrRange:null,reason:'Starts after values are recorded on two days.',tag:null};
  else{
    const all=(summary.periods??[]).find(p=>p.label==='All')??null;
    if(!all)out.total={gain:null,twr:null,twrRange:null,reason:'No result for the whole history yet.',tag:null};
    else{
      const missing=all.unavailable?.length?all.unavailable:null;
      const gain=Number.isFinite(all.gain)?all.gain:null,twr=Number.isFinite(all.twr)?all.twr:null,twrRange=all.twrRange??null;
      const reason=missing?periodNote(all,summary).text:gain==null?'Not known for the whole history.':null;
      const tag=all.settlementAffected?{text:'Not verified',why:TAG_SETTLEMENT}:summary.provisional?.unresolved?.length?{text:'Provisional',why:TAG_UNRESOLVED}:null;
      out.total={gain,twr,twrRange:twr==null?twrRange:null,reason,tag,start:all.start,end:all.end};
      // Benchmark over the same days, shown only next to a return.
      if(Number.isFinite(all.benchmark)&&twr!=null)out.benchmark={benchmark:all.benchmark,you:twr};
    }
  }

  // Today: the latest recorded day, as the box's "Latest day".
  const last=points.at(-1);
  if(!last||points.length<2)out.today={pnl:null,dailyReturn:null,pnlRange:null,returnRange:null,correction:null,day:last?.day??null,reason:'Starts after values are recorded on two days.'};
  else out.today={day:last.day,pnl:Number.isFinite(last.pnl)?last.pnl:null,dailyReturn:Number.isFinite(last.dailyReturn)?last.dailyReturn:null,
    pnlRange:last.bounded?null:last.pnlRange??null,returnRange:last.bounded?.returnRange??null,correction:Number.isFinite(last.correction)&&last.correction?last.correction:null,
    reason:Number.isFinite(last.pnl)?null:last.unavailable?.length?firstWhy(last.unavailable[0]):'Not known for the latest day.',
    // A recorded reason ("Unavailable" on the box) as against no figure yet ("—").
    unavailable:!Number.isFinite(last.pnl)&&Boolean(last.unavailable?.length)};

  // Unrealized: the old tile's figure, over the holdings the account value counts (Korea alone until the U.S. is loaded).
  const counted=rows.filter(r=>r.market==='KR'||usLoaded);
  const u=portfolioProfit(counted,'KRW',equityKnown);
  out.unrealized=u?{amount:u.amount,percent:u.percent,reason:null}:{amount:null,percent:null,reason:equityKnown?'A holding has no average cost or price.':'The account value is not loaded yet.'};
  const us=rows.filter(r=>r.market==='US');
  // The U.S. amount in dollars needs no exchange rate: shown once the U.S. total is known (as the old tile's U.S. line).
  if(us.length){const d=portfolioProfit(us,'USD',usdLoaded);out.unrealizedUSD=d?{amount:d.amount,percent:d.percent}:null;}
  return out;
}
