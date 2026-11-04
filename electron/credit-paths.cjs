// Credit trades, typed (audit 2026-11-04, Stage 3). Every order has one position effect: OPEN_LONG (cash or a margin
// loan), CLOSE_LONG (from the cash shares or one margin loan, by its loan date), OPEN_SHORT, or CLOSE_SHORT (one
// short lot, by its loan date). Only an opening effect increases exposure; a closing one is limited to what remains in
// its lot after closing orders already waiting on it, so an order can never turn a long into a short or the reverse.
// Each credit path's broker contract is recorded with its evidence (PATHS, from KIS's official open-trading-api
// examples, read 2026-11-04). A path whose execution fields are not confirmed cannot be submitted, manual approval
// included: approval decides whether to trade, it does not establish what a broker field means. Openings are never
// automatic; protective closes are automatic only on a confirmed path and once the user has approved Stage 3.
const KINDS={none:{Buy:'OPEN_LONG',Sell:'CLOSE_LONG'},'margin-buy':{Buy:'OPEN_LONG'},'margin-sell':{Sell:'CLOSE_LONG'},short:{Sell:'OPEN_SHORT'},cover:{Buy:'CLOSE_SHORT'}};
// The position effect of an order: {effect, funding, kind, opening}. Throws INVALID_ORDER for a side its credit kind
// does not have (a short sale is a Sell, a cover a Buy, and so on).
function effectOf({side,credit=null}){
  const kind=credit==null?'none':typeof credit==='string'?credit:credit.kind;const effect=KINDS[kind]?.[side];if(!effect)throw new Error('INVALID_ORDER');
  return {effect,kind,funding:kind==='margin-buy'||kind==='margin-sell'?'MARGIN':kind==='short'||kind==='cover'?'SHORT':'CASH',opening:effect.startsWith('OPEN_')};
}
// The lots of one symbol in a KIS balance: the cash shares (the holding less its margin loans), each margin loan and
// each short, by loan date, with what KIS says can be ordered of each.
function lots(balance,symbol){
  const h=(balance?.holdings??[]).find(r=>r.symbol===symbol);const loans=h?.loans??[];const loanQty=loans.reduce((n,l)=>n+l.quantity,0);
  const loanAvail=loans.reduce((n,l)=>n+(l.availableQuantity??l.quantity),0);const cashQty=Math.max(0,(h?.quantity??0)-loanQty);
  return {cash:{quantity:cashQty,available:h?Math.max(0,Math.min(cashQty,(h.availableQuantity??h.quantity)-loanAvail)):0},
    margin:loans.map(l=>({loanDate:l.loanDate,quantity:l.quantity,available:l.availableQuantity??l.quantity,source:l.source??null})),
    short:(balance?.shorts??[]).filter(s=>s.symbol===symbol).map(s=>({loanDate:s.loanDate,quantity:s.quantity,available:s.availableQuantity??s.quantity,source:s.source??null}))};
}
const OPEN=['Ready','Submitting','Uncertain','Accepted','Partially filled'];
const lotKey=(kind,loanDate)=>kind==='margin-sell'?'margin|'+loanDate:kind==='cover'?'short|'+loanDate:'cash';
// What a closing order may still take from its lot: the lot's orderable quantity less the unfilled part of closing
// orders already waiting on the same lot (orders: the engine's). Returns {lot, available, reserved} or throws:
// NO_SUCH_LOT (no lot with that loan date) or, from check, EXCEEDS_LOT.
function remaining(balance,{symbol,side,credit=null},orders=[]){
  const {effect,kind}=effectOf({side,credit});if(!effect.startsWith('CLOSE_'))return null;const loanDate=typeof credit==='object'?credit?.loanDate??null:null;
  const all=lots(balance,symbol);const lot=kind==='none'?all.cash:(kind==='margin-sell'?all.margin:all.short).find(l=>l.loanDate===loanDate);if(!lot)throw new Error('NO_SUCH_LOT');
  const key=lotKey(kind,loanDate);// A proposal never sent stops reserving once it has expired.
  const reserved=orders.filter(o=>o.symbol===symbol&&OPEN.includes(o.status)&&!(o.status==='Ready'&&o.expiresAt<Date.now())&&(()=>{try{return effectOf(o).effect.startsWith('CLOSE_');}catch{return false;}})()&&lotKey(o.credit?.kind??'none',o.credit?.loanDate??null)===key).reduce((n,o)=>n+Math.max(0,(o.quantity??0)-(o.filled??0)),0);
  return {lot,available:Math.max(0,lot.available-reserved),reserved};
}
function check(balance,order,orders=[]){const r=remaining(balance,order,orders);if(r&&order.quantity>r.available)throw new Error('EXCEEDS_LOT');return r;}
// The broker contract of each credit path. executable: every field the order sends has a confirmed meaning.
// Stage 4 correction (2026-11-05): a margin repayment was marked executable in Stage 3, but which balance rows are margin
// loans and whether a loan is the broker's own or a distribution loan (CRDT_TYPE 25 or 27) are read from trad_dvsn_name
// text the app matches (융자, 자기), whose values are not confirmed (U5). Every credit path now waits on a field.
// requires: the unresolved items (U1-U5) that block the path.
const PATHS={
  'margin-sell':{executable:false,requires:['U5'],evidence:'order_credit: CRDT_TYPE 25 own / 27 distribution margin repayment; LOAN_DT is the loan date of the stock sold (balance loan_dt)',reason:'which balance rows are margin loans and whether a loan is own or distribution (CRDT_TYPE 25 or 27) come from trad_dvsn_name text whose values are not confirmed (U5)'},
  'margin-buy':{executable:false,requires:['U4','U5'],reason:'a margin position is valued from KIS net assets (nass_amt), and what that figure deducts is not confirmed (U4); the loan rows it creates are recognized by unconfirmed trad_dvsn_name text (U5)'},
  short:{executable:false,requires:['U1','U3','U5'],reason:'the loan date a new short sends (U1), the borrowable quantity (U3, lendable_by_company fields) and how a short row appears in the balance (U5) are not confirmed'},
  cover:{executable:false,requires:['U2','U5'],reason:'how a cover names the short lot it repays (LOAN_DT for CRDT_TYPE 26/28, U2) and how the short row appears in the balance (U5) are not confirmed'},
};
const OPENINGS_LABEL='Automatic credit openings temporarily disabled pending validation.';
const PROTECTION_LABEL='Requires approval—not automatic protection.';
// Whether a credit path can be submitted and whether automatically. approved: the user approved Stage 3.
function pathStatus(kind,{approved=false}={}){
  if(!kind||kind==='none')return {executable:true,automatic:true};const p=PATHS[kind];if(!p)return {executable:false,automatic:false,reason:'unknown credit kind'};
  const opening=kind==='margin-buy'||kind==='short';
  if(!p.executable)return {executable:false,automatic:false,reason:p.reason,label:opening?OPENINGS_LABEL:PROTECTION_LABEL};
  if(opening)return {executable:true,automatic:false,label:OPENINGS_LABEL};
  return {executable:true,automatic:Boolean(approved),...(approved?{}:{label:PROTECTION_LABEL}),...(p.evidence?{evidence:p.evidence}:{})};
}
// The stop a plan needs for its effect: below the price for a long, above it for a short.
function stopSide(effect){return effect==='OPEN_SHORT'?'above':'below';}
module.exports={effectOf,lots,remaining,check,pathStatus,stopSide,PATHS,OPENINGS_LABEL,PROTECTION_LABEL};
