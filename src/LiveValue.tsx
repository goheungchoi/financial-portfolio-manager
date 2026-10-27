import {useEffect,useRef,useState} from 'react';
import {nextChange} from './live-change.mjs';
export const formatMoney=(value:number)=>new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(value);
// basis names where the value comes from; a change of basis (loading, a price source settling) is not shown as a move.
// The last change in a live total: labeled, with an arrow, the signed amount, the percent and when it happened. It stays
// until the next change (an update with no change does not clear it), so it reads as a fact rather than a flicker.
export function TickDelta({value,sample,currency='KRW',basis=''}:{value:number;sample:number;currency?:string;basis?:string}){
  const previous=useRef<{value:number;basis:string}|null>({value,basis});const lastSample=useRef(sample);
  const [move,setMove]=useState<{delta:number;from:number;at:number;sequence:number}|null>(null);
  useEffect(()=>{if(lastSample.current===sample&&previous.current?.value===value&&previous.current?.basis===basis)return;lastSample.current=sample;const from=previous.current?.value;const next=nextChange(previous.current,value,basis);previous.current=next.state;
    if(next.delta)setMove(current=>({delta:next.delta!,from:from??value-next.delta!,at:Date.now(),sequence:(current?.sequence??0)+1}));},[value,sample,basis]);
  const format=(amount:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2}).format(amount);
  if(!move)return <span className="tick-delta unchanged" data-delta="" title="Shows the next change in this total as prices, fills or cash update"><span className="tick-label">No change yet</span></span>;
  const up=move.delta>0,pct=move.from?Math.abs(move.delta/move.from*100):null,time=new Date(move.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const sign=up?'+':'−',amount=`${sign}${format(Math.abs(move.delta))}`,percent=pct==null?null:pct<0.01?`${sign}<0.01%`:`${sign}${pct.toFixed(2)}%`;
  return <span className={`tick-delta ${up?'increase':'decrease'}`} data-delta={move.delta} title={`Last change at ${time}: ${amount}${percent?` (${percent})`:''}, from prices, fills, fees or cash`}>
    <span className="tick-label">Last change</span><span key={move.sequence} className="tick-pill"><i aria-hidden="true">{up?'▲':'▼'}</i><b>{amount}</b>{percent&&<span className="tick-pct">{percent}</span>}</span><time>{time}</time></span>;
}
export function LiveValue({value,format=formatMoney,basis=''}:{value:number;format?(value:number):string;basis?:string}){
  const previous=useRef<{value:number;basis:string}|null>({value,basis});const [change,setChange]=useState({delta:0,sequence:0});
  useEffect(()=>{const next=nextChange(previous.current,value,basis);previous.current=next.state;if(next.delta)setChange(current=>({delta:next.delta!,sequence:current.sequence+1}));else if(next.delta===null)setChange(current=>({delta:0,sequence:current.sequence}));},[value,basis]);
  return <span key={change.sequence} className={`live-number ${change.delta>0?'tick-up':change.delta<0?'tick-down':''}`} title={change.delta?`Change since previous update: ${change.delta>0?'+':''}${format(change.delta)}`:'Waiting for a changed value'}>{format(value)}</span>;
}
export function EquityTrace({value,sample}:{value:number;sample:number}){
  const [points,setPoints]=useState<number[]>([]);
  useEffect(()=>{setPoints(current=>[...current,value].slice(-60));},[value,sample]);
  const low=Math.min(...points),high=Math.max(...points);const coordinates=points.map((price,i)=>`${i/Math.max(1,points.length-1)*240},${high===low?25:45-(price-low)/(high-low)*40}`).join(' ');
  return <div className="equity-trace" title="Equity sampled since this view opened"><svg viewBox="0 0 240 50" role="img" aria-label="Equity observed during this view"><polyline points={coordinates} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg></div>;
}
