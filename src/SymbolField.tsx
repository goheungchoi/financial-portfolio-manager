import {useEffect,useRef,useState} from 'react';
import type {Security} from './Discover';
// Order symbol entry: type a code or a name, pick from the symbol list, and see the current price.
export function SymbolField({market,value,onChange,label}:{market:'KR'|'US';value:string;onChange(symbol:string):void;label:string}){
  const [text,setText]=useState(value);const [options,setOptions]=useState<Security[]>([]);const [open,setOpen]=useState(false);const [active,setActive]=useState(0);const seq=useRef(0);
  useEffect(()=>{setText(value);},[value]);
  useEffect(()=>{const q=text.trim();if(!open||q.length<1||q===value){setOptions([]);return;}const id=++seq.current;
    const t=setTimeout(async()=>{try{const reply=await window.portfolio?.searchSecurities(q,market);if(id===seq.current&&reply?.ok)setOptions((reply.data as Security[]).slice(0,8));}catch{}},180);return()=>clearTimeout(t);},[text,open,market,value]);
  const choose=(s:Security)=>{onChange(s.symbol);setText(s.symbol);setOpen(false);setOptions([]);};
  return <span className="symbol-field">
    <input aria-label={label} role="combobox" aria-expanded={open&&options.length>0} aria-autocomplete="list" placeholder={market==='US'?'Ticker or name (NASD:AAPL)':'Code or name (005930, 삼성전자)'} value={text}
      onChange={e=>{setText(e.target.value);setOpen(true);setActive(0);const v=e.target.value.trim().toUpperCase();if(market==='KR'?/^\d{6}$/.test(v):/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(v))onChange(v);}}
      onKeyDown={e=>{if(!options.length)return;if(e.key==='ArrowDown'){e.preventDefault();setActive(a=>Math.min(options.length-1,a+1));}else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>Math.max(0,a-1));}else if(e.key==='Enter'){e.preventDefault();choose(options[active]);}else if(e.key==='Escape')setOpen(false);}}
      onBlur={()=>setTimeout(()=>setOpen(false),150)}/>
    {open&&options.length>0&&<ul className="symbol-options" role="listbox">{options.map((s,i)=><li key={s.symbol} role="option" aria-selected={i===active} onMouseDown={e=>{e.preventDefault();choose(s);}}><b>{s.name}</b><small>{s.symbol} · {s.type.toUpperCase()}</small></li>)}</ul>}
  </span>;
}
// The current price for the order symbol, with a shortcut to use it as the limit and the order's estimated value.
export function OrderQuote({symbol,quantity,currency,onUsePrice}:{symbol:string;quantity:number;currency:string;onUsePrice(price:number):void}){
  const [quote,setQuote]=useState<{name:string|null;price:number|null;changePct:number|null}|null>(null);
  useEffect(()=>{let alive=true;setQuote(null);if(!/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol))return;
    window.portfolio?.getResearch(symbol,['overview']).then(p=>{if(!alive)return;const o=p.sections.overview;setQuote({name:p.name,price:o?.status==='ok'?o.data.price:null,changePct:o?.status==='ok'?o.data.changePct:null});}).catch(()=>{});return()=>{alive=false;};},[symbol]);
  if(!quote)return null;
  const fmt=(v:number)=>new Intl.NumberFormat(currency==='USD'?'en-US':'ko-KR',{style:'currency',currency,maximumFractionDigits:currency==='USD'?2:0}).format(v);
  return <p className="order-quote" aria-label="Order quote">{quote.name?<b>{quote.name}</b>:null}{quote.price!=null?<> · {fmt(quote.price)} <span className={(quote.changePct??0)>0?'positive':(quote.changePct??0)<0?'negative':''}>{quote.changePct==null?'':`${quote.changePct>0?'+':''}${quote.changePct.toFixed(2)}%`}</span> · <button type="button" className="link-button" onClick={()=>onUsePrice(quote.price!)}>Use as limit price</button>{quantity>0?<> · about {fmt(quote.price*quantity)} for {quantity} share{quantity===1?'':'s'}</>:null}</>:' · no price right now'}</p>;
}
