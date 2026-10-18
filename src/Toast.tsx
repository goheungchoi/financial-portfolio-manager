import {useEffect,useState} from 'react';
// Short confirmations shown at the bottom of the window, so a save is acknowledged wherever its button is on the page.
type Item={id:number;text:string;tone:'ok'|'error'};
let next=0;
export function toast(text:string,tone:'ok'|'error'='ok'){window.dispatchEvent(new CustomEvent('app-toast',{detail:{id:++next,text,tone}}));}
export function Toaster(){
  const [items,setItems]=useState<Item[]>([]);
  useEffect(()=>{const show=(e:Event)=>{const item=(e as CustomEvent<Item>).detail;setItems(v=>[...v.filter(x=>x.text!==item.text),item].slice(-3));window.setTimeout(()=>setItems(v=>v.filter(x=>x.id!==item.id)),item.tone==='error'?6000:3000);};
    window.addEventListener('app-toast',show);return()=>window.removeEventListener('app-toast',show);},[]);
  return <div className="toaster" role="status" aria-live="polite">{items.map(i=><div key={i.id} className={`toast ${i.tone}`}><span aria-hidden="true">{i.tone==='ok'?'✓':'!'}</span>{i.text}</div>)}</div>;
}
