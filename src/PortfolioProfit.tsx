import {portfolioProfit} from './portfolio-profit.mjs';
import type {PortfolioRow} from './UnifiedPortfolio';
export function PortfolioProfit({rows,currency='KRW',loaded=true}:{rows:PortfolioRow[];currency?:string;loaded?:boolean}){
  const result=portfolioProfit(rows,currency,loaded);
  const digits=currency==='KRW'?0:2;
  const rounded=result?Number(result.amount.toFixed(digits)):0;
  const tone=rounded>0?'gain':rounded<0?'loss':'neutral';
  const amount=result?new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:digits,signDisplay:'exceptZero'}).format(rounded):'—';
  return <div className={`portfolio-profit ${tone}`} data-amount={result?.amount??''} title="Unrealized price gain/loss against holding acquisition cost, before selling fees and taxes. Percentage uses invested cost, excluding cash. Combined KRW uses current indicative FX; historical currency gains are not included."><span className="profit-label">Unrealized P/L</span><div className="profit-amount"><b>{amount}</b>{result?.percent!=null&&<span>{new Intl.NumberFormat('en-US',{maximumFractionDigits:2,minimumFractionDigits:2,signDisplay:'exceptZero'}).format(Number(result.percent.toFixed(2)))}%</span>}</div></div>;
}
