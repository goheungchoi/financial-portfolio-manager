import {useEffect} from 'react';
import {CompanyView} from './CompanyView';
// Chart-only window opened from Charts. It follows the app theme and refreshes quietly every minute.
export function ChartWindow({symbol}:{symbol:string}){
  useEffect(()=>{
    const api=window.portfolio;if(!api)return;let alive=true;const apply=(theme:string)=>{if(alive)document.documentElement.dataset.theme=theme;};
    const off=api.onTheme(apply);api.getTheme().then(apply).catch(()=>{});return()=>{alive=false;off();};
  },[]);
  return <main className="chart-window" aria-label="Chart window"><CompanyView initialSymbol={symbol} standalone autoRefreshMs={60000} onSymbolChange={value=>{document.title=`${value} · Chart`;}}/></main>;
}
