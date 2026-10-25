// How an instrument is taxed, kept as two separate questions: the sale (transaction) tax and the income tax on gains.
// An ETF's transaction-tax exemption says nothing about income tax: domestic-equity ETFs and Korean-listed overseas,
// bond or commodity ETFs differ, and the security master does not tell them apart, so their income tax stays unknown.
// row: the security-master row {market, type} or null.
// transactionTax: taxable | exempt | unknown; incomeTax: minority-listed-exempt | overseas-capital-gains |
// domestic-equity-fund-exempt | taxable-fund-dividend | unknown.
// fund: the user's classification of a Korean ETF {class: 'domestic-equity'|'taxable', source}, or null.
function classify(symbol,row,fund=null){
  const s=String(symbol??'');
  if(/^\d{6}$/.test(s)||/^[0-9][0-9A-Z]{5}$/.test(s)){
    if(!row)return {instrument:'unknown',market:null,transactionTax:'unknown',incomeTax:'unknown',why:'not in the security master'};
    const market=['KOSPI','KOSDAQ','KONEX'].includes(row.market)?row.market:null;
    if(row.type==='stock')return {instrument:'kr-listed-share',market,transactionTax:market?'taxable':'unknown',incomeTax:'minority-listed-exempt',why:'Korean exchange-listed share'};
    if(row.type==='etf'){
      if(fund?.class==='domestic-equity')return {instrument:'kr-etf',market,transactionTax:'exempt',incomeTax:'domestic-equity-fund-exempt',why:'domestic-equity ETF: sale gains not taxed (distributions are)',assumption:'domestic-equity ETF (classified by you)'};
      if(fund?.class==='taxable')return {instrument:'kr-etf',market,transactionTax:'exempt',incomeTax:'taxable-fund-dividend',why:'taxable ETF: 15.4% withholding as dividend income on the lower of the trading gain and the taxable-NAV increase',assumption:'taxable ETF (classified by you)'};
      return {instrument:'kr-etf',market,transactionTax:'exempt',incomeTax:'unknown',why:'Korean-listed ETF: sale-gain taxation depends on the fund (domestic equity or taxable) and its taxable NAV'};}
    if(row.type==='etn')return {instrument:'kr-etn',market,transactionTax:'exempt',incomeTax:'unknown',why:'Korean-listed ETN: issuer-specific rules not implemented'};
    return {instrument:'kr-other',market,transactionTax:'unknown',incomeTax:'unknown',why:`Korean ${row.type}: rules not implemented`};
  }
  if(/^(NASD|NYSE|AMEX):/.test(s)){
    if(!row)return {instrument:'foreign-share',market:'US',transactionTax:'exempt',incomeTax:'overseas-capital-gains',why:'U.S.-listed; not in the security master, assumed an ordinary share',assumption:'ordinary foreign-company share (not in the security master)'};
    if(row.type==='stock')return {instrument:'foreign-share',market:'US',transactionTax:'exempt',incomeTax:'overseas-capital-gains',why:'ordinary foreign-company share'};
    if(row.type==='etf')return {instrument:'foreign-etf',market:'US',transactionTax:'exempt',incomeTax:'overseas-capital-gains',why:'foreign-listed ETF'};
    return {instrument:'foreign-other',market:'US',transactionTax:'exempt',incomeTax:'unknown',why:`U.S.-listed ${row.type}: rules not implemented`};
  }
  return {instrument:'unknown',market:null,transactionTax:'unknown',incomeTax:'unknown',why:'unrecognized symbol'};
}
module.exports={classify};
