// Short selling B3f-3 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 3): the confirmation shown when
// short selling is switched on, from the settings being saved. Short, with the rest under More. While the short and
// cover paths cannot be sent one line says so; once they can (shorts on), the confirmation says whether a short the AI
// decides is sent by itself or proposed, from the value in force, and what the conditional-order switches make its stop
// and loan-end buy-back now. Facts only.
// short: the draft's short section; pathsOpen: both paths executable; automatic: the short path's own automatic.
// B3f-4: your own buy while a short is open shows KIS's orderable cash from its preparation (KIS may hold cash against
// the short); null: KIS did not give it.
export function orderableCashText(v){return typeof v==='number'&&Number.isFinite(v)?`A short is open: KIS's orderable cash ${new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(v)}`:'A short is open: KIS\'s orderable cash could not be read';}
// Shorts on, stage 3: the stop and the loan-end buy-back are conditional orders; coverStops is what the saved
// conditional-order switches make them now ({armed, whenHit: 'sent'|'proposed'|null}; null: not known).
export function coverStopsWords(c){if(!c)return null;if(!c.armed)return 'Conditional orders are off now, so a short will have no stop and no loan-end buy-back until you turn them on in Engine settings.';
  if(c.whenHit==='not')return 'Conditional orders are on, but they are not watched now, so a stop or buy-back that is hit is neither sent nor proposed until you press Start (or keep them working while auto trading is stopped).';
  return c.whenHit==='sent'?'Conditional orders are on now, and a stop or buy-back that is hit is sent by itself.':'Conditional orders are on now, but a stop or buy-back that is hit is only proposed and waits for your approval.';}
/** @param {any} short @param {{pathsOpen?:boolean,automatic?:boolean,coverStops?:{armed:boolean,whenHit:string|null}|null}} [options] */
export function shortConfirmLines(short,{pathsOpen=false,automatic=false,coverStops=null}={}){
  const n=Number(short?.maxGrossPctOfEquity),m=Number(short?.stopLossPct),days=Number(short?.maxDays)>0?Number(short.maxDays):90;
  const main=['Turn on short selling? The app may then sell borrowed shares and buy them back later. A short loses when the price rises, and its loss has no limit.',
    `All shorts together stay within ${n}% of the account value. Each gets a stop ${m}% above its sale price, and is bought back before its ${days}-day loan ends; both are conditional orders.`,
    ...(pathsOpen&&coverStopsWords(coverStops)?[coverStopsWords(coverStops)]:[]),
    'While the app is closed, or after Stop everything, a short has no stop: only KIS\'s own forced buy-back protects it.'];
  if(!pathsOpen)main.push('The app cannot send a short yet. That is switched on by a later update, after one real test on your account.');
  else main.push(short?.auto===true&&automatic?'A short the AI decides is sent by itself.':'A short the AI decides is proposed and waits for your approval.');
  const more=['A short sale is priced above the last trade (the uptick rule), so it may not fill while the price is falling.',
    'Short sales go to KRX only, for KOSPI and KOSDAQ stocks; an ETF short is refused for now.',
    'The borrowing cost is an estimate until KIS reports it.',
    'While a short is losing, the app holds the difference back from the cash its own buys may use.',
    'The app cannot see the short-selling ban list or your KIS loan limit, so KIS may still refuse a short.',
    ...(pathsOpen?['No short has been sent by this app yet, so the first one is also the first test with KIS. If KIS refuses a buy-back, the app tries the other loan date once, then lists the short on Home. A short can always be bought back in KIS\'s own app.']:[])];
  return {main,more};}
