// Phone control (1.6.0), stage P3: what Status, Stop and Stop everything do from the phone (artifacts/reviews/
// 2026-11-25-phone-control). Stop calls auto-launch.cjs stop(automation) and Stop everything automation.stopEverything(),
// the functions the desktop's buttons call (main.cjs runtime:stop and runtime:stop-everything), and the reply is their own
// sentence, which already says what happens to the armed orders. Status is built from the app's own state, in fixed
// sentences; amounts follow "Show amounts in snapshots" (config.phoneAmounts). Start (P4) shows what would start, holds
// the desktop's launch token (auto-launch.cjs launchState) and, after the button and the PIN, calls auto-launch.cjs
// start(automation, token): the function the desktop's Start calls (main.cjs runtime:start), with every refusal in its own
// words. The lost-order fixes come in P5; until then they answer that they are not active yet.
const L=require('./auto-launch.cjs');
const MODEL_NAMES={'gpt-6-luna':'GPT-6 Luna','gpt-6-sol':'GPT-6 Sol','gpt-6-astra':'GPT-6 Astra','claude-opus-5-5':'Claude Opus 5.5','claude-haiku-5-5':'Claude Haiku 5.5'};
const CHANGED='Settings or account changed. Check the updated account label and try again.';
const START_CONFIRM='Confirm below, then enter your PIN. This request ends in 2 minutes.';
const NOT_YET='Phone control is being built: this command is not active yet.';
const at=t=>Number.isFinite(t)&&t>0?new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST':null;
const SCOPE={kis:'Korea',us:'U.S.',both:'Korea and U.S.',paper:'Paper'};
const won=n=>'₩'+Math.round(n).toLocaleString('en-US');
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
// automation: the app's Automation. equity(): the account value in KRW, or null (for Status with amounts shown).
// Each line is read on its own: a getter that throws or gives an odd shape drops that line, never the reply (P3 review, 6).
// A value that could not be read says so ("not known"), never a guess; with nothing read the reply is the last-resort
// sentence (P3 follow-up B).
function statusText(automation,{equity=()=>null}={}){if(!automation||typeof automation!=='object')return 'Status could not be read.';
  const a=automation;let c={};try{c=a.config&&typeof a.config==='object'?a.config:{};}catch{c={};}const lines=[];let known=0;
  const line=fn=>{try{const v=fn();if(typeof v==='string'&&v){lines.push(v);return true;}}catch{}return false;};
  const fact=fn=>{if(line(fn))known++;};
  let running=null;try{if(typeof a.autoTradingRuns==='function')running=Boolean(a.autoTradingRuns());}catch{running=null;}
  if(running===null)line(()=>'Auto trading: not known.');
  else fact(()=>{let env=null;try{env=a.live?.getConnection?.()?.snapshot?.environment??null;}catch{}const kind=env==='live'?' (live account)':env==='mock'?' (mock account)':'';
    return `Auto trading: ${running?'running':'stopped'} · ${SCOPE[c.scope]??'—'}${kind}.`;});
  if(c.phoneAmounts)fact(()=>{const v=equity();return Number.isFinite(v)?`Account value: ${won(v)}.`:null;});
  if(running!==null)fact(()=>{let next=null;try{next=Number(a.nextReviewAt?.())||null;}catch{next=null;}const nextText=next?at(next):running?'none scheduled':'not while stopped';
    return `Last review: ${at(Number(a.lastRun))??'none yet'}. Next review: ${nextText}.`;});
  // Armed orders and whether they are watched now, in the words Home and Stop use.
  let armed=null;try{if(a.config&&typeof a.config==='object'){const v=c.conditionalOrders?a.desk.orders(a.watchScope()):[];armed=Array.isArray(v)?v:null;}}catch{armed=null;}
  if(armed===null)line(()=>'Armed orders: not known.');
  else fact(()=>{if(!armed.length)return 'No armed orders.';const many=plural(armed.length,'armed order is','armed orders are');
    if(running===null)return `${plural(armed.length,'armed order','armed orders')}; whether watched is not known.`;if(running)return `${many} watched.`;
    let w=null;try{w=a.watchingWhileStopped?.()?a.whileStoppedState():null;}catch{w=null;}
    if(w&&typeof w==='object'){try{const t=L.watchedWords(w);if(typeof t==='string'&&t)return t;}catch{}}return `${many} not watched until you start auto trading.`;});
  let orders=null;try{if(typeof a.live?.orders==='function')orders=[...(a.live?.orders?.()??[]),...(a.usLive?.orders?.()??[])].filter(o=>o&&typeof o==='object');}catch{orders=null;}
  if(orders){known++;const n=orders.filter(o=>o.status==='Ready').length,u=orders.filter(o=>o.status==='Uncertain').length;
    if(n)line(()=>`${plural(n,'order waits','orders wait')} for your approval on the PC.`);
    if(u)line(()=>`${plural(u,'order has','orders have')} a lost KIS reply (/orders lists them).`);}
  let waits=[];try{waits=a.providerWaitState?.()??[];}catch{waits=[];}
  for(const w of Array.isArray(waits)?waits:[])fact(()=>w&&typeof w.name==='string'&&typeof w.nextTry==='string'?`${w.name}: waiting, next try ${w.nextTry} KST.`:null);
  return known&&lines.length?lines.join('\n'):'Status could not be read.';}
