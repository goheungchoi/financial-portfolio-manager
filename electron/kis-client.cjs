const ORIGINS = { live:'https://openapi.koreainvestment.com:9443', mock:'https://openapivts.koreainvestment.com:29443' };
class KisError extends Error { constructor(code) { super(code); this.code=code; } }
// The token fix, review 2: an order, revision or cancellation, and its preparation's reads, never wait for a sign-in. They
// run inside SEND; with no valid token in hand, or one KIS has just ended, they are refused at once as not sent
// (TOKEN_EXPIRED) while the sign-in runs on outside SEND.
const {AsyncLocalStorage}=require('node:async_hooks');const SEND=new AsyncLocalStorage();
// The token fix, review 2: KIS allows one token request a minute per app key, so the minute is kept per key, across every
// client in this process (Reconnect and an account switch build a new one) and, through a small file the main process
// names (KIS_TOKEN_CLOCK), across the KIS broker and market-calendar workers. The key is kept only as a short hash.
// Kept per KIS endpoint (the transport: the app uses one fetch for all its clients) and per key.
const TOKEN_CLOCK=new WeakMap();const clockOf=transport=>{if(!TOKEN_CLOCK.has(transport))TOKEN_CLOCK.set(transport,new Map());return TOKEN_CLOCK.get(transport);};
// Fourth review: a keyed hash (HMAC) with a random value made once per install and kept beside the file, so the file says
// nothing about the key outside this machine; without the file, a random value for this process.
// Fifth review: the file is read at every use (only at a sign-in), so a process never keeps a value that is not the
// file's while the file is readable. A new value is written to a temp file and linked into place only where no file is
// (a link never overwrites, so two workers racing end on the one that landed; an unreadable, invalid file is replaced);
// then the file is read again and its value used. Only when it cannot be read is a value for this process used.
let PROCESS_SECRET=null;const processSecret=()=>PROCESS_SECRET??=require('node:crypto').randomBytes(32).toString('hex');
function secret(){const f=process.env.KIS_TOKEN_CLOCK;if(!f)return processSecret();const fs=require('node:fs'),p=f+'.secret';
  const valid=()=>{try{const v=fs.readFileSync(p,'utf8').trim();return /^[0-9a-f]{64}$/.test(v)?v:null;}catch{return null;}};
  const v=valid();if(v)return v;
  const tmp=`${p}.${process.pid}.${Date.now()}.tmp`;try{fs.writeFileSync(tmp,require('node:crypto').randomBytes(32).toString('hex'));
    try{fs.linkSync(tmp,p);}catch(error){if(error?.code==='EEXIST'){if(!valid())fs.renameSync(tmp,p);}else if(!fs.existsSync(p))fs.renameSync(tmp,p);}}catch{}finally{try{fs.unlinkSync(tmp);}catch{}}
  return valid()??processSecret();}
const keyHash=appKey=>require('node:crypto').createHmac('sha256',secret()).update(String(appKey)).digest('hex').slice(0,16);
function clockFile(){const f=process.env.KIS_TOKEN_CLOCK;if(!f)return {};try{const v=JSON.parse(require('node:fs').readFileSync(f,'utf8'));return v&&typeof v==='object'?v:{};}catch{return {};}}
// A stored time in the future (the file a day ahead, or the PC's clock set back) counts as now: never more than a minute's wait.
function lastTokenAt(transport,appKey){const k=keyHash(appKey);return Math.min(Date.now(),Math.max(clockOf(transport).get(k)??-Infinity,Number(clockFile()[k])||-Infinity));}
function noteTokenAt(transport,appKey,at){const k=keyHash(appKey);clockOf(transport).set(k,at);const f=process.env.KIS_TOKEN_CLOCK;if(!f)return;
  try{const fsx=require('node:fs');const v=clockFile();v[k]=at;for(const [x,t] of Object.entries(v))if(!(Number(t)>at-3600000))delete v[x];const tmp=f+'.'+process.pid+'.tmp';fsx.writeFileSync(tmp,JSON.stringify(v));try{fsx.renameSync(tmp,f);}catch{try{fsx.unlinkSync(tmp);}catch{}}}catch{}}// sixth review: a temp file whose rename failed (another worker's) is removed
const tokenExpired=brokerCode=>Object.assign(new KisError('TOKEN_EXPIRED'),{notSent:true,...(brokerCode?{brokerCode}:{})});
// What a failed order request means (M-1a): KIS refused it, it never left the app (refused by the request-limit window
// before it was sent: ORDER_NOT_SENT, with when to try again), or anything else, which may have reached KIS.
// A rate limit KIS returns for the request itself stays uncertain: the request was sent.
// A KIS refusal (rt_cd not 0) with KIS's message code (msg_cd) kept, and nothing else of the reply.
// KIS's message for a refusal (msg1), kept beside its code: at most 120 characters, control characters removed, any run
// of 6 or more digits masked (no account or order numbers), so it can be shown and saved with the failure.
function brokerText(body){const t=typeof body?.msg1==='string'?body.msg1:'';const c=t.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\d{6,}/g,'…').replace(/\s+/g,' ').trim().slice(0,120);return c||null;}
function brokerFields(body){return {...(/^[A-Z0-9_-]{1,24}$/.test(String(body?.msg_cd??''))?{brokerCode:body.msg_cd}:{}),...(brokerText(body)?{brokerMessage:brokerText(body)}:{})};}
function rejected(body){return Object.assign(new KisError('BROKER_REJECTED'),brokerFields(body));}
function orderError(error){if(error?.code==='BROKER_REJECTED')return Object.assign(new KisError('BROKER_REJECTED'),error.brokerCode?{brokerCode:error.brokerCode}:{},error.brokerMessage?{brokerMessage:error.brokerMessage}:{},Array.isArray(error.loanDateTried)?{loanDateTried:error.loanDateTried}:{});
  // The token fix (artifacts/reviews/2026-11-24-kis-token): KIS's gateway refused the order's expired sign-in, so it is not
  // at KIS; it keeps its own code so a stop stays armed and is tried again with the renewed sign-in.
  if(error?.code==='TOKEN_EXPIRED')return Object.assign(new KisError('TOKEN_EXPIRED'),{notSent:true});
  if(error?.notSent===true){const e=new KisError('ORDER_NOT_SENT');if(Number.isFinite(error.retryAt))e.retryAt=error.retryAt;return e;}
  return new KisError('ORDER_UNCERTAIN');}
