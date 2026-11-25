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
function statusText(automation,{equity=()=>null}={}){const a=automation??{},c=a.config??{};const lines=[];
  // Each line on its own: a getter that throws or gives an odd shape drops that line, never the reply (P3 review, 6).
  const line=fn=>{try{const v=fn();if(typeof v==='string'&&v)lines.push(v);}catch{}};
  let running=false;try{running=Boolean(a.autoTradingRuns?.());}catch{running=false;}
  line(()=>{let env=null;try{env=a.live?.getConnection?.()?.snapshot?.environment??null;}catch{}const kind=env==='live'?' (live account)':env==='mock'?' (mock account)':'';
    return `Auto trading: ${running?'running':'stopped'} · ${SCOPE[c.scope]??'—'}${kind}.`;});
  if(c.phoneAmounts)line(()=>{const v=equity();return Number.isFinite(v)?`Account value: ${won(v)}.`:null;});
  line(()=>{let next=null;try{next=Number(a.nextReviewAt?.())||null;}catch{next=null;}const nextText=next?at(next):running?'none scheduled':'not while stopped';
    return `Last review: ${at(Number(a.lastRun))??'none yet'}. Next review: ${nextText}.`;});
  // Armed orders and whether they are watched now, in the words Home and Stop use.
  line(()=>{const armed=c.conditionalOrders?a.desk.orders(a.watchScope()):[];if(!Array.isArray(armed)||!armed.length)return 'No armed orders.';
    const many=plural(armed.length,'armed order is','armed orders are');if(running)return `${many} watched.`;
    let w=null;try{w=a.watchingWhileStopped?.()?a.whileStoppedState():null;}catch{w=null;}
    if(w&&typeof w==='object'){try{const t=L.watchedWords(w);if(typeof t==='string'&&t)return t;}catch{}}return `${many} not watched until you start auto trading.`;});
  let orders=[];try{orders=[...(a.live?.orders?.()??[]),...(a.usLive?.orders?.()??[])].filter(o=>o&&typeof o==='object');}catch{orders=[];}
  line(()=>{const n=orders.filter(o=>o.status==='Ready').length;return n?`${plural(n,'order waits','orders wait')} for your approval on the PC.`:null;});
  line(()=>{const n=orders.filter(o=>o.status==='Uncertain').length;return n?`${plural(n,'order has','orders have')} a lost KIS reply (/orders lists them).`:null;});
  let waits=[];try{waits=a.providerWaitState?.()??[];}catch{waits=[];}
  for(const w of Array.isArray(waits)?waits:[])line(()=>w&&typeof w.name==='string'&&typeof w.nextTry==='string'?`${w.name}: waiting, next try ${w.nextTry} KST.`:null);
  return lines.length?lines.join('\n'):'Status could not be read.';}
// The executor the phone service calls (phone-service.cjs). Every outcome is the desktop function's own sentence or a
// fixed one; an error answers with its public text, never a stack or a value from Discord.
function createExecutor({automation,equity=()=>null,launch=L}){
  return {
    async summary(){return {ok:false,text:NOT_YET};},
    async run(act){
      if(act.command==='status')return statusText(automation,{equity});
      if(act.command==='stop'){try{return launch.stop(automation);}catch(error){return `Not stopped: ${error?.text??error?.message??'error'}.`;}}
      if(act.command==='stopall'){try{return automation.stopEverything();}catch(error){return `Not stopped: ${error?.text??error?.message??'error'}.`;}}
      return NOT_YET;}};}
module.exports={createExecutor,statusText,NOT_YET};
