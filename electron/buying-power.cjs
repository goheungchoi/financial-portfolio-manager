// U.S. buying power, capped at real cash. KIS reports two figures from its buying-power query: foreign currency only
// and integrated (통합증거금, KRW and foreign cash used without conversion). Integrated margin is on when the integrated
// figure is larger. Then KRW cash funds U.S. buys as one pool shared with Korea; without it only USD cash counts.
// The broker figure is never used above what the account's cash supports (mock accounts report virtual funds).
const round2=n=>Math.round(n*100)/100;
// From TTTS3007R/VTTS3007R output: {foreignUSD, integratedUSD, foreignQty, integratedQty, rate}.
function brokerFigures(output){if(!output||typeof output!=='object')return null;const n=v=>{const x=Number(v);return Number.isFinite(x)&&x>=0?x:null;};
  const foreignUSD=n(output.ord_psbl_frcr_amt),integratedUSD=n(output.frcr_ord_psbl_amt1);if(foreignUSD==null)return null;
  return {foreignUSD,integratedUSD,foreignQty:n(output.ord_psbl_qty),integratedQty:n(output.ovrs_max_ord_psbl_qty),rate:n(output.exrt)};}
const integratedOn=broker=>Boolean(broker&&broker.integratedUSD!=null&&broker.integratedUSD>broker.foreignUSD+0.01);
// usdCash: USD deposit; krwCash: settled KRW cash; usdKRW: exchange rate. Returns {usd, integratedMargin, fromKRWUSD, brokerUSD, basis}.
function usBuyingPower({usdCash=0,broker=null,krwCash=null,usdKRW=null}={}){
  const integrated=integratedOn(broker);const rate=usdKRW>0?usdKRW:broker?.rate>0?broker.rate:null;
  const krwAsUSD=integrated&&krwCash>0&&rate?krwCash/rate:0;const real=Math.max(0,usdCash||0)+krwAsUSD;
  const brokerUSD=broker?(integrated?broker.integratedUSD:broker.foreignUSD):null;const usd=brokerUSD==null?Math.max(0,usdCash||0):Math.min(brokerUSD,real);
  const fromKRW=Math.max(0,Math.min(usd-Math.max(0,usdCash||0),krwAsUSD));
  return {usd:round2(usd),integratedMargin:integrated,fromKRWUSD:round2(fromKRW),brokerUSD:brokerUSD==null?null:round2(brokerUSD),
    basis:integrated?'Integrated margin: USD cash plus KRW cash at the current rate, capped at what KIS allows. KRW used here is the same money as Korea cash.':'USD cash only (integrated margin is off); KRW cannot fund U.S. buys.'};
}
module.exports={brokerFigures,integratedOn,usBuyingPower};
