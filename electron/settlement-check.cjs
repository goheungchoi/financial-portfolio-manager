'use strict';
// D4 (artifacts/reviews/2026-11-12-risk-figures/design.md and its review): a KIS Korean balance reading taken while KIS
// is moving last night's settlement. On 2026-11-12 at 00:04 one reading showed yesterday's buy as a previous-day buy
// while the projected settled cash (D+1 and D+2) still equalled the deposit, so the total (D+2 cash + stocks) was
// ₩137,770 too high; the next reading, 52 minutes later, was right. That reading set the day's peak, the record's high
// and a 52-minute spike in the account graph.
//
// The rule that acts is the narrow state seen (the review's choice): a previous-day buy or sell, no trade today, and
// D+1 and D+2 cash both equal to the deposit. A general relation (D+2 cash = deposit - buys + sells - fees, previous
// day and today) held in 358 of 359 stored readings and failed only on that one; it runs in observe mode: when it
// disagrees and the narrow state does not, one log line with the amount and the fields, nothing else changes.
//
// While a reading is in the narrow state the app holds the last consistent reading of the same account for the account
// value (display, the day's record, reviews, the loss check) and takes no baseline, peak, high, low or graph point from
// it. A reading with a trade today ends the hold at once. With no earlier reading, or after 3 hours, the reading is
// used (marked provisional) but still never for the baseline, peak, high, low or graph. Order checks never read the
// held value: an order is prepared from a fresh balance and KIS's orderable quantity (kis-client.cjs prepareOrder).

const FIELDS=['dnca_tot_amt','nxdy_excc_amt','prvs_rcdl_excc_amt','bfdy_buy_amt','thdt_buy_amt','bfdy_sll_amt','thdt_sll_amt','bfdy_tlex_amt','thdt_tlex_amt','scts_evlu_amt','tot_evlu_amt'];
const CORE=['dnca_tot_amt','nxdy_excc_amt','prvs_rcdl_excc_amt','bfdy_buy_amt','thdt_buy_amt','bfdy_sll_amt','thdt_sll_amt'];
const num=v=>typeof v==='number'&&Number.isFinite(v);
const BOUND_MS=3*3600000;

/**
 * The settlement check of a KIS Korean balance's raw summary fields, or null when the reading is consistent (or the
 * fields needed are missing: then nothing is concluded). overnight: the narrow state (acts). relationOff: the general
 * relation disagrees by more than ₩1 (observed only).
 */
function krCheck(raw){
  if(!raw||typeof raw!=='object'||CORE.some(k=>!num(raw[k])))return null;
  const v=k=>num(raw[k])?raw[k]:0;const deposit=v('dnca_tot_amt');
  const tradeToday=v('thdt_buy_amt')>0||v('thdt_sll_amt')>0,previousTrade=v('bfdy_buy_amt')>0||v('bfdy_sll_amt')>0;
  const overnight=previousTrade&&!tradeToday&&v('nxdy_excc_amt')===deposit&&v('prvs_rcdl_excc_amt')===deposit;
  const expected=deposit-v('bfdy_buy_amt')-v('thdt_buy_amt')+v('bfdy_sll_amt')+v('thdt_sll_amt')-v('bfdy_tlex_amt')-v('thdt_tlex_amt');
  const offBy=Math.round(v('prvs_rcdl_excc_amt')-expected);const relationOff=Math.abs(offBy)>1;
  if(!overnight&&!relationOff)return null;
  return {overnight,relationOff,offBy,fields:Object.fromEntries(FIELDS.filter(k=>num(raw[k])).map(k=>[k,raw[k]]))};
}
const won=n=>'₩'+Math.round(Math.abs(n)).toLocaleString('en-US');

/**
 * Decides which Korean reading the app uses. accept(snapshot) returns {balance, held, provisional, reason}:
 * - held: balance is the last consistent reading (the new one is in the overnight state);
 * - provisional: balance is the new reading, in the overnight state, used because there is no earlier one or the hold
 *   reached its bound; it must not set the baseline, the day's peak, high or low, or a graph point.
 * log(title, body) receives one line per state, not one per reading.
 */
class BalanceHold {
  constructor({log=()=>{},clock=Date.now,boundMs=BOUND_MS}={}){this.log=log;this.clock=clock;this.boundMs=boundMs;this.heldSince=null;this.consistent=null;this.logged=new Set();}
  once(key,title,body){if(this.logged.has(key))return;this.logged.add(key);if(this.logged.size>50)this.logged.delete(this.logged.values().next().value);try{this.log(title,body);}catch{}}
  accept(snapshot){
    const check=snapshot?.settlementCheck??null;
    if(check?.relationOff&&!check.overnight)this.once(`relation|${snapshot.accountKey}|${check.offBy}|${JSON.stringify(check.fields)}`,'KIS balance check (observe only)',
      `Projected settled cash (D+2) differs from the deposit less buys and fees plus sales by ${check.offBy>0?'+':'-'}${won(check.offBy)}; the reading is used as before. Fields: ${JSON.stringify(check.fields)}`);
    if(!check?.overnight){if(this.heldSince!=null&&snapshot?.accountKey)this.once(`end|${this.heldSince}`,'KIS balance reading consistent again','The overnight hold ended; the new reading is used.');
      this.heldSince=null;if(snapshot?.accountKey)this.consistent=snapshot;return {balance:snapshot,held:false,provisional:false,reason:null};}
    const now=this.clock();if(this.heldSince==null)this.heldSince=now;
    const reason=`KIS has not yet netted last night's settlement: projected settled cash equals the deposit while a previous-day ${check.fields.bfdy_buy_amt>0?'buy':'sale'} is listed, ${won(check.offBy)} off`;
    const previous=this.consistent?.accountKey===snapshot.accountKey?this.consistent:null;
    if(previous&&now-this.heldSince<this.boundMs){
      this.once(`hold|${this.heldSince}`,'KIS balance reading held',`${reason}. Using the reading of ${previous.timestamp??'earlier'} until KIS updates it.`);
      return {balance:previous,held:true,provisional:false,reason};}
    this.once(`provisional|${this.heldSince}|${previous?'bound':'none'}`,'KIS balance reading used provisionally',`${reason}. ${previous?'Held for 3 hours; the reading is now shown':'No earlier reading to hold; the reading is shown'}, but the day's baseline, peak, high, low and graph do not take it.`);
    return {balance:snapshot,held:false,provisional:true,reason};
  }
}
module.exports={krCheck,BalanceHold,BOUND_MS};
