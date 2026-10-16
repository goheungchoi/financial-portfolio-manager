// Read-only KIS ranking queries used by the market screener. Runs inside the private broker worker.
const KINDS=['volume','gainers','losers','market-cap'];
const EXCHANGES={NASD:'NAS',NYSE:'NYS',AMEX:'AMS'},MARKETS={NAS:'NASD',NYS:'NYSE',AMS:'AMEX'};
const num=value=>{const text=String(value??'').replace(/[,+]/g,'').trim();if(!text)return null;const n=Number(text);return Number.isFinite(n)?n:null;};
const domestic={
  volume:['/uapi/domestic-stock/v1/quotations/volume-rank','FHPST01710000',{FID_COND_MRKT_DIV_CODE:'J',FID_COND_SCR_DIV_CODE:'20171',FID_INPUT_ISCD:'0000',FID_DIV_CLS_CODE:'0',FID_BLNG_CLS_CODE:'0',FID_TRGT_CLS_CODE:'111111111',FID_TRGT_EXLS_CLS_CODE:'0000000000',FID_INPUT_PRICE_1:'',FID_INPUT_PRICE_2:'',FID_VOL_CNT:'',FID_INPUT_DATE_1:''}],
  gainers:['/uapi/domestic-stock/v1/ranking/fluctuation','FHPST01700000',{fid_cond_mrkt_div_code:'J',fid_cond_scr_div_code:'20170',fid_input_iscd:'0000',fid_rank_sort_cls_code:'0',fid_input_cnt_1:'0',fid_prc_cls_code:'0',fid_input_price_1:'',fid_input_price_2:'',fid_vol_cnt:'',fid_trgt_cls_code:'0',fid_trgt_exls_cls_code:'0',fid_div_cls_code:'0',fid_rsfl_rate1:'',fid_rsfl_rate2:''}],
  'market-cap':['/uapi/domestic-stock/v1/ranking/market-cap','FHPST01740000',{fid_input_price_2:'',fid_cond_mrkt_div_code:'J',fid_cond_scr_div_code:'20174',fid_div_cls_code:'0',fid_input_iscd:'0000',fid_trgt_cls_code:'0',fid_trgt_exls_cls_code:'0',fid_input_price_1:'',fid_vol_cnt:''}]};
domestic.losers=[domestic.gainers[0],domestic.gainers[1],{...domestic.gainers[2],fid_rank_sort_cls_code:'1'}];
function normalizeDomestic(rows){
  return (Array.isArray(rows)?rows:[]).map(r=>({symbol:String(r.mksc_shrn_iscd??r.stck_shrn_iscd??'').trim(),name:String(r.hts_kor_isnm??'').trim(),price:num(r.stck_prpr),changePct:num(r.prdy_ctrt),volume:num(r.acml_vol),
    // stck_avls is reported in hundred-million KRW units.
    marketCap:num(r.stck_avls)?num(r.stck_avls)*1e8:null,per:null,currency:'KRW'})).filter(r=>r.symbol&&r.price>0);
}
function normalizeOverseas(rows){
  return (Array.isArray(rows)?rows:[]).map(r=>({symbol:(MARKETS[r.excd]??'')+':'+String(r.symb??'').trim(),name:String(r.name??'').trim(),englishName:String(r.ename??'').trim(),price:num(r.last),changePct:num(r.rate),volume:num(r.tvol),
    // valx is reported in thousand USD.
    marketCap:num(r.valx)?num(r.valx)*1000:null,per:num(r.per),currency:'USD',orderable:r.e_ordyn==null?null:r.e_ordyn==='○'})).filter(r=>/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol)&&r.price>0);
}
function validRequest(request){return request&&typeof request==='object'&&KINDS.includes(request.kind)&&(request.market==='KR'||request.market==='US'&&Object.hasOwn(EXCHANGES,request.exchange));}
async function rankings(client,request){
  if(!validRequest(request))throw new Error('INVALID_REQUEST');
  if(request.market==='KR'){const [path,trId,params]=domestic[request.kind];const body=await client.quotation(path,trId,params);return normalizeDomestic(body.output);}
  const excd=EXCHANGES[request.exchange];let endpoint,trId,params;
  if(request.kind==='volume')[endpoint,trId,params]=['/uapi/overseas-stock/v1/ranking/trade-vol','HHDFS76310010',{EXCD:excd,NDAY:'0',VOL_RANG:'0',KEYB:'',AUTH:'',PRC1:'',PRC2:''}];
  else if(request.kind!=='market-cap')[endpoint,trId,params]=['/uapi/overseas-stock/v1/ranking/updown-rate','HHDFS76290000',{EXCD:excd,NDAY:'0',GUBN:request.kind==='gainers'?'1':'0',VOL_RANG:'0',KEYB:'',AUTH:''}];
  // The overseas market-cap ranking is not available to every account; use the condition search for companies of at least USD 10 billion.
  else [endpoint,trId,params]=['/uapi/overseas-price/v1/quotations/inquire-search','HHDFS76410000',{AUTH:'',EXCD:excd,CO_YN_PRICECUR:'',CO_ST_PRICECUR:'',CO_EN_PRICECUR:'',CO_YN_RATE:'',CO_ST_RATE:'',CO_EN_RATE:'',CO_YN_VALX:'1',CO_ST_VALX:'10000000',CO_EN_VALX:'99999999999',CO_YN_SHAR:'',CO_ST_SHAR:'',CO_EN_SHAR:'',CO_YN_VOLUME:'',CO_ST_VOLUME:'',CO_EN_VOLUME:'',CO_YN_AMT:'',CO_ST_AMT:'',CO_EN_AMT:'',CO_YN_EPS:'',CO_ST_EPS:'',CO_EN_EPS:'',CO_YN_PER:'',CO_ST_PER:'',CO_EN_PER:'',KEYB:''}];
  const {body}=await client.overseasRequest(endpoint,trId,params,{includeAccount:false});const rows=normalizeOverseas(body.output2??body.output);
  return request.kind==='market-cap'?rows.sort((a,b)=>(b.marketCap??0)-(a.marketCap??0)):rows;
}
module.exports={rankings,normalizeDomestic,normalizeOverseas,validRequest,KINDS};
