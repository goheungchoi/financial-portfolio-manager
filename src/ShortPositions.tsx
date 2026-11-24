// Short selling B3f-2 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 2): the "Short positions"
// section, directly below the holdings on the Holdings tab and on Home's holdings card. A short is not a holding: it
// joins neither the holdings rows, their portfolio share nor the Allocation chart. One row per lot. With no short the
// section is absent and both screens are as before.
import {shortStopText,shortResultClass,shortLoanText} from './short-positions.mjs';
export type ShortPosition={symbol:string;name:string|null;quantity:number;entryPrice:number|null;price:number|null;result:number|null;loanDate:string|null;lastDay:string|null;businessDaysLeft:number|null;pastLastDay:boolean;byHand:boolean;stop:{state:'armed';level:number|null;notApps?:boolean}|{state:'waiting';why:string}|{state:'none';cause:string}|null};
const won=(v:number|null)=>v==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(v);
const signed=(v:number|null)=>v==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',maximumFractionDigits:0,signDisplay:'exceptZero'}).format(v);
export function ShortPositions({rows,compact=false}:{rows?:ShortPosition[];compact?:boolean}){
  if(!rows?.length)return null;
  // Home: part of the holdings card (a subheading under the list, no box of its own); each short on two lines.
  if(compact)return <div className="home-shorts" role="group" aria-label="Short positions"><h3 className="home-shorts-title">Short positions</h3>
    <ul className="compact-rows home-shorts-list">{rows.map(r=><li key={r.symbol+'|'+r.loanDate}><div className="short-line"><span className="row-text">{r.name??r.symbol}{r.byHand&&<small className="muted"> · opened in the KIS app</small>}</span><span className="num">{r.quantity} at {won(r.entryPrice)}</span><span className={`num ${shortResultClass(r.result)}`}>{signed(r.result)}</span></div><small className="muted short-detail">{shortStopText(r,won)} · last buy-back day {shortLoanText(r)}, the app's count</small></li>)}</ul></div>;
  return <section aria-label="Short positions"><div className="section-head"><h2>Short positions</h2><small>Result so far: the sale's proceeds less buying back now. Business days left are the app's count.</small></div>
    <table><thead><tr><th>Stock</th><th className="num">Quantity</th><th className="num">Sale price</th><th className="num">Price now</th><th className="num">Result so far</th><th>Loan date</th><th title="The app's count of business days to the last day a buy-back can be made">Last buy-back day</th><th>Stop</th></tr></thead>
      <tbody>{rows.map(r=><tr key={r.symbol+'|'+r.loanDate}><td>{r.name??r.symbol} <small>{r.symbol}</small>{r.byHand&&<small> · opened in the KIS app</small>}</td><td className="num">{r.quantity}</td><td className="num">{won(r.entryPrice)}</td><td className="num">{won(r.price)}</td><td className={`num ${shortResultClass(r.result)}`}>{signed(r.result)}</td><td>{r.loanDate??'—'}</td><td>{shortLoanText(r)}</td><td>{shortStopText(r,won)}</td></tr>)}</tbody></table></section>;
}
