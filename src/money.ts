// Item 8 (artifacts/reviews/2026-11-17-amount-inputs/design-note.md, cleared): amounts of money as the user types them.
// Pure: no React. The plain value is what the fields give back, exactly as today: digits, and for USD a "." with at most
// two decimals ("3000000", "1234.5"); '' for blank. Only the shown text is grouped ("3,000,000").
export type Currency='KRW'|'USD';
// 15 integer digits: below Number.MAX_SAFE_INTEGER, so every plain value is an exact number.
export const MAX_DIGITS=15;
export type Problem='numbers'|'whole'|'decimals'|'large';
export type Parsed={ok:true;plain:string}|{ok:false;problem:Problem};
const places=(c:Currency)=>c==='USD'?2:0;
const bad=(problem:Problem):Parsed=>({ok:false,problem});
function finish(int:string,frac:string|null,c:Currency):Parsed{
  const whole=int.replace(/^0+(?=\d)/,'');if(whole.length>MAX_DIGITS)return bad('large');
  if(frac==null)return {ok:true,plain:whole};
  if(c==='KRW')return bad('whole');if(frac.length>places(c))return bad('decimals');
  return {ok:true,plain:`${whole||'0'}.${frac}`};}
// Text as typed in the field (after an edit): commas and spaces are grouping; only digits and one "." otherwise.
export function parseTyped(text:string,c:Currency):Parsed{
  const s=text.replace(/[,\s]/g,'');if(s==='')return {ok:true,plain:''};
  if(/[^0-9.]/.test(s))return bad('numbers');const parts=s.split('.');if(parts.length>2)return bad('numbers');
  return finish(parts[0],parts.length===2?parts[1]:null,c);}
// Pasted (or IME-composed) text, read on its own: "3,000,000", "₩3,000,000", "3 000 000", "3000000원", "$1,234.50",
// "1,234.50 USD". A zero fraction on KRW ("3,000,000.00") is whole won; trailing zeros past two USD decimals are
// dropped. Anything else is refused, never cut.
export function parsePasted(text:string,c:Currency):Parsed{
  let s=String(text).trim().replace(/^(₩|\$|krw|usd)\s*/i,'').replace(/\s*(원|krw|usd|won)$/i,'').replace(/\s/g,'');
  // F1 (planner): a comma only between thousands. "5,00" or "50,00,000" may be a decimal comma or a mistyped number,
  // so it is refused rather than read as 500 or 5,000,000. A comma after the "." is refused too.
  {const [int,frac='']=s.split('.');if(int.includes(',')&&!/^\d{1,3}(,\d{3})+$/.test(int)||frac.includes(','))return bad('numbers');}
  s=s.replace(/,/g,'');
  if(!/^\d*(\.\d*)?$/.test(s)||!/\d/.test(s))return bad('numbers');
  let [int,frac]=s.split('.') as [string,string|undefined];
  if(frac!=null){const keep=frac.slice(0,places(c));if(/[1-9]/.test(frac.slice(places(c))))return bad(c==='KRW'?'whole':'decimals');frac=c==='KRW'?undefined:keep||undefined;}
  return finish(int,frac??null,c);}
const groupInt=(digits:string)=>digits.replace(/\B(?=(\d{3})+(?!\d))/g,',');
// The shown text of a plain value: the whole part grouped; a "." being typed is kept.
export function group(plain:string,_c?:Currency):string{if(!plain)return '';const [int,frac]=plain.split('.');return groupInt(int||'0')+(frac!=null?'.'+frac:'');}
export const plainOf=(shown:string)=>shown.replace(/[,\s]/g,'');
// Where the caret goes after a regroup: after the same number of digits (and ".") as were left of it.
export const significantBefore=(text:string,caret:number)=>text.slice(0,caret).replace(/[^0-9.]/g,'').length;
export function caretAt(shown:string,significant:number):number{if(significant<=0)return 0;let n=0;
  for(let i=0;i<shown.length;i++)if(/[0-9.]/.test(shown[i])&&++n===significant)return i+1;return shown.length;}
// Backspace or Delete with the caret beside a comma (no selection): the digit on the far side of the comma goes, as in
// banking apps; deleting only the comma would put it straight back. null when it does not apply.
export function deleteAcrossComma(shown:string,caret:number,key:'Backspace'|'Delete'):{text:string;significant:number}|null{
  if(key==='Backspace'&&shown[caret-1]===','&&caret>=2){const text=shown.slice(0,caret-2)+shown.slice(caret-1);return {text,significant:significantBefore(shown,caret-2)};}
  if(key==='Delete'&&shown[caret]===','&&caret+1<shown.length){const text=shown.slice(0,caret+1)+shown.slice(caret+2);return {text,significant:significantBefore(shown,caret)};}
  return null;}
// Korean units: "300만 원", "1,234만 5,678원", "1억 5,000만 원", "1조 2,000억 원". Whole won.
const UNITS:[number,string][]=[[1e12,'조'],[1e8,'억'],[1e4,'만']];
export function koreanReading(amount:number):string{let v=Math.floor(Math.abs(amount));if(v===0)return '0원';const parts:string[]=[];
  for(const [size,name] of UNITS){const q=Math.floor(v/size);if(q){parts.push(groupInt(String(q))+name);v-=q*size;}}
  if(v)parts.push(groupInt(String(v)));return parts.join(' ')+(v?'원':' 원');}
// The line under the field: "₩3,000,000 · 300만 원", "$1,234.50"; '' for blank.
export function readBack(plain:string,c:Currency):string{if(plain===''||plain==null)return '';const [int,frac='']=plain.split('.');
  return c==='USD'?`$${groupInt(int||'0')}.${(frac+'00').slice(0,2)}`:`₩${groupInt(int||'0')} · ${koreanReading(Number(int||'0'))}`;}
// What a refused edit is quoted as: the characters that are not digits, ".", "," or white space; the whole text when
// nothing else is left (e.g. "1.2.3").
export const refusedPart=(raw:string)=>raw.replace(/[0-9.,\s]/g,'')||raw;
// What the line says when an edit or a paste is refused.
export function problemText(problem:Problem,text:string):string{
  return problem==='whole'?'Whole won only':problem==='decimals'?'Two decimals at most':problem==='large'?'Too large':`Couldn’t read “${text.length>24?text.slice(0,24)+'…':text}”: numbers only`;}
// The soft note on a deposit or withdrawal far beyond its account (never blocking).
export const FAR_NOTE='over 10× this account — check the amount';
export const farBeyond=(plain:string,accountValue:number|null|undefined)=>Number.isFinite(accountValue)&&(accountValue as number)>0&&Number(plain)>10*(accountValue as number);
