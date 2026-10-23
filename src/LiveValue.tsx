import {useEffect,useRef,useState} from 'react';
import {nextChange} from './live-change.mjs';
export const formatMoney=(value:number)=>new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(value);
// basis names where the value comes from; a change of basis (loading, a price source settling) is not shown as a move.
export function TickDelta({value,sample,currency='KRW',basis=''}:{value:number;sample:number;currency?:string;basis?:string}){
  const previous=useRef<{value:number;basis:string}|null>({value,basis});const lastSample=useRef(sample);const [delta,setDelta]=useState<number|null>(null);
  useEffect(()=>{if(lastSample.current===sample&&previous.current?.value===value&&previous.current?.basis===basis)return;lastSample.current=sample;const next=nextChange(previous.current,value,basis);previous.current=next.state;setDelta(next.delta);},[value,sample,basis]);
  const format=(amount:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2}).format(amount);
  // A signed, colored amount; no change shows a quiet dash. The meaning lives in the tooltip.
  const text=delta===null||delta===0?'—':`${delta>0?'+':'−'}${format(Math.abs(delta))}`;
  return <span className={`tick-delta ${delta!==null&&delta>0?'increase':delta!==null&&delta<0?'decrease':'unchanged'}`} data-delta={delta??''} title={delta===null?'Waiting for the next price update':'Change since the last price update, including fills, fees and cash changes'}><b>{text}</b></span>;
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
