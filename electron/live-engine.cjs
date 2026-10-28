const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
const {validateLoss,lossStatus}=require('./loss-policy.cjs');
class LiveEngine {
  constructor(db,broker,getConnection,options={}) {
    this.market=options.market??'KR';this.day=this.market==='US'?require('./kis-overseas.cjs').localDate:seoulDate;this.validSymbol=symbol=>this.market==='US'?/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(symbol):/^\d{6}$/.test(symbol);this.validPrice=price=>Number.isFinite(price)&&price>=1&&(this.market==='US'?Math.abs(price*100-Math.round(price*100))<1e-7:Number.isSafeInteger(price));
    this.db=db;this.broker=broker;this.getConnection=getConnection;this.enabled=false;this.autoEnabled=false;this.busy=false;
    db.exec('CREATE TABLE IF NOT EXISTS live_policy(accountKey TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL);');
  }
  identity(){const connection=this.getConnection();if(!connection.snapshot?.accountKey)throw new Error('KIS_NOT_CONNECTED');return connection.snapshot.accountKey;}
  policy(){const key=this.identity();const row=this.db.prepare('SELECT payload FROM live_policy WHERE accountKey=?').get(key);return row?JSON.parse(row.payload):null;}
  orders(){let key;try{key=this.identity();}catch{return [];}return this.db.prepare('SELECT payload FROM live_intents WHERE accountKey=? ORDER BY rowid DESC').all(key).map(row=>JSON.parse(row.payload));}
  save(order){this.db.prepare('INSERT INTO live_intents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(order.id,order.accountKey,JSON.stringify(order));}
  configure(value,confirmation) {
    if(this.busy)throw new Error('KIS_ORDER_BUSY');
    const connection=this.getConnection();const key=this.identity();
    if(confirmation!==(connection.snapshot.environment==='live'?'ENABLE LIVE':'ENABLE MOCK'))throw new Error('ACTIVATION_REQUIRED');
    if(!this.funded(connection.snapshot))throw new Error('NO_FUNDED_BALANCE');
    if(!value || Object.keys(value).some(field=>!['symbols','maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct','maxDailyLossKRW','lossLimit'].includes(field)) || !Array.isArray(value.symbols)||value.symbols.length>20||value.symbols.some(symbol=>typeof symbol!=='string'||!this.validSymbol(symbol)))throw new Error('INVALID_LIMITS');
    const caps=require('./optional-caps.cjs').optionalCaps(value);
    const lossLimit=validateLoss(value.lossLimit??(value.maxDailyLossKRW!=null?{mode:'amount',value:value.maxDailyLossKRW}:{mode:'off',value:0}));
    const existing=this.policy();const baseline=existing?.day===this.day()?existing.baseline:connection.snapshot.reportedTotal;const policy={...value,...caps,anyStock:value.symbols.length===0,lossLimit,maxDailyLossKRW:lossLimit.mode==='off'?null:Math.max(1,Math.round(lossLimit.mode==='percent'?(baseline+this.integratedFunding(connection.snapshot))*lossLimit.value/100:lossLimit.value)),day:this.day(),baseline,dayPeakEquity:existing?.day===this.day()?Math.max(existing.dayPeakEquity??baseline,connection.snapshot.reportedTotal):baseline};
    this.db.prepare('INSERT INTO live_policy VALUES(?,?) ON CONFLICT(accountKey) DO UPDATE SET payload=excluded.payload').run(key,JSON.stringify(policy));this.enabled=true;return this.getState();
  }
  // A U.S. account that holds nothing can still buy with KRW through integrated margin.
  integratedFunding(snapshot){if(this.market!=='US'||!this.buyingPower)return 0;try{return this.buyingPower(snapshot)?.fromKRWUSD||0;}catch{return 0;}}
  funded(snapshot){return (Number.isFinite(snapshot?.reportedTotal)&&snapshot.reportedTotal>0)||this.integratedFunding(snapshot)>0;}
  stop(){this.enabled=false;this.autoEnabled=false;return this.getState();}
  enableAuto(confirmation){const environment=this.getConnection().snapshot?.environment;if(!this.enabled||confirmation!==(environment==='live'?'ENABLE AUTO LIVE':'ENABLE AUTO MOCK'))throw new Error('ACTIVATION_REQUIRED');this.autoEnabled=true;return this.getState();}
  getState(){let policy=null;try{policy=this.policy();}catch{}const connection=this.getConnection().snapshot;const snapshot=this.riskBalance?.accountKey===connection?.accountKey?this.riskBalance:connection;return {httpStatus:this.httpStatus??null,brokerCode:this.brokerCode??null,refreshError:this.refreshError??null,warnings:this.refreshWarnings??[],market:this.market,currency:this.market==='US'?'USD':'KRW',portfolio:this.market==='US'?connection:null,enabled:this.enabled,autoEnabled:this.autoEnabled,busy:this.busy,environment:connection?.environment??null,policy,loss:policy&&snapshot&&policy.day===this.day()?lossStatus(policy.lossLimit??{mode:'amount',value:policy.maxDailyLossKRW},this.adjustedBaseline(policy),snapshot.reportedTotal):null,orders:this.orders().map(({accountKey,...order})=>order),reconcileHealth:this.reconcileHealth??null};}
  observeBalance(snapshot){if(snapshot.accountKey!==this.identity())return;this.annotateBalance?.(snapshot);this.riskBalance=snapshot;const policy=this.policy();if(!policy)return;const today=this.day();const next={...policy,day:today,baseline:policy.day===today?policy.baseline:snapshot.reportedTotal,dayPeakEquity:policy.day===today?Math.max(policy.dayPeakEquity??policy.baseline,snapshot.reportedTotal):snapshot.reportedTotal};this.db.prepare('UPDATE live_policy SET payload=? WHERE accountKey=?').run(JSON.stringify(next),this.identity());}
  async context(supplied=null) {
    const executionEnabled=this.enabled;const configured=this.policy();
    const extra=this.market==='KR'?[...new Set((await this.extraSymbols?.())??[])].filter(symbol=>/^\d{6}$/.test(symbol)&&!(configured?.symbols??[]).includes(symbol)).slice(0,20):[];
    const value=supplied??await this.broker.request('live-context',{...(this.sessionOptions?{sessions:this.sessionOptions()}:{}),symbols:configured?.symbols??[],...(extra.length?{extra}:{})});
    if(value.balance.accountKey!==this.identity())throw new Error('ACCOUNT_CHANGED');
    this.observeBalance(value.balance);
    return {...(this.market==='US'&&this.buyingPower?{buyingPower:this.buyingPower(value.balance)}:{}),...(this.market==='US'?(s=>({unsettledKRW:s.unsettledKRW,...(s.uncertainKRW?{unsettledUncertainKRW:s.uncertainKRW}:{})}))(require('./integrated-settlement.cjs').settlement(value.balance)):{}),environment:'kis',executionEnabled:executionEnabled&&this.enabled,automaticExecutionEnabled:this.autoEnabled,market:this.market,currency:this.market==='US'?'USD':'KRW',marketSession:value.marketSession??{open:false,status:'unverified'},equity:value.balance.reportedTotal,cash:Number.isFinite(value.balance.settledCash)?value.balance.settledCash:value.balance.cash,depositCash:value.balance.cash,positions:Object.fromEntries(value.balance.holdings.map(row=>[row.symbol,{quantity:row.quantity,costTotal:row.cost*row.quantity}])),universe:value.quotes.map(quote=>({symbol:quote.symbol,name:value.balance.holdings.find(row=>row.symbol===quote.symbol)?.name??this.nameOf?.(quote.symbol)??quote.symbol,price:quote.price})),quotes:value.quotes.map(quote=>({...quote,timestamp:quote.retrievedAt,stale:value.marketSession?.open!==true})),orders:this.orders().filter(row=>['Accepted','Uncertain','Submitting','Partially filled'].includes(row.status)).map(({symbol,side,quantity,filled,status,brokerOrderId,createdAt,reconciledAt})=>({symbol,side,quantity,filled,status,orderId:brokerOrderId??null,placedAt:createdAt?new Date(createdAt).toISOString():null,lastConfirmedAt:reconciledAt?new Date(reconciledAt).toISOString():null})),...(this.orderReconciliation()?{orderReconciliation:this.orderReconciliation()}:{}),risk:(policy=>policy?{...policy,baseline:this.adjustedBaseline(policy),...(this.adjustedBaseline(policy)!==policy.baseline?{baselineIncludesFlows:this.adjustedBaseline(policy)-policy.baseline}:{})}:null)(this.policy())??{symbols:[],anyStock:true,maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,baseline:value.balance.reportedTotal,dayPeakEquity:value.balance.reportedTotal,lossLimit:{mode:'off',value:0},readOnly:true},...this.productRisk(value)};
  }
  // First app purchase of a held symbol, for holding-period warnings on daily-reset products.
  firstBought(symbol){const buys=this.orders().filter(o=>o.symbol===symbol&&o.side==='Buy'&&o.filled>0).map(o=>o.createdAt);return buys.length?Math.min(...buys):null;}
  productRisk(value){
    if(!this.exposure)return {};const risk=this.exposure.context(this.identity(),value.quotes.map(q=>({symbol:q.symbol,name:value.balance.holdings.find(h=>h.symbol===q.symbol)?.name})),value.balance.holdings,value.balance.reportedTotal,symbol=>this.firstBought(symbol));
    if(this.market==='KR'){const policy=this.exposure.policy(this.identity()),held=this.exposure.creditRisk(this.identity(),value.balance,this.day());
      if(policy.margin.enabled||policy.short.enabled||held){risk.credit={liveAccountOnly:true,environment:value.balance.environment,margin:{allowed:policy.margin.enabled,automatic:policy.margin.auto,maxLoanPctOfEquity:policy.margin.maxLoanPctOfEquity,annualInterestPct:policy.margin.interestPct},short:{allowed:policy.short.enabled,automatic:policy.short.auto,maxGrossPctOfEquity:policy.short.maxGrossPctOfEquity,stopLossPct:policy.short.stopLossPct,annualFeePct:policy.short.feePct},...(held?{loans:held.margin.loans,estimatedCollateralPct:held.margin.estimatedCollateralPct,shorts:held.short.positions}:{})};if(held)risk.warnings.push(...held.warnings);}}
    return risk.products.length||risk.warnings.length||risk.leveragedEtps.allowed||risk.credit?{productRisk:risk}:{};
  }
  propose(command) {
    // Optional credit: {kind:'margin-buy'|'margin-sell'|'short'|'cover', loanDate} for Korean margin and short orders (live accounts).
    const credit=command?.credit??null;if(command&&'credit' in command){const {credit:_,...rest}=command;command=rest;}
    if(credit!=null&&(this.market!=='KR'||typeof credit!=='object'||Object.keys(credit).some(k=>!['kind','loanDate'].includes(k))||!({'margin-buy':'Buy','margin-sell':'Sell',short:'Sell',cover:'Buy'})[credit.kind]||({'margin-buy':'Buy','margin-sell':'Sell',short:'Sell',cover:'Buy'})[credit.kind]!==command.side))throw new Error('INVALID_ORDER');
    if(credit&&this.getConnection().snapshot?.environment!=='live')throw new Error('FEATURE_UNAVAILABLE');
    if(!command || Object.keys(command).sort().join(',')!=='limitPrice,quantity,side,symbol' || !['Buy','Sell'].includes(command.side)||!Number.isSafeInteger(command.quantity)||command.quantity<1||command.quantity>10000||!this.validPrice(command.limitPrice)||!this.validSymbol(command.symbol))throw new Error('INVALID_ORDER');
    if(!this.enabled)throw new Error('KIS_TRADING_DISABLED');const policy=this.policy();if(!policy?.anyStock&&!policy?.symbols.includes(command.symbol))throw new Error('INSTRUMENT_NOT_ALLOWED');
    const notional=command.quantity*command.limitPrice;if(!Number.isFinite(notional)||policy.maxOrderKRW!=null&&notional>policy.maxOrderKRW)throw new Error('ORDER_SIZE_LIMIT');
    const current=this.getConnection().snapshot;const balance=this.riskBalance?.accountKey===current.accountKey?this.riskBalance:current;const costPerShare=balance.holdings.find(row=>row.symbol===command.symbol)?.cost??null;const costSettings=this.costs?.get();const costEstimate=this.costs?require('./trading-costs.cjs').estimateCosts({market:this.market,side:command.side,quantity:command.quantity,price:command.limitPrice,symbol:command.symbol,costPerShare,settings:costSettings,classification:this.costs.classify?.(command.symbol)??null}):null;
    // Leveraged and inverse products need their own opt-in and cap; without automatic mode they wait for manual approval.
    const gate=this.exposure?this.exposure.check({account:this.identity(),symbol:command.symbol,side:command.side,notional,equity:balance.reportedTotal+this.integratedFunding(balance),holdings:balance.holdings}):null;
    let creditGate=null;if(credit){if(!this.exposure)throw new Error('FEATURE_UNAVAILABLE');creditGate=this.exposure.checkCredit({account:this.identity(),kind:credit.kind,symbol:command.symbol,notional,equity:balance.reportedTotal,balance,loanDate:credit.loanDate??null});}
    const intent={...(gate&&gate.product.kind!=='standard'?{product:gate.product,requiresApproval:gate.requiresApproval}:{}),...(creditGate?{credit:{kind:credit.kind,type:creditGate.type,loanDate:credit.loanDate??null},requiresApproval:creditGate.requiresApproval||Boolean(gate?.requiresApproval)}:{}),market:this.market,currency:this.market==='US'?'USD':'KRW',costPerShare,costSettings,costEstimate,id:randomUUID(),accountKey:this.identity(),source:'kis',environment:this.getConnection().snapshot.environment,...command,status:'Ready',createdAt:Date.now(),expiresAt:Date.now()+120000,day:this.day(),notional,brokerOrderId:null,filled:0,reason:null};this.save(intent);return intent;
  }
  async submit(id,confirmation) {
    if(this.busy)throw new Error('KIS_ORDER_BUSY');this.busy=true;
    try {
      let order=this.orders().find(row=>row.id===id);if(!order)throw new Error('UNKNOWN_ORDER');
      if(order.status!=='Ready')return order;
      const environment=this.getConnection().snapshot.environment;
      if(confirmation!==(environment==='live'?'PLACE LIVE ORDER':'PLACE MOCK ORDER'))throw new Error('APPROVAL_REQUIRED');
      if(!this.enabled||Date.now()>order.expiresAt)throw new Error('DISABLED_OR_EXPIRED');
      if(this.orders().some(row=>['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'].includes(row.status)) || this.db.prepare("SELECT id FROM live_intents WHERE json_extract(payload,'$.status') IN ('Uncertain','Submitting') LIMIT 1").get())throw new Error('RECONCILIATION_REQUIRED');
      let policy=this.policy();if(!policy.anyStock&&!policy.symbols.includes(order.symbol)||policy.maxOrderKRW!=null&&order.notional>policy.maxOrderKRW)throw new Error('LIMIT_CHANGED');
      const turnover=this.orders().filter(row=>row.day===this.day()&&['Submitting','Uncertain','Accepted','Partially filled','Filled','Canceled'].includes(row.status)).reduce((sum,row)=>sum+row.notional,0);
      if(policy.maxDailyTurnoverKRW!=null&&turnover+order.notional>policy.maxDailyTurnoverKRW)throw new Error('DAILY_TURNOVER_LIMIT');
      const prepared=await this.broker.request('prepare-order',{...(this.sessionOptions?{sessions:this.sessionOptions()}:{}),command:{symbol:order.symbol,side:order.side,quantity:order.quantity,limitPrice:order.limitPrice,...(order.credit?{credit:order.credit}:{})}});
      if(prepared.balance.accountKey!==order.accountKey)throw new Error('ACCOUNT_CHANGED');
      // Percentage limits use one base: the account value plus the KRW that funds U.S. buys through integrated margin (the
      // U.S. account alone may hold nothing, which would otherwise block every buy or skip the leveraged-product check).
      const accountBase=prepared.balance.reportedTotal+this.integratedFunding(prepared.balance);
      // Extended sessions: U.S. pre- and after-market orders always wait for your approval, and every extended-session order is
      // capped at a smaller share of equity. Nothing has been sent to KIS yet, so the order simply stays Ready.
      if(prepared.session&&!prepared.session.regular){
        if(prepared.session.approval&&this.submittingAutomatically)throw new Error('EXTENDED_APPROVAL_REQUIRED');
        const pct=this.extendedMaxOrderPct?.()??5;if(order.notional>accountBase*pct/100)throw new Error('EXTENDED_SIZE_LIMIT');
        order={...order,session:prepared.session.id};}
      this.observeBalance(prepared.balance);
      policy=this.policy();
      if(policy.day!==this.day())throw new Error('DAILY_SESSION_SETUP_REQUIRED');
      if(this.exposure)this.exposure.check({account:order.accountKey,symbol:order.symbol,side:order.side,notional:order.notional,equity:accountBase,holdings:prepared.balance.holdings});
      if(order.credit){if(prepared.balance.environment!=='live')throw new Error('FEATURE_UNAVAILABLE');const again=this.exposure.checkCredit({account:order.accountKey,kind:order.credit.kind,symbol:order.symbol,notional:order.notional,equity:prepared.balance.reportedTotal,balance:prepared.balance,loanDate:order.credit.loanDate});if(again.type!==order.credit.type)throw new Error('LIMIT_CHANGED');}
      if(policy.maxCompanyPct!=null&&order.side==='Buy'&&((prepared.balance.holdings.find(row=>row.symbol===order.symbol)?.quantity??0)+order.quantity)*order.limitPrice/accountBase*100>policy.maxCompanyPct)throw new Error('CONCENTRATION_LIMIT');
      if(!this.enabled || Date.now()>order.expiresAt || this.identity()!==order.accountKey)throw new Error('DISABLED_OR_EXPIRED');
      if(this.costs){const costSettings=this.costs.get();const costPerShare=prepared.balance.holdings.find(row=>row.symbol===order.symbol)?.cost??null;order={...order,costSettings,costPerShare,costEstimate:require('./trading-costs.cjs').estimateCosts({market:this.market,side:order.side,quantity:order.quantity,price:order.limitPrice,symbol:order.symbol,costPerShare,settings:costSettings,classification:this.costs.classify?.(order.symbol)??null})};}
      // A margin buy is funded by the loan; the broker's credit capacity was checked when preparing the order.
      // U.S. buys may draw on KRW through integrated margin, capped at real cash (buying-power.cjs).
      const available=this.market==='US'&&this.buyingPower?this.buyingPower(prepared.balance).usd:Math.min(prepared.balance.cash,Number.isFinite(prepared.balance.settledCash)?prepared.balance.settledCash:prepared.balance.cash);
      if(order.side==='Buy'&&order.credit?.kind!=='margin-buy'&&order.costEstimate&&-order.costEstimate.netCash>available)throw new Error('INSUFFICIENT_CAPACITY');
      order={...order,status:'Submitting'};this.save(order);
      try {const result=await this.broker.request('place-order',{ticket:prepared.ticket});order={...order,...result,status:'Accepted'};}
      // SESSION_CLOSED comes from the session re-check before anything is sent to KIS, so the order was not placed.
      catch(error){if(error.message==='SESSION_CLOSED'){order={...order,status:'Rejected',reason:'SESSION_CLOSED'};this.save(order);return order;}order={...order,status:error.message==='BROKER_REJECTED'?'Rejected':'Uncertain',reason:error.message==='BROKER_REJECTED'?'BROKER_REJECTED':'ORDER_UNCERTAIN'};this.enabled=false;}
      this.save(order);return order;
    }finally{this.busy=false;}
  }
  // Whether open orders' statuses were confirmed with KIS, for reviews: null when nothing is open. After failed checks an
  // order listed as open may already be filled, so its exposure is unknown rather than additional.
  // The day's starting value plus that day's deposits less withdrawals, so a deposit neither hides a loss nor a
  // withdrawal looks like one. flowsToday is supplied by the app (performance history) in this market's currency.
  adjustedBaseline(policy){const flows=Number(this.flowsToday?.())||0;return policy.baseline+flows;}
  orderReconciliation(){
    if(!this.orders().some(row=>['Accepted','Uncertain','Submitting','Partially filled'].includes(row.status)))return null;const h=this.reconcileHealth??{failures:0};
    return {status:h.failures?'unconfirmed':'confirmed',lastConfirmedAt:h.lastSuccessAt?new Date(h.lastSuccessAt).toISOString():null,...(h.failures?{failedChecks:h.failures,failingSince:new Date(h.since).toISOString(),error:h.error,
      note:'KIS order history could not be read, so these open-order statuses are not confirmed. An order listed as open may already be filled: compare positions before treating it as additional exposure. New orders in this market, including stop-losses, are blocked until the status is confirmed.'}:{})};
  }
  async reconcile() {
    if(this.busy)throw new Error('KIS_ORDER_BUSY');this.busy=true;
    try {
      const open=this.orders().filter(row=>['Submitting','Uncertain','Accepted','Partially filled'].includes(row.status));
      for(const day of new Set(open.map(row=>row.day))) {
        const report=await this.broker.request('orders',{startDate:day,endDate:day});
        for(const order of open.filter(row=>row.day===day)) {
          const found=order.brokerOrderId?report.orders.find(row=>row.orderId===order.brokerOrderId):null;
          // Korean order history reports the average execution price as averagePrice; U.S. history as fillPrice.
          if(found){const fillPrice=found.fillPrice??(found.averagePrice>0?found.averagePrice:null);const resultCosts=found.filled>0&&fillPrice&&order.costSettings?require('./trading-costs.cjs').estimateCosts({market:this.market,side:order.side,quantity:found.filled,price:fillPrice,symbol:order.symbol,costPerShare:order.costPerShare,settings:order.costSettings,classification:this.costs?.classify?.(order.symbol)??null}):null;this.save({...order,resultCosts,fillPrice,reconciledAt:Date.now(),...((found.status==='Filled'||found.filled>0&&/cancel|reject/i.test(found.status))&&!order.filledObservedAt?{filledObservedAt:Date.now()}:{}),filled:found.filled,status:found.status==='Filled'?'Filled':found.status==='Rejected'?'Rejected':/cancel/i.test(found.status)?'Canceled':found.filled>0?'Partially filled':'Accepted',reason:null});}
        }
      }
      this.reconcileHealth={failures:0,lastSuccessAt:Date.now()};
      return this.getState();
    }catch(error){const h=this.reconcileHealth??{failures:0};this.reconcileHealth={...h,failures:(h.failures??0)+1,since:h.failures?h.since:Date.now(),error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'RECONCILE_FAILED'};throw error;}
    finally{this.busy=false;}
  }
  // Replaces estimated costs of executed orders with broker-reported figures once available, at most every 15 minutes per order.
  // KR: the order inquiry's fee-and-tax amount (live and mock). U.S.: settled trade history (live accounts only), matched by
  // ticker, side and trade date; when other trades of the same kind make the match ambiguous the estimate is kept.
  async refreshCharges(now=Date.now()){
    const {brokerCosts}=require('./trading-costs.cjs');const attempt=(o,status,code=null)=>this.save({...o,reportedCosts:{status,code,attempts:(o.reportedCosts?.attempts??0)+1,lastAttempt:now}});
    const provisional=o=>this.market==='US'&&o.reportedCosts?.status==='reported'&&!(o.reportedCosts.exchangeRate>0);
    const due=this.orders().filter(o=>o.filled>0&&o.fillPrice>0&&o.brokerOrderId&&o.costSettings&&['Filled','Canceled','Rejected'].includes(o.status)&&(!['reported','unavailable','ambiguous'].includes(o.reportedCosts?.status)||provisional(o))&&(o.reportedCosts?.attempts??0)<12&&now-(o.reportedCosts?.lastAttempt??0)>=15*60000&&now-(o.createdAt??now)<10*86400000);
    if(!due.length)return 0;let updated=0;
    if(this.market==='US'){
      const start=due.map(o=>o.day).sort()[0];let trades;
      try{trades=await this.broker.request('charges',{start,end:this.day(now)});}catch(error){for(const o of due)attempt(o,error.message==='FEATURE_UNAVAILABLE'?'unavailable':'pending',error.message);return 0;}
      const near=(a,b)=>Math.abs(Date.parse(a)-Date.parse(b))<=86400000;
      for(const o of due){
        const rows=trades.filter(t=>t.ticker===o.symbol.split(':')[1]&&t.side===o.side&&near(t.tradeDate,o.day));if(!rows.length){attempt(o,'pending','NOT_SETTLED');continue;}
        const peers=this.orders().filter(p=>p.symbol===o.symbol&&p.side===o.side&&near(p.day,o.day)&&p.filled>0),rowQty=rows.reduce((n,r)=>n+r.quantity,0),appQty=peers.reduce((n,p)=>n+p.filled,0);
        if(rowQty!==appQty){attempt(o,'ambiguous','QUANTITY_MISMATCH');continue;}
        // KIS reports zero fees and rate until a trade is final; keep the estimate until it is.
        if(!rows.every(r=>r.exchangeRate>0)){attempt(o,'pending','NOT_FINAL');continue;}
        const share=o.filled/appQty,sum=key=>rows.every(r=>r[key]!=null)?rows.reduce((n,r)=>n+r[key],0)*share:null;
        const reported={status:'reported',source:'KIS settled trade history',feesUSD:Math.round(sum('feesUSD')*100)/100,settlementUSD:sum('settlementUSD')==null?null:Math.round(sum('settlementUSD')*100)/100,settlementKRW:sum('settlementKRW')==null?null:Math.round(sum('settlementKRW')),exchangeRate:rows[0].exchangeRate,settlementDate:rows[0].settlementDate,retrievedAt:now};
        this.save({...o,reportedCosts:reported,resultCosts:brokerCosts({market:'US',side:o.side,quantity:o.filled,price:o.fillPrice,costPerShare:o.costPerShare,symbol:o.symbol,settings:o.costSettings,reported})});updated++;
      }
      return updated;
    }
    for(const o of due){
      try{
        const r=await this.broker.request('charges',{day:o.day,orderId:o.brokerOrderId});if(r.filled!==o.filled){attempt(o,'pending','FILL_MISMATCH');continue;}
        const reported={status:'reported',source:'KIS order inquiry',charges:r.charges,retrievedAt:now};
        this.save({...o,reportedCosts:reported,resultCosts:brokerCosts({market:'KR',side:o.side,quantity:o.filled,price:o.fillPrice,costPerShare:o.costPerShare,symbol:o.symbol,settings:o.costSettings,reported,classification:this.costs?.classify?.(o.symbol)??null})});updated++;
      }catch(error){attempt(o,error.message==='FEATURE_UNAVAILABLE'?'unavailable':'pending',error.message);}
    }
    return updated;
  }
  // Proposals that need approval stay Ready for the user instead of being submitted automatically.
  async autoSubmit(id){if(!this.autoEnabled)throw new Error('AUTO_KIS_DISABLED');const order=this.orders().find(row=>row.id===id);if(order?.requiresApproval)return {...order,reason:'APPROVAL_REQUIRED'};this.submittingAutomatically=true;try{return await this.submit(id,this.getConnection().snapshot.environment==='live'?'PLACE LIVE ORDER':'PLACE MOCK ORDER');}catch(error){if(error.message==='EXTENDED_APPROVAL_REQUIRED')return {...order,reason:'APPROVAL_REQUIRED'};throw error;}finally{this.submittingAutomatically=false;}}
  async linkUncertain(id,brokerOrderId,confirmation) {
    if(confirmation!=='LINK BROKER ORDER')throw new Error('APPROVAL_REQUIRED');const order=this.orders().find(row=>row.id===id);if(!order||!['Uncertain','Submitting'].includes(order.status))throw new Error('UNKNOWN_ORDER');
    const report=await this.broker.request('orders',{startDate:order.day,endDate:order.day});const match=report.orders.find(row=>row.orderId===brokerOrderId);
    if(!match||match.symbol!==order.symbol||match.side!==order.side||match.quantity!==order.quantity||match.orderPrice!==order.limitPrice)throw new Error('BROKER_ORDER_MISMATCH');
    this.save({...order,brokerOrderId:match.orderId,status:'Accepted',reason:null});return this.reconcile();
  }
}
module.exports={LiveEngine};
