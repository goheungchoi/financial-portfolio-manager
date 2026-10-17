import {useEffect,useState} from 'react';
import {Note} from './Note';
import './research.css';
// Where the portfolio's risk sits: sectors, concentration, beta and holdings that move together. The agents read the same view.
export type ExposureState={holdings:number;investedPct?:number;cashPct?:number|null;largest?:{symbol:string;name:string;weightPct:number};top3WeightPct?:number;effectiveHoldings?:number;sectors?:{name:string;weightPct:number}[];markets?:{market:string;weightPct:number}[];portfolioBeta?:number|null;betaCoveragePct?:number;movesTogether?:{symbols:string[];names:string[];weightPct:number}[]};
export function ExposurePanel(){
  const [e,setE]=useState<ExposureState|null>(null);
  useEffect(()=>{let alive=true;const load=async()=>{try{const s=await window.portfolio?.getRuntime();if(alive)setE((s as any)?.exposure??null);}catch{}};void load();const t=setInterval(load,30000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!e||!e.holdings)return null;
  const max=Math.max(...(e.sectors??[]).map(s=>s.weightPct),1);
  return <section className="exposure-panel" aria-label="Portfolio exposure">
    <div className="section-head"><div><h2>Exposure</h2><small className="muted">Shares of total equity, including cash</small></div></div>
    <div className="company-stats">{([['Invested',`${e.investedPct}%`],['Cash',`${e.cashPct}%`],['Largest holding',e.largest?`${e.largest.name} ${e.largest.weightPct}%`:'—'],['Top 3',`${e.top3WeightPct}%`],['Effective holdings',e.effectiveHoldings!=null?String(e.effectiveHoldings):'—'],['Portfolio beta',e.portfolioBeta!=null?String(e.portfolioBeta):'Needs history']] as [string,string][]).map(([k,v])=><div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
    {(e.sectors?.length??0)>0&&<><h3 className="research-sub">By sector</h3><div className="research-weights" aria-label="Sector exposure">{e.sectors!.map(s=><div key={s.name}><span>{s.name}</span><i style={{width:`${Math.max(2,s.weightPct/max*100)}%`}}/><b>{s.weightPct}%</b></div>)}</div></>}
    {(e.movesTogether?.length??0)>0&&<p className="research-line research-warn">Move together: {e.movesTogether!.map(g=>`${g.names.join(' + ')} (${g.weightPct}% combined)`).join(' · ')}</p>}
    <Note summary="How this is measured">Effective holdings is how many equal-sized positions the portfolio behaves like (1 ÷ sum of squared weights). Beta is weighted over holdings with price history; it measures sensitivity to KOSPI or the S&amp;P 500. Holdings that move together have daily-return correlation of 0.7 or more over about 60 days, so they act like one bet.</Note>
  </section>;
}
