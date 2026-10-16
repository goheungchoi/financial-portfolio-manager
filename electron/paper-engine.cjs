const {randomUUID}=require('node:crypto');
const {seoulDate}=require('./kis-activity.cjs');
const POLICY={maxOrderKRW:1000000,maxDailyTurnoverKRW:5000000,maxConcentrationBps:4000,maxDailyLossKRW:500000,feeBps:10,slippageBps:10,toleranceBps:50,quoteMaxAgeMs:5000,proposalLifetimeMs:30000,orderLifetimeMs:60000,fillChunk:2};
const fee=amount=>Math.ceil(amount*POLICY.feeBps/10000);
const pending=order=>['Pending','Partially filled'].includes(order.status);
const {validateLoss,lossStatus}=require('./loss-policy.cjs');
class PaperEngine {
  constructor(db,universe,getQuotes,clock=Date.now) {
    this.db=db;this.universe=universe.map(({symbol,name,price})=>({symbol,name,price}));this.getQuotes=getQuotes;this.clock=clock;
    db.exec(`CREATE TABLE IF NOT EXISTS paper_account(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_loss_policy(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_caps(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_proposals(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_orders(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_fills(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);`);
    if(!db.prepare('SELECT id FROM paper_account WHERE id=1').get())this.saveAccount({version:1,cash:10000000,initialCash:10000000,positions:{},realized:0,paused:true,day:seoulDate(clock()),dailyTurnover:0,dayBaseline:10000000});
    this.atomic(()=>{const account=this.account();account.paused=true;account.version++;this.saveAccount(account);for(const order of this.orders().filter(pending))this.saveOrder({...order,status:'Canceled',reason:'Restart recovery'});});
  }
  atomic(fn) {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  account(){return JSON.parse(this.db.prepare('SELECT payload FROM paper_account WHERE id=1').get().payload);}
  lossPolicy(){const row=this.db.prepare('SELECT payload FROM paper_loss_policy WHERE id=1').get();return row?JSON.parse(row.payload):{mode:'off',value:0};}
  caps(){const row=this.db.prepare('SELECT payload FROM paper_caps WHERE id=1').get();return row?JSON.parse(row.payload):require('./optional-caps.cjs').optionalCaps();}
  configureCaps(value){if(!value||Object.keys(value).some(key=>!['maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct'].includes(key)))throw new Error('INVALID_LIMITS');const caps=require('./optional-caps.cjs').optionalCaps(value);this.atomic(()=>{this.db.prepare('INSERT INTO paper_caps VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(caps));const account=this.account();account.version++;this.saveAccount(account);});return this.getState();}
  configureLoss(value){const policy=validateLoss(value);this.atomic(()=>{this.db.prepare('INSERT INTO paper_loss_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(policy));const account=this.account();account.version++;this.saveAccount(account);});this.tick();return this.getState();}
  saveAccount(account){this.db.prepare('INSERT INTO paper_account VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(account));}
  orders(){return this.db.prepare('SELECT payload FROM paper_orders ORDER BY rowid').all().map(row=>JSON.parse(row.payload));}
  saveOrder(order){this.db.prepare('INSERT INTO paper_orders VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(order.id,JSON.stringify(order));}
  saveProposal(proposal){this.db.prepare('INSERT INTO paper_proposals VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(proposal.id,JSON.stringify(proposal));}
  quotes(){return new Map(this.getQuotes().filter(quote=>this.universe.some(row=>row.symbol===quote.symbol)&&Number.isSafeInteger(quote.price)&&quote.price>0&&Number.isSafeInteger(quote.sequence)&&Number.isFinite(quote.timestamp)).map(quote=>[quote.symbol,quote]));}
  equity(account,quotes){return account.cash+Object.entries(account.positions).reduce((sum,[symbol,position])=>sum+position.quantity*(quotes.get(symbol)?.price??position.markPrice),0);}
  rollDay(account,quotes) {const day=seoulDate(this.clock());if(account.day!==day){account.day=day;account.dailyTurnover=0;account.dayBaseline=this.equity(account,quotes);account.dayPeakEquity=account.dayBaseline;account.version++;}}
  reservations(orders=this.orders()) {
    let cash=0,turnover=0;const shares={};const buys={};
    for(const order of orders.filter(pending)) {
      const remaining=order.quantity-order.filled;turnover+=remaining*order.capPrice;
      if(order.side==='Buy'){cash+=remaining*(order.capPrice+fee(order.capPrice));buys[order.symbol]=(buys[order.symbol]??0)+remaining;}
      else shares[order.symbol]=(shares[order.symbol]??0)+remaining;
    }
    return {cash,turnover,shares,buys};
  }
  check(command,account,quotes,capPrice,excludeId) {
    if(account.paused)return 'PAPER_PAUSED';
    if(!this.universe.some(row=>row.symbol===command.symbol))return 'INSTRUMENT_NOT_ALLOWED';
    if(!['Buy','Sell'].includes(command.side)||!Number.isSafeInteger(command.quantity)||command.quantity<1||command.quantity>1000)return 'INVALID_QUANTITY_OR_SIDE';
    const quote=quotes.get(command.symbol);const now=this.clock();
    if(!quote || quote.stale || !Number.isSafeInteger(quote.price)||quote.price<=0 || !Number.isFinite(quote.timestamp) || now-quote.timestamp>POLICY.quoteMaxAgeMs || quote.timestamp>now+1000)return 'STALE_QUOTE';
    if(Object.keys(account.positions).some(symbol=>{const q=quotes.get(symbol);return !q || q.stale || now-q.timestamp>POLICY.quoteMaxAgeMs;}))return 'STALE_PORTFOLIO_QUOTES';
    const equity=this.equity(account,quotes);
    const executionPrice=command.side==='Buy'?Math.ceil(quote.price*(10000+POLICY.slippageBps)/10000):Math.floor(quote.price*(10000-POLICY.slippageBps)/10000);
    if(command.side==='Buy' && executionPrice>capPrice || command.side==='Sell' && executionPrice<capPrice)return 'PRICE_MOVED';
    const notional=command.quantity*(command.side==='Buy'?capPrice:quote.price);
    const caps=this.caps();if(!Number.isSafeInteger(notional)||caps.maxOrderKRW!=null&&notional>caps.maxOrderKRW)return 'ORDER_SIZE_LIMIT';
    const reserved=this.reservations(this.orders().filter(order=>order.id!==excludeId));
    if(caps.maxDailyTurnoverKRW!=null&&account.dailyTurnover+reserved.turnover+notional>caps.maxDailyTurnoverKRW)return 'DAILY_TURNOVER_LIMIT';
    if(command.side==='Buy') {
      if(command.quantity*(capPrice+fee(capPrice))>account.cash-reserved.cash)return 'INSUFFICIENT_CASH';
      const exposure=((account.positions[command.symbol]?.quantity??0)+(reserved.buys[command.symbol]??0)+command.quantity)*capPrice;
      if(caps.maxCompanyPct!=null&&exposure*100>Math.max(0,equity-command.quantity*fee(capPrice))*caps.maxCompanyPct)return 'CONCENTRATION_LIMIT';
    } else if(command.quantity>(account.positions[command.symbol]?.quantity??0)-(reserved.shares[command.symbol]??0))return 'INSUFFICIENT_SHARES';
    return null;
  }
  propose(command) {
    if(!command || typeof command!=='object' || Object.keys(command).some(key=>!['symbol','side','quantity'].includes(key)) || typeof command.symbol!=='string' || command.symbol.length>20 || !['Buy','Sell'].includes(command.side) || !Number.isSafeInteger(command.quantity) || command.quantity<1 || command.quantity>1000)throw new Error('INVALID_REQUEST');
    return this.atomic(()=>{
      const account=this.account(),quotes=this.quotes();this.rollDay(account,quotes);this.saveAccount(account);
      const quote=quotes.get(command.symbol);
      const capPrice=Number.isSafeInteger(quote?.price)?command.side==='Buy'?Math.ceil(quote.price*(10000+POLICY.toleranceBps)/10000):Math.floor(quote.price*(10000-POLICY.toleranceBps)/10000):0;
      const reason=this.check(command,account,quotes,capPrice);
      const proposal={id:randomUUID(),symbol:typeof command.symbol==='string'?command.symbol.slice(0,20):'',side:command.side,quantity:command.quantity,version:account.version,createdAt:this.clock(),expiresAt:this.clock()+POLICY.proposalLifetimeMs,capPrice,quotePrice:quote?.price??0,status:reason?'Rejected':'Ready',reason};
      this.saveProposal(proposal);return proposal;
    });
  }
  submit(id) {
    return this.atomic(()=>{
      const row=this.db.prepare('SELECT payload FROM paper_proposals WHERE id=?').get(id);
      if(!row)throw new Error('UNKNOWN_PROPOSAL');
      const proposal=JSON.parse(row.payload);
      if(proposal.orderId)return this.orders().find(order=>order.id===proposal.orderId);
      const account=this.account(),quotes=this.quotes();this.rollDay(account,quotes);
      const reason=proposal.status!=='Ready'?'PROPOSAL_NOT_READY':this.clock()>proposal.expiresAt?'PROPOSAL_EXPIRED':proposal.version!==account.version?'PORTFOLIO_CHANGED':this.check(proposal,account,quotes,proposal.capPrice);
      if(reason){proposal.status='Rejected';proposal.reason=reason;this.saveProposal(proposal);this.saveAccount(account);return {status:'Rejected',reason};}
      const order={id:randomUUID(),proposalId:id,symbol:proposal.symbol,side:proposal.side,quantity:proposal.quantity,capPrice:proposal.capPrice,filled:0,status:'Pending',createdAt:this.clock(),expiresAt:this.clock()+POLICY.orderLifetimeMs,reason:null,lastSequence:null};
      account.version++;this.saveAccount(account);this.saveOrder(order);this.saveProposal({...proposal,status:'Submitted',orderId:order.id});return order;
    });
  }
  setPaused(paused) {
    if(typeof paused!=='boolean')throw new Error('INVALID_REQUEST');
    this.atomic(()=>{const account=this.account();account.paused=paused;account.version++;this.saveAccount(account);if(paused)for(const order of this.orders().filter(pending))this.saveOrder({...order,status:'Canceled',reason:'Paper kill switch'});});
    return this.getState();
  }
  cancel(id) {
    this.atomic(()=>{const order=this.orders().find(order=>order.id===id);if(!order)throw new Error('UNKNOWN_ORDER');if(!pending(order))return;this.saveOrder({...order,status:'Canceled',reason:'User cancellation'});const account=this.account();account.version++;this.saveAccount(account);});return this.getState();
  }
  tick() {
    this.atomic(()=>{
      const account=this.account(),quotes=this.quotes();this.rollDay(account,quotes);account.dayPeakEquity=Math.max(account.dayPeakEquity??account.dayBaseline,this.equity(account,quotes));
      for(const order of this.orders().filter(pending)) {
        if(account.paused || this.clock()>order.expiresAt){this.saveOrder({...order,status:'Canceled',reason:account.paused?'Paper paused':'Order expired'});account.version++;continue;}
        const quote=quotes.get(order.symbol);
        if(!quote || order.lastSequence===quote.sequence)continue;
        const remaining=order.quantity-order.filled;
        const reason=this.check({...order,quantity:remaining},account,quotes,order.capPrice,order.id);
        if(reason){this.saveOrder({...order,status:'Risk stopped',reason});account.version++;continue;}
        const quantity=Math.min(POLICY.fillChunk,remaining,Number.isSafeInteger(quote.volume)?quote.volume:0);if(quantity<1)continue;
        const price=order.side==='Buy'?Math.ceil(quote.price*(10000+POLICY.slippageBps)/10000):Math.floor(quote.price*(10000-POLICY.slippageBps)/10000);
        const gross=price*quantity,cost=fee(gross);let realized=0;
        const position=account.positions[order.symbol]??{quantity:0,costTotal:0,markPrice:price};
        if(order.side==='Buy'){account.cash-=gross+cost;position.quantity+=quantity;position.costTotal+=gross+cost;position.markPrice=price;account.positions[order.symbol]=position;}
        else {
          const basis=quantity===position.quantity?position.costTotal:Number(BigInt(position.costTotal)*BigInt(quantity)/BigInt(position.quantity));
          account.cash+=gross-cost;realized=gross-cost-basis;account.realized+=realized;position.quantity-=quantity;position.costTotal-=basis;
          if(position.quantity)account.positions[order.symbol]=position;else delete account.positions[order.symbol];
        }
        account.dailyTurnover+=gross;account.version++;
        const fill={id:randomUUID(),orderId:order.id,symbol:order.symbol,side:order.side,quantity,price,fee:cost,gross,realized,timestamp:this.clock(),source:'synthetic'};
        this.db.prepare('INSERT INTO paper_fills(id,payload) VALUES(?,?)').run(fill.id,JSON.stringify(fill));
        this.saveOrder({...order,filled:order.filled+quantity,status:order.filled+quantity===order.quantity?'Filled':'Partially filled',lastSequence:quote.sequence});
      }
      this.saveAccount(account);
    });
  }
  getState() {
    const account=this.account(),quotes=this.quotes(),reserved=this.reservations();
    return {account:{...account,equity:this.equity(account,quotes),reservedCash:reserved.cash,availableCash:account.cash-reserved.cash},loss:lossStatus(this.lossPolicy(),account.dayBaseline,this.equity(account,quotes)),policy:{...POLICY,...this.caps(),maxConcentrationBps:this.caps().maxCompanyPct==null?null:this.caps().maxCompanyPct*100,maxDailyLossKRW:lossStatus(this.lossPolicy(),account.dayBaseline,this.equity(account,quotes)).limitKRW},universe:this.universe,quotes:[...quotes.values()].map(({symbol,price,timestamp,stale})=>({symbol,price,timestamp,stale})),proposals:this.db.prepare('SELECT payload FROM paper_proposals ORDER BY rowid DESC LIMIT 30').all().map(row=>JSON.parse(row.payload)),orders:this.orders().slice(-100).reverse(),fills:this.db.prepare('SELECT payload FROM paper_fills ORDER BY seq DESC LIMIT 100').all().map(row=>JSON.parse(row.payload))};
  }
}
module.exports={PaperEngine,POLICY};
