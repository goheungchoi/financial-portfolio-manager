// Short selling B3f-3 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 3): the confirmation shown when
// short selling is switched on, from the settings being saved. Short, with the rest under More. While the short and
// cover paths cannot be sent (before B4) one line says so; after, the confirmation says whether a short the AI decides is
// sent by itself or proposed, from the value in force. Facts only.
// short: the draft's short section; pathsOpen: both paths executable; automatic: the short path's own automatic.
export function shortConfirmLines(short,{pathsOpen=false,automatic=false}={}){
  const n=Number(short?.maxGrossPctOfEquity),m=Number(short?.stopLossPct),days=Number(short?.maxDays)>0?Number(short.maxDays):90;
  const main=['Turn on short selling? The app may then sell borrowed shares and buy them back later. A short loses when the price rises, and its loss has no limit.',
    `All shorts together stay within ${n}% of the account value. Each gets a stop ${m}% above its sale price, and is bought back before its ${days}-day loan ends.`,
    'While the app is closed, or after Stop everything, a short has no stop: only KIS\'s own forced buy-back protects it.'];
  if(!pathsOpen)main.push('The app cannot send a short yet. That is switched on by a later update, after one real test on your account.');
  else main.push(short?.auto===true&&automatic?'A short the AI decides is sent by itself.':'A short the AI decides is proposed and waits for your approval.');
  const more=['A short sale is priced above the last trade (the uptick rule), so it may not fill while the price is falling.',
    'Short sales go to KRX only, for KOSPI and KOSDAQ stocks; an ETF short is refused for now.',
    'The borrowing cost is an estimate until KIS reports it.',
    'While a short is losing, the app holds the difference back from the cash its own buys may use.',
    'The app cannot see the short-selling ban list or your KIS loan limit, so KIS may still refuse a short.'];
  return {main,more};}
