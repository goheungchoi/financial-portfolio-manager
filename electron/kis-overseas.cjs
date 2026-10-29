const {stage,records}=require('./us-errors.cjs');
const EXCHANGES={NASD:'NAS',NYSE:'NYS',AMEX:'AMS'};
const PATH='/uapi/overseas-stock/v1/trading/';
function instrument(value){const match=typeof value==='string'&&/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(value);if(!match)throw new Error('INVALID_ORDER');return {exchange:match[1],ticker:match[2]};}
function numeric(value){if(!['string','number'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error('INVALID_RESPONSE');return Number(value);}
const localDate=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
function usSession(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(row=>[row.type,row.value]));
  const year=Number(parts.year),day=`${parts.year}-${parts.month}-${parts.day}`;const fmt=d=>d.toISOString().slice(0,10);
  const nth=(month,weekday,n)=>{const d=new Date(Date.UTC(year,month-1,1));return new Date(Date.UTC(year,month-1,1+(weekday-d.getUTCDay()+7)%7+7*(n-1)));};
  const observed=(y,m,d)=>{const value=new Date(Date.UTC(y,m-1,d));const w=value.getUTCDay();if(w===6)value.setUTCDate(d-1);if(w===0)value.setUTCDate(d+1);return fmt(value);};
  // Gregorian Easter; NYSE/Nasdaq observe Good Friday.
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),ed=(h+l-7*m+114)%31+1;
  const goodFriday=new Date(Date.UTC(year,month-1,ed-2));const memorial=new Date(Date.UTC(year,4,31));memorial.setUTCDate(31-(memorial.getUTCDay()+6)%7);
  const holidays=[observed(year,1,1),fmt(nth(1,1,3)),fmt(nth(2,1,3)),fmt(goodFriday),fmt(memorial),observed(year,6,19),observed(year,7,4),fmt(nth(9,1,1)),fmt(nth(11,4,4)),observed(year,12,25)];
  const thanksgiving=nth(11,4,4);thanksgiving.setUTCDate(thanksgiving.getUTCDate()+1);
  const early=day===fmt(thanksgiving)||parts.month==='12'&&parts.day==='24'||parts.month==='07'&&parts.day==='03';
  const minutes=Number(parts.hour)*60+Number(parts.minute),open=!['Sat','Sun'].includes(parts.weekday)&&!holidays.includes(day)&&minutes>=570&&minutes<(early?780:960)-10;
  return {open,status:open?'open':'closed',timeZone:'America/New_York',basis:'regular-session calendar; broker validates holidays, halts and eligibility',day};
}
const DAYTIME={NASD:'BAQ',NYSE:'BAY',AMEX:'BAA'};
// The USD/KRW rate from the present balance: the USD cash row's first published rate. With no USD held, KIS returns no
// cash row, so the base rate on the U.S. holding rows (bass_exrt) is used; without either the rate is unknown.
function usdRate(usd,holdingRows){
  if(usd&&Number(usd.frst_bltn_exrt)>0)return {usdKRW:Number(usd.frst_bltn_exrt),source:'KIS first published rate',timestamp:Date.now()};
  const base=records(holdingRows).map(row=>Number(row?.bass_exrt)).find(rate=>rate>0);
  return base?{usdKRW:base,source:'KIS base rate (holdings)',timestamp:Date.now()}:null;
}
class OverseasClient{
  constructor(client,clock=()=>new Date()){this.client=client;this.clock=clock;}
  identity(){return this.client.overseasIdentity();}
  async query(endpoint,trId,params,options){return this.client.overseasRequest(PATH+endpoint,trId,params,options);}
  tr(live,mock){return this.identity().environment==='live'?live:mock;}
  async pages(endpoint,trId,params,field){const rows=[],seen=new Set();let fk='',nk='',continuation='';for(let page=0;page<10;page++){const result=await this.query(endpoint,trId,{...params,CTX_AREA_FK200:fk,CTX_AREA_NK200:nk},{continuation});const list=records(result.body[field]);rows.push(...list);if(!['M','F'].includes(result.continuation))return rows;fk=result.body.ctx_area_fk200;nk=result.body.ctx_area_nk200;const key=fk+'|'+nk;if(typeof fk!=='string'||typeof nk!=='string'||!fk&&!nk||seen.has(key))throw new Error('INCOMPLETE_BALANCE');seen.add(key);continuation='N';}throw new Error('INCOMPLETE_BALANCE');}
  async balance(){return stage('BALANCE',()=>this.readBalance());}
  async readBalance(){
    const rows=[];for(const exchange of this.identity().environment==='live'?['NASD']:Object.keys(EXCHANGES))rows.push(...await stage('BALANCE',()=>this.pages('inquire-balance',this.tr('TTTS3012R','VTTS3012R'),{OVRS_EXCG_CD:exchange,TR_CRCY_CD:'USD'},'output1')));
    const seen=new Set(),holdings=[];
    for(const row of rows){if(!row||typeof row!=='object')throw new Error('US_BALANCE_INVALID_RESPONSE');if(Object.values(row).every(value=>value==null||String(value).trim()===''))continue;const quantity=numeric(row.ovrs_cblc_qty);if(quantity===0)continue;const exchange=row.ovrs_excg_cd==='NAS'?'NASD':row.ovrs_excg_cd;if(!EXCHANGES[exchange]||row.tr_crcy_cd&&row.tr_crcy_cd.trim()!=='USD')continue;const symbol=exchange+':'+row.ovrs_pdno;instrument(symbol);if(seen.has(symbol)){const previous=holdings.find(item=>item.symbol===symbol);if(previous.quantity===quantity&&previous.marketValue===numeric(row.ovrs_stck_evlu_amt))continue;throw new Error('US_BALANCE_INVALID_RESPONSE');}seen.add(symbol);const holding={symbol,name:String(row.ovrs_item_name??row.ovrs_pdno).slice(0,120),quantity,cost:numeric(row.pchs_avg_pric),price:numeric(row.now_pric2),marketValue:numeric(row.ovrs_stck_evlu_amt),availableQuantity:row.ord_psbl_qty==null||String(row.ord_psbl_qty).trim()===''?null:numeric(row.ord_psbl_qty)};if(Object.values(holding).some(value=>typeof value==='number'&&value<0))throw new Error('INVALID_RESPONSE');holdings.push(holding);}
    const present=await stage('CASH',()=>this.query('inquire-present-balance',this.tr('CTRP6504R','VTRP6504R'),{WCRC_FRCR_DVSN_CD:'02',NATN_CD:'840',TR_MKET_CD:'00',INQR_DVSN_CD:'01'}));
    if(['M','F'].includes(present.continuation))throw new Error('INCOMPLETE_BALANCE');
    const usd=await stage('CASH',async()=>{if(!Object.hasOwn(present.body,'output2'))throw new Error('INVALID_RESPONSE');return records(present.body.output2).find(row=>row.crcy_cd?.trim()==='USD');});const cash=await stage('CASH',async()=>usd?numeric(usd.frcr_dncl_amt_2):0);
    // Broker buying power (foreign-only and integrated) for one reference stock; a failure leaves it unknown, not zero.
    let brokerBuyingPower=null;try{const ref=holdings[0]??null;const {exchange:ex,ticker:tk}=instrument(ref?.symbol??'NASD:AAPL');const {body}=await this.query('inquire-psamount',this.tr('TTTS3007R','VTTS3007R'),{OVRS_EXCG_CD:ex,OVRS_ORD_UNPR:(ref?.price>0?ref.price:100).toFixed(2),ITEM_CD:tk});brokerBuyingPower=require('./buying-power.cjs').brokerFigures(body.output);}catch{}
    return {...this.identity(),source:'kis-us',currency:'USD',...(brokerBuyingPower?{brokerBuyingPower}:{}),fx:usdRate(usd,present.body.output1),timestamp:new Date().toISOString(),cash,reportedTotal:Math.round((cash+holdings.reduce((sum,row)=>sum+row.marketValue,0))*100)/100,holdings,
      // Unsettled U.S. buys and sales in KRW (electron/integrated-settlement.cjs); absent when KIS does not report them.
      ...(present.body.output3&&typeof present.body.output3==='object'&&!Array.isArray(present.body.output3)?{unsettled:{buyKRW:numeric(present.body.output3.ustl_buy_amt_smtl)||0,sellKRW:numeric(present.body.output3.ustl_sll_amt_smtl)||0}}:{})};
  }
  // venue 'daytime': the KIS daytime session prices (Blue Ocean exchange codes BAQ/BAY/BAA). The quote names its venue:
  // the two feeds can differ by several percent at the same moment (overnight the regular feed keeps an old price).
  async quote(symbol,venue='regular'){const {exchange,ticker}=instrument(symbol);const {body}=await this.client.overseasRequest('/uapi/overseas-price/v1/quotations/price','HHDFS00000300',{AUTH:'',EXCD:venue==='daytime'?DAYTIME[exchange]:EXCHANGES[exchange],SYMB:ticker});const price=numeric(body.output?.last);if(price<=0)throw new Error('INVALID_RESPONSE');return {symbol,price,retrievedAt:Date.now(),currency:'USD',venue:venue==='daytime'?'daytime':'regular',timeBasis:'broker snapshot; exchange timestamp unavailable'};}
  async orders(day=localDate(this.clock())){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('INVALID_DATE_RANGE');const mock=this.identity().environment==='mock';const rows=await this.pages('inquire-ccnl',this.tr('TTTS3035R','VTTS3035R'),{PDNO:mock?'':'%',ORD_STRT_DT:day.replaceAll('-',''),ORD_END_DT:day.replaceAll('-',''),SLL_BUY_DVSN:'00',CCLD_NCCS_DVSN:'00',OVRS_EXCG_CD:mock?'':'NASD',SORT_SQN:'DS',ORD_DT:'',ORD_GNO_BRNO:'',ODNO:''},'output');
    return {orders:rows.filter(row=>EXCHANGES[row.ovrs_excg_cd]).map(row=>{const quantity=numeric(row.ft_ord_qty),filled=numeric(row.ft_ccld_qty),remaining=numeric(row.nccs_qty);if(quantity<0||filled<0||remaining<0||filled>quantity)throw new Error('INVALID_RESPONSE');return {orderId:String(row.odno),symbol:row.ovrs_excg_cd+':'+row.pdno,side:row.sll_buy_dvsn_cd==='01'?'Sell':'Buy',quantity,filled,remaining,orderPrice:numeric(row.ft_ord_unpr3),fillPrice:filled?numeric(row.ft_ccld_unpr3):null,status:row.rjct_rson&&row.rjct_rson!=='0'?'Rejected':filled===quantity?'Filled':row.rvse_cncl_dvsn==='02'?'Canceled':filled?'Partially filled':'Pending'};})};
  }
  // U.S. order history for the Activity report: orders placed on Korean dates start..end (any channel), with order time
  // in KST (dmst_ord_dt + thco_ord_tmd; verified 2026-10-25), USD quantities, prices and executed amounts.
  async orderHistory(start,end){
    if(![start,end].every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d))||start>end)throw new Error('INVALID_DATE_RANGE');const mock=this.identity().environment==='mock';
    // U.S. order dates run a day behind Korean ones, so the query starts a day early and rows are kept by Korean date.
    const before=new Date(Date.parse(start+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    const rows=await this.pages('inquire-ccnl',this.tr('TTTS3035R','VTTS3035R'),{PDNO:mock?'':'%',ORD_STRT_DT:before.replaceAll('-',''),ORD_END_DT:end.replaceAll('-',''),SLL_BUY_DVSN:'00',CCLD_NCCS_DVSN:'00',OVRS_EXCG_CD:mock?'':'%',SORT_SQN:'DS',ORD_DT:'',ORD_GNO_BRNO:'',ODNO:''},'output');
    const out=new Map();
    for(const row of rows){
      if(!EXCHANGES[row.ovrs_excg_cd]||!/^[A-Z][A-Z0-9./-]{0,14}$/.test(String(row.pdno??''))||!/^\d{1,20}$/.test(String(row.odno??''))||!['01','02'].includes(row.sll_buy_dvsn_cd))throw new Error('INVALID_RESPONSE');
      const date=/^\d{8}$/.test(row.dmst_ord_dt??'')?row.dmst_ord_dt:row.ord_dt,tmd=/^\d{6}$/.test(row.thco_ord_tmd??'')?row.thco_ord_tmd:row.ord_tmd;
      if(!/^\d{8}$/.test(date??'')||!/^\d{6}$/.test(tmd??''))throw new Error('INVALID_RESPONSE');
      const day=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;if(day<start||day>end)continue;
      const timestamp=Date.parse(`${day}T${tmd.slice(0,2)}:${tmd.slice(2,4)}:${tmd.slice(4,6)}+09:00`);
      const quantity=numeric(row.ft_ord_qty),filled=numeric(row.ft_ccld_qty),remaining=numeric(row.nccs_qty);if(!Number.isFinite(timestamp)||quantity<0||filled<0||remaining<0||filled>quantity)throw new Error('INVALID_RESPONSE');
      const rejected=Boolean(row.rjct_rson&&row.rjct_rson!=='0'),canceled=row.rvse_cncl_dvsn==='02';
      const status=rejected?(filled?'Partially filled / rejected':'Rejected'):canceled?(filled?'Partially filled / canceled':'Canceled'):filled===quantity&&quantity>0?'Filled':filled?'Partially filled':remaining?'Pending':'Unfilled';
      const original=/^0*$/.test(String(row.orgn_odno??''))?null:String(row.orgn_odno);
      const record={id:`US:${row.ord_dt}:${row.ord_gno_brno??''}:${row.odno}`,orderId:String(row.odno),originalOrderId:original,symbol:row.ovrs_excg_cd+':'+row.pdno,name:String(row.prdt_name??row.pdno).slice(0,120),timestamp,side:row.sll_buy_dvsn_cd==='01'?'Sell':'Buy',quantity,filled,remaining,rejected:rejected?quantity-filled:0,executionAmount:filled?numeric(row.ft_ccld_amt3):0,averagePrice:filled?numeric(row.ft_ccld_unpr3):0,orderPrice:numeric(row.ft_ord_unpr3),status,market:'US',currency:'USD',channel:typeof row.mdia_dvsn_name==='string'?row.mdia_dvsn_name.slice(0,20):null};
      out.set(record.id,record);
    }
    return [...out.values()].sort((a,b)=>b.timestamp-a.timestamp||b.orderId.localeCompare(a.orderId));
  }
  // Settled trade history with broker fees, settlement date and the registered exchange rate (live accounts only).
  async trades(start,end){
    if(![start,end].every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d))||start>end)throw new Error('INVALID_DATE_RANGE');if(this.identity().environment!=='live')throw new Error('FEATURE_UNAVAILABLE');
    const rows=[],seen=new Set();let fk='',nk='',continuation='';
    for(let page=0;page<10;page++){
      const result=await this.query('inquire-period-trans','CTOS4001R',{ERLM_STRT_DT:start.replaceAll('-',''),ERLM_END_DT:end.replaceAll('-',''),OVRS_EXCG_CD:'',PDNO:'',SLL_BUY_DVSN_CD:'00',LOAN_DVSN_CD:'',CTX_AREA_FK100:fk,CTX_AREA_NK100:nk},{continuation});
      rows.push(...records(result.body.output1));if(!['M','F'].includes(result.continuation))break;
      fk=result.body.ctx_area_fk100;nk=result.body.ctx_area_nk100;const key=fk+'|'+nk;if(typeof fk!=='string'||typeof nk!=='string'||seen.has(key))throw new Error('INCOMPLETE_HISTORY');seen.add(key);continuation='N';
    }
    const day=v=>/^\d{8}$/.test(String(v??''))?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:null;const optional=v=>v==null||String(v).trim()===''?null:numeric(v);
    // Before KIS finalizes a trade it reports zero for the rate and settlement amounts: zero means not yet known.
    const positive=v=>{const n=optional(v);return n>0?n:null;};
    // ft_ccld_unpr2 is the USD unit price; ovrs_stck_ccld_unpr is the same price in KRW (verified 2026-10-25: 323.64 vs
    // 428,693.544 at 1,324.6). Without the USD price, the USD amount over the quantity stands in.
    const usdPrice=row=>positive(row.ft_ccld_unpr2)??(positive(row.tr_frcr_amt2)&&numeric(row.ccld_qty)>0?positive(row.tr_frcr_amt2)/numeric(row.ccld_qty):null);
    return rows.filter(row=>['01','02'].includes(row.sll_buy_dvsn_cd)&&String(row.crcy_cd??'USD').trim()==='USD').map(row=>({tradeDate:day(row.trad_dt),settlementDate:day(row.sttl_dt),ticker:String(row.pdno).trim(),side:row.sll_buy_dvsn_cd==='01'?'Sell':'Buy',quantity:numeric(row.ccld_qty),price:usdPrice(row),grossUSD:positive(row.tr_frcr_amt2),settlementUSD:positive(row.frcr_excc_amt_1),settlementKRW:positive(row.wcrc_excc_amt),feesUSD:(optional(row.frcr_fee1)??0)+(optional(row.dmst_frcr_fee1)??0),exchangeRate:positive(row.erlm_exrt)})).filter(row=>row.tradeDate&&row.quantity>0&&row.price>0);
  }
  async context(symbols=[],session=null){if(!Array.isArray(symbols)||symbols.length>20)throw new Error('INVALID_ORDER');symbols.forEach(instrument);const balance=await this.balance();const quotes=[],warnings=[];for(const symbol of symbols.length?symbols:balance.holdings.map(row=>row.symbol).slice(0,20)){try{quotes.push(await stage('QUOTES',()=>this.quote(symbol,session?.id==='us-daytime'?'daytime':'regular')));}catch(error){warnings.push({symbol,code:error.message});}}return {balance,quotes,warnings,marketSession:session&&!session.regular?{open:true,status:'open',session:{id:session.id,label:session.label,regular:false,endsAt:session.endAt},timeZone:'America/New_York'}:{...usSession(this.clock()),...(session?{session:{id:session.id,label:session.label,regular:true,endsAt:session.endAt}}:{})}};}
  async prepare(command,session=null){instrument(command?.symbol);if(!['Buy','Sell'].includes(command.side)||!Number.isInteger(command.quantity)||command.quantity<1||command.quantity>10000||!Number.isFinite(command.limitPrice)||command.limitPrice<1||Math.abs(command.limitPrice*100-Math.round(command.limitPrice*100))>1e-7)throw new Error('INVALID_ORDER');if(!(session&&!session.regular)&&!usSession(this.clock()).open)throw new Error('SESSION_CLOSED');const {exchange,ticker}=instrument(command.symbol),quote=await this.quote(command.symbol,session?.id==='us-daytime'?'daytime':'regular');if(Math.abs(command.limitPrice/quote.price-1)>.02)throw new Error('PRICE_MOVED');const balance=await this.balance();if(command.side==='Sell'){if(command.quantity>(balance.holdings.find(row=>row.symbol===command.symbol)?.availableQuantity??0))throw new Error('INSUFFICIENT_CAPACITY');}else{const {body}=await this.query('inquire-psamount',this.tr('TTTS3007R','VTTS3007R'),{OVRS_EXCG_CD:exchange,OVRS_ORD_UNPR:command.limitPrice.toFixed(2),ITEM_CD:ticker});const figures=require('./buying-power.cjs').brokerFigures(body.output);const integrated=require('./buying-power.cjs').integratedOn(figures);if(!figures||command.quantity>(integrated?figures.integratedQty??figures.foreignQty:figures.foreignQty)||command.quantity*command.limitPrice*1.02>(integrated?figures.integratedUSD:figures.foreignUSD))throw new Error('INSUFFICIENT_CAPACITY');}if((await this.orders()).orders.some(row=>row.remaining>0&&['Pending','Partially filled'].includes(row.status)))throw new Error('OPEN_BROKER_ORDERS');return {balance,price:quote.price,checkedAt:Date.now()};}
  // Extended sessions: the KIS daytime session has its own endpoint (live accounts, limit only); pre- and after-market use the regular order.
  async place(command,session=null){const {exchange,ticker}=instrument(command.symbol);if(!(session&&!session.regular)&&!usSession(this.clock()).open)throw new Error('SESSION_CLOSED');
    if(session?.route?.endpoint==='daytime'){if(this.identity().environment!=='live')throw new Error('FEATURE_UNAVAILABLE');try{const {body}=await this.client.overseasRequest('/uapi/overseas-stock/v1/trading/daytime-order',command.side==='Buy'?'TTTS6036U':'TTTS6037U',{OVRS_EXCG_CD:exchange,PDNO:ticker,ORD_QTY:String(command.quantity),OVRS_ORD_UNPR:command.limitPrice.toFixed(2),CTAC_TLNO:'',MGCO_APTM_ODNO:'',ORD_SVR_DVSN_CD:'0',ORD_DVSN:'00'},{post:true});if(!/^\d+$/.test(body.output?.ODNO))throw new Error('ORDER_UNCERTAIN');return {brokerOrderId:body.output.ODNO,acceptedAt:new Date().toISOString(),session:session.id};}catch(error){throw new Error(error.code==='BROKER_REJECTED'?'BROKER_REJECTED':'ORDER_UNCERTAIN');}}
    try{const {body}=await this.query('order',command.side==='Buy'?this.tr('TTTT1002U','VTTT1002U'):this.tr('TTTT1006U','VTTT1001U'),{OVRS_EXCG_CD:exchange,PDNO:ticker,ORD_QTY:String(command.quantity),OVRS_ORD_UNPR:command.limitPrice.toFixed(2),CTAC_TLNO:'',MGCO_APTM_ODNO:'',SLL_TYPE:command.side==='Sell'?'00':'',ORD_SVR_DVSN_CD:'0',ORD_DVSN:'00'},{post:true});if(!/^\d+$/.test(body.output?.ODNO))throw new Error('ORDER_UNCERTAIN');return {brokerOrderId:body.output.ODNO,acceptedAt:new Date().toISOString()};}catch(error){throw new Error(error.code==='BROKER_REJECTED'?'BROKER_REJECTED':'ORDER_UNCERTAIN');}}
}
module.exports={OverseasClient,instrument,usSession,localDate};
