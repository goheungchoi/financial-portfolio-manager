// A bounded, explicit hypothesis test, not a simulation of arbitrary natural-language lessons.
export function replay(candles,{lossPct=10,feePct=0,sellTaxPct=0}={}){
  if(!Number.isFinite(lossPct)||lossPct<=0||lossPct>100||![feePct,sellTaxPct].every(n=>Number.isFinite(n)&&n>=0&&n<=10))throw Error('Invalid scenario');
  if(!Array.isArray(candles)||candles.length<20||candles.some((c,i)=>!Number.isFinite(c.timestamp)||!Number.isFinite(c.open)||!Number.isFinite(c.close)||c.open<=0||c.close<=0||i>0&&c.timestamp<=candles[i-1].timestamp))throw Error('At least 20 chronological completed bars are required');
  const run=(bars,stop)=>{
    const fee=feePct/100,sellCost=(feePct+sellTaxPct)/100;
    const shares=100/(bars[0].open*(1+fee));let cash=0,held=true,pending=false,peak=100,drawdown=0,exit=null;
    for(let i=0;i<bars.length;i++){
      if(pending&&held){cash=shares*bars[i].open*(1-sellCost);held=false;exit=bars[i].timestamp;}
      const equity=held?shares*bars[i].close*(1-sellCost):cash;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,(peak-equity)/peak*100);
      // Observe a completed close, then execute only at the following open.
      if(stop&&held&&bars[i].close/bars[0].open-1<=-lossPct/100)pending=true;
    }
    const end=held?shares*bars.at(-1).close*(1-sellCost):cash;
    return {returnPct:end-100,maxDrawdownPct:drawdown,exit,endingIndex:end};
  };
  const split=Math.floor(candles.length/2);
  return {parameters:{lossPct,feePct,sellTaxPct},barCount:candles.length,segments:[['Earlier sample',candles.slice(0,split)],['Later holdout',candles.slice(split)]].map(([name,bars])=>({name,start:bars[0].timestamp,end:bars.at(-1).timestamp,baseline:run(bars,false),candidate:run(bars,true)}))};
}