// The executor the phone service calls (phone-service.cjs). Every outcome is the desktop function's own sentence or a
// fixed one; an error answers with its public text, never a stack or a value from Discord.
// The markets Start would enable, by scope (auto-launch.cjs engines).
const marketsOf=a=>{const s=a.config?.scope;return s==='both'?[['KR',a.live],['US',a.usLive]]:s==='kis'?[['KR',a.live]]:s==='us'?[['US',a.usLive]]:[];};
// What the phone holds beside the desktop token (P4 review, 2): what the user set, never a running value (P4 second
// review, 1). From each market's saved trading policy the limit fields (live-engine.cjs LIMIT_FIELDS: symbols, the caps,
// lossLimit, anyStock, which start() applies again), but maxDailyLossKRW only when it is an amount the user typed: in
// percent mode it is figured from the day's baseline at each save, as day, baseline, valuation and dayPeakEquity move with
// the account. From the exposure policy each section's user-set keys (exposure.cjs DEFAULT_POLICY: short selling, margin,
// leveraged products). Taken with the summary and compared just before start(); a value that cannot be read throws, so
// nothing starts on it.
const userLimits=p=>{if(!p)return null;const {LIMIT_FIELDS}=require('./live-engine.cjs');const out={};for(const k of [...LIMIT_FIELDS].sort())if(p[k]!==undefined)out[k]=p[k];
  if(p.lossLimit?.mode==='percent')delete out.maxDailyLossKRW;return out;};
const userExposure=p=>{if(!p)return null;const {DEFAULT_POLICY}=require('./exposure.cjs');
  return Object.fromEntries(Object.keys(DEFAULT_POLICY).map(s=>[s,Object.fromEntries(Object.keys(DEFAULT_POLICY[s]).map(k=>[k,p[s]?.[k]??null]))]));};
function phoneFingerprint(a){const out={};for(const [m,e] of marketsOf(a)){if(!e)throw new Error('NO_ENGINE');
    out[m]={policy:userLimits(e.policy?.()??null),exposure:e.exposure?userExposure(e.exposure.policy(e.identity())):null};}
  return require('node:crypto').createHash('sha256').update(JSON.stringify(out)).digest('hex');}
// Margin buying and leveraged products when on, in the Short and leverage card's words ("automatic" / "propose only").
const exposureLines=(p,market)=>{const out=[];const how=s=>s.auto?'automatic':'propose only';
  if(market==='KR'&&p?.margin?.enabled)out.push(`Margin buying: on, ${how(p.margin)}; loans up to ${p.margin.maxLoanPctOfEquity}% of net assets.`);
  if(p?.leveragedEtps?.enabled)out.push(`Leveraged & inverse ETFs${market==='US'?' (U.S.)':' (Korea)'}: on, ${how(p.leveragedEtps)}; up to ${p.leveragedEtps.maxPctOfEquity}% of the account.`);return out;};
