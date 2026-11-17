// M-3 (artifacts/reviews/2026-11-16-multi-order/m3-plan.md): a stateful mock of KIS for tests, answering the engine's
// broker interface, request(operation, payload), in the shapes the KIS worker returns (tests/mock-kis-contract.test.cjs
// checks them against the real clients run on fixture HTTP bodies). One instance holds a Korean and a U.S. account;
// broker('KR') and broker('US') are what main.cjs gives the two engines (the U.S. one under its own operation names).
//
// The test decides every event: fills (full or partial, of any open order, at any time), and one-off faults queued per
// operation (a rejection with a KIS code, a lost reply with the order placed or not, the request limit before the place,
// a closed session, failing history reads). Your own orders in KIS are added with userOrder(). Q1/Q2 knobs: whether the
// orderable cash and orderable quantity KIS reports already net open orders (netsOpenCash, netsOpenQty); tests that
// depend on them run both ways. A restart is a new engine on the same database and this same mock.
//
// It reuses the app's own rules where KIS's are the app's assumption: the open-order guard (broker-open-orders.cjs) and
// the prepared-ticket expiry (order-tickets.cjs), so the two cannot drift.
const {openGuard}=require('../../electron/broker-open-orders.cjs');const {takeTicket}=require('../../electron/order-tickets.cjs');
const {randomUUID}=require('node:crypto');
const iso=t=>new Date(t).toISOString();
const seoulDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(t));
const nyDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t));
const err=(message,extra={})=>Object.assign(new Error(message),extra);
const norm=id=>String(id).replace(/^0+(?=\d)/,'');
class MockKis {
  // kr: {cash, settledCash, holdings:[{symbol,name,quantity,cost,price}]}; us: {cash, holdings, fx}; prices: {symbol: price}.
  constructor({clock=()=>Date.now(),accountKey='acct',environment='mock',kr={},us={},prices={}}={}){
    this.clock=clock;this.accountKey=accountKey;this.environment=environment;this.prices={...prices};
    this.accounts={KR:{cash:kr.cash??10000000,settledCash:kr.settledCash??kr.cash??10000000,holdings:(kr.holdings??[]).map(h=>({...h}))},
      US:{cash:us.cash??10000,holdings:(us.holdings??[]).map(h=>({...h})),fx:us.fx??1340,unsettled:us.unsettled??null}};
    this.book={KR:[],US:[]};this.seq={KR:100,US:500};this.faults={};this.tickets=new Map();this.log=[];
    this.netsOpenCash=false;this.netsOpenQty=false;this.sessionOpen={KR:true,US:true};
  }
  broker(market){return market==='US'?{request:(op,p)=>this.request('US',op==='live-context'?'context':op,p)}:{request:(op,p)=>this.request('KR',op,p)};}
  // A fault for the next call of an operation (place-order, revise-order, orders, prepare-order, live-context), or n calls.
  fault(operation,fault,times=1){(this.faults[operation]??=[]).push(...Array(times).fill(fault));return this;}
  price(symbol,p){this.prices[symbol]=p;return this;}
  priceOf(market,symbol){const p=this.prices[symbol]??this.accounts[market].holdings.find(h=>h.symbol===symbol)?.price;if(!(p>0))throw err('INVALID_INSTRUMENT');return p;}
  async request(market,operation,payload={}){const at=this.clock();this.log.push({at,market,operation,payload});const f=(this.faults[operation]??[]).shift();
    if(f?.fail)throw err(f.fail);
    if(operation==='live-context'||operation==='context')return this.context(market,payload);
    if(operation==='prepare-order')return this.prepare(market,payload,f);
    if(operation==='place-order')return this.place(market,payload,f);
    if(operation==='revise-order')return this.revise(market,payload,f);
    if(operation==='orders')return this.history(market,payload);
    if(operation==='charges')return this.charges(market,payload);
    throw err('UNSUPPORTED_OPERATION');}
  // ---- readings
  balance(market){const a=this.accounts[market],t=this.clock();
    if(market==='US'){const holdings=a.holdings.filter(h=>h.quantity>0).map(h=>({symbol:h.symbol,name:h.name??h.symbol,quantity:h.quantity,cost:h.cost,price:this.prices[h.symbol]??h.price,marketValue:Math.round(h.quantity*(this.prices[h.symbol]??h.price)*100)/100,availableQuantity:this.orderableQty('US',h)}));
      // brokerBuyingPower: KIS's own orderable figures (buying-power.cjs brokerFigures of inquire-psamount); USD only here
      // (integrated margin off), so integratedUSD is null.
      return {environment:this.environment,accountKey:this.accountKey+':US',source:'kis-us',currency:'USD',raw:{usd:{frcr_dncl_amt_2:a.cash},summary:{}},
        brokerBuyingPower:{foreignUSD:a.cash,integratedUSD:null,foreignQty:null,integratedQty:null,rate:a.fx},fx:{usdKRW:a.fx,source:'KIS first published rate',timestamp:t},timestamp:iso(t),cash:a.cash,reportedTotal:Math.round((a.cash+holdings.reduce((n,h)=>n+h.marketValue,0))*100)/100,holdings,...(a.unsettled?{unsettled:{...a.unsettled}}:{})};}
    const holdings=a.holdings.filter(h=>h.quantity>0).map(h=>{const price=this.prices[h.symbol]??h.price;return {symbol:h.symbol,name:h.name??h.symbol,quantity:h.quantity,cost:h.cost,price,marketValue:h.quantity*price,unrealized:h.quantity*(price-h.cost),availableQuantity:this.orderableQty('KR',h)};});
    return {source:'kis',environment:this.environment,timestamp:iso(t),raw:{dnca_tot_amt:a.cash,prvs_rcdl_excc_amt:a.settledCash},cash:a.cash,settledCash:a.settledCash,reportedTotal:a.settledCash+holdings.reduce((n,h)=>n+h.marketValue,0),holdings,accountKey:this.accountKey};}
  quote(market,symbol){const t=this.clock(),price=this.priceOf(market,symbol);
    return market==='US'?{symbol,price,retrievedAt:t,currency:'USD',venue:'regular',timeBasis:'broker snapshot; exchange timestamp unavailable'}:{symbol,price,retrievedAt:t,previousClose:price,changePct:0,volume:1000};}
  context(market,payload){const balance=this.balance(market),symbols=(payload.symbols?.length?payload.symbols:balance.holdings.map(h=>h.symbol)).filter(s=>{try{this.priceOf(market,s);return true;}catch{return false;}});
    const quotes=symbols.map(s=>this.quote(market,s));
    // The U.S. session as the client reads it (usSession), opened or closed by the test.
    return market==='US'?{balance,quotes,warnings:[],marketSession:{...require('../../electron/kis-overseas.cjs').usSession(new Date(this.clock())),open:this.sessionOpen.US,status:this.sessionOpen.US?'open':'closed'}}:{balance,quotes,marketSession:{open:this.sessionOpen.KR,status:this.sessionOpen.KR?'open':'closed'}};}
  // ---- the order book: one row per KIS order number (an order, a revision or a cancellation), as history lists them
  open(market){return this.book[market].filter(o=>o.remaining>0&&o.kind!=='cancel');}
  rowOf(market,id){return this.book[market].find(o=>norm(o.orderId)===norm(id));}
  // The live link of a chain (what a fill applies to): the row nothing else revises or cancels.
  tail(market,id){let r=this.rowOf(market,id);for(;;){const next=this.book[market].find(o=>o.originalOrderId!=null&&norm(o.originalOrderId)===norm(r.orderId));if(!next)return r;r=next;}}
  openBuyCash(market){return this.open(market).filter(o=>o.side==='Buy').reduce((n,o)=>n+o.remaining*o.orderPrice,0);}
  orderableQty(market,h){const sells=this.netsOpenQty?this.open(market).filter(o=>o.side==='Sell'&&o.symbol===h.symbol).reduce((n,o)=>n+o.remaining,0):0;return Math.max(0,h.quantity-sells);}
  prepare(market,{command,severalOpen},f){if(!this.sessionOpen[market]||f==='session-closed')throw err('SESSION_CLOSED');
    const a=this.accounts[market],price=this.priceOf(market,command.symbol);if(Math.abs(command.limitPrice/price-1)>.02)throw err('PRICE_MOVED');
    const balance=this.balance(market);let capacity,availableQuantity;
    if(command.side==='Buy'){const cash=(market==='US'?a.cash:a.settledCash)-(this.netsOpenCash?this.openBuyCash(market):0),q=Math.floor(Math.max(0,cash)/command.limitPrice);
      capacity=market==='US'?{tr:'TTTS3007R',fields:{ord_psbl_frcr_amt:cash,ord_psbl_qty:q}}:{tr:'TTTC8908R',fields:{nrcvb_buy_amt:cash,nrcvb_buy_qty:q}};
      if(command.quantity>q||command.limitPrice*command.quantity*1.02>cash)throw err('INSUFFICIENT_CAPACITY');availableQuantity=q;}
    else{const held=balance.holdings.find(h=>h.symbol===command.symbol);availableQuantity=held?.availableQuantity;capacity={tr:'balance',fields:market==='US'?{ord_psbl_qty:held?.availableQuantity,ovrs_cblc_qty:held?.quantity}:{ord_psbl_qty:held?.availableQuantity,hldg_qty:held?.quantity}};
      if(availableQuantity==null||command.quantity>availableQuantity)throw err('INSUFFICIENT_CAPACITY');}
    const open=openGuard(this.historyRows(market),command,{severalOpen,fail:()=>err('OPEN_BROKER_ORDERS')});
    const ticket=randomUUID();this.tickets.set(ticket,{command,...(market==='US'?{market:'US'}:{}),session:null,expiresAt:this.clock()+15000});
    return {balance,price,...(market==='KR'?{unit:1,availableQuantity}:{}),checkedAt:this.clock(),...open,capacityRaw:{...capacity,at:this.clock()},ticket,session:null};}
  newRow(market,{symbol,side,quantity,orderPrice,originalOrderId=null,kind='order',by='app',name}){const n=++this.seq[market];
    const row={market,orderId:String(n),originalOrderId,kind,symbol,name:name??symbol,side,quantity,filled:0,remaining:kind==='cancel'?0:quantity,orderPrice,amount:0,rejected:0,by,at:this.clock(),day:market==='US'?nyDay(this.clock()):seoulDay(this.clock())};
    this.book[market].push(row);return row;}
  place(market,{ticket},f){const entry=takeTicket(this.tickets,ticket,market,this.clock());const c=entry.command;
    if(f==='not-sent')throw err('ORDER_NOT_SENT',{notSent:true,retryAt:this.clock()+60000});
    if(f==='session-closed'||!this.sessionOpen[market])throw err('SESSION_CLOSED');
    if(f?.reject)throw err('BROKER_REJECTED',{brokerCode:f.reject});
    if(f==='lost-unplaced')throw err('ORDER_UNCERTAIN');
    const row=this.newRow(market,{symbol:c.symbol,side:c.side,quantity:c.quantity,orderPrice:c.limitPrice});
    if(f==='lost')throw err('ORDER_UNCERTAIN');
    // KIS gives the number zero-padded when an order is placed and lists it without the zeros (2026-10-30).
    return market==='US'?{brokerOrderId:row.orderId,acceptedAt:iso(this.clock())}:{brokerOrderId:row.orderId.padStart(10,'0'),organization:'06010',acceptedAt:iso(this.clock())};}
  revise(market,{command},f){if(f==='not-sent')throw err('ORDER_NOT_SENT',{notSent:true,retryAt:this.clock()+60000});if(f?.reject)throw err('BROKER_REJECTED',{brokerCode:f.reject});if(f==='lost-unplaced')throw err('ORDER_UNCERTAIN');
    const from=this.rowOf(market,command.originalOrderId);if(!from||from.remaining<1)throw err('BROKER_REJECTED',{brokerCode:'APBK0000'});
    const left=from.remaining;from.remaining=0;
    const row=this.newRow(market,{symbol:from.symbol,side:from.side,quantity:left,orderPrice:command.cancel?from.orderPrice:command.price,originalOrderId:from.orderId,kind:command.cancel?'cancel':'revision',name:from.name});
    if(f==='lost')throw err('ORDER_UNCERTAIN');
    return market==='US'?{brokerOrderId:row.orderId,at:iso(this.clock())}:{brokerOrderId:row.orderId.padStart(10,'0'),organization:'06010',at:iso(this.clock())};}
  // ---- what the test makes happen at KIS
  // Fills qty shares of the order (any number of its chain) on its live link, at its price or the one given.
  fill(market,id,qty=null,price=null){const r=this.tail(market,id);const q=qty??r.remaining;if(q<1||q>r.remaining)throw new Error('mock: bad fill');
    const p=price??r.orderPrice;r.filled+=q;r.remaining-=q;r.amount+=q*p;const a=this.accounts[market];let h=a.holdings.find(x=>x.symbol===r.symbol);
    if(r.side==='Buy'){if(!h){h={symbol:r.symbol,name:r.name,quantity:0,cost:p,price:p};a.holdings.push(h);}h.cost=(h.cost*h.quantity+p*q)/(h.quantity+q);h.quantity+=q;if(market==='US')a.cash-=q*p;else a.settledCash-=q*p;}
    else{h.quantity-=q;if(market==='US')a.cash+=q*p;else a.settledCash+=q*p;}
    return r;}
  reject(market,id){const r=this.tail(market,id);r.rejected=r.remaining;r.remaining=0;return r;}
  // An order you place yourself in KIS (D3): in history and in the open orders, never the app's.
  userOrder(market,{symbol,side,quantity,orderPrice}){return this.newRow(market,{symbol,side,quantity,orderPrice,by:'user'});}
  // The session ends: KIS drops every open order (its remaining shares are no longer open).
  endSession(market){for(const o of this.open(market))o.remaining=0;}
  // ---- history in the normalized shapes (kis-activity normalizeOrders; kis-overseas orders)
  statusOf(o){if(o.kind==='cancel')return o.filled?'Partially filled / canceled':'Canceled';if(o.rejected)return o.filled?'Partially filled / rejected':'Rejected';
    return o.filled===o.quantity&&o.quantity>0?'Filled':o.filled?'Partially filled':o.remaining?'Pending':'Unfilled';}
  historyRows(market,day=null){const rows=this.book[market].filter(o=>!day||o.day===day);
    if(market==='US')return rows.map(o=>({orderId:o.orderId,originalOrderId:o.originalOrderId,kind:o.kind,symbol:o.symbol,side:o.side,quantity:o.quantity,filled:o.filled,remaining:o.remaining,orderPrice:o.orderPrice,fillPrice:o.filled?Math.round(o.amount/o.filled*100)/100:null,
      status:o.rejected?'Rejected':o.kind==='cancel'?'Canceled':o.filled===o.quantity?'Filled':o.filled?'Partially filled':'Pending'}));
    return rows.map(o=>({id:`${o.day.replaceAll('-','')}::${o.orderId}`,orderId:o.orderId,originalOrderId:o.originalOrderId,symbol:o.symbol,name:o.name,timestamp:o.at,side:o.side,quantity:o.quantity,filled:o.filled,remaining:o.remaining,rejected:o.rejected,executionAmount:o.amount,averagePrice:o.filled?Math.round(o.amount/o.filled):0,orderPrice:o.orderPrice,status:this.statusOf(o)})).sort((a,b)=>b.timestamp-a.timestamp||b.orderId.localeCompare(a.orderId));}
  history(market,{startDate,endDate}){const rows=this.historyRows(market,startDate);
    return market==='US'?{orders:rows}:{source:'kis',environment:this.environment,startDate,endDate,retrievedAt:iso(this.clock()),orders:rows};}
  charges(market,{day,orderId}){if(market==='US')throw err('FEATURE_UNAVAILABLE');const r=this.rowOf(market,orderId);if(!r)throw err('INVALID_RESPONSE');
    return {orderId:String(orderId),filled:r.filled,amount:r.amount,charges:Math.round(r.amount*0.00015),retrievedAt:this.clock()};}
}
module.exports={MockKis,seoulDay,nyDay};
