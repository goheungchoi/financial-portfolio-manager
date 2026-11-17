// Item 8 (artifacts/reviews/2026-11-17-amount-inputs/design-note.md, cleared): the one field for an amount of money.
// Grouped while typing with the caret kept in place; KRW whole won, USD two decimals; a read-back line under it
// ("₩3,000,000 · 300만 원", "$1,234.50") that is the field's description; pastes like "₩3,000,000" or "3000000원" read
// whole, and anything unreadable is refused with the field unchanged. It gives back the plain value ("3000000"), the
// same text or number the field gave before; only what is shown is grouped.
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import * as M from './money';
type Props={label:string;currency:M.Currency;value:string;onChange(plain:string):void;placeholder?:string;disabled?:boolean;
  min?:number;max?:number;unit?:string;commitOnBlur?:boolean;accountValue?:number|null;className?:string;quick?:boolean};
type Step={text:string;caret:number};
export function MoneyField({label,currency,value,onChange,placeholder,disabled,min,max,unit,commitOnBlur=false,accountValue,className,quick=false}:Props){
  const id=useId();const ref=useRef<HTMLInputElement>(null);
  const [shown,setShown]=useState(()=>{const p=M.parseTyped(String(value??''),currency);return p.ok?M.group(p.plain):String(value??'');});
  const [problem,setProblem]=useState<string|null>(null);
  const caret=useRef<number|null>(null),undo=useRef<Step[]>([]),redo=useRef<Step[]>([]),composing=useRef<Step|null>(null);
  const plain=M.plainOf(shown);
  // A value set from outside (cleared after recording, another account's currency) replaces what is shown. A number
  // field gives 0 for a cleared box, as its number input did; that does not put a 0 back while the user retypes.
  useEffect(()=>{const outside=String(value??'');if(outside===plain||outside!==''&&plain!==''&&Number(outside)===Number(plain)||plain===''&&Number(outside)===0&&outside!=='')return;
    const p=M.parseTyped(outside,currency);setShown(p.ok?M.group(p.plain):outside);setProblem(null);},[value]);
  // A change of currency re-reads what is there: an amount the new currency cannot hold says so and gives back ''.
  const first=useRef(true);useEffect(()=>{if(first.current){first.current=false;return;}const p=M.parseTyped(shown,currency);
    if(p.ok){setProblem(null);if(!commitOnBlur)onChange(p.plain);}else{setProblem(M.problemText(p.problem,shown));if(!commitOnBlur)onChange('');}},[currency]);
  useLayoutEffect(()=>{if(caret.current!=null&&ref.current&&document.activeElement===ref.current){ref.current.setSelectionRange(caret.current,caret.current);caret.current=null;}});
  const here=()=>({text:shown,caret:ref.current?.selectionStart??shown.length});
  // Shows a plain value with the caret after `significant` digits, remembers the step for undo, and gives it back.
  const show=(p:string,significant:number,record=true)=>{const next=M.group(p);if(record&&next!==shown){undo.current=[...undo.current.slice(-49),here()];redo.current=[];}
    caret.current=M.caretAt(next,significant);setShown(next);setProblem(null);if(!commitOnBlur)onChange(p);};
  const refuse=(text:string,problem:M.Problem)=>setProblem(M.problemText(problem,text));
  // Text that would result from putting `insert` in place of the selection.
  const spliced=(insert:string)=>{const el=ref.current!;const a=el.selectionStart??shown.length,b=el.selectionEnd??a;return {text:shown.slice(0,a)+insert+shown.slice(b),at:a+insert.length};};
  useEffect(()=>{const el=ref.current;if(!el)return;
    // A typed character is checked before it lands: a refused one never shows.
    const before=(e:InputEvent)=>{if(e.isComposing||composing.current||e.inputType!=='insertText'||e.data==null)return;const {text}=spliced(e.data);const p=M.parseTyped(text,currency);
      if(!p.ok){e.preventDefault();refuse(e.data,p.problem);}};
    el.addEventListener('beforeinput',before);return ()=>el.removeEventListener('beforeinput',before);});
  const changed=(e:React.ChangeEvent<HTMLInputElement>)=>{const raw=e.target.value;if(composing.current){setShown(raw);return;}
    // A refused edit that got past beforeinput (an input method or an inserted text): the line quotes only what was refused.
    const p=M.parseTyped(raw,currency);if(!p.ok){refuse(p.problem==='numbers'?M.refusedPart(raw):raw,p.problem);return;}show(p.plain,M.significantBefore(raw,e.target.selectionStart??raw.length));};
  const pasted=(e:React.ClipboardEvent<HTMLInputElement>)=>{e.preventDefault();const text=e.clipboardData.getData('text');const read=M.parsePasted(text,currency);if(!read.ok){refuse(text,read.problem);return;}
    const {text:combined,at}=spliced(M.group(read.plain));const all=M.parseTyped(combined,currency);if(!all.ok){refuse(text,all.problem);return;}show(all.plain,M.significantBefore(combined,at));};
  const keyed=(e:React.KeyboardEvent<HTMLInputElement>)=>{const el=e.currentTarget;const mod=e.ctrlKey||e.metaKey;
    if(mod&&(e.key==='z'||e.key==='Z'||e.key==='y')){const back=e.key==='z'&&!e.shiftKey;const from=back?undo.current:redo.current,to=back?redo.current:undo.current;e.preventDefault();const step=from.pop();if(!step)return;
      to.push(here());const p=M.parseTyped(step.text,currency);if(!p.ok)return;caret.current=step.caret;setShown(step.text);setProblem(null);if(!commitOnBlur)onChange(p.plain);return;}
    if((e.key==='Backspace'||e.key==='Delete')&&el.selectionStart===el.selectionEnd){const d=M.deleteAcrossComma(shown,el.selectionStart??0,e.key);if(d){e.preventDefault();const p=M.parseTyped(d.text,currency);if(p.ok)show(p.plain,d.significant);}return;}
    if(e.key==='ArrowUp'||e.key==='ArrowDown')e.preventDefault();};
  // A Korean IME: nothing is regrouped while composing; the composed text is then read like a paste ("3000000원").
  const composeEnd=(e:React.CompositionEvent<HTMLInputElement>)=>{const start=composing.current;composing.current=null;const raw=e.currentTarget.value;const read=M.parsePasted(raw,currency);
    if(read.ok)show(read.plain,M.significantBefore(raw,raw.length));else{if(start){setShown(start.text);caret.current=start.caret;}refuse(raw,read.problem);}};
  const number=Number(plain),out=plain!==''&&Number.isFinite(number)&&(min!=null&&number<min||max!=null&&number>max);
  const line=problem??(M.readBack(plain,currency)+(M.farBeyond(plain,accountValue)?` · ${M.FAR_NOTE}`:''));
  return <span className={`money-field-wrap ${className??''}`}><span className={`number-field money-field ${problem||out?'invalid':''}`}>
    <input ref={ref} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} aria-label={label} aria-describedby={id} aria-invalid={Boolean(problem||out)||undefined}
      placeholder={placeholder} disabled={disabled} value={shown} onChange={changed} onPaste={pasted} onKeyDown={keyed}
      onCompositionStart={()=>{composing.current=here();}} onCompositionEnd={composeEnd} onBlur={()=>{if(commitOnBlur&&!problem)onChange(plain);}}/>
    {unit&&<span className="unit">{unit}</span>}</span>
    <small id={id} className={`money-readback ${problem?'field-error':''}`} aria-live="polite">{problem?line:line.split(' · ').map(part=>part.replace(/ /g,'\u00a0')).join(' · ')}</small>
    {out&&<small className="field-error" role="alert">Allowed {min}–{max}{unit?` ${unit}`:''}</small>}
    {/* Item 9 quick buttons (deposits and withdrawals only): each press adds, as one undo step; focus stays on the button. */}
    {quick&&<span className="money-quick" role="group" aria-label={`${label}: quick amounts`}>{M.QUICK[currency].map(add=><button key={add} type="button" className="mini" disabled={disabled} aria-label={M.quickName(add,currency)}
      onClick={()=>{const r=M.addAmount(plain,add,currency);if(!r.ok){refuse(String(add),r.problem);return;}show(r.plain,M.significantBefore(M.group(r.plain),M.group(r.plain).length));}}>{M.quickLabel(add,currency)}</button>)}</span>}</span>;
}
