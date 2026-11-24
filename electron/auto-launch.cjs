const {createHash}=require('node:crypto');
function engines(a){return a.config.scope==='paper'?[]:a.config.scope==='both'?[a.live,a.usLive]:[a.config.scope==='us'?a.usLive:a.live];}
function launchState(a){
  const selected=engines(a);const environment=a.config.scope==='paper'?'PAPER':a.live?.getState().environment?.toUpperCase()??'DISCONNECTED';
  const scope={paper:'Paper',kis:'Korea',us:'U.S.',both:'Korea + U.S.'}[a.config.scope];
  let identity;try{identity=a.live?.identity();}catch{identity='disconnected';}
  const token=createHash('sha256').update(JSON.stringify({config:a.config,identity,environment,policies:selected.map(e=>{const p=e?.getState().policy??{};return Object.fromEntries(['symbols','maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct','lossLimit'].map(k=>[k,p[k]]));})})).digest('hex');
  return {token,label:`${environment} · ${scope}`,running:Boolean(a.config.enabled&&a.config.autoSubmit&&a.sessionArmed&&(selected.length?selected.every(e=>e.enabled&&e.autoEnabled):!a.paper.account().paused)),starting:Boolean(a.launching)};
}
async function start(a,token){
  if(a.launching||a.busy)throw new Error('A review is already running. Wait for it to finish.');
  if(token!==launchState(a).token)throw new Error('Settings or account changed. Check the updated account label and try again.');
  if(a.config.lossAction==='stop'&&a.emergencyState().active)throw new Error('The daily loss limit is reached and the guardrail keeps auto trading stopped today. Change Loss-limit response in Engine settings to restart.');
  if(a.config.provider==='external')throw new Error('Choose an AI model in Engine settings to start automatic reviews.');
  if(require('./ai-models.cjs').decisionMaker(a.config)==='ai'){const missing=a.missingKey?a.missingKey(a.config.openaiModel):(a.providerStatus.aiConnected?null:'OpenAI');if(missing)throw new Error(`Import your ${missing} key in Connections first.`);}
  if(a.config.scope!=='paper'&&require('./ai-models.cjs').decisionMaker(a.config)!=='ai')throw new Error('Select an AI model for broker auto trading. Local rules are for paper practice.');
  // B1: the consent and the daily limits of the trading model's provider.
  if(a.config.scope!=='paper'&&!(a.consentFor?a.consentFor(a.config.openaiModel):a.config.shareKisWithOpenAI))throw new Error(a.consentMessage?a.consentMessage(a.config.openaiModel):'Allow sharing KIS data with OpenAI in Connections.');
  if(require('./ai-models.cjs').decisionMaker(a.config)==='ai'&&(a.budgetBlocked?a.budgetBlocked(a.config.openaiModel,require('./ai-models.cjs').reservation(a.config)):require('./ai-models.cjs').budgetExceeded(a.config,a.getState().usage,require('./ai-models.cjs').reservation(a.config))))throw new Error('Daily API budget reached. Update your budget or wait for the next day.');
  a.launching=true;const generation=a.launchGeneration??0;const selected=engines(a);const prior=selected.map(e=>({e,enabled:e.enabled,autoEnabled:e.autoEnabled}));
  try{
    if(['us','both'].includes(a.config.scope))await a.refreshUS();
    if(generation!==(a.launchGeneration??0)||token!==launchState(a).token)throw new Error('Launch canceled because settings or the account changed.');
    for(const e of selected){const c=e.getConnection();if(!c.snapshot||c.status==='disconnected')throw new Error('Connect the selected KIS account first.');if(!(e.funded?e.funded(c.snapshot):c.snapshot.reportedTotal>0))throw new Error(`${e.market}: no funded balance available. Choose a funded market in Engine settings.`);if(e.busy)throw new Error('An order is being processed. Try again after it completes.');}
    for(const e of selected){const saved=e.policy()??{symbols:[],lossLimit:{mode:'off',value:0}};const policy=Object.fromEntries(['symbols','maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct','maxDailyLossKRW','lossLimit'].filter(k=>saved[k]!==undefined).map(k=>[k,saved[k]]));const env=e.getState().environment==='live'?'LIVE':'MOCK';e.configure(policy,`ENABLE ${env}`);e.enableAuto(`ENABLE AUTO ${env}`);}
    if(!selected.length)a.paper.setPaused(false);
    a.configure({enabled:true,autoSubmit:true});
    // Start is what arms the session (audit item 15): a settings save never does.
    a.sessionArmed=true;a.pausedByRestart=false;
    a.watchStarted?.();// orders while stopped, B-3: the switches record
  }catch(error){if(generation===(a.launchGeneration??0))for(const row of prior){row.e.enabled=row.enabled;row.e.autoEnabled=row.autoEnabled;}throw error;}
  finally{a.launching=false;}
  // Starting resumes the schedule: no review runs because of the button. The last review time is kept across restarts
  // (Automation.restoreClock), so a review that ran just before waits its interval; one already due starts within
  // seconds from the scheduler, and with every market in scope closed the pre-open review comes first (unless set otherwise).
  // The message says what the scheduler will do: the near-budget slowdown and a pre-open review that already ran are in
  // nextReviewAt. With markets closed no review is due now, so none is named after Start.
  const said=startMessage(a);const us=usLine(a);return us?`${said} ${us}`:said;
}
// With U.S. automatic orders on (R15 removed, 2026-11-19): what goes out, and the U.S. limits as saved, each set or not.
function usLine(a){const e=a.usLive;if(!e||!engines(a).includes(e)||!e.autoEnabled)return '';let p=null;try{p=e.policy?.();}catch{}
  const usd=v=>Number.isFinite(v)?`$${Number(v).toLocaleString('en-US')}`:'not set';
  const loss=p?.lossLimit?.mode==='percent'?`${p.lossLimit.value}%`:p?.lossLimit?.mode==='amount'?usd(p.lossLimit.value):'off';
  return `U.S.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order ${usd(p?.maxOrderKRW)}, daily turnover ${usd(p?.maxDailyTurnoverKRW)}, per company ${Number.isFinite(p?.maxCompanyPct)?p.maxCompanyPct+'%':'not set'}, daily loss ${loss}.`;}
