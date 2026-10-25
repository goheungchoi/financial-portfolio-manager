// The acquisition-cost pool of one instrument in one account. The same disposal function serves the recorded ledger
// and hypothetical sale quotes, so a quote and the executed sale use the same basis.
// lot: {quantity, costKRW (null when unknown), costUSD (null when unknown), date, source, expensesIncluded}.
// moving-average (KIS's method): the pool's average cost; first-in-first-out: the oldest lots first. Unknown cost in
// any lot the disposal draws from (all lots for the average) makes the basis unknown.
function dispose(lots,quantity,method){
  if(!['moving-average','fifo'].includes(method))throw new Error('INVALID_METHOD');
  const live=lots.filter(l=>l.quantity>0);const total=live.reduce((n,l)=>n+l.quantity,0);const take=Math.min(quantity,total),outside=quantity-take;
  if(!take)return {taken:0,outside,costKRW:0,costUSD:0,known:true,knownUSD:true,lots:live,used:[]};
  if(method==='moving-average'){
    const knownKRW=live.every(l=>l.costKRW!=null),knownUSD=live.every(l=>l.costUSD!=null);const sumKRW=live.reduce((n,l)=>n+(l.costKRW??0),0),sumUSD=live.reduce((n,l)=>n+(l.costUSD??0),0);const share=take/total;
    const left=total-take;const rest=left?[{quantity:left,costKRW:knownKRW?sumKRW*(1-share):null,costUSD:knownUSD?sumUSD*(1-share):null,date:live[0].date,source:'average of remaining lots',expensesIncluded:live.every(l=>l.expensesIncluded!==false)}]:[];
    return {taken:take,outside,costKRW:knownKRW?sumKRW*share:null,costUSD:knownUSD?sumUSD*share:null,known:knownKRW,knownUSD,lots:rest,used:live.map(l=>({...l,quantity:l.quantity*share}))};
  }
  let left=take,costKRW=0,costUSD=0,known=true,knownUSD=true;const rest=[],used=[];
  for(const l of [...live].sort((a,b)=>String(a.date).localeCompare(String(b.date)))){
    const n=Math.min(left,l.quantity);left-=n;if(n){const f=n/l.quantity;if(l.costKRW==null)known=false;else costKRW+=l.costKRW*f;if(l.costUSD==null)knownUSD=false;else costUSD+=l.costUSD*f;used.push({...l,quantity:n,costKRW:l.costKRW==null?null:l.costKRW*f,costUSD:l.costUSD==null?null:l.costUSD*f});}
    if(l.quantity>n){const f=(l.quantity-n)/l.quantity;rest.push({...l,quantity:l.quantity-n,costKRW:l.costKRW==null?null:l.costKRW*f,costUSD:l.costUSD==null?null:l.costUSD*f});}
  }
  return {taken:take,outside,costKRW:known?costKRW:null,costUSD:knownUSD?costUSD:null,known,knownUSD,lots:rest,used};
}
module.exports={dispose};