function parseCredentials(text) {
  try {
    const value=JSON.parse(text);
    const keys=['environment','appKey','appSecret','accountNumber','accountProductCode'];
    if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)) || typeof value.environment!=='string' || !Object.hasOwn(ORIGINS,value.environment) || typeof value.accountNumber!=='string' || !/^\d{8}$/.test(value.accountNumber) || value.accountProductCode!=='01') throw 0;
    for(const key of ['appKey','appSecret']) if(typeof value[key]!=='string' || !/^[A-Za-z0-9_\-+/=]{1,256}$/.test(value[key])) throw 0;
    return Object.fromEntries(keys.map(key=>[key,value[key]]));
  } catch { throw new KisError('INVALID_CREDENTIAL_FILE'); }
}
// HHMMSS in Seoul, as KIS minute requests take it.
const seoulClock=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(value).replaceAll(':','');
function amount(value) {
  if(typeof value!=='string' && typeof value!=='number') throw new KisError('INVALID_RESPONSE');
  if(String(value).trim()==='' || !/^-?\d+(\.\d+)?$/.test(String(value))) throw new KisError('INVALID_RESPONSE');
  const number=Number(value);
  if(!Number.isFinite(number) || Math.abs(number)>Number.MAX_SAFE_INTEGER) throw new KisError('INVALID_RESPONSE');
  return number;
}
// KIS credit types (CRDT_TYPE): 21/23 margin loan (self/distribution), 25/27 its repayment by sale;
// 24/22 short sale by stock loan (self/distribution), 28/26 its repayment by purchase.
const CREDIT_KINDS={'margin-buy':{side:'Buy',types:['21','23']},'margin-sell':{side:'Sell',types:['25','27'],repay:true},short:{side:'Sell',types:['24','22']},cover:{side:'Buy',types:['28','26'],repay:true}};
function normalizeBalance(rows,summary,environment) {
  if(!summary || !Array.isArray(rows)) throw new KisError('INVALID_RESPONSE');
  // Credit accounts report one row per symbol and credit type (cash, 융자 margin loans by loan date, 대주 short sales).
  // Margin rows merge into the holding with their loans listed; short rows become separate short positions.
  const bySymbol=new Map(),shorts=[];const day=v=>/^\d{8}$/.test(String(v??''))?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:null;
  for(const row of rows) {
    const quantity=amount(row.hldg_qty);
    if(quantity===0) continue;
    if(quantity<0 || !/^[A-Z0-9]{6}$/.test(row.pdno) || typeof row.prdt_name!=='string') throw new KisError('INVALID_RESPONSE');
    const type=String(row.trad_dvsn_name??'');const credit=type.includes('대주')?'short':type.includes('융자')?'margin':'cash';
    const line={quantity,cost:amount(row.pchs_avg_pric),price:amount(row.prpr),marketValue:amount(row.evlu_amt),unrealized:amount(row.evlu_pfls_amt),available:row.ord_psbl_qty===undefined?null:amount(row.ord_psbl_qty)};
    if(line.cost<0 || line.price<0 || line.marketValue<0) throw new KisError('INVALID_RESPONSE');
    if(credit==='short'){const proceeds=row.stln_slng_chgs==null||String(row.stln_slng_chgs).trim()===''?null:amount(row.stln_slng_chgs);// loanAmount: the obligation at market (loan_amt; found in live use to be the price times the quantity).
      const loanAmount=row.loan_amt==null||String(row.loan_amt).trim()===''?null:amount(row.loan_amt);
      shorts.push({symbol:row.pdno,name:row.prdt_name.slice(0,120),quantity,price:line.price,entryPrice:proceeds!=null&&quantity?Math.round(proceeds/quantity):line.cost||null,proceeds,loanAmount,loanDate:day(row.loan_dt),expiry:day(row.expd_dt),source:type.includes('자기')?'self':'distribution',availableQuantity:line.available});continue;}
    const existing=bySymbol.get(row.pdno);
    if(credit==='cash'&&existing?.cashRow)throw new KisError('INVALID_RESPONSE');
    const holding=existing??{symbol:row.pdno,name:row.prdt_name.slice(0,120),quantity:0,cost:0,price:line.price,marketValue:0,unrealized:0,availableQuantity:null,loans:[],cashRow:false};
    holding.cost=(holding.cost*holding.quantity+line.cost*quantity)/(holding.quantity+quantity);holding.quantity+=quantity;holding.marketValue+=line.marketValue;holding.unrealized+=line.unrealized;holding.price=line.price;
    if(line.available!=null)holding.availableQuantity=(holding.availableQuantity??0)+line.available;
    if(credit==='margin')holding.loans.push({quantity,amount:row.loan_amt==null||String(row.loan_amt).trim()===''?null:amount(row.loan_amt),loanDate:day(row.loan_dt),expiry:day(row.expd_dt),source:type.includes('자기')?'self':'distribution',availableQuantity:line.available});else holding.cashRow=true;
    bySymbol.set(row.pdno,holding);
  }
  const holdings=[...bySymbol.values()].map(({loans,cashRow,...h})=>loans.length?{...h,loans}:h);
  const settled=summary.prvs_rcdl_excc_amt,optional=v=>v==null||String(v).trim()===''?null:amount(v);
  const loanTotal=optional(summary.tot_loan_amt),shortProceeds=optional(summary.tot_stln_slng_chgs),netAssets=optional(summary.nass_amt),credit=Boolean(loanTotal||shortProceeds||shorts.length);
  // With loans or shorts outstanding, the account value for risk is net assets (total value minus loans and short obligations).
  // D4: a reading taken while KIS moves last night's settlement is marked (settlement-check.cjs); a consistent one is unchanged.
  const raw=require('./broker-raw.cjs').numericFields(summary),settlementCheck=require('./settlement-check.cjs').krCheck(raw);
  return {source:'kis',environment,timestamp:new Date().toISOString(),raw,...(settlementCheck?{settlementCheck}:{}),cash:amount(summary.dnca_tot_amt),settledCash:settled==null||String(settled).trim()===''?null:amount(settled),reportedTotal:credit&&netAssets!=null?netAssets:amount(summary.tot_evlu_amt),holdings,...(credit?{shorts,loanTotal,shortProceeds,netAssets,grossTotal:amount(summary.tot_evlu_amt)}:{})};
}
class KisReadOnlyClient {
  #credentials; #token; #expires=0; #streamConfig; #streamConfigUntil=0;
  constructor(credentials,transport=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
    this.#credentials=parseCredentials(JSON.stringify(credentials)); this.transport=transport; this.wait=wait;
  }
  // KIS ended the sign-in before its own expiry (EGW00123 expired, EGW00121 invalid; seen live 2026-11-24). The token is
  // renewed through authenticate, which is single-flight and keeps KIS's one-token-a-minute rule for every sign-in (the
  // first, the natural expiry and a renewal); a failed token request makes the next try wait a minute. A GET is retried
  // once with the new token; an order, revision or cancellation is thrown not sent (TOKEN_EXPIRED) at once while the
  // renewal runs on. A failed renewal throws the GET's original error, as before.
  static tokenGone(error){return ['EGW00123','EGW00121'].includes(error?.brokerCode);}
  // used: the Authorization header the refused request carried. A token renewed since by another request is kept.
  renewToken(used){if(this.#token&&used&&used!=='Bearer '+this.#token&&Date.now()<this.#expires)return Promise.resolve();this.#expires=0;return this.authenticate();}
  async request(path,options) {
    const first=this.queued(path,options);if(path==='/oauth2/tokenP'||options?.renewed)return first;
    return first.catch(async error=>{if(!KisReadOnlyClient.tokenGone(error))throw error;const used=options?.headers?.authorization;
      const get=String(options?.method??'GET').toUpperCase()==='GET';
      if(!get||SEND.getStore()){SEND.exit(()=>this.renewToken(used)).catch(()=>{});throw tokenExpired(error.brokerCode);}
      try{await this.renewToken(used);}catch{throw error;}
      return this.queued(path,{...options,renewed:true,headers:{...options.headers,...(used?{authorization:'Bearer '+this.#token}:{})}});});
  }
  queued(path,options) {
    const task=(this.httpQueue??Promise.resolve()).then(async()=>{
      for(let attempt=0;attempt<2;attempt++){
        // Fourth review: a time from before the PC's clock was set back never stretches a wait (the spacing at most its own
        // length; a request-limit pause at most its five minutes).
        const gap=this.#credentials.environment==='mock'?1500:650;const spacing=Math.min(gap,gap-(Date.now()-(this.lastHttpAt??0)));if(spacing>0)await this.wait(spacing);
        if((this.rateLimitedUntil??0)>Date.now()+300000)this.rateLimitedUntil=Date.now()+300000;
        // notSent: refused here, before the request left the app (M-1a); an order request refused so is not at KIS.
        if(Date.now()<(this.rateLimitedUntil??0)){const error=new KisError('RATE_LIMITED');error.retryAt=this.rateLimitedUntil;error.notSent=true;throw error;}
        this.lastHttpAt=Date.now();if(path==='/oauth2/tokenP')noteTokenAt(this.transport,this.#credentials.appKey,this.lastHttpAt);// the minute counts from when a token request leaves, per app key
        try{return await this.performRequest(path,options);}catch(error){if(error.code==='RATE_LIMITED'){this.throttleCount=(Date.now()-(this.lastThrottleAt??0)>600000?0:this.throttleCount??0)+1;this.lastThrottleAt=Date.now();this.rateLimitedUntil=Date.now()+Math.min(300000,60000*2**(this.throttleCount-1));error.retryAt=this.rateLimitedUntil;}if(options.method!=='GET'||attempt===1||KisReadOnlyClient.tokenGone(error)||!['NETWORK_UNAVAILABLE','REQUEST_TIMEOUT','SERVER_ERROR'].includes(error.code))throw error;await this.wait(1200);}
      }
    });this.httpQueue=task.catch(()=>{});return task;
  }
  async performRequest(path,options) {
    try {
      const response=await this.transport(ORIGINS[this.#credentials.environment]+path,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      const text=await response.text();
      if(text.length>2000000) throw new KisError('INVALID_RESPONSE');
      let body;try{body=JSON.parse(text);}catch{if(response.ok)throw new KisError('INVALID_RESPONSE');}
      if(!response.ok||body?.msg_cd==='EGW00201'||['EGW00123','EGW00121'].includes(body?.msg_cd)){const info=require('./broker-errors.cjs').responseError(response.status,body);const error=new KisError(info.reason);error.brokerCode=info.brokerCode;error.httpStatus=info.httpStatus;throw error;}
      if(!body||typeof body!=='object')throw new KisError('INVALID_RESPONSE');return {body,continuation:response.headers.get('tr_cont')};
    } catch(error) { if(error instanceof KisError)throw error;throw new KisError(['TimeoutError','AbortError'].includes(error.name)?'REQUEST_TIMEOUT':'NETWORK_UNAVAILABLE'); }
  }
  // Single-flight: every caller that needs a token while one is being requested waits for that one. At most one token
  // request a minute (tokenAt: the last request, failed or not).
  lastTokenRequest(){return lastTokenAt(this.transport,this.#credentials.appKey);}
  authenticate() {
    if(this.#token && Date.now()<this.#expires) return Promise.resolve();
    // In a send: a sign-in that would have to wait (one already running, or the minute not over) is not waited for.
    if(SEND.getStore()&&(this.authing||Date.now()-(this.lastTokenRequest()??-Infinity)<60000)){SEND.exit(()=>this.authenticate()).catch(()=>{});return Promise.reject(tokenExpired());}
    if(!this.authing)this.authing=this.signIn().finally(()=>{this.authing=null;});
    return this.authing;
  }
  async signIn() {
    const wait=60000-(Date.now()-this.lastTokenRequest());if(wait>0){try{this.onSignInWait?.(wait);}catch{}await this.wait(wait);}
    if(this.#token && Date.now()<this.#expires) return;
    const {body}=await this.request('/oauth2/tokenP',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret})});
    if(typeof body.access_token!=='string' || !/^[A-Za-z0-9._\-+/=]+$/.test(body.access_token) || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in)<60) throw new KisError('AUTH_FAILED');
    this.#token=body.access_token;this.#expires=Date.now()+(Number(body.expires_in)-30)*1000;
  }
  async quotation(endpoint,trId,params) {
    await this.authenticate();await this.wait(550);
    const {body}=await this.request((/^\/uapi\/(domestic-stock|etfetn)\/v1\//.test(endpoint)?endpoint:'/uapi/domestic-stock/v1/quotations/'+endpoint)+'?'+new URLSearchParams(params),{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P'}});
    // KIS's message code goes with the refusal (audit 2026-11-19: a refusal reached the log as BROKER_REJECTED with no code).
    if(body.rt_cd!=='0')throw rejected(body);
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
    return (await this.minutePage(symbol,seoulClock(new Date()))).slice(-30);
  }
  // Today's one-minute bars from the open: KIS returns 30 bars up to a given time, so pages step back before the
  // oldest bar until the open or the page limit.
  async getMinuteDay(symbol,maxPages=14,now=new Date()) {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(t));const today=day(now.getTime());const rows=new Map();let hour=seoulClock(now);
    for(let page=0;page<maxPages;page++){
      const batch=await this.minutePage(symbol,hour),todays=batch.filter(c=>day(c.timestamp)===today);for(const c of todays)rows.set(c.timestamp,c);
      if(!todays.length||todays.length<batch.length||batch.length<30)break;const oldest=Math.min(...todays.map(c=>c.timestamp));hour=seoulClock(new Date(oldest-60000));if(hour<'090000')break;
    }
    return [...rows.values()].sort((a,b)=>a.timestamp-b.timestamp);
  }
  async minutePage(symbol,hour) {
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
    }).sort((a,b)=>a.timestamp-b.timestamp);
  }
  // market: J = KRX, NX = Nextrade (its pre- and after-market prices).
  async getQuote(symbol,market='J') {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const body=await this.quotation('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:['J','NX'].includes(market)?market:'J',FID_INPUT_ISCD:symbol});
    const price=amount(body.output?.stck_prpr);
    if(price<=0)throw new KisError('INVALID_RESPONSE');
    const o=body.output??{};const n=v=>{const x=Number(v);return v!=null&&String(v).trim()!==''&&Number.isFinite(x)?x:null;};
    return {symbol,price,retrievedAt:Date.now(),previousClose:n(o.stck_sdpr),changePct:n(o.prdy_ctrt),volume:n(o.acml_vol)};
  }
  // KIS returns at most 100 rows per request; extra pages continue before the earliest row. period: D daily, W weekly, M monthly.
  async getDailyHistory(symbol,pages=1,period='D') {
    if(typeof symbol!=='string' || !/^[A-Z0-9]{6}$/.test(symbol))throw new KisError('INVALID_INSTRUMENT');
    const rows=new Map();let end=new Date();
    for(let page=0;page<pages;page++){
      const batch=await this.dailyPage(symbol,end,period);for(const candle of batch)rows.set(candle.timestamp,candle);
      if(batch.length<90)break;end=new Date(Math.min(...batch.map(c=>c.timestamp))-86400000);
    }
    return [...rows.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-100*pages);
  }
  // A window long enough for 100 rows of the period.
  async dailyPage(symbol,end,period='D') {
    const start=new Date(end.getTime()-({D:180,W:760,M:3100}[period]??180)*86400000);
    const date=value=>{
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
      return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('');
    };
    const body=await this.quotation('inquire-daily-itemchartprice','FHKST03010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:date(start),FID_INPUT_DATE_2:date(end),FID_PERIOD_DIV_CODE:['D','W','M'].includes(period)?period:'D',FID_ORG_ADJ_PRC:'0'});
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
    }).sort((a,b)=>a.timestamp-b.timestamp);
  }
  async getBalance() {
    await this.authenticate();
    let fk='',nk='',continuation=''; const rows=[]; let summary; const cursors=new Set();
    for(let page=0;page<10;page++) {
      await this.wait(550);
      const params=new URLSearchParams({CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,AFHR_FLPR_YN:'N',OFL_YN:'',INQR_DVSN:'02',UNPR_DVSN:'01',FUND_STTL_ICLD_YN:'N',FNCG_AMT_AUTO_RDPT_YN:'N',PRCS_DVSN:'00',CTX_AREA_FK100:fk,CTX_AREA_NK100:nk});
      const result=await this.request('/uapi/domestic-stock/v1/trading/inquire-balance?'+params,{method:'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:this.#credentials.environment==='live'?'TTTC8434R':'VTTC8434R',custtype:'P',tr_cont:continuation}});
      if(result.body.rt_cd!=='0') throw rejected(result.body);
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
      if(result.body.rt_cd!=='0')throw rejected(result.body);
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
    if(body.rt_cd!=='0'){const error=new KisError(body.msg_cd==='APBK1617'?'CREDIT_ACCOUNT_REQUIRED':'BROKER_REJECTED');error.brokerCode=typeof body.msg_cd==='string'?body.msg_cd:null;if(brokerText(body))error.brokerMessage=brokerText(body);throw error;}return body;
  }
  // One domestic order's executions and the broker's fee-plus-tax figure (prsm_tlex_smtl), via the daily order inquiry.
  async getOrderCharges(day,orderId) {
    if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||typeof orderId!=='string'||!/^\d{1,20}$/.test(orderId))throw new KisError('INVALID_REQUEST');
    const date=day.replaceAll('-','');
    const body=await this.tradingQuery('inquire-daily-ccld',this.#credentials.environment==='live'?'TTTC0081R':'VTTC0081R',{INQR_STRT_DT:date,INQR_END_DT:date,SLL_BUY_DVSN_CD:'00',PDNO:'',CCLD_DVSN:'00',INQR_DVSN:'00',INQR_DVSN_3:'00',ORD_GNO_BRNO:'',ODNO:orderId,INQR_DVSN_1:'',EXCG_ID_DVSN_CD:'ALL',CTX_AREA_FK100:'',CTX_AREA_NK100:''});
    const rows=(Array.isArray(body.output1)?body.output1:[]).filter(row=>String(row.odno)===orderId);const summary=Array.isArray(body.output2)?body.output2[0]:body.output2;
    const value=v=>v==null||String(v).trim()===''?null:Number(v);const charges=value(summary?.prsm_tlex_smtl);
    if(!rows.length||!summary||!Number.isFinite(charges)||charges<0)throw new KisError('INVALID_RESPONSE');
    return {orderId,filled:rows.reduce((n,row)=>n+Number(row.tot_ccld_qty||0),0),amount:rows.reduce((n,row)=>n+Number(row.tot_ccld_amt||0),0),charges,retrievedAt:Date.now()};
  }
  async overseasRequest(endpoint,trId,params,{post=false,continuation='',includeAccount=true}={}) {
    await this.authenticate();await this.wait(550);
    const account=includeAccount&&endpoint.startsWith('/uapi/overseas-stock/')?{CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode}:{};
    const payload={...account,...params};
    const result=await this.request(endpoint+(post?'':'?'+new URLSearchParams(payload)),{method:post?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:trId,custtype:'P',tr_cont:continuation},...(post?{body:JSON.stringify(payload)}:{})});
    if(result.body.rt_cd!=='0')throw rejected(result.body);return result;
  }
  overseasIdentity(){return {environment:this.#credentials.environment,accountKey:require('node:crypto').createHmac('sha256',this.#credentials.appSecret).update(this.#credentials.environment+this.#credentials.accountNumber+this.#credentials.accountProductCode).digest('hex')+':US'};}
  // session: an extended session from market-sessions.tradableNow (its hours were checked there); it still needs a trading day.
  async checkSession(session=null) {
    const {seoulDate}=require('./kis-activity.cjs');const today=seoulDate();
    const local=new Date(Date.now()+9*3600000);const minutes=local.getUTCHours()*60+local.getUTCMinutes();
    // The regular window moves on the days listed in kr-hours.cjs (2026-11-19: 10:00–16:20).
    const w=require('./kr-hours.cjs').krWindow(today);
    if(!(session&&!session.regular)&&(minutes<w.open || minutes>=w.appEnd))throw new KisError('SESSION_CLOSED');
    // The mock server has no holiday calendar (CTCA0903R returns EGW02006), so mock accounts use weekdays and hours; the broker still rejects holiday orders.
    if(this.#credentials.environment!=='live'){if([0,6].includes(local.getUTCDay()))throw new KisError('SESSION_CLOSED');return {open:true,basis:'trading hours (holiday calendar unavailable on mock accounts)'};}
    if(!this.holidayDay || this.holidayDay!==today) {
      const body=await this.quotation('chk-holiday','CTCA0903R',{BASS_DT:today.replaceAll('-',''),CTX_AREA_FK:'',CTX_AREA_NK:''});
      const rows=Array.isArray(body.output)?body.output:[body.output];const day=rows.find(row=>row?.bass_dt===today.replaceAll('-',''));
      if(!day || day.opnd_yn!=='Y')throw new KisError('SESSION_CLOSED');this.holidayDay=today;
    }
    return {open:true,basis:'KRX holiday calendar and trading hours'};
  }
  // Runs fn as a send (no waiting for a sign-in): the overseas client's prepare, place and revise use it too.
  sending(fn){return SEND.run(true,fn);}
  prepareOrder(...args){return SEND.run(true,()=>this.prepareOrderNow(...args));}
  async prepareOrderNow(command,session=null,{severalOpen=false}={}) {
    if(session&&!session.regular&&command?.credit!=null)throw new KisError('FEATURE_UNAVAILABLE');
    if(!command||!/^\d{6}$/.test(command.symbol)||!['Buy','Sell'].includes(command.side)||!Number.isSafeInteger(command.quantity)||command.quantity<1||command.quantity>10000||!Number.isSafeInteger(command.limitPrice)||command.limitPrice<=0)throw new KisError('INVALID_ORDER');
    if(command.credit!=null){
      const spec=CREDIT_KINDS[command.credit?.kind];if(!spec||spec.side!==command.side||!spec.types.includes(command.credit.type)||spec.repay&&!/^\d{4}-\d{2}-\d{2}$/.test(command.credit.loanDate??''))throw new KisError('INVALID_ORDER');
      if(this.#credentials.environment!=='live')throw new KisError('FEATURE_UNAVAILABLE');
    }
    // A credit path whose fields are not confirmed is refused before any request, after the order is checked (as propose, send and placeCreditOrder).
    // The worker checks the code's paths (shortsOn); the engine checks the switch.
    if(command?.credit!=null&&!require('./credit-paths.cjs').pathStatus(command.credit?.kind,{shortsOn:true}).executable)throw new KisError('CREDIT_PATH_UNVERIFIED');
    await this.checkSession(session);const {seoulDate}=require('./kis-activity.cjs');const today=seoulDate();
    const quoteBody=await this.quotation('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:session?.route?.quote==='NX'?'NX':'J',FID_INPUT_ISCD:command.symbol});const output=quoteBody.output;
    const price=amount(output?.stck_prpr),unit=amount(output?.aspr_unit);
    if(price<=0||unit<=0||command.limitPrice%unit!==0||output.temp_stop_yn!=='N')throw new KisError('INVALID_ORDER');
    if(Math.abs(command.limitPrice/price-1)>.02)throw new KisError('PRICE_MOVED');
    // Short selling B3d-1: a short sale's price at or above the uptick floor from the price read now (the last trade; in
    // the opening auction KIS's current price is the previous close).
    if(command.credit?.kind==='short'){const floor=require('./short-rules.cjs').floorPrice(price);if(floor==null||command.limitPrice<floor)throw new KisError('SHORT_BELOW_UPTICK');}
    // capacity (M-1.5b): KIS's orderable answer for this order, numeric fields only, for broker_capacity (broker-raw.cjs).
    const balance=await this.getBalance();let availableQuantity;let capacity=null,shortCash=null,sendPlan=null,alternateDropped=null;const numeric=require('./broker-raw.cjs').numericFields;
    if(command.credit) {
      // New margin loans and short sales: the broker's credit capacity. Repayments: the matching loan or short position.
      const {kind,type,loanDate}=command.credit;
      // APBK1617: the account has no KIS credit-trading agreement (신용계좌만 신용주문가능금액조회가 가능합니다).
      // B3c: a short's capacity is KIS's lending list for the stock (CTSC2702R), read now; TTTC8909R answers new margin
      // loans only (read 2026-11-23). The stock's market (KOSPI or KOSDAQ) comes with the command.
      if(kind==='short'){const R=require('./short-rules.cjs');const read=await this.getLendable(command.symbol,command.credit.market);const ok=R.borrowable(read,command.quantity,Date.now(),{symbol:command.symbol,market:command.credit.market});
        if(!ok.ok)throw new KisError(ok.code);availableQuantity=ok.tradable;capacity={tr:'CTSC2702R',fields:{trad_psbl_qty2:read.tradable,lmt_qty1:read.limit,use_qty1:read.used}};}
      else if(kind==='margin-buy'){const body=await this.tradingQuery('inquire-credit-psamount','TTTC8909R',{PDNO:command.symbol,ORD_UNPR:String(command.limitPrice),ORD_DVSN:'00',CRDT_TYPE:type,CMA_EVLU_AMT_ICLD_YN:'N',OVRS_ICLD_YN:'N'});availableQuantity=amount(body.output?.max_buy_qty);capacity={tr:'TTTC8909R',fields:numeric(body.output)};}
      else if(kind==='margin-sell'){const loan=balance.holdings.find(row=>row.symbol===command.symbol)?.loans?.find(row=>row.loanDate===loanDate);availableQuantity=loan?loan.availableQuantity??loan.quantity:null;}
      else {const short=balance.shorts?.find(row=>row.symbol===command.symbol&&row.loanDate===loanDate);availableQuantity=short?short.availableQuantity??short.quantity:null;
        // Shorts on, stages 1b-1c: no date sent for a cover, first or alternate, names another short lot of this stock in
        // this balance (guardPlan).
        if(command.credit.send!=null){const LD=require('./short-loan-date.cjs');const plan=LD.validPlan('cover',command.credit.send);if(!plan)throw new KisError('INVALID_ORDER');const d=LD.guardPlan(plan,{symbol:command.symbol,loanDate,balance});sendPlan=d.plan;if(d.dropped)alternateDropped=d.dropped;}}
      if(availableQuantity==null||command.quantity>availableQuantity)throw new KisError('INSUFFICIENT_CAPACITY');
    } else if(command.side==='Buy') {
      const body=await this.tradingQuery('inquire-psbl-order',this.#credentials.environment==='live'?'TTTC8908R':'VTTC8908R',{PDNO:command.symbol,ORD_UNPR:String(command.limitPrice),ORD_DVSN:'01',CMA_EVLU_AMT_ICLD_YN:'N',OVRS_ICLD_YN:'N'});
      // Short selling B3d-1: while the balance shows an open short, an orderable figure that cannot be read makes the buy
      // wait (KIS may hold cash against the short); with no short, as before.
      // Your own order ticket (yours) keeps today's check and codes, short or not; it only carries the fact for its screen.
      const shortOpen=(balance.shorts??[]).length>0,yours=command.yours===true;
      let cash,quantity;try{cash=amount(body.output?.nrcvb_buy_amt);quantity=amount(body.output?.nrcvb_buy_qty);}catch(error){if(shortOpen&&!yours)throw new KisError('SHORT_OPEN_CASH_UNKNOWN');throw error;}capacity={tr:'TTTC8908R',fields:numeric(body.output)};
      if(shortOpen&&yours)shortCash={orderableCash:cash};
      if(command.quantity>quantity || command.limitPrice*command.quantity*1.02>cash)throw new KisError('INSUFFICIENT_CAPACITY');availableQuantity=quantity;
    } else {{const held=balance.holdings.find(row=>row.symbol===command.symbol);capacity={tr:'balance',fields:{ord_psbl_qty:held?.availableQuantity,hldg_qty:held?.quantity}};}availableQuantity=balance.holdings.find(row=>row.symbol===command.symbol)?.availableQuantity;if(availableQuantity==null || command.quantity>availableQuantity)throw new KisError('INSUFFICIENT_CAPACITY');}
    const {orders}=await this.getActivity('orders',today,today);
    const open=require('./broker-open-orders.cjs').openGuard(orders,command,{severalOpen,fail:()=>new KisError('OPEN_BROKER_ORDERS')});
    // The token fix, third review: today's orders at KIS (orders, not revisions), whatever their status, for the resend check.
    const todayOrders=(orders??[]).filter(o=>!o.originalOrderId).map(o=>({orderId:String(o.orderId),symbol:o.symbol,side:o.side,quantity:Number.isFinite(o.quantity)?o.quantity:null,timestamp:Number.isFinite(o.timestamp)?o.timestamp:null,status:o.status}));
    return {balance,price,unit,availableQuantity,checkedAt:Date.now(),...open,todayOrders,...(capacity?{capacityRaw:{...capacity,at:Date.now()}}:{}),...(shortCash?{shortCash}:{}),...(sendPlan?{sendPlan}:{}),...(alternateDropped?{alternateDropped}:{})};
  }
  // B3c: KIS's lending list for one stock (CTSC2702R, lendable-by-company), read just before a short: the row for this
  // stock as short-rules reads it, or one that is not open when the stock is not listed (not lendable now).
  async getLendable(symbol,market){const R=require('./short-rules.cjs');const code=R.lendExchange(market);if(!/^[0-9A-Z]{6}$/.test(String(symbol??'')))throw new KisError('INVALID_ORDER');
    const body=await this.quotation('lendable-by-company','CTSC2702R',{EXCG_DVSN_CD:code,PDNO:symbol,THCO_STLN_PSBL_YN:'Y',INQR_DVSN_1:'1',CTX_AREA_FK200:'',CTX_AREA_NK100:''});
    const row=(Array.isArray(body.output1)?body.output1:[]).find(r=>r?.pdno===symbol);return row?R.parseBorrowable(row,Date.now(),code):{symbol,exchange:code,open:false,tradable:0,limit:null,used:null,at:Date.now()};}
  // Credit order (order-credit): margin buy/repay and short sale/cover. Live accounts only; KIS does not support it on mock.
  async placeCreditOrder(command) {
    // Only a credit path whose fields are confirmed is ever sent (electron/credit-paths.cjs, audit 2026-11-04 Stage 3).
    if(!require('./credit-paths.cjs').pathStatus(command.credit?.kind,{shortsOn:true}).executable)throw new KisError('CREDIT_PATH_UNVERIFIED');
    await this.authenticate();await this.wait(550);const {seoulDate}=require('./kis-activity.cjs');
    // Shorts on (2026-11-25): a short or cover sends the loan date of its plan (short-loan-date: the engine's, with the
    // app's calendar and the remembered form; without one, the default form on weekdays and no alternate), and on a KIS
    // refusal the plan's alternate once. A margin buy sends today, a margin repayment its loan's date, with no alternate.
    const kind=command.credit.kind,LD=require('./short-loan-date.cjs');
    const plan=kind==='short'||kind==='cover'?(command.credit.send!=null?LD.validPlan(kind,command.credit.send):LD.candidates(kind,{today:seoulDate(),loanDate:command.credit.loanDate,alternate:false})):{first:{form:null,date:kind==='margin-buy'?seoulDate():command.credit.loanDate},alternate:null};
    if(!plan)throw new KisError('INVALID_ORDER');
    // KRX always: short sales go to KRX only (never NXT or SOR), and every credit order with them.
    const post=async loanDate=>{const params={CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,PDNO:command.symbol,CRDT_TYPE:command.credit.type,LOAN_DT:String(loanDate).replaceAll('-',''),EXCG_ID_DVSN_CD:require('./short-rules.cjs').VENUE,ORD_DVSN:'00',ORD_QTY:String(command.quantity),ORD_UNPR:String(command.limitPrice)};
      const {body}=await this.request('/uapi/domestic-stock/v1/trading/order-credit',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:command.side==='Buy'?'TTTC0052U':'TTTC0051U',custtype:'P'},body:JSON.stringify(params)});return body;};
    const accepted=(body,sent,more={})=>{if(typeof body.output?.ODNO!=='string' || !/^\d+$/.test(body.output.ODNO))throw new KisError('ORDER_UNCERTAIN');
      return {brokerOrderId:body.output.ODNO,organization:body.output.KRX_FWDG_ORD_ORGNO??'',acceptedAt:new Date().toISOString(),...(sent.form?{loanDateSent:{date:sent.date,form:sent.form,alternate:false,...more}}:{})};};
    try {
      const body=await post(plan.first.date);
      if(body.rt_cd==='0')return accepted(body,plan.first);
      // Stage 1b: no alternate when there is none (the calendar, another lot's date) or the refusal names another reason.
      if(!plan.alternate||LD.notAboutDate(body,kind))throw rejected(body);
      // The first refusal was a refusal: nothing was placed, so the one alternate is sent. Any other outcome of it (no
      // answer, an unclear reply) is the order's own outcome, unclear as always, and keeps the first refusal and the date
      // that may be at KIS.
      const first={date:plan.first.date,form:plan.first.form,...brokerFields(body)};await this.wait(550);
      let again;try{again=await post(plan.alternate.date);if(again.rt_cd==='0'){const r=accepted(again,plan.alternate);return {...r,loanDateSent:{...r.loanDateSent,alternate:true,firstRefusal:first}};}}
      catch(error){const e=orderError(error);throw Object.assign(e,{loanDateTried:[first,{date:plan.alternate.date,form:plan.alternate.form,...(e.code==='ORDER_UNCERTAIN'?{unclear:true}:{notSent:true})}]});}
      throw Object.assign(rejected(again),{loanDateTried:[first,{date:plan.alternate.date,form:plan.alternate.form,...brokerFields(again)}]});
    }catch(error){if(error instanceof KisError&&Array.isArray(error.loanDateTried)&&error.code!=='BROKER_REJECTED')throw error;throw orderError(error);}
  }
  // session.route picks the exchange (KRX or NXT) and order type (00 limit).
  placeOrder(...args){return SEND.run(true,()=>this.placeOrderNow(...args));}
  async placeOrderNow(command,session=null) {
    if(command.credit)return this.placeCreditOrder(command);
    await this.authenticate();await this.wait(550);
    const params={CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,PDNO:command.symbol,ORD_DVSN:['00','07'].includes(session?.route?.ordDvsn)?session.route.ordDvsn:'00',ORD_QTY:String(command.quantity),ORD_UNPR:String(command.limitPrice),EXCG_ID_DVSN_CD:['KRX','NXT'].includes(session?.route?.exchange)?session.route.exchange:'KRX',SLL_TYPE:command.side==='Sell'?'01':'',CNDT_PRIC:''};
    try {
      const {body}=await this.request('/uapi/domestic-stock/v1/trading/order-cash',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:(this.#credentials.environment==='live'?'T':'V')+(command.side==='Buy'?'TTC0012U':'TTC0011U'),custtype:'P'},body:JSON.stringify(params)});
      if(body.rt_cd!=='0')throw rejected(body);
      if(typeof body.output?.ODNO!=='string' || !/^\d+$/.test(body.output.ODNO))throw new KisError('ORDER_UNCERTAIN');
      return {brokerOrderId:body.output.ODNO,organization:body.output.KRX_FWDG_ORD_ORGNO??'',acceptedAt:new Date().toISOString()};
    }catch(error){throw orderError(error);}
  }
  // Revises the price of an open order, or cancels it, for all its unfilled shares (order-rvsecncl). originalOrderId
  // and organization are the order's current number and KRX forwarding organization; a revision gets a new number.
  reviseOrder(...args){return SEND.run(true,()=>this.reviseOrderNow(...args));}
  async reviseOrderNow({originalOrderId,organization,price,cancel=false,exchange='KRX'}) {
    if(!/^\d{1,20}$/.test(String(originalOrderId??''))||!/^\d{0,10}$/.test(String(organization??''))||!cancel&&!(Number.isSafeInteger(price)&&price>0)||!['KRX','NXT'].includes(exchange))throw new KisError('INVALID_REQUEST');
    await this.authenticate();await this.wait(550);
    const params={CANO:this.#credentials.accountNumber,ACNT_PRDT_CD:this.#credentials.accountProductCode,KRX_FWDG_ORD_ORGNO:String(organization??''),ORGN_ODNO:String(originalOrderId),ORD_DVSN:'00',RVSE_CNCL_DVSN_CD:cancel?'02':'01',ORD_QTY:'0',ORD_UNPR:cancel?'0':String(price),QTY_ALL_ORD_YN:'Y',EXCG_ID_DVSN_CD:exchange};
    try {
      const {body}=await this.request('/uapi/domestic-stock/v1/trading/order-rvsecncl',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+this.#token,appkey:this.#credentials.appKey,appsecret:this.#credentials.appSecret,tr_id:this.#credentials.environment==='live'?'TTTC0013U':'VTTC0013U',custtype:'P'},body:JSON.stringify(params)});
      if(body.rt_cd!=='0')throw rejected(body);
      if(typeof body.output?.ODNO!=='string' || !/^\d+$/.test(body.output.ODNO))throw new KisError('ORDER_UNCERTAIN');
      return {brokerOrderId:body.output.ODNO,organization:body.output.KRX_FWDG_ORD_ORGNO??String(organization??''),at:new Date().toISOString()};
    }catch(error){throw orderError(error);}// M-1.5a: refused by the request-limit window before sending: ORDER_NOT_SENT
  }
}
module.exports={KisReadOnlyClient,KisError,parseCredentials,normalizeBalance,CREDIT_KINDS,orderError,rejected,brokerText};
