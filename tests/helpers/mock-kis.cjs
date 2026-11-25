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
// Shorts on, stage 2b: Korean credit on a live mock (environment 'live'). Short lots (kr.shorts) are in the balance; the
// lending list per stock (lend[symbol] = {open, tradable}) and the uptick floor (short-rules floorPrice of the price) are
// checked at the preparation as the client does; a cover names its lot and its plan is guarded against other lots
// by the mock's own rule (no date of another lot is sent; not the app's guardPlan). A placed short or cover keeps its kind
// and loan date in history (creditName, loanDate: the date sent); KIS's lot date for a short is lotDateOf(the date sent),
// the same date unless a test says otherwise (the settlement world: the row D, the lot D+2). A cover whose LOAN_DT names
// no lot of the stock is refused, as KIS would; its plan's alternate is tried once, as the client does. A fill of a short
// adds to its lot, of a cover takes from it; with shortLag on, short fills wait for showShorts() (KIS's balance lag).
// Faults: {reject, message, loanDateTried} for a refusal; {alternate:true} for a send accepted on its alternate date;
// 'no-credit' at the preparation (no credit agreement).
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
    this.accounts.KR.shorts=(kr.shorts??[]).map(s=>({source:'distribution',...s}));this.lend={};this.shortLag=false;this.pendingShorts=[];this.lotDateOf=d=>d;
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
    return {source:'kis',environment:this.environment,timestamp:iso(t),raw:{dnca_tot_amt:a.cash,prvs_rcdl_excc_amt:a.settledCash},cash:a.cash,settledCash:a.settledCash,reportedTotal:a.settledCash+holdings.reduce((n,h)=>n+h.marketValue,0),holdings,...(this.environment==='live'?{shorts:this.shortsOf()}:{}),accountKey:this.accountKey};}
  shortsOf(){return this.accounts.KR.shorts.filter(s=>s.quantity>0).map(s=>({symbol:s.symbol,name:s.name??s.symbol,quantity:s.quantity,availableQuantity:s.quantity,price:this.prices[s.symbol]??s.price,entryPrice:s.entryPrice??null,proceeds:s.proceeds??null,loanAmount:s.loanAmount??null,loanDate:s.loanDate,expiry:null,source:s.source}));}
  addShort(symbol,loanDate,q,p){const list=this.accounts.KR.shorts;let lot=list.find(s=>s.symbol===symbol&&s.loanDate===loanDate);if(!lot){lot={symbol,name:symbol,quantity:0,loanDate,source:'distribution',proceeds:0,loanAmount:0,price:p};list.push(lot);}
    lot.quantity+=q;lot.proceeds+=q*p;lot.loanAmount+=q*p;lot.entryPrice=Math.round(lot.proceeds/lot.quantity);return lot;}
  // KIS's balance catches up with the short fills (the 1-3 minutes after a credit fill).
  showShorts(){for(const x of this.pendingShorts.splice(0))this.addShort(x.symbol,x.loanDate,x.q,x.p);return this;}
  quote(market,symbol){const t=this.clock(),price=this.priceOf(market,symbol);
    return market==='US'?{symbol,price,retrievedAt:t,currency:'USD',venue:'regular',timeBasis:'broker snapshot; exchange timestamp unavailable'}:{symbol,price,retrievedAt:t,previousClose:price,changePct:0,volume:1000};}
  // As kis-worker.cjs: the configured symbols, else the holdings, plus the extra ones the app watches (Korea), at most 20.
  context(market,payload){const balance=this.balance(market),symbols=[...new Set([...(payload.symbols?.length?payload.symbols:balance.holdings.map(h=>h.symbol)),...(market==='KR'?payload.extra??[]:[])])].slice(0,20).filter(s=>{try{this.priceOf(market,s);return true;}catch{return false;}});
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
    const balance=this.balance(market);let capacity,availableQuantity,sendPlan=null;
    if(command.credit){if(market!=='KR'||this.environment!=='live')throw err('FEATURE_UNAVAILABLE');const k=command.credit.kind;if(f==='no-credit')throw err('CREDIT_ACCOUNT_REQUIRED');
      if(k==='short'){const l=this.lend[command.symbol]??{open:true,tradable:1e9};if(!l.open)throw err('SHORT_NOT_LENDABLE');if(!(l.tradable>=command.quantity))throw err('SHORT_BORROW_SHORT');
        const floor=require('../../electron/short-rules.cjs').floorPrice(price);if(floor==null||command.limitPrice<floor)throw err('SHORT_BELOW_UPTICK');availableQuantity=l.tradable;capacity={tr:'CTSC2702R',fields:{trad_psbl_qty2:l.tradable}};}
      else if(k==='cover'){const lot=balance.shorts.find(s=>s.symbol===command.symbol&&s.loanDate===command.credit.loanDate);availableQuantity=lot?.availableQuantity;capacity={tr:'balance',fields:{}};if(availableQuantity==null||command.quantity>availableQuantity)throw err('INSUFFICIENT_CAPACITY');
        if(command.credit.send){const LD=require('../../electron/short-loan-date.cjs');const plan=LD.validPlan('cover',command.credit.send);if(!plan)throw err('INVALID_ORDER');const other=d=>d!==command.credit.loanDate&&balance.shorts.some(s=>s.symbol===command.symbol&&s.loanDate===d);
          sendPlan=other(plan.first.date)?{first:{form:'balance',date:command.credit.loanDate},alternate:null}:plan.alternate&&other(plan.alternate.date)?{...plan,alternate:null}:plan;}}
      else throw err('CREDIT_PATH_UNVERIFIED');}
    else if(command.side==='Buy'){const cash=(market==='US'?a.cash:a.settledCash)-(this.netsOpenCash?this.openBuyCash(market):0),q=Math.floor(Math.max(0,cash)/command.limitPrice);
      capacity=market==='US'?{tr:'TTTS3007R',fields:{ord_psbl_frcr_amt:cash,ord_psbl_qty:q}}:{tr:'TTTC8908R',fields:{nrcvb_buy_amt:cash,nrcvb_buy_qty:q}};
      if(command.quantity>q||command.limitPrice*command.quantity*1.02>cash)throw err('INSUFFICIENT_CAPACITY');availableQuantity=q;}
    else{const held=balance.holdings.find(h=>h.symbol===command.symbol);availableQuantity=held?.availableQuantity;capacity={tr:'balance',fields:market==='US'?{ord_psbl_qty:held?.availableQuantity,ovrs_cblc_qty:held?.quantity}:{ord_psbl_qty:held?.availableQuantity,hldg_qty:held?.quantity}};
      if(availableQuantity==null||command.quantity>availableQuantity)throw err('INSUFFICIENT_CAPACITY');}
    const open=openGuard(this.historyRows(market),command,{severalOpen,fail:()=>err('OPEN_BROKER_ORDERS')});
    const ticket=randomUUID();this.tickets.set(ticket,{command:sendPlan?{...command,credit:{...command.credit,send:sendPlan}}:command,...(market==='US'?{market:'US'}:{}),session:null,expiresAt:this.clock()+15000});
    return {balance,price,...(market==='KR'?{unit:1,availableQuantity}:{}),checkedAt:this.clock(),...open,todayOrders:this.historyRows(market).filter(o=>!o.originalOrderId&&(o.kind??'order')==='order').map(o=>({orderId:String(o.orderId),symbol:o.symbol,side:o.side,quantity:Number.isFinite(o.quantity)?o.quantity:null,timestamp:Number.isFinite(o.timestamp)?o.timestamp:null,status:o.status})),capacityRaw:{...capacity,at:this.clock()},ticket,session:null,...(sendPlan?{sendPlan}:{})};}
  newRow(market,{symbol,side,quantity,orderPrice,originalOrderId=null,kind='order',by='app',name,credit=null,loanDate=null,lotDate=null}){const n=++this.seq[market];
    const row={market,orderId:String(n),originalOrderId,kind,symbol,name:name??symbol,side,quantity,filled:0,remaining:kind==='cancel'?0:quantity,orderPrice,amount:0,rejected:0,by,at:this.clock(),day:market==='US'?nyDay(this.clock()):seoulDay(this.clock()),...(credit?{credit,loanDate,lotDate:lotDate??loanDate}:{})};
    this.book[market].push(row);return row;}
  place(market,{ticket},f){const entry=takeTicket(this.tickets,ticket,market,this.clock());const c=entry.command;const a0=this.accounts[market];
    if(f==='not-sent')throw err('ORDER_NOT_SENT',{notSent:true,retryAt:this.clock()+60000});
    if(f==='session-closed'||!this.sessionOpen[market])throw err('SESSION_CLOSED');
    if(f?.reject)throw err('BROKER_REJECTED',{brokerCode:f.reject,...(f.message?{brokerMessage:f.message}:{}),...(f.loanDateTried?{loanDateTried:f.loanDateTried}:{})});
    if(f==='lost-unplaced')throw err('ORDER_UNCERTAIN');
    let sentDate=null,more={},lotDate=null;if(c.credit){const plan=c.credit.send;let sent=f?.alternate&&plan?.alternate?plan.alternate:plan?.first;
      // A cover's LOAN_DT must name a lot of the stock: the first, else the alternate once; neither is a refusal.
      if(c.credit.kind==='cover'&&sent){const isLot=d=>a0.shorts.some(s=>s.symbol===c.symbol&&s.loanDate===d&&s.quantity>0);
        if(!isLot(sent.date)){if(plan.alternate&&isLot(plan.alternate.date)){f={...(typeof f==='object'?f:{}),alternate:true};sent=plan.alternate;}
          else throw err('BROKER_REJECTED',{brokerCode:'APBK9999',brokerMessage:'made-up: no loan with that date',loanDateTried:[{date:plan.first.date,form:plan.first.form,brokerCode:'APBK9999'},...(plan.alternate?[{date:plan.alternate.date,form:plan.alternate.form,brokerCode:'APBK9999'}]:[])]});}}
      sentDate=sent?.date??(c.credit.kind==='short'?seoulDay(this.clock()):c.credit.loanDate);lotDate=c.credit.kind==='short'?this.lotDateOf(sentDate):sentDate;
      if(sent)more={loanDateSent:{date:sent.date,form:sent.form,alternate:Boolean(f?.alternate&&plan.alternate),...(f?.alternate&&plan.alternate?{firstRefusal:{date:plan.first.date,form:plan.first.form,brokerCode:'APBK9999',brokerMessage:'made-up refusal'}}:{})}};}
    const row=this.newRow(market,{symbol:c.symbol,side:c.side,quantity:c.quantity,orderPrice:c.limitPrice,...(c.credit?{credit:c.credit.kind,loanDate:sentDate,lotDate}:{})});
    if(f==='lost')throw err('ORDER_UNCERTAIN');
    // KIS gives the number zero-padded when an order is placed and lists it without the zeros (2026-10-30).
    return market==='US'?{brokerOrderId:row.orderId,acceptedAt:iso(this.clock())}:{brokerOrderId:row.orderId.padStart(10,'0'),organization:'06010',acceptedAt:iso(this.clock()),...more};}
  revise(market,{command},f){if(f==='not-sent')throw err('ORDER_NOT_SENT',{notSent:true,retryAt:this.clock()+60000});if(f?.reject)throw err('BROKER_REJECTED',{brokerCode:f.reject});if(f==='lost-unplaced')throw err('ORDER_UNCERTAIN');
    const from=this.rowOf(market,command.originalOrderId);if(!from||from.remaining<1)throw err('BROKER_REJECTED',{brokerCode:'APBK0000'});
    const left=from.remaining;from.remaining=0;
    const row=this.newRow(market,{symbol:from.symbol,side:from.side,quantity:left,orderPrice:command.cancel?from.orderPrice:command.price,originalOrderId:from.orderId,kind:command.cancel?'cancel':'revision',name:from.name,...(from.credit?{credit:from.credit,loanDate:from.loanDate,lotDate:from.lotDate}:{})});
    if(f==='lost')throw err('ORDER_UNCERTAIN');
    return market==='US'?{brokerOrderId:row.orderId,at:iso(this.clock())}:{brokerOrderId:row.orderId.padStart(10,'0'),organization:'06010',at:iso(this.clock())};}
  // ---- what the test makes happen at KIS
  // Fills qty shares of the order (any number of its chain) on its live link, at its price or the one given.
  fill(market,id,qty=null,price=null){const r=this.tail(market,id);const q=qty??r.remaining;if(q<1||q>r.remaining)throw new Error('mock: bad fill');
    const p=price??r.orderPrice;r.filled+=q;r.remaining-=q;r.amount+=q*p;const a=this.accounts[market];
    if(r.credit==='short'){if(this.shortLag)this.pendingShorts.push({symbol:r.symbol,loanDate:r.lotDate,q,p});else this.addShort(r.symbol,r.lotDate,q,p);return r;}
    if(r.credit==='cover'){const lot=a.shorts.find(s=>s.symbol===r.symbol&&s.loanDate===r.lotDate);if(lot){const share=lot.quantity?q/lot.quantity:1;lot.proceeds-=Math.round((lot.proceeds??0)*share);lot.loanAmount-=Math.round((lot.loanAmount??0)*share);lot.quantity-=q;}return r;}
    let h=a.holdings.find(x=>x.symbol===r.symbol);
    // Korea: the D+2 cash KIS projects moves at the fill. U.S.: cash moves at settlement (settle), as KIS's does.
    if(r.side==='Buy'){if(!h){h={symbol:r.symbol,name:r.name,quantity:0,cost:p,price:p};a.holdings.push(h);}h.cost=(h.cost*h.quantity+p*q)/(h.quantity+q);h.quantity+=q;if(market==='US')r.unsettled=(r.unsettled??0)-q*p;else a.settledCash-=q*p;}
    else{h.quantity-=q;if(market==='US')r.unsettled=(r.unsettled??0)+q*p;else a.settledCash+=q*p;}
    return r;}
  // U.S. settlement of an order's fills not yet settled (any number of its chain; all orders when none is given): cash moves.
  settle(market,id=null){for(const r of id==null?this.book[market]:[this.tail(market,id)]){if(r.unsettled){this.accounts[market].cash=Math.round((this.accounts[market].cash+r.unsettled)*100)/100;r.unsettled=0;}}return this;}
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
    return rows.map(o=>({id:`${o.day.replaceAll('-','')}::${o.orderId}`,orderId:o.orderId,originalOrderId:o.originalOrderId,symbol:o.symbol,name:o.name,timestamp:o.at,side:o.side,quantity:o.quantity,filled:o.filled,remaining:o.remaining,rejected:o.rejected,executionAmount:o.amount,averagePrice:o.filled?Math.round(o.amount/o.filled):0,orderPrice:o.orderPrice,status:this.statusOf(o),...(o.credit?{creditName:o.credit==='short'?'유대신규':'유대상환',loanDate:o.loanDate}:{})})).sort((a,b)=>b.timestamp-a.timestamp||b.orderId.localeCompare(a.orderId));}
  history(market,{startDate,endDate}){const rows=this.historyRows(market,startDate);
    return market==='US'?{orders:rows}:{source:'kis',environment:this.environment,startDate,endDate,retrievedAt:iso(this.clock()),orders:rows};}
  charges(market,{day,orderId}){if(market==='US')throw err('FEATURE_UNAVAILABLE');const r=this.rowOf(market,orderId);if(!r)throw err('INVALID_RESPONSE');
    return {orderId:String(orderId),filled:r.filled,amount:r.amount,charges:Math.round(r.amount*0.00015),retrievedAt:this.clock()};}
}
module.exports={MockKis,seoulDay,nyDay};