function startMessage(a){
  a.restoreClock?.();const next=a.nextReviewAt?.()??Date.now();a.firstAfterStart=next<=Date.now()+5000;
  const at=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST';
  const hours=a.marketHours?.();if(hours&&!hours.open&&a.config.closedMarketReviews!=='keep'&&!a.emergencyState?.().active){a.firstAfterStart=false;
    if(a.config.closedMarketReviews==='off')return `Auto trading started. Markets are closed, so the first review runs at the open${hours.next?` (${at(next)})`:''}.`;
    if(a.preOpenRan?.(hours))return `Auto trading started. Markets are closed and the pre-open review already ran; next review at ${at(next)}.`;
    return 'Auto trading started. Markets are closed, so the first review runs before the next open.';}
  if(a.firstAfterStart)return 'Auto trading started. A review is due and starts shortly.';
  return `Auto trading started. Next review at ${at(next)}, on schedule.`;
}
// The engines stop even if the save throws (2026-11-18); the error then reaches runtime:stop, which shows it.
// The message says plainly that armed conditional orders are the app's, not KIS's (found in live use: "existing broker
// orders remain active" was read as the stops staying at KIS): they are not watched until auto trading starts again.
function stop(a){a.launchGeneration=(a.launchGeneration??0)+1;try{a.refreshWatchRecord?.();}catch{}try{a.configure({enabled:false,autoSubmit:false});}finally{a.live?.stop();a.usLive?.stop();if(a.config.scope==='paper')a.paper.setPaused(true);}
  let armed=[];try{armed=a.config.conditionalOrders?a.desk.orders(a.watchScope()):[];}catch{armed=[];}if(!armed.length)return 'Auto trading stopped. Existing broker orders remain active.';
  // Orders while stopped, B-4: with the setting on they are still watched; how they are sent; how to stop them too.
  {let w=null;try{w=a.watchingWhileStopped?.()?a.whileStoppedState():null;}catch{w=null;}if(w)return `Auto trading stopped. Orders already at KIS stay. ${watchedWords(w)} To stop them too, use Stop everything.`;}
  const stops=armed.every(o=>o.purpose==='stop_loss'),n=armed.length,word=stops?(n===1?'stop':'stops'):(n===1?'conditional order':'conditional orders');
  return `Auto trading stopped. Orders already at KIS stay. Your ${n} armed ${word} (${[...new Set([...armed].sort((x,y)=>(x.createdAt??0)-(y.createdAt??0)).map(o=>o.symbol))].slice(0,4).join(', ')}) ${n===1?'is':'are'} not watched until you start it again.`;}
// The watched orders while stopped, one sentence (the Stop reply and Home): how many, buys among them, and which are sent
// by themselves and which only proposed for your approval.
function watchedWords(w){const held=(w.waiting??[]).reduce((s,x)=>s+x.orders,0);const n=(w.sentByThemselves??0)+(w.proposedOnly??0),one=n===1;
  const wait=[...(w.waiting??[]).map(x=>`${x.orders} ${x.orders===1?'waits':'wait'}: ${x.why}.`),w.notStarted?.length?`Not watched until you start auto trading on this account: ${w.notStarted.slice(0,4).join(', ')}.`:''].filter(Boolean).join(' ');
  if(!n)return held?`Your ${held} armed ${held===1?'order is':'orders are'} still watched. ${wait}`:wait;
  // B3f-1: covers named apart: "(2 buys, 1 cover)".
  const parts=[w.buys?`${w.buys} ${w.buys===1?'buy':'buys'}`:'',w.covers?`${w.covers} ${w.covers===1?'cover':'covers'}`:''].filter(Boolean),b=parts.length?` (${parts.join(', ')})`:'';const head=`Your ${n} armed ${one?'order is':'orders are'} still watched${b}`;
  const how=w.proposedOnly===0?(one?' and is sent by itself if its conditions are met.':' and are sent by themselves if their conditions are met.'):w.sentByThemselves===0?(one?': if its conditions are met it is only proposed for your approval.':': if their conditions are met they are only proposed for your approval.'):`: ${w.sentByThemselves} sent by themselves, ${w.proposedOnly} only proposed for your approval.`;
  return head+how+(wait?' '+wait:'');}
const EVERYTHING_STOPPED='Everything stopped. No order will be sent by the app; orders already at KIS stay.';
module.exports={launchState,start,stop,watchedWords,EVERYTHING_STOPPED};
