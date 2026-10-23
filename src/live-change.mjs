// Whether a new value is a change to show (tick color, delta) or a settling of where the value comes from. basis names
// the value's sources (for example each holding priced from the account balance or from a live quote); when it changes,
// the value moves to the new source silently, so loading never looks like a market move.
export function nextChange(previous,value,basis=''){
  if(previous==null||basis!==previous.basis)return {state:{value,basis},delta:null};
  if(value===previous.value)return {state:previous,delta:0};
  return {state:{value,basis},delta:value-previous.value};
}
// The source basis for the Home totals: which markets are included and how each holding is priced.
export function priceBasis(rows,{krLoaded,withUS}){
  return `${krLoaded?'KR':''}${withUS?'+US':''}|`+rows.map(r=>`${r.symbol}:${r.priceSource??''}`).sort().join(',');
}
