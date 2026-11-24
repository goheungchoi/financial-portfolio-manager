'use strict';
// Short selling, shorts on (planner handoff 2026-11-25): the loan date a short sale and a cover send (order-credit LOAN_DT),
// with at most one alternate attempt when KIS refuses the first, and the form KIS accepts learned with care.
// - A new short (CRDT_TYPE 22/24): 'trade-day' (today) or 'settlement' (T+2 Korean business days, what KIS's own app
//   recorded in the hand test). First the form in use (short-rules SHORT_LOAN_DATE_RULE until learned otherwise).
// - A cover (CRDT_TYPE 26/28): 'balance', the lot's loan date as KIS's own balance reports it (loan_dt; the cover always
//   names a lot read from the balance), or 'trade-day', two Korean business days before it (the lot's trade day when the
//   balance date is the settlement day). First the form in use ('balance' until learned otherwise).
// When a date is not sent (stage 1b and 1c reviews):
// - a cover date other than the lot's own balance date, first or alternate, that is the loan date of another short lot of
//   the same stock in the balance read at the preparation, or any such date when the short rows cannot be read: the
//   worker sends the lot's own balance date first and nothing else (guardPlan);
// - the alternate after a refusal the app can name as not about the date (notAboutDate). For a cover only what cannot be
//   the date: no rt_cd, a gateway code, no credit agreement, the session. For a short also quantities, amounts, limits,
//   the lending pool, a halt or the price;
// - the alternate when the app's Korean calendar could not be read, or when the engine gave no plan.
// Never more than one alternate per order.
const R=require('./short-rules.cjs');const {isBusinessDay}=require('./business-days.cjs');
const FORMS={short:['trade-day','settlement'],cover:['balance','trade-day']};
const DEFAULT_FORMS={short:R.SHORT_LOAN_DATE_RULE,cover:'balance'};
const DATE=/^\d{4}-\d{2}-\d{2}$/;
// A real calendar date (2026-02-30, 2026-13-45 and 2026-10-32 are not); never throws.
const realDate=d=>{if(typeof d!=='string'||!DATE.test(d))return false;const t=Date.parse(d+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===d;};
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// n Korean business days before (n>0) or after (n<0) day. isOpen(day): true or false when known, else weekdays.
function businessDaysBefore(day,n,isOpen=null){if(!realDate(day))throw new Error('INVALID_DATE');const step=n>=0?-1:1;let d=day,k=0;while(k<Math.abs(n)){d=shift(d,step);if(isBusinessDay('KR',d,{krOpen:isOpen}))k++;}return d;}
// A date and its counterpart in the other form: two Korean business days before and after (trade day and settlement day).
function counterparts(day,isOpen=null){if(!realDate(day))return [];return [day,businessDaysBefore(day,2,isOpen),businessDaysBefore(day,-2,isOpen)];}
const other=(kind,form)=>FORMS[kind].find(f=>f!==form);
// The dates to send for one order: {first:{form,date}, alternate:{form,date}|null}. today: the Seoul trade day; loanDate:
// the cover's lot (from the balance); forms: the forms in use; alternate:false gives no alternate (calendar unreadable).
// Null for a credit kind without a loan-date choice.
function candidates(kind,{today,loanDate=null,forms=DEFAULT_FORMS,isOpen=null,alternate=true}={}){
  if(!['short','cover'].includes(kind))return null;
  const f=FORMS[kind].includes(forms?.[kind])?forms[kind]:DEFAULT_FORMS[kind],o=other(kind,f);
  const date=kind==='short'?form=>R.shortLoanDate(today,form,isOpen):form=>{if(!realDate(loanDate))throw new Error('INVALID_DATE');return form==='balance'?loanDate:businessDaysBefore(loanDate,2,isOpen);};
  const first={form:f,date:date(f)};if(!alternate)return {first,alternate:null};const alt={form:o,date:date(o)};return {first,alternate:alt.date!==first.date?alt:null};}
// A send plan as the worker receives it, checked and copied: two different real dates of the kind's forms (or one), or
// null when it is not one. Extra keys are dropped. Never throws.
function validPlan(kind,plan){const ok=x=>x&&typeof x==='object'&&FORMS[kind]?.includes(x.form)&&realDate(x.date);if(!plan||typeof plan!=='object'||!ok(plan.first))return null;
  if(plan.alternate!=null&&(!ok(plan.alternate)||plan.alternate.form===plan.first.form||plan.alternate.date===plan.first.date))return null;
  return {first:{form:plan.first.form,date:plan.first.date},alternate:plan.alternate?{form:plan.alternate.form,date:plan.alternate.date}:null};}
// A cover's plan against the balance read at the preparation (stage 1c): any date other than the lot's own balance date,
// first or alternate, that is another short lot's loan date of the same stock, or any such date when the short rows cannot
// be read, is not sent: the lot's own balance date is sent first and nothing else. Returns {plan, dropped}.
function guardPlan(plan,{symbol,loanDate,balance}){if(!plan)return {plan,dropped:null};const dates=[plan.first,plan.alternate].filter(Boolean).filter(x=>x.date!==loanDate);if(!dates.length)return {plan,dropped:null};
  const shorts=balance?.shorts,only={first:{form:'balance',date:loanDate},alternate:null};
  if(!Array.isArray(shorts))return {plan:plan.first.date===loanDate?{...plan,alternate:null}:only,dropped:'the balance\'s short rows could not be read'};
  const clash=dates.find(x=>shorts.some(s=>s?.symbol===symbol&&s.loanDate!==loanDate&&s.loanDate===x.date));if(!clash)return {plan,dropped:null};
  return {plan:plan.first.date===loanDate?{...plan,alternate:null}:only,dropped:`${clash.date} is another short lot of ${symbol}`};}
// Alias kept for the stage 1b name.
const dropAlternate=guardPlan;
// A refusal the app can name as not about the loan date: the reason in words, or null (possibly the date: the alternate
// is sent). body: KIS's reply; kind: 'short' or 'cover'. For a cover, balance, quantity and repayable words are how a
// wrong date is likely worded (no lot with that date), so only what cannot be the date counts.
const SESSION=/장\s*운영|장\s*종료|장\s*마감|장\s*시작|운영\s*시간|시간\s*외|휴장/;
const SHORT_ONLY=/신용\s*계좌|신용\s*약정|약정이\s*없|대주\s*가능|대여\s*가능|주문\s*가능|가능\s*수량|수량(?!\s*단위)|금액|잔고|한도|증거금|거래\s*정지|매매\s*정지|가격|호가|단가|상한|하한|공매도\s*(금지|제한)/;
const DATE_WORD=/대출\s*일|대주\s*일|대여\s*일|대차\s*일|일자|날짜|LOAN_DT/i;
function notAboutDate(body,kind='short'){if(!body||typeof body!=='object'||body.rt_cd==null||body.rt_cd==='')return 'KIS gave no result code';const code=String(body.msg_cd??'');
  if(/^EGW/.test(code))return 'a KIS gateway refusal';if(code==='APBK1617')return 'the account has no KIS credit agreement';
  const words=String(body.msg1??'');if(DATE_WORD.test(words))return null;if(SESSION.test(words))return 'KIS named the session';
  if(kind!=='cover'&&SHORT_ONLY.test(words))return 'KIS named another reason';return null;}
// One attempt as the order keeps it: date, form, KIS's code and words, or unclear (the reply could not be read).
function attempt(x){if(!x||typeof x!=='object'||!realDate(x.date))return null;const form=Object.values(FORMS).flat().includes(x.form)?x.form:null;
  return {date:x.date,...(form?{form}:{}),...(/^[A-Z0-9_-]{1,24}$/.test(x.brokerCode??'')?{brokerCode:x.brokerCode}:{}),...(typeof x.brokerMessage==='string'&&x.brokerMessage?{brokerMessage:x.brokerMessage.slice(0,120)}:{}),...(x.unclear===true?{unclear:true}:{}),...(x.notSent===true?{notSent:true}:{})};}
// The two-attempt record as it crosses the worker and the service: at most two attempts, checked; null otherwise.
function tried(list){if(!Array.isArray(list)||!list.length||list.length>2)return null;const out=list.map(attempt);return out.every(Boolean)?out:null;}
// The forms in use (one row; KIS's API is the same for every account), learned with care so one accident is not kept:
// - an alternate accepted with the default form puts the default back at once (a learned form refused, the default
//   taken: dropped);
// - an alternate accepted with the other form counts once; it becomes the form in use only when KIS takes it on the
//   alternate again, on a different order, within PENDING_MS (10 days) of the first; an older count lapses;
// - a first-attempt acceptance of the form in use clears that count (the default accepted first after one accident:
//   nothing is kept).
const PENDING_MS=10*86400000;
class LoanDateForms{
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS short_loan_forms(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');}
  read(){try{const r=this.db.prepare('SELECT payload FROM short_loan_forms WHERE id=1').get();const v=r?JSON.parse(r.payload):{};return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}}
  write(v){this.db.prepare('INSERT INTO short_loan_forms VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(v));}
  get(){const v=this.read();return {short:FORMS.short.includes(v.short)?v.short:DEFAULT_FORMS.short,cover:FORMS.cover.includes(v.cover)?v.cover:DEFAULT_FORMS.cover};}
  // KIS accepted form for kind, on the first attempt or on the alternate, for the order orderId. Returns {changed, form (in
  // use after), count}.
  accepted(kind,form,{alternate,orderId=null}){if(!FORMS[kind]?.includes(form))return {changed:false,form:this.get()[kind],count:0};const v=this.read(),now=this.get()[kind],key=kind+'Pending';const drop=()=>{const {[key]:_,...rest}=v;return rest;};
    if(!alternate){if(form===now&&v[key])this.write(drop());return {changed:false,form:now,count:0};}
    if(form===now)return {changed:false,form:now,count:0};
    if(form===DEFAULT_FORMS[kind]){this.write({...drop(),[kind]:form,[kind+'LearnedAt']:this.clock()});return {changed:true,form,count:0};}
    // The count read strictly: a whole number, this form, not lapsed, another order.
    const p=v[key],live=p&&typeof p==='object'&&p.form===form&&Number.isInteger(p.count)&&p.count>=1&&Number.isFinite(p.at)&&this.clock()-p.at<=PENDING_MS;
    if(live&&orderId!=null&&p.orderId===orderId)return {changed:false,form:now,count:p.count};
    const count=(live?p.count:0)+1;
    if(count>=2){this.write({...drop(),[kind]:form,[kind+'LearnedAt']:this.clock()});return {changed:true,form,count};}
    this.write({...v,[key]:{form,count,at:this.clock(),...(orderId!=null?{orderId:String(orderId).slice(0,64)}:{})}});return {changed:false,form:now,count};}
}
const FORM_WORDS={'trade-day':'the trade day','settlement':'the settlement day (T+2)','balance':'the loan date in KIS\'s balance'};
module.exports={FORMS,DEFAULT_FORMS,FORM_WORDS,PENDING_MS,realDate,businessDaysBefore,counterparts,candidates,validPlan,guardPlan,dropAlternate,notAboutDate,attempt,tried,LoanDateForms};
