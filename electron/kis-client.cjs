const ORIGINS = { live:'https://openapi.koreainvestment.com:9443', mock:'https://openapivts.koreainvestment.com:29443' };
class KisError extends Error { constructor(code) { super(code); this.code=code; } }
function parseCredentials(text) {
  try {
    const value=JSON.parse(text);
    const keys=['environment','appKey','appSecret','accountNumber','accountProductCode'];
    if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)) || typeof value.environment!=='string' || !Object.hasOwn(ORIGINS,value.environment) || typeof value.accountNumber!=='string' || !/^\d{8}$/.test(value.accountNumber) || value.accountProductCode!=='01') throw 0;
    for(const key of ['appKey','appSecret']) if(typeof value[key]!=='string' || !/^[A-Za-z0-9_\-+/=]{1,256}$/.test(value[key])) throw 0;
    return Object.fromEntries(keys.map(key=>[key,value[key]]));
  } catch { throw new KisError('INVALID_CREDENTIAL_FILE'); }
}
function amount(value) {
  if(typeof value!=='string' && typeof value!=='number') throw new KisError('INVALID_RESPONSE');
  if(String(value).trim()==='' || !/^-?\d+(\.\d+)?$/.test(String(value))) throw new KisError('INVALID_RESPONSE');
  const number=Number(value);
  if(!Number.isFinite(number) || Math.abs(number)>Number.MAX_SAFE_INTEGER) throw new KisError('INVALID_RESPONSE');
  return number;
}
function normalizeBalance(rows,summary,environment) {
  if(!summary || !Array.isArray(rows)) throw new KisError('INVALID_RESPONSE');
  const seen=new Set();
  const holdings=[];
  for(const row of rows) {
    const quantity=amount(row.hldg_qty);
    if(quantity===0) continue;
    if(quantity<0 || !/^[A-Z0-9]{6}$/.test(row.pdno) || typeof row.prdt_name!=='string' || seen.has(row.pdno)) throw new KisError('INVALID_RESPONSE');
    seen.add(row.pdno);
    const holding={symbol:row.pdno,name:row.prdt_name.slice(0,120),quantity,cost:amount(row.pchs_avg_pric),price:amount(row.prpr),marketValue:amount(row.evlu_amt),unrealized:amount(row.evlu_pfls_amt),availableQuantity:row.ord_psbl_qty===undefined?null:amount(row.ord_psbl_qty)};
    if(holding.cost<0 || holding.price<0 || holding.marketValue<0) throw new KisError('INVALID_RESPONSE');
    holdings.push(holding);
  }
  return {source:'kis',environment,timestamp:new Date().toISOString(),cash:amount(summary.dnca_tot_amt),reportedTotal:amount(summary.tot_evlu_amt),holdings};
}
class KisReadOnlyClient {
  #credentials; #token; #expires=0; #streamConfig; #streamConfigUntil=0;
  constructor(credentials,transport=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
    this.#credentials=parseCredentials(JSON.stringify(credentials)); this.transport=transport; this.wait=wait;
  }
  async request(path,options) {
    const task=(this.httpQueue??Promise.resolve()).then(async()=>{
      for(let attempt=0;attempt<2;attempt++){
        const spacing=(this.#credentials.environment==='mock'?1500:650)-(Date.now()-(this.lastHttpAt??0));if(spacing>0)await this.wait(spacing);
        if(Date.now()<(this.rateLimitedUntil??0)){const error=new KisError('RATE_LIMITED');error.retryAt=this.rateLimitedUntil;throw error;}
        this.lastHttpAt=Date.now();
        try{return await this.performRequest(path,options);}catch(error){if(error.code==='RATE_LIMITED'){this.throttleCount=(Date.now()-(this.lastThrottleAt??0)>600000?0:this.throttleCount??0)+1;this.lastThrottleAt=Date.now();this.rateLimitedUntil=Date.now()+Math.min(300000,60000*2**(this.throttleCount-1));error.retryAt=this.rateLimitedUntil;}if(options.method!=='GET'||attempt===1||!['NETWORK_UNAVAILABLE','REQUEST_TIMEOUT','SERVER_ERROR'].includes(error.code))throw error;await this.wait(1200);}
      }
    });this.httpQueue=task.catch(()=>{});return task;
  }
  async performRequest(path,options) {
    try {
      const response=await this.transport(ORIGINS[this.#credentials.environment]+path,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      const text=await response.text();
      if(text.length>2000000) throw new KisError('INVALID_RESPONSE');
      let body;try{body=JSON.parse(text);}catch{if(response.ok)throw new KisError('INVALID_RESPONSE');}
      if(!response.ok||body?.msg_cd==='EGW00201'){const info=require('./broker-errors.cjs').responseError(response.status,body);const error=new KisError(info.reason);error.brokerCode=info.brokerCode;error.httpStatus=info.httpStatus;throw error;}
      if(!body||typeof body!=='object')throw new KisError('INVALID_RESPONSE');return {body,continuation:response.headers.get('tr_cont')};
    } catch(error) { if(error instanceof KisError)throw error;throw new KisError(['TimeoutError','AbortError'].includes(error.name)?'REQUEST_TIMEOUT':'NETWORK_UNAVAILABLE'); }
  }
  async authenticate() {
    if(this.#token && Date.now()<this.#expires) return;
    const {body}=await this.request('/oauth2/tokenP',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret})});
    if(typeof body.access_token!=='string' || !/^[A-Za-z0-9._\-+/=]+$/.test(body.access_token) || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in)<60) throw new KisError('AUTH_FAILED');
    this.#token=body.access_token;this.#expires=Date.now()+(Number(body.expires_in)-30)*1000;
  }
  async quotation(endpoint,trId,params) {
    await this.authenticate();await this.wait(550);
    const {body}=await this.request('/uapi/domestic-stock/v1/quotations/'+endpoint+'?'+new URLSearchParams(params),{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P'}});
    if(body.rt_cd!=='0')throw new KisError('BROKER_REJECTED');
    return body;
  }
  async getStreamConfig() {
    if(this.#streamConfig && Date.now()<this.#streamConfigUntil)return this.#streamConfig;
    await this.wait(550);
    const {body}=await this.request('/oauth2/Approval',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:this.#credentials.appKey,secretkey:this.#credentials.appSecret})});
    if(typeof body.approval_key!=='string' || !/^[A-Za-z0-9._\-+/=]+$/.test(body.approval_key))throw new KisError('AUTH_FAILED');
    this.#streamConfig={url:this.#credentials.environment==='live'?'ws://ops.koreainvestment.com:21000':'ws://ops.koreainvestment.com:31000',approvalKey:body.approval_key};
    this.#streamConfigUntil=Date.now()+30*60000;return this.#streamConfig;
  }
  invalidateStreamApproval(){this.#streamConfig=null;this.#streamConfigUntil=0;}
  async getMinuteHistory(symbol) {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const hour=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date()).replaceAll(':','');
    const body=await this.quotation('inquire-time-itemchartprice','FHKST03010200',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_HOUR_1:hour,FID_PW_DATA_INCU_YN:'Y',FID_ETC_CLS_CODE:''});
    if(!Array.isArray(body.output2))throw new KisError('INVALID_RESPONSE');
    const {exchangeTimestamp}=require('./kis-stream.cjs');const seen=new Set();
    return body.output2.filter(row=>row.stck_bsop_date && row.stck_cntg_hour).map(row=>{
      let timestamp;
      try{timestamp=exchangeTimestamp(row.stck_bsop_date,row.stck_cntg_hour);}catch{throw new KisError('INVALID_RESPONSE');}
      if(seen.has(timestamp))throw new KisError('INVALID_RESPONSE');seen.add(timestamp);
      const candle={timestamp,open:amount(row.stck_oprc),high:amount(row.stck_hgpr),low:amount(row.stck_lwpr),close:amount(row.stck_prpr),volume:amount(row.cntg_vol)};
      if(candle.low<=0 || candle.high<Math.max(candle.open,candle.close) || candle.low>Math.min(candle.open,candle.close) || candle.volume<0)throw new KisError('INVALID_RESPONSE');
      return candle;
    }).sort((a,b)=>a.timestamp-b.timestamp).slice(-30);
  }
  async getQuote(symbol) {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const body=await this.quotation('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol});
    const price=amount(body.output?.stck_prpr);
    if(price<=0)throw new KisError('INVALID_RESPONSE');
    return {symbol,price,retrievedAt:Date.now()};
  }
  async getDailyHistory(symbol) {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const end=new Date();const start=new Date(end.getTime()-180*86400000);
    const date=value=>{
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
      return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('');
    };
    const body=await this.quotation('inquire-daily-itemchartprice','FHKST03010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:date(start),FID_INPUT_DATE_2:date(end),FID_PERIOD_DIV_CODE:'D',FID_ORG_ADJ_PRC:'0'});
    if(!Array.isArray(body.output2))throw new KisError('INVALID_RESPONSE');
    const dates=new Set();
    return body.output2.filter(row=>row.stck_bsop_date).map(row=>{
      const d=row.stck_bsop_date;
      if(!/^\d{8}$/.test(d) || dates.has(d))throw new KisError('INVALID_RESPONSE');
      dates.add(d);
      const timestamp=Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00+09:00`);
      if(!Number.isFinite(timestamp) || date(new Date(timestamp))!==d)throw new KisError('INVALID_RESPONSE');
      const candle={timestamp,open:amount(row.stck_oprc),high:amount(row.stck_hgpr),low:amount(row.stck_lwpr),close:amount(row.stck_clpr),volume:amount(row.acml_vol)};
      if(candle.low<=0 || candle.high<Math.max(candle.open,candle.close) || candle.low>Math.min(candle.open,candle.close) || candle.volume<0)throw new KisError('INVALID_RESPONSE');
      return candle;
    }).sort((a,b)=>a.timestamp-b.timestamp).slice(-100);
  }
  async getBalance() {
    await this.authenticate();
    let fk='',nk='',continuation=''; const rows=[]; let summary; const cursors=new Set();
    for(let page=0;page<10;page++) {
      await this.wait(550);
      const params=new URLSearchParams({CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,AFHR_FLPR_YN:'N',OFL_YN:'',INQR_DVSN:'02',UNPR_DVSN:'01',FUND_STTL_ICLD_YN:'N',FNCG_AMT_AUTO_RDPT_YN:'N',PRCS_DVSN:'00',CTX_AREA_FK100:fk,CTX_AREA_NK100:nk});
      const result=await this.request('/uapi/domestic-stock/v1/trading/inquire-balance?'+params,{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:this.#credentials.environment==='live'?'TTTC8434R':'VTTC8434R',custtype:'P',tr_cont:continuation}});
      if(result.body.rt_cd!=='0') throw new KisError('BROKER_REJECTED');
      if(!Array.isArray(result.body.output1) || !Array.isArray(result.body.output2) || !result.body.output2[0]) throw new KisError('INVALID_RESPONSE');
      rows.push(...result.body.output1); summary ??= result.body.output2[0];
      if(!['M','F'].includes(result.continuation)) return {...normalizeBalance(rows,summary,this.#credentials.environment),accountKey:require('node:crypto').createHmac('sha256',this.#credentials.appSecret).update(this.#credentials.environment+this.#credentials.accountNumber+this.#credentials.accountProductCode).digest('hex')};
      fk=result.body.ctx_area_fk100; nk=result.body.ctx_area_nk100;
      if(typeof fk!=='string' || typeof nk!=='string' || (!fk && !nk) || cursors.has(fk+'|'+nk)) throw new KisError('INCOMPLETE_BALANCE');
      cursors.add(fk+'|'+nk);continuation='N';
    }
    throw new KisError('INCOMPLETE_BALANCE');
  }
  async getActivity(kind,startDate,endDate) {
    if(!['orders','profit'].includes(kind))throw new KisError('INVALID_REQUEST');
    const {validateRange,normalizeOrders,normalizeProfit}=require('./kis-activity.cjs');
    let range;try{range=validateRange(startDate,endDate);}catch{throw new KisError('INVALID_DATE_RANGE');}
    if(kind==='profit' && this.#credentials.environment==='mock')throw new KisError('FEATURE_UNAVAILABLE');
    await this.authenticate();
    const endpoint=kind==='orders'?'inquire-daily-ccld':'inquire-period-trade-profit';
    const trId=kind==='orders'?(this.#credentials.environment==='live'?'TTTC0081R':'VTTC0081R'):'TTTC8715R';
    let fk='',nk='',continuation='';const rows=[];let summary;const cursors=new Set();
    for(let page=0;page<10;page++) {
      await this.wait(550);
      const filters=kind==='orders'?{SLL_BUY_DVSN_CD:'00',CCLD_DVSN:'00',INQR_DVSN:'00',INQR_DVSN_3:'00',ORD_GNO_BRNO:'',ODNO:'',INQR_DVSN_1:'',EXCG_ID_DVSN_CD:'ALL'}:{SORT_DVSN:'02',CBLC_DVSN:'00'};
      const params=new URLSearchParams({CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,INQR_STRT_DT:range.start,INQR_END_DT:range.end,PDNO:'',CTX_AREA_FK100:fk,CTX_AREA_NK100:nk,...filters});
      const result=await this.request('/uapi/domestic-stock/v1/trading/'+endpoint+'?'+params,{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P',tr_cont:continuation}});
      if(result.body.rt_cd!=='0')throw new KisError('BROKER_REJECTED');
      if(!Array.isArray(result.body.output1))throw new KisError('INVALID_RESPONSE');
      rows.push(...result.body.output1);
      summary ??= Array.isArray(result.body.output2)?result.body.output2[0]:result.body.output2;
      if(!['M','F'].includes(result.continuation)) {
        try {
          const normalized=kind==='orders'?{orders:normalizeOrders(rows,range.start,range.end)}:normalizeProfit(rows,summary,range.start,range.end);
          return {source:'kis',environment:this.#credentials.environment,startDate,endDate,retrievedAt:new Date().toISOString(),...normalized};
        } catch(error){throw new KisError(error.message==='INCOMPLETE_HISTORY'?'INCOMPLETE_HISTORY':'INVALID_RESPONSE');}
      }
      fk=result.body.ctx_area_fk100;nk=result.body.ctx_area_nk100;
      if(typeof fk!=='string' || typeof nk!=='string' || (!fk && !nk) || cursors.has(fk+'|'+nk))throw new KisError('INCOMPLETE_HISTORY');
      cursors.add(fk+'|'+nk);continuation='N';
    }
    throw new KisError('INCOMPLETE_HISTORY');
  }
  async tradingQuery(endpoint,trId,params) {
    await this.authenticate();await this.wait(550);
    const {body}=await this.request('/uapi/domestic-stock/v1/trading/'+endpoint+'?'+new URLSearchParams({CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,...params}),{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P'}});
    if(body.rt_cd!=='0')throw new KisError('BROKER_REJECTED');return body;
  }
  async overseasRequest(endpoint,trId,params,{post=false,continuation=''}={}) {
    await this.authenticate();await this.wait(550);
    const account=endpoint.startsWith('/uapi/overseas-stock/')?{CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode}:{};
    const payload={...account,...params};
    const result=await this.request(endpoint+(post?'':'?'+new URLSearchParams(payload)),{method:post?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P',tr_cont:continuation},...(post?{body:JSON.stringify(payload)}:{})});
    if(result.body.rt_cd!=='0'){const error=new KisError('BROKER_REJECTED');if(/^[A-Z0-9_-]{1,24}$/.test(result.body.msg_cd??''))error.brokerCode=result.body.msg_cd;throw error;}return result;
  }
  overseasIdentity(){return {environment:this.#credentials.environment,accountKey:require('node:crypto').createHmac('sha256',this.#credentials.appSecret).update(this.#credentials.environment+this.#credentials.accountNumber+this.#credentials.accountProductCode).digest('hex')+':US'};}
  async checkSession() {
    const {seoulDate}=require('./kis-activity.cjs');const today=seoulDate();
    const local=new Date(Date.now()+9*3600000);const minutes=local.getUTCHours()*60+local.getUTCMinutes();
    if(minutes<9*60 || minutes>=15*60+20)throw new KisError('SESSION_CLOSED');
    if(!this.holidayDay || this.holidayDay!==today) {
      const body=await this.quotation('chk-holiday','CTCA0903R',{BASS_DT:today.replaceAll('-',''),CTX_AREA_FK:'',CTX_AREA_NK:''});
      const rows=Array.isArray(body.output)?body.output:[body.output];const day=rows.find(row=>row?.bass_dt===today.replaceAll('-',''));
      if(!day || day.opnd_yn!=='Y')throw new KisError('SESSION_CLOSED');this.holidayDay=today;
    }
    return {open:true};
  }
  async prepareOrder(command) {
    if(!command||!/^\d{6}$/.test(command.symbol)||!['Buy','Sell'].includes(command.side)||!Number.isSafeInteger(command.quantity)||command.quantity<1||command.quantity>10000||!Number.isSafeInteger(command.limitPrice)||command.limitPrice<=0)throw new KisError('INVALID_ORDER');
    await this.checkSession();const {seoulDate}=require('./kis-activity.cjs');const today=seoulDate();
    const quoteBody=await this.quotation('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:command.symbol});const output=quoteBody.output;
    const price=amount(output?.stck_prpr),unit=amount(output?.aspr_unit);
    if(price<=0||unit<=0||command.limitPrice%unit!==0||output.temp_stop_yn!=='N')throw new KisError('INVALID_ORDER');
    if(Math.abs(command.limitPrice/price-1)>.02)throw new KisError('PRICE_MOVED');
    const balance=await this.getBalance();let availableQuantity;
    if(command.side==='Buy') {
      const body=await this.tradingQuery('inquire-psbl-order',this.#credentials.environment==='live'?'TTTC8908R':'VTTC8908R',{PDNO:command.symbol,ORD_UNPR:String(command.limitPrice),ORD_DVSN:'01',CMA_EVLU_AMT_ICLD_YN:'N',OVRS_ICLD_YN:'N'});
      const cash=amount(body.output?.nrcvb_buy_amt),quantity=amount(body.output?.nrcvb_buy_qty);
      if(command.quantity>quantity || command.limitPrice*command.quantity*1.02>cash)throw new KisError('INSUFFICIENT_CAPACITY');availableQuantity=quantity;
    } else {availableQuantity=balance.holdings.find(row=>row.symbol===command.symbol)?.availableQuantity;if(availableQuantity==null || command.quantity>availableQuantity)throw new KisError('INSUFFICIENT_CAPACITY');}
    const {orders}=await this.getActivity('orders',today,today);
    if(orders.some(order=>order.remaining>0 && ['Pending','Partially filled'].includes(order.status)))throw new KisError('OPEN_BROKER_ORDERS');
    return {balance,price,unit,availableQuantity,checkedAt:Date.now()};
  }
  async placeOrder(command) {
    await this.authenticate();await this.wait(550);
    const params={CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,PDNO:command.symbol,ORD_DVSN:'00',ORD_QTY:String(command.quantity),ORD_UNPR:String(command.limitPrice),EXCG_ID_DVSN_CD:'KRX',SLL_TYPE:command.side==='Sell'?'01':'',CNDT_PRIC:''};
    try {
      const {body}=await this.request('/uapi/domestic-stock/v1/trading/order-cash',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:(this.#credentials.environment==='live'?'T':'V')+(command.side==='Buy'?'TTC0012U':'TTC0011U'),custtype:'P'},body:JSON.stringify(params)});
      if(body.rt_cd!=='0')throw new KisError('BROKER_REJECTED');
      if(typeof body.output?.ODNO!=='string' || !/^\d+$/.test(body.output.ODNO))throw new KisError('ORDER_UNCERTAIN');
      return {brokerOrderId:body.output.ODNO,organization:body.output.KRX_FWDG_ORD_ORGNO??'',acceptedAt:new Date().toISOString()};
    }catch(error){throw new KisError(error.code==='BROKER_REJECTED'?'BROKER_REJECTED':'ORDER_UNCERTAIN');}
  }
}
module.exports={KisReadOnlyClient,KisError,parseCredentials,normalizeBalance};
