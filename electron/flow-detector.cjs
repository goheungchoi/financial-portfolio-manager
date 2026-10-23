// Deposits and withdrawals the user did not record, detected from cash changes that reconciled trades do not explain.
// Between two balance observations, each market's cash change minus the cash effect of orders placed and filled in
// between is unexplained. Offsetting KRW and USD amounts are a currency conversion (including integrated-margin
// funding of U.S. buys), not a flow. Detection waits while any order is open, so a fill not yet reconciled is never
// mistaken for a flow. Detected flows count in returns at once and wait for the user to confirm or remove them.
const {seoulDate}=require('./kis-activity.cjs');
const THRESHOLD_KRW=10000;
// Korean cash net of KRW committed to unsettled U.S. buys (electron/integrated-settlement.cjs).
const BASIS='net-of-unsettled';
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
// An order's cash effect in its market currency: the broker's net cash when known, otherwise the gross amount.
function cashEffect(order){
  if(!(order.filled>0)||!(order.fillPrice>0))return 0;const net=order.resultCosts?.netCash;
  if(Number.isFinite(net))return net;const gross=order.filled*order.fillPrice;return order.side==='Sell'?gross:-gross;
}
// Unexplained cash change per market since the previous observation, or null when it cannot be judged now.
function unexplained(prev,now,orders){
  if(orders.some(o=>OPEN.includes(o.status)))return null;
  const recent=orders.filter(o=>o.createdAt>prev.at&&o.createdAt<=now.at);
  const usTraded=recent.some(o=>o.market==='US'&&o.filled>0);
  if(!Number.isFinite(now.krCash)||!Number.isFinite(prev.krCash))return null;
  // Without both U.S. readings a U.S. fill funded from KRW could look like a withdrawal.
  const usKnown=Number.isFinite(now.usCash)&&Number.isFinite(prev.usCash);if(usTraded&&!usKnown)return null;
  const explained=market=>recent.filter(o=>(o.market??'KR')===market).reduce((sum,o)=>sum+cashEffect(o),0);
  return {KR:now.krCash-prev.krCash-explained('KR'),US:usKnown?now.usCash-prev.usCash-explained('US'):0};
}
// Which flows an unexplained change amounts to: none below the threshold. KRW and USD changes that offset each other
// are money moving between the two markets (integrated-margin funding of a U.S. buy, a currency exchange): recorded as
// a transfer pair so each market's own returns stay right; transfers do not count in the combined account.
function flowsFrom(u,fx){
  const usKRW=fx>0?u.US*fx:null;const big=v=>Math.abs(v)>=THRESHOLD_KRW;
  if(usKRW!=null&&!big(u.KR+usKRW))return big(u.KR)&&big(usKRW)?[{market:'KR',amount:Math.round(u.KR),transfer:true},{market:'US',amount:Math.round(u.US*100)/100,transfer:true}]:[];
  const out=[];if(big(u.KR))out.push({market:'KR',amount:Math.round(u.KR)});
  if(usKRW!=null?big(usKRW):Math.abs(u.US)>=10)out.push({market:'US',amount:Math.round(u.US*100)/100});
  return out;
}
class FlowDetector {
  constructor(db,performance,clock=Date.now){this.db=db;this.performance=performance;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS flow_watch(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  // Records and returns the flows found since the last observation; the observation advances only when it was judged.
  observe(account,{krCash,usCash=null,fx=null,orders=[]}){
    if(typeof account!=='string'||!account||!Number.isFinite(krCash))return [];
    const now={at:this.clock(),krCash,usCash:Number.isFinite(usCash)?usCash:null,basis:BASIS};
    const row=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);const prev=row?JSON.parse(row.payload):null;
    const save=()=>this.db.prepare('INSERT INTO flow_watch VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(now));
    // Readings taken before KRW committed to unsettled U.S. buys was netted out are a different basis: start again.
    if(!prev||prev.basis!==BASIS){save();return [];}
    const u=unexplained(prev,now,orders);if(!u)return [];
    const found=flowsFrom(u,fx);save();const day=seoulDate(now.at);
    return found.map(f=>this.performance.addFlow(account,f.transfer?{day,market:f.market,amount:f.amount,transfer:true,
      note:`Transfer between markets: ${f.amount<0?'out of':'into'} the ${f.market==='US'?'U.S.':'Korean'} account (integrated-margin funding or currency exchange).`}:{day,market:f.market,amount:f.amount,detected:true,
      note:`Detected: ${f.market==='US'?'U.S.':'Korean'} cash ${f.amount>0?'rose':'fell'} with no matching trade. Confirm or remove.`}));
  }
}
module.exports={FlowDetector,unexplained,flowsFrom,cashEffect,THRESHOLD_KRW};
