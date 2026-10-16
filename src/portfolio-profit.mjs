/** Unrealized price return only; current FX converts both value and basis. Cash is excluded.
 * @param {{quantity:number,price:number,cost:number,currency:string,valueKRW:number|null,costKRW:number|null}[]} rows
 */
export function portfolioProfit(rows, currency='KRW', loaded=true) {
  if(!loaded)return null;
  let value=0,basis=0;
  for(const row of rows){
    if(row.quantity===0)continue;
    if(!Number.isFinite(row.cost)||row.cost<=0||!Number.isFinite(row.price)||row.price<0)return null;
    const v=currency===row.currency?row.price*row.quantity:row.valueKRW;
    const b=currency===row.currency?row.cost*row.quantity:row.costKRW;
    if(v==null||b==null||!Number.isFinite(v)||!Number.isFinite(b))return null;
    value+=v;basis+=b;
  }
  return {amount:value-basis,percent:basis>0?(value-basis)/basis*100:null};
}
