// Leveraged / inverse products, margin and short exposure: classification, per-account policy and order checks.
// Classification uses the security master name and type, a list of common U.S. tickers and user overrides.
// The factor is the daily multiple of the underlying index: 2 = 2x leveraged, -1 = inverse, -2 = 2x inverse.
const US_KNOWN={TQQQ:3,SQQQ:-3,QLD:2,QID:-2,PSQ:-1,UPRO:3,SPXU:-3,SPXL:3,SPXS:-3,SSO:2,SDS:-2,SH:-1,SOXL:3,SOXS:-3,TNA:3,TZA:-3,TECL:3,TECS:-3,FAS:3,FAZ:-3,LABU:3,LABD:-3,UDOW:3,SDOW:-3,DDM:2,DXD:-2,DOG:-1,TMF:3,TMV:-3,TBT:-2,UBT:2,NUGT:2,DUST:-2,YINN:3,YANG:-3,FNGU:3,FNGD:-3,NVDL:2,NVDU:2,NVDD:-1,TSLL:2,TSLQ:-1,CONL:2,MSTU:2,BITX:2,UVXY:1.5,SVXY:-0.5};
// Margin: loan source self (자기융자) or distribution (유통융자, via KSFC); interestPct is the annual loan rate used for estimates.
// Short: stock loan source (자기대주 / 유통대주); feePct is the annual borrowing fee used for estimates.
const DEFAULT_POLICY={leveragedEtps:{enabled:false,auto:false,maxPctOfEquity:20,maxHoldingDays:10},margin:{enabled:false,auto:false,maxLoanPctOfEquity:30,minCollateralPct:140,source:'self',interestPct:9},short:{enabled:false,auto:false,maxGrossPctOfEquity:20,stopLossPct:15,maxDays:90,source:'distribution',feePct:5}};
const CREDIT_TYPES={'margin-buy':{self:'21',distribution:'23'},'margin-sell':{self:'25',distribution:'27'},short:{self:'24',distribution:'22'},cover:{self:'28',distribution:'26'}};
const daysBetween=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/86400000);
function classifyName(symbol,name='',englishName=''){
  const us=symbol.includes(':');const ticker=us?symbol.split(':')[1]:symbol;
  if(us&&US_KNOWN[ticker]!=null)return US_KNOWN[ticker];
  if(!us){
    const n=String(name).replace(/\s+/g,'');
    const multiple=/(\d(?:\.\d)?)X/i.exec(n);const factor=multiple?Number(multiple[1]):null;
    if(n.includes('인버스'))return -(factor??1);
    if(n.includes('레버리지'))return factor??2;
    return 1;
  }
  const e=String(englishName||name).toLowerCase();
  const multiple=/(\d(?:\.\d+)?)\s*x\b/.exec(e);const factor=multiple?Number(multiple[1]):/ultrapro/.test(e)?3:/\bultra(short)?\b/.test(e)?2:null;
  // "Short" also names bond duration (short-term, short treasury), which is not inverse exposure.
  const inverse=/\b(inverse|bear|ultrashort)\b/.test(e)||/\bshort\b/.test(e)&&!/short[- ](term|treasury|duration|maturity|dated|bond)/.test(e);
  if(inverse)return -(factor??1);if(factor&&factor>1)return factor;return 1;
}
function kindOf(factor){return factor===1?'standard':factor<0?(factor<-1?'leveraged-inverse':'inverse'):'leveraged';}
class Exposure {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS product_overrides(symbol TEXT PRIMARY KEY,factor REAL NOT NULL);CREATE TABLE IF NOT EXISTS exposure_policy(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  security(symbol){try{return this.db.prepare('SELECT name,englishName,type FROM securities WHERE symbol=?').get(symbol)??null;}catch{return null;}}
  // {factor, kind, source}; only ETFs/ETNs (or overrides / known tickers) are treated as leveraged or inverse.
  classify(symbol,name=null){
    const override=this.db.prepare('SELECT factor FROM product_overrides WHERE symbol=?').get(symbol);if(override)return {factor:override.factor,kind:kindOf(override.factor),source:'Your setting'};
    const row=this.security(symbol);const ticker=symbol.includes(':')?symbol.split(':')[1]:symbol;
    if(symbol.includes(':')&&US_KNOWN[ticker]!=null)return {factor:US_KNOWN[ticker],kind:kindOf(US_KNOWN[ticker]),source:'Known product list'};
    if(row&&!['etf','etn'].includes(row.type))return {factor:1,kind:'standard',source:'Security master'};
    if(!row&&!name)return {factor:1,kind:'standard',source:'Unknown product'};
    const factor=classifyName(symbol,row?.name??name??'',row?.englishName??'');return {factor,kind:kindOf(factor),source:row?'Security master name':'Product name'};
  }
  setOverride(symbol,factor){
    if(typeof symbol!=='string'||!(/^\d{6}$/.test(symbol)||/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)))throw new Error('INVALID_REQUEST');
    if(factor==null){this.db.prepare('DELETE FROM product_overrides WHERE symbol=?').run(symbol);return;}
    if(!Number.isFinite(factor)||factor===0||Math.abs(factor)>5)throw new Error('INVALID_REQUEST');this.db.prepare('INSERT INTO product_overrides VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET factor=excluded.factor').run(symbol,factor);
  }
  overrides(){return this.db.prepare('SELECT symbol,factor FROM product_overrides ORDER BY symbol').all().map(r=>({...r}));}
  policy(account){const row=this.db.prepare('SELECT payload FROM exposure_policy WHERE account=?').get(account);const saved=row?JSON.parse(row.payload):{};return Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([k,v])=>[k,{...v,...(saved[k]??{})}]));}
  savePolicy(account,value){
    if(typeof account!=='string'||!account||!value||typeof value!=='object'||Object.keys(value).some(k=>!DEFAULT_POLICY[k]))throw new Error('INVALID_SETTINGS');
    const next=this.policy(account);
    for(const [section,fields] of Object.entries(value)){if(!fields||typeof fields!=='object')throw new Error('INVALID_SETTINGS');for(const [key,v] of Object.entries(fields)){
      if(!Object.hasOwn(DEFAULT_POLICY[section],key))throw new Error('INVALID_SETTINGS');
      if(key==='source'?!['self','distribution'].includes(v):['enabled','auto'].includes(key)?typeof v!=='boolean':!(Number.isFinite(v)&&v>0&&v<=(key==='minCollateralPct'?1000:key.endsWith('Days')?365:100)))throw new Error('INVALID_SETTINGS');
      next[section][key]=v;}}
    for(const section of Object.keys(next))if(!next[section].enabled)next[section].auto=false;
    this.db.prepare('INSERT INTO exposure_policy VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(next));return next;
  }
  // Exposure of holdings: market value, and effective exposure = value x factor (inverse counts as short exposure).
  summary(holdings,equity,now=Date.now(),firstSeen=()=>null){
    const rows=(holdings??[]).filter(h=>h.quantity!==0).map(h=>{const product=this.classify(h.symbol,h.name);const value=h.marketValue??h.quantity*(h.price??h.cost??0);const since=firstSeen(h.symbol);return {symbol:h.symbol,name:h.name??h.symbol,...product,value,effective:value*product.factor,heldDays:since?Math.floor((now-since)/86400000):null,short:h.quantity<0,loan:h.loan??null};});
    const special=rows.filter(r=>r.kind!=='standard'||r.short||r.loan);const sum=list=>list.reduce((n,r)=>n+Math.abs(r.value),0);
    return {equity,positions:special,leveragedValue:sum(rows.filter(r=>r.kind!=='standard')),leveragedPct:equity>0?sum(rows.filter(r=>r.kind!=='standard'))/equity*100:null,effectiveExposure:rows.reduce((n,r)=>n+(r.short?-Math.abs(r.value):r.effective),0),effectivePct:equity>0?rows.reduce((n,r)=>n+(r.short?-Math.abs(r.value):r.effective),0)/equity*100:null};
  }
  // Checks an order against the policy. Returns {product, requiresApproval} or throws a policy error code.
  check({account,symbol,side,notional,equity,holdings,name=null}){
    const policy=this.policy(account),product=this.classify(symbol,name);
    if(product.kind==='standard'||side==='Sell')return {product,requiresApproval:false};
    const p=policy.leveragedEtps;if(!p.enabled)throw new Error('LEVERAGED_NOT_ENABLED');
    const current=this.summary(holdings,equity).leveragedValue;
    if(equity>0&&(current+notional)/equity*100>p.maxPctOfEquity)throw new Error('LEVERAGED_EXPOSURE_LIMIT');
    return {product,requiresApproval:!p.auto};
  }
  // Credit orders (Korea): new margin loans and short sales need their switch and cap; repayments always reduce risk.
  // Returns {type, requiresApproval}, with the KIS credit type for the order.
  checkCredit({account,kind,symbol,notional,equity,balance,loanDate=null}){
    const policy=this.policy(account);if(!CREDIT_TYPES[kind])throw new Error('INVALID_ORDER');
    if(kind==='margin-sell'){const loan=balance.holdings?.find(h=>h.symbol===symbol)?.loans?.find(l=>l.loanDate===loanDate);if(!loan)throw new Error('INSUFFICIENT_CAPACITY');return {type:CREDIT_TYPES[kind][loan.source],requiresApproval:false};}
    if(kind==='cover'){const short=balance.shorts?.find(s=>s.symbol===symbol&&s.loanDate===loanDate);if(!short)throw new Error('INSUFFICIENT_CAPACITY');return {type:CREDIT_TYPES[kind][short.source],requiresApproval:false};}
    if(kind==='margin-buy'){
      const p=policy.margin;if(!p.enabled)throw new Error('MARGIN_NOT_ENABLED');
      if(!(equity>0)||((balance.loanTotal??0)+notional)/equity*100>p.maxLoanPctOfEquity)throw new Error('MARGIN_LIMIT');
      const leveraged=this.check({account,symbol,side:'Buy',notional,equity,holdings:balance.holdings});
      return {type:CREDIT_TYPES[kind][p.source],requiresApproval:!p.auto||leveraged.requiresApproval};
    }
    const p=policy.short;if(!p.enabled)throw new Error('SHORT_NOT_ENABLED');
    const gross=(balance.shorts??[]).reduce((n,s)=>n+s.quantity*s.price,0);
    if(!(equity>0)||(gross+notional)/equity*100>p.maxGrossPctOfEquity)throw new Error('SHORT_LIMIT');
    return {type:CREDIT_TYPES[kind][p.source],requiresApproval:!p.auto};
  }
  // Margin loans and short positions: estimated interest/fees so far, expiry and collateral warnings, short stop levels.
  creditRisk(account,balance,today){
    const policy=this.policy(account),loans=(balance.holdings??[]).flatMap(h=>(h.loans??[]).map(l=>({symbol:h.symbol,name:h.name,...l,value:l.quantity*h.price})));const shorts=balance.shorts??[];
    if(!loans.length&&!shorts.length)return null;const warnings=[];
    const loanRows=loans.map(l=>{const days=l.loanDate?daysBetween(l.loanDate,today):null;const toExpiry=l.expiry?daysBetween(today,l.expiry):null;if(toExpiry!=null&&toExpiry<=7)warnings.push(`Margin loan on ${l.symbol} (${l.loanDate}) matures in ${toExpiry} days; repay or extend.`);return {symbol:l.symbol,quantity:l.quantity,loanAmount:l.amount,loanDate:l.loanDate,expiry:l.expiry,daysToExpiry:toExpiry,estimatedInterest:l.amount!=null&&days!=null?Math.round(l.amount*policy.margin.interestPct/100*days/365):null};});
    const loanTotal=balance.loanTotal??loans.reduce((n,l)=>n+(l.amount??0),0);const collateral=loanTotal>0?Math.round((loans.reduce((n,l)=>n+l.value,0)+(balance.cash??0))/loanTotal*1000)/10:null;
    if(collateral!=null&&collateral<policy.margin.minCollateralPct)warnings.push(`Estimated collateral ratio ${collateral}% is below your ${policy.margin.minCollateralPct}% floor; the broker may force a sale below its maintenance ratio.`);
    const shortRows=shorts.map(s=>{const adverse=s.entryPrice?(s.price/s.entryPrice-1)*100:null;const days=s.loanDate?daysBetween(s.loanDate,today):null;const toExpiry=s.expiry?daysBetween(today,s.expiry):days!=null?policy.short.maxDays-days:null;
      if(adverse!=null&&adverse>=policy.short.stopLossPct)warnings.push(`Short ${s.symbol} is ${adverse.toFixed(1)}% above its sale price, past your ${policy.short.stopLossPct}% stop; consider covering.`);if(toExpiry!=null&&toExpiry<=7)warnings.push(`Short ${s.symbol} (${s.loanDate}) must be repaid within ${toExpiry} days.`);
      return {symbol:s.symbol,quantity:s.quantity,entryPrice:s.entryPrice,price:s.price,adversePct:adverse==null?null:Math.round(adverse*10)/10,loanDate:s.loanDate,daysToRepay:toExpiry,estimatedFee:s.proceeds!=null&&days!=null?Math.round(s.proceeds*policy.short.feePct/100*days/365):null};});
    return {margin:{allowed:policy.margin.enabled,automatic:policy.margin.auto,loanTotal,estimatedCollateralPct:collateral,loans:loanRows},short:{allowed:policy.short.enabled,automatic:policy.short.auto,stopLossPct:policy.short.stopLossPct,positions:shortRows},warnings};
  }
  // AI context: product flags for the review universe and held positions, policy switches and holding-period warnings.
  context(account,universe,holdings,equity,firstSeen){
    const policy=this.policy(account),summary=this.summary(holdings,equity,Date.now(),firstSeen);
    const products=[...new Set([...(universe??[]).map(u=>u.symbol),...(holdings??[]).map(h=>h.symbol)])].map(symbol=>({symbol,...this.classify(symbol,(universe??[]).find(u=>u.symbol===symbol)?.name)})).filter(p=>p.kind!=='standard').map(({symbol,factor,kind})=>({symbol,factor,kind}));
    const warnings=summary.positions.filter(r=>r.kind!=='standard'&&r.heldDays!=null&&r.heldDays>policy.leveragedEtps.maxHoldingDays).map(r=>`${r.symbol} (${r.factor}x daily) held ${r.heldDays} days; daily-reset products drift from the index over longer holds.`);
    return {leveragedEtps:{allowed:policy.leveragedEtps.enabled,automatic:policy.leveragedEtps.auto,maxPctOfEquity:policy.leveragedEtps.maxPctOfEquity,maxHoldingDays:policy.leveragedEtps.maxHoldingDays},products,exposure:{leveragedPct:summary.leveragedPct==null?null:Math.round(summary.leveragedPct*10)/10,effectivePct:summary.effectivePct==null?null:Math.round(summary.effectivePct*10)/10},warnings};
  }
}
module.exports={Exposure,classifyName,DEFAULT_POLICY,US_KNOWN,CREDIT_TYPES};
