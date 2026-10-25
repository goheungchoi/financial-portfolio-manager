// Statutory Korean tax rules, versioned by effective date, with their sources. Commission plans are separate
// (trading-costs.cjs). Only enacted rules are listed; each change of a rule or source bumps RULE_VERSION.
// Rates are percentages. Retrieved 2026-10-25; see docs/KOREAN-TAX-IMPLEMENTATION-PLAN.md.
const RULE_VERSION='kr-tax-2026-10-25';
const SOURCES={
  'transaction-tax-decree':{title:'Securities Transaction Tax Act Enforcement Decree, Article 5',url:'https://law.go.kr/LSW/lsLinkCommonInfo.do?lspttninfSeq=64014',retrieved:'2026-10-25'},
  'nabo-2026':{title:'National Assembly Budget Office, 2026 taxation reference',url:'https://www.nabo.go.kr/board/file/down.do?fid=33319156',retrieved:'2026-10-25'},
  'nts-stock-tax':{title:'NTS stock capital-gains tax calculation guidance',url:'https://i.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274',retrieved:'2026-10-25'},
  'kis-tax-guide':{title:'KIS overseas-stock capital-gains guide',url:'https://securities.koreainvestment.com/main/bond/research/_static/TF03ca030100.jsp',retrieved:'2026-10-25'},
  'nts-withholding':{title:'NTS withholding rates',url:'https://webtv.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7703&mi=2291',retrieved:'2026-10-25'},
  'etf-tax-guide':{title:'Samsung Asset Management ETF tax guide',url:'https://www.samsungfund.com/etf/insight/guide/view05.do',retrieved:'2026-10-25'},
};
// Sale taxes on ordinary exchange-listed Korean shares by market: securities transaction tax plus rural special tax
// (KOSPI only). They apply to the sale value, including loss-making sales. ETFs and ETNs are exempt (classification).
const KR_SALE_TAX=[
  {from:'2023-01-01',to:'2023-12-31',KOSPI:{transaction:0.05,rural:0.15},KOSDAQ:{transaction:0.20,rural:0},KONEX:{transaction:0.10,rural:0},sources:['transaction-tax-decree']},
  {from:'2024-01-01',to:'2024-12-31',KOSPI:{transaction:0.03,rural:0.15},KOSDAQ:{transaction:0.18,rural:0},KONEX:{transaction:0.10,rural:0},sources:['transaction-tax-decree']},
  {from:'2025-01-01',to:'2025-12-31',KOSPI:{transaction:0,rural:0.15},KOSDAQ:{transaction:0.15,rural:0},KONEX:{transaction:0.10,rural:0},sources:['transaction-tax-decree']},
  {from:'2026-01-01',to:null,KOSPI:{transaction:0.05,rural:0.15},KOSDAQ:{transaction:0.20,rural:0},KONEX:{transaction:0.10,rural:0},sources:['transaction-tax-decree','nabo-2026']},
];
// Capital gains on ordinary foreign-company shares and foreign-listed ETFs: one KRW 2.5m basic deduction per taxpayer
// per year across eligible gains, then 20% national income tax and local income tax of 10% of it (2%).
const OVERSEAS_GAINS=[{from:'2023-01-01',to:null,deductionKRW:2500000,national:20,localOfNational:10,sources:['nts-stock-tax','kis-tax-guide']}];
// Withholding on ordinary dividends and taxable Korean fund distributions: 14% national plus 10% of it local (15.4%).
const WITHHOLDING=[{from:'2023-01-01',to:null,national:14,localOfNational:10,sources:['nts-withholding','etf-tax-guide']}];
const inForce=(table,day)=>table.find(r=>r.from<=day&&(r.to==null||day<=r.to))??null;
// Korean tax amounts drop amounts below 10 won (national treasury and local tax rounding); not yet verified against a
// KIS tax-support statement, so it is reported as an assumption wherever it is used.
const ROUNDING='amounts below 10 won are dropped (not yet verified against a broker statement)';
const truncate10=n=>Math.floor(n/10)*10;
// Sale taxes for a Korean exchange sale of the given value on a day ('YYYY-MM-DD'), or null for an unknown market.
function krSaleTax(market,value,day){
  const rule=inForce(KR_SALE_TAX,day),m=rule?.[market];if(!m)return null;
  const transaction=Math.floor(value*m.transaction/100),rural=Math.floor(value*m.rural/100);
  return {securitiesTransactionTax:transaction,ruralSpecialTax:rural,total:transaction+rural,ratePct:Math.round((m.transaction+m.rural)*1000)/1000,market,ruleFrom:rule.from,sources:rule.sources};
}
// National and local income tax on overseas-share gains for a year's net amount.
function overseasGainsTax(netKRW,year){
  const rule=inForce(OVERSEAS_GAINS,`${year}-12-31`);if(!rule)return null;const taxable=Math.max(0,netKRW-rule.deductionKRW);
  const national=truncate10(taxable*rule.national/100),local=truncate10(national*rule.localOfNational/100);
  return {taxableKRW:taxable,nationalKRW:national,localKRW:local,totalKRW:national+local,deductionKRW:rule.deductionKRW,sources:rule.sources};
}
function withholding(amountKRW,day){const rule=inForce(WITHHOLDING,day);if(!rule)return null;const national=truncate10(amountKRW*rule.national/100),local=truncate10(national*rule.localOfNational/100);return {nationalKRW:national,localKRW:local,totalKRW:national+local,sources:rule.sources};}
// A tax figure with its certainty. status: reconciled (broker-confirmed), estimated (complete inputs, some assumptions),
// incomplete (a required input is missing: the value is null) or unsupported (the case is outside the implemented rules).
function taxResult({status,value=null,knownSubtotal=null,missingInputs=[],assumptions=[],taxYear=null,asOf=Date.now(),sourceIds=[]}){
  if(!['reconciled','estimated','incomplete','unsupported'].includes(status))throw new Error('INVALID_TAX_STATUS');
  return {status,value:status==='incomplete'||status==='unsupported'?null:value,knownSubtotal,missingInputs:[...new Set(missingInputs)],assumptions:[...new Set(assumptions)],ruleVersion:RULE_VERSION,taxYear,asOf:new Date(asOf).toISOString(),sourceIds:[...new Set(sourceIds)]};
}
module.exports={RULE_VERSION,SOURCES,KR_SALE_TAX,OVERSEAS_GAINS,WITHHOLDING,ROUNDING,inForce,krSaleTax,overseasGainsTax,withholding,taxResult,truncate10};