// What Start would start (P4): everything Start newly allows, since on the phone the screen cannot be seen. The account
// label as the desktop shows it (launchState label), the trading model, how orders go out, orders per review above 1,
// short selling (Korea: always on or off), conditional orders, each market's saved limits (the U.S. in the Start
// message's words, auto-launch.cjs usLine), and the armed orders. Money follows "Show amounts in snapshots": with it off
// a limit says only "set" or "not set". A line that cannot be read says "not known", never a default (P4 review, 3).
function startSummary(a){const c=a.config??{},amounts=c.phoneAmounts===true;const lines=['Start auto trading?'];const state=L.launchState(a);
  const add=(fn,unknown)=>{let v=null;try{v=fn();}catch{v=unknown;}if(typeof v==='string'&&v)lines.push(v);};
  add(()=>`Account: ${state.label}${String(state.label).endsWith('.')?'':'.'}`,'Account: not known.');
  add(()=>{const maker=require('./ai-models.cjs').decisionMaker(c);return `Trading model: ${maker==='ai'?MODEL_NAMES[c.openaiModel]??String(c.openaiModel):maker==='rules'?'Local rules':'none chosen'}.`;},'Trading model: not known.');
  add(()=>c.scope==='paper'?'Orders: paper practice; nothing is sent to KIS.':'Orders: buys and sales are sent to KIS automatically.','Orders: not known.');
  add(()=>{if(typeof a.ordersFor!=='function')return null;const n=a.ordersFor(a.agentModel('trading'));return Number.isInteger(n)&&n>1?`Up to ${n} orders per review.`:null;},'Orders per review: not known.');
  const markets=marketsOf(a);
  if(markets.some(([m])=>m==='KR'))add(()=>{const p=a.live.exposure.policy(a.live.identity()).short;if(!p?.enabled)return 'Short selling: off.';
    return `Short selling: on, ${p.auto?'automatic: a short the AI decides is sent by itself':'propose only: each short the AI decides waits for your approval'}; short positions up to ${p.maxGrossPctOfEquity}% of net assets.`;},'Short selling: not known.');
  // Margin and leveraged products: a line only when on (P4 second review, 3).
  for(const [m,e] of markets){let p=null;try{p=e?.exposure?e.exposure.policy(e.identity()):null;}catch{lines.push(`${m==='KR'?'Korea':'U.S.'} margin and leveraged products: not known.`);continue;}lines.push(...exposureLines(p,m));}
  if(c.conditionalOrders)add(()=>c.conditionalAutoSubmit?'Conditional orders: a hit armed order is submitted automatically when the conditions are met and every check passes.':'Conditional orders: when the conditions are met a hit armed order becomes a proposal that waits for approval.','Conditional orders: not known.');
  const money=(v,fmt)=>Number.isFinite(v)?(amounts?fmt(v):'set'):'not set';const usd=v=>`$${Number(v).toLocaleString('en-US')}`;
  const limits=(e,fmt)=>{if(!e||typeof e.policy!=='function')throw new Error('NO_ENGINE');const p=e.policy();const loss=p?.lossLimit?.mode==='percent'?`${p.lossLimit.value}%`:p?.lossLimit?.mode==='amount'?money(p.lossLimit.value,fmt):'off';
    return `maximum order ${money(p?.maxOrderKRW,fmt)}, daily turnover ${money(p?.maxDailyTurnoverKRW,fmt)}, per company ${Number.isFinite(p?.maxCompanyPct)?p.maxCompanyPct+'%':'not set'}, daily loss ${loss}.`;};
  for(const [m,e] of markets){if(m==='KR')add(()=>`Korea limits: ${limits(e,won)}`,'Korea: limits not known.');
    else add(()=>`U.S.: buys and sales are sent automatically, each counted against your won cash; limits: ${limits(e,usd)}`,'U.S.: buys and sales are sent automatically, each counted against your won cash; limits not known.');}
  add(()=>{const armed=c.conditionalOrders?a.desk.orders(a.watchScope()):[];if(!Array.isArray(armed))throw 0;return armed.length?`${plural(armed.length,'armed order becomes','armed orders become')} watched.`:'No armed orders.';},'Armed orders: not known.');
  let fingerprint=null;try{fingerprint=phoneFingerprint(a);}catch{fingerprint=null;}
  lines.push(START_CONFIRM);return {text:lines.join('\n'),token:state.token,fingerprint,state};}
function createExecutor({automation,equity=()=>null,launch=L}){
  return {
    // Start's first step: the summary and the launch token, taken now and held unchanged until the PIN (P4). Already
    // running or starting: said, and nothing held.
    async summary(act){if(act?.command!=='start')return {ok:false,text:NOT_YET};
      try{const s=startSummary(automation);if(s.state.running||s.state.starting)return {ok:false,text:'Auto trading is already running.'};return {ok:true,text:s.text,held:{token:s.token,fingerprint:s.fingerprint}};}
      catch{return {ok:false,text:'What Start would start could not be read. Try again from the PC.'};}},
    async run(act){
      if(act.command==='status')return statusText(automation,{equity});
      // Start: auto-launch.cjs start with the token held at the summary, as runtime:start does; every refusal (a review
      // running, settings or the account changed, the loss-limit guardrail, no model, no key, no consent, the budget, no
      // funded balance, an order in process, a launch cancelled) is start()'s own sentence.
      // The phone's own fingerprint is compared just before start(), with no await between (P4 review, 2): one that could
      // not be read then or at the summary, or that differs, refuses in the desktop's sentence.
      if(act.command==='start'){const token=act.held?.token;if(typeof token!=='string'||!token)return {text:CHANGED,changed:false};
        let now=null;try{now=phoneFingerprint(automation);}catch{now=null;}if(!now||typeof act.held.fingerprint!=='string'||now!==act.held.fingerprint)return {text:CHANGED,changed:false};
        try{return {text:String(await launch.start(automation,token)),changed:true};}catch(error){return {text:String(error?.text??error?.message??'Could not start.'),changed:false};}}
      // {text, changed}: changed only when the desktop function returned, so the alert follows a real stop (P3 follow-up C).
      if(act.command==='stop'){try{return {text:String(launch.stop(automation)),changed:true};}catch(error){return {text:`Not stopped: ${error?.text??error?.message??'error'}.`,changed:false};}}
      if(act.command==='stopall'){try{return {text:String(automation.stopEverything()),changed:true};}catch(error){return {text:`Not stopped: ${error?.text??error?.message??'error'}.`,changed:false};}}
      return NOT_YET;}};}
module.exports={createExecutor,statusText,startSummary,phoneFingerprint,NOT_YET,START_CONFIRM,MODEL_NAMES,CHANGED};
