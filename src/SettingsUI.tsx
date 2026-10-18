import type {ReactNode} from 'react';
// Settings building blocks: a card of rows, each row a short title, an optional one-line hint and a control on the right.
export function Card({id,title,hint,aside,label,children}:{id?:string;title:string;hint?:ReactNode;aside?:ReactNode;label?:string;children:ReactNode}){
  return <section className="settings-card" id={id} aria-label={label??title}><div className="card-head"><div><h2>{title}</h2>{hint&&<small>{hint}</small>}</div>{aside}</div><div className="setting-rows">{children}</div></section>;
}
export function Row({title,hint,info,children,block=false}:{title:ReactNode;hint?:ReactNode;info?:string;children:ReactNode;block?:boolean}){
  const text=<span className="setting-text"><b>{title}{info&&<span className="info-dot" title={info} aria-label={info}>i</span>}</b>{hint&&<small>{hint}</small>}</span>;
  // A row with several controls is a div; a single-control row is a label so the whole row is clickable.
  return block?<div className="setting-row">{text}<span className="setting-control">{children}</span></div>:<label className="setting-row">{text}<span className="setting-control">{children}</span></label>;
}
export function Switch({label,checked,disabled,onChange}:{label:string;checked:boolean;disabled?:boolean;onChange(value:boolean):void}){
  return <input type="checkbox" role="switch" className="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>;
}
export function NumberField({label,value,min,max,step,unit,disabled,onChange}:{label:string;value:number;min:number;max:number;step?:number;unit?:string;disabled?:boolean;onChange(value:number):void}){
  return <span className="number-field"><input type="number" aria-label={label} min={min} max={max} step={step??1} disabled={disabled} value={value} onChange={e=>onChange(Number(e.target.value))}/>{unit&&<span className="unit">{unit}</span>}</span>;
}
// A daily limit with a "No limit" switch; the number is hidden while unlimited.
export function Limit({label,unlimited,value,min,max,step,unit,disabled,onUnlimited,onValue,offLabel='No limit'}:{label:string;unlimited:boolean;value:number;min:number;max:number;step?:number;unit?:string;disabled?:boolean;onUnlimited(value:boolean):void;onValue(value:number):void;offLabel?:string}){
  return <span className="limit-control">{!unlimited&&<NumberField label={label} value={value} min={min} max={max} step={step} unit={unit} disabled={disabled} onChange={onValue}/>}<label className="mini-switch"><input type="checkbox" role="switch" className="switch small" aria-label={`Unlimited ${label}`} checked={unlimited} disabled={disabled} onChange={e=>onUnlimited(e.target.checked)}/>{offLabel}</label></span>;
}
export function Segmented<T extends string>({label,value,options,disabled,onChange}:{label:string;value:T;options:[T,string][];disabled?:boolean;onChange(value:T):void}){
  return <span className="segmented" role="radiogroup" aria-label={label}>{options.map(([key,text])=><button key={key} type="button" role="radio" aria-checked={value===key} disabled={disabled} className={value===key?'selected':''} onClick={()=>onChange(key)}>{text}</button>)}</span>;
}
