// The Home line while armed conditional orders are not watched (found in live use: they were taken to stay at KIS). Only
// when conditional orders are on, the account is not the paper one, and they are not watched (auto trading stopped or
// not started); the word follows what they are: "stops" only when every one is a stop loss.
export function unwatchedLine(state){const desk=state?.desk,config=state?.config;if(!desk||desk.monitoringActive!==false||!config?.conditionalOrders||config.scope==='paper')return null;
  const orders=Array.isArray(desk.orders)?desk.orders:[];const n=orders.length;if(!n)return null;const stops=orders.every(o=>o.purpose==='stop_loss');
  const what=stops?(n===1?'stop is':'stops are'):(n===1?'armed conditional order is':'armed conditional orders are');
  return `${n} ${what} not watched until auto trading is started.`;}
