// Phone control (1.6.0), stage P3: what Status, Stop and Stop everything do from the phone (artifacts/reviews/
// 2026-11-25-phone-control). Stop calls auto-launch.cjs stop(automation) and Stop everything automation.stopEverything(),
// the functions the desktop's buttons call (main.cjs runtime:stop and runtime:stop-everything), and the reply is their own
// sentence, which already says what happens to the armed orders. Status is built from the app's own state, in fixed
// sentences; amounts follow "Show amounts in snapshots" (config.phoneAmounts). Start and the lost-order fixes come in P4
// and P5; until then they answer that they are not active yet.
const L=require('./auto-launch.cjs');
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
function createExecutor({automation,equity=()=>null,launch=L}){
  return {
    async summary(){return {ok:false,text:NOT_YET};},
    async run(act){
      if(act.command==='status')return statusText(automation,{equity});
      // {text, changed}: changed only when the desktop function returned, so the alert follows a real stop (P3 follow-up C).
      if(act.command==='stop'){try{return {text:String(launch.stop(automation)),changed:true};}catch(error){return {text:`Not stopped: ${error?.text??error?.message??'error'}.`,changed:false};}}
      if(act.command==='stopall'){try{return {text:String(automation.stopEverything()),changed:true};}catch(error){return {text:`Not stopped: ${error?.text??error?.message??'error'}.`,changed:false};}}
      return NOT_YET;}};}
module.exports={createExecutor,statusText,NOT_YET};
