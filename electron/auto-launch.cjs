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
  if(a.config.provider==='external')throw new Error('Choose OpenAI in Engine settings to start automatic reviews.');
  if(a.config.provider==='openai'&&!a.providerStatus.aiConnected)throw new Error('Import your OpenAI key in Connections first.');
  if(a.config.scope!=='paper'&&a.config.provider!=='openai')throw new Error('Select OpenAI for broker auto trading. Local rules are for paper practice.');
  if(a.config.scope!=='paper'&&!a.config.shareKisWithAI)throw new Error('Allow portfolio sharing with OpenAI in Engine settings first.');
  const usage=a.getState().usage;
  if(a.config.provider==='openai'&&require('./ai-models.cjs').budgetExceeded(a.config,usage,require('./ai-models.cjs').reservation(a.config)))throw new Error('Daily API budget reached. Update your budget or wait for the next day.');
  a.launching=true;const generation=a.launchGeneration??0;const selected=engines(a);const prior=selected.map(e=>({e,enabled:e.enabled,autoEnabled:e.autoEnabled}));
  try{
    if(['us','both'].includes(a.config.scope))await a.refreshUS();
    if(generation!==(a.launchGeneration??0)||token!==launchState(a).token)throw new Error('Launch canceled because settings or the account changed.');
    for(const e of selected){const c=e.getConnection();if(!c.snapshot||c.status==='disconnected')throw new Error('Connect the selected KIS account first.');if(!(e.funded?e.funded(c.snapshot):c.snapshot.reportedTotal>0))throw new Error(`${e.market}: no funded balance available. Choose a funded market in Engine settings.`);if(e.busy)throw new Error('An order is being processed. Try again after it completes.');}
    for(const e of selected){const saved=e.policy()??{symbols:[],lossLimit:{mode:'off',value:0}};const policy=Object.fromEntries(['symbols','maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct','maxDailyLossKRW','lossLimit'].filter(k=>saved[k]!==undefined).map(k=>[k,saved[k]]));const env=e.getState().environment==='live'?'LIVE':'MOCK';e.configure(policy,`ENABLE ${env}`);e.enableAuto(`ENABLE AUTO ${env}`);}
    if(!selected.length)a.paper.setPaused(false);
    a.configure({enabled:true,autoSubmit:true});
  }catch(error){if(generation===(a.launchGeneration??0))for(const row of prior){row.e.enabled=row.enabled;row.e.autoEnabled=row.autoEnabled;}throw error;}
  finally{a.launching=false;}
  // Starting resumes the schedule: no review runs because of the button. The last review time is kept across restarts
  // (Automation.restoreClock), so a review that ran just before waits its interval; one already due starts within
  // seconds from the scheduler, and with every market in scope closed the pre-open review comes first (unless set otherwise).
  // The message says what the scheduler will do: the near-budget slowdown and a pre-open review that already ran are in
  // nextReviewAt. With markets closed no review is due now, so none is named after Start.
  a.restoreClock?.();const next=a.nextReviewAt?.()??Date.now();a.firstAfterStart=next<=Date.now()+5000;
  const at=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST';
  const hours=a.marketHours?.();if(hours&&!hours.open&&a.config.closedMarketReviews!=='keep'&&!a.emergencyState?.().active){a.firstAfterStart=false;
    if(a.config.closedMarketReviews==='off')return `Auto trading started. Markets are closed, so the first review runs at the open${hours.next?` (${at(next)})`:''}.`;
    if(a.preOpenRan?.(hours))return `Auto trading started. Markets are closed and the pre-open review already ran; next review at ${at(next)}.`;
    return 'Auto trading started. Markets are closed, so the first review runs before the next open.';}
  if(a.firstAfterStart)return 'Auto trading started. A review is due and starts shortly.';
  return `Auto trading started. Next review at ${at(next)}, on schedule.`;
}
function stop(a){a.launchGeneration=(a.launchGeneration??0)+1;a.configure({enabled:false,autoSubmit:false});a.live?.stop();a.usLive?.stop();if(a.config.scope==='paper')a.paper.setPaused(true);return 'Auto trading stopped. Existing broker orders remain active.';}
module.exports={launchState,start,stop};
