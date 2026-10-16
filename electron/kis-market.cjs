function buildKisMarket(state,quotes,now=Date.now()) {
  const colors=['#66d9c0','#8ca5ff','#f3ba70','#e39acb','#b9c98b'];
  const normalized=state.snapshot.holdings.map(row=>{
    const quote=quotes.get(row.symbol);
    const timestamp=quote?.source==='stream'?quote.timestamp:quote?.retrievedAt;
    return {symbol:row.symbol,price:quote?.price ?? row.price,timestamp,timeBasis:quote?.source==='stream'?'exchange':'retrieval',stale:!quote || now-(quote.source==='stream'?quote.receivedAt:quote.retrievedAt)>60000 || now-timestamp>60000};
  });
  const holdings=state.snapshot.holdings.map((row,index)=>({symbol:row.symbol,name:row.name,quantity:row.quantity,cost:row.cost,price:normalized[index].price,sector:'Unknown',color:colors[index%colors.length]}));
  return {source:'kis',environment:state.snapshot.environment,status:state.status==='error'?'error':normalized.some(q=>q.stale)?'stale':'connected',paused:false,error:state.error,accountTimestamp:state.snapshot.timestamp,quotes:normalized,snapshot:{cash:state.snapshot.cash,holdings,reportedTotal:state.snapshot.reportedTotal}};
}
module.exports={buildKisMarket};
