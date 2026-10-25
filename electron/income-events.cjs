// Dividends, fund distributions and interest: a separate ledger from capital gains. Gross income, foreign withholding,
// Korean national and local withholding and the net amount received are kept apart, so a payment taxed abroad is not
// charged a second blanket 15.4%, and withholding is never mistaken for the final annual liability. Dividend income
// never offsets capital gains or losses, and a dividend is not an external deposit for performance tracking.
const {withholding,taxResult,truncate10}=require('./tax-rules.cjs');
const CATEGORIES=['dividend','fund-distribution','interest'];
const COMPREHENSIVE_THRESHOLD_KRW=20000000;
const num=v=>v===null||v===undefined?null:Number(v);
function validate(v){
  const e=v??{};const ok=x=>x===null||(Number.isFinite(x)&&x>=0&&x<1e13);
  if(!/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}|[A-Z0-9:.-]{1,24})$/.test(e.symbol??'')||!CATEGORIES.includes(e.category)||!/^\d{4}-\d{2}-\d{2}$/.test(e.payDate??'')||!['KRW','USD'].includes(e.currency)||!/^[A-Z]{2}$/.test(e.country??''))throw new Error('INVALID_INCOME_EVENT');
  const f={gross:num(e.gross),foreignWithholding:num(e.foreignWithholding),krNational:num(e.krNational),krLocal:num(e.krLocal),net:num(e.net),fxRate:num(e.fxRate)};
  if(!Object.values(f).every(ok)||f.net==null&&f.gross==null)throw new Error('INVALID_INCOME_EVENT');
  return {symbol:e.symbol,category:e.category,payDate:e.payDate,fiscalYear:Number.isInteger(e.fiscalYear)?e.fiscalYear:null,currency:e.currency,country:e.country,...f,source:['broker','entered','detected-flow'].includes(e.source)?e.source:'entered',specialRegime:'not assessed'};
}
// Expected Korean withholding on a payment: 14% national (10% of it local) on domestic income; on foreign income the
// foreign tax already withheld is credited against the 14%, so a U.S. dividend withheld at the 15% treaty rate owes no
// further Korean withholding. An estimate: the broker's figures replace it.
function expectedWithholding({gross,foreignWithholding=0,country,day}){
  if(gross==null)return null;const base=withholding(gross,day);if(!base)return null;
  if(country==='KR')return {national:base.nationalKRW,local:base.localKRW,total:base.totalKRW,basis:'domestic 14% + local'};
  const national=truncate10(Math.max(0,base.nationalKRW-(foreignWithholding??0))),local=truncate10(national/10);
  return {national,local,total:national+local,basis:'14% less foreign tax withheld, + local'};
}
// Gross minus every withholding should equal the net received; a difference is reported, never forced to agree.
function reconcile(e){
  if(e.gross==null||e.net==null||[e.foreignWithholding,e.krNational,e.krLocal].some(x=>x==null))return {status:'incomplete',differenceKRW:null};
  const diff=e.gross-(e.foreignWithholding+e.krNational+e.krLocal)-e.net;return {status:Math.abs(diff)<=(e.currency==='USD'?0.01:1)?'reconciled':'differs',difference:Math.round(diff*100)/100};
}
class IncomeEvents {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS income_events(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS income_declarations(year INTEGER PRIMARY KEY,payload TEXT NOT NULL)');}
  add(account,value){const e=validate(value);const id=require('node:crypto').randomUUID();const row={id,account,...e,recordedAt:Date.now()};this.db.prepare('INSERT INTO income_events VALUES(?,?,?)').run(id,account,JSON.stringify(row));return row;}
  remove(id){this.db.prepare('DELETE FROM income_events WHERE id=?').run(String(id));}
  list(accounts){return this.db.prepare('SELECT payload FROM income_events').all().map(r=>JSON.parse(r.payload)).filter(e=>!accounts||accounts.has(e.account)).sort((a,b)=>b.payDate.localeCompare(a.payDate));}
  // Financial income received outside these records this year (other brokers, bank interest), declared by the user:
  // null until declared, distinct from the capital-gains outside figure.
  declare(year,externalKRW){if(!Number.isInteger(year)||externalKRW!==null&&(!Number.isFinite(externalKRW)||externalKRW<0||externalKRW>1e13))throw new Error('INVALID_INCOME_EVENT');this.db.prepare('INSERT INTO income_declarations VALUES(?,?) ON CONFLICT(year) DO UPDATE SET payload=excluded.payload').run(year,JSON.stringify({externalKRW}));}
  declared(year){const r=this.db.prepare('SELECT payload FROM income_declarations WHERE year=?').get(year);return r?JSON.parse(r.payload).externalKRW:null;}
  // The year's financial income in KRW. Comprehensive taxation is only flagged (above KRW 20m of interest and dividends
  // a filing review is needed); the final personal liability is not calculated.
  summary(year,accounts,rateOn=()=>null){
    const rows=this.list(accounts).filter(e=>e.payDate.startsWith(String(year)));const missing=[],assumptions=[];
    const krw=(e,v)=>v==null?null:e.currency==='KRW'?v:(e.fxRate??rateOn(e.payDate)?.rate)?Math.round(v*(e.fxRate??rateOn(e.payDate).rate)):null;
    let gross=0,withheld=0,net=0,unknownGross=0;
    for(const e of rows){const g=krw(e,e.gross);if(g==null)unknownGross++;else gross+=g;withheld+=[e.foreignWithholding,e.krNational,e.krLocal].reduce((n,v)=>n+(krw(e,v)??0),0);net+=krw(e,e.net)??0;}
    if(unknownGross)missing.push(`gross amount or exchange rate for ${unknownGross} payment(s)`);const external=this.declared(year);if(external==null)missing.push('interest and dividends received outside these records');
    if(rows.some(e=>e.category==='dividend'))assumptions.push('the 2026 high-dividend separate-tax regime is not applied (eligibility not assessed)');
    const total=missing.length?null:gross+external;const known=gross+(external??0);
    return {year,payments:rows.length,grossKRW:gross,withheldKRW:withheld,netKRW:net,externalKRW:external,totalKRW:total,knownTotalKRW:known,
      comprehensiveReview:known>COMPREHENSIVE_THRESHOLD_KRW?'above KRW 20,000,000: comprehensive taxation applies; a filing review is needed':total==null?'unknown until all income is recorded':'not above KRW 20,000,000',
      result:taxResult({status:missing.length?'incomplete':'estimated',value:withheld,knownSubtotal:withheld,missingInputs:missing,assumptions,taxYear:year,sourceIds:['nts-withholding']}),
      reconciliation:rows.map(e=>({id:e.id,...reconcile(e)}))};
  }
}
// A Korean-listed taxable ETF sale: withholding on the positive lower of the actual trading gain and the increase in
// taxable NAV (과표기준가격), as dividend income. Without the taxable NAVs the withholding is unknown, and the known
// pre-income-tax proceeds are reported instead.
function etfSaleWithholding({gainKRW,quantity,taxableNavBuy=null,taxableNavSell=null,day}){
  if(taxableNavBuy==null||taxableNavSell==null||gainKRW==null)return taxResult({status:'incomplete',missingInputs:['taxable NAV (과표기준가격) at purchase and sale'],sourceIds:['etf-tax-guide']});
  const base=Math.max(0,Math.min(gainKRW,(taxableNavSell-taxableNavBuy)*quantity));const w=withholding(base,day);
  return taxResult({status:'estimated',value:w.totalKRW,assumptions:['no distribution adjustments to the taxable NAV','amounts below 10 won are dropped (not yet verified against a broker statement)'],sourceIds:w.sources});
}
module.exports={IncomeEvents,CATEGORIES,COMPREHENSIVE_THRESHOLD_KRW,expectedWithholding,reconcile,etfSaleWithholding,validate};
