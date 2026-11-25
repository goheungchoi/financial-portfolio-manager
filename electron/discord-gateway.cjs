// Phone control (1.6.0), stage P2: the Discord gateway client the phone worker runs (artifacts/reviews/2026-11-25-phone-control,
// p0-note.md; Discord's documentation: docs.discord.com/developers/events/gateway and …/topics/opcodes-and-status-codes).
// One outward WebSocket, intents 0 (INTERACTION_CREATE belongs to no intent), JSON encoding, API v10. Hello, then Identify
// or Resume; heartbeats with a random first delay; no ACK before the next beat means a zombie connection, closed with 4000
// and resumed; op 7 resumes; op 9 resumes when d is true, else identifies anew. Close codes 4004, 4010-4014 are never
// retried (the token or the setup is wrong); every other drop reconnects after 5 s, doubling to 5 minutes, reset once
// the session is ready. The bot token stays inside this object: it is in no state, event or error it hands out.
const API='https://discord.com/api/v10';
const NEVER_RECONNECT=new Set([4004,4010,4011,4012,4013,4014]);
const WAIT_FIRST=5000,WAIT_MAX=300000;
const OP={DISPATCH:0,HEARTBEAT:1,IDENTIFY:2,RESUME:6,RECONNECT:7,INVALID_SESSION:9,HELLO:10,ACK:11};
class Gateway{
  // fetch, WebSocket, timers and random are injected (the tests use a stand-in gateway). onDispatch(t, d) gets every event
  // after READY; onState({state, code?}) gets connecting, ready, waiting (with the wait), refused (with the close code),
  // stopped.
  constructor({token,fetch:f=globalThis.fetch,WebSocket:WS=globalThis.WebSocket,setTimeout:st=setTimeout,clearTimeout:ct=clearTimeout,random=Math.random,onDispatch=()=>{},onState=()=>{}}){
    const t=token;this.auth=()=>'Bot '+t;this.fetch=f;this.WS=WS;this.st=st;this.ct=ct;this.random=random;this.onDispatch=onDispatch;this.onState=onState;
    this.ws=null;this.seq=null;this.session=null;this.resumeUrl=null;this.wait=WAIT_FIRST;this.stopped=false;this.timer=null;this.retry=null;this.acked=true;}
  async api(method,path,body){for(let attempt=0;attempt<2;attempt++){
      const r=await this.fetch(API+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:this.auth(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      if(r.status===429&&attempt===0){let after=1;try{after=Number((await r.json()).retry_after)||1;}catch{}await new Promise(res=>this.st(res,Math.min(after,10)*1000));continue;}
      if(!r.ok)throw Object.assign(new Error('DISCORD_HTTP'),{status:r.status});return r.status===204?null:r.json().catch(()=>null);}
    throw Object.assign(new Error('DISCORD_HTTP'),{status:429});}
  start(){this.stopped=false;void this.open(false);}
  stop(){this.stopped=true;this.ct(this.timer);this.ct(this.retry);try{this.ws?.close(1000);}catch{}this.ws=null;this.onState({state:'stopped'});}
  async open(resume){if(this.stopped)return;this.onState({state:'connecting'});let url=resume&&this.resumeUrl?this.resumeUrl:null;
    if(!url){try{url=(await this.api('GET','/gateway/bot'))?.url;}catch(error){if([401,403].includes(error.status)){this.refuse(error.status);return;}this.later();return;}}
    if(this.stopped)return;if(typeof url!=='string'||!/^wss:\/\//.test(url)){this.later();return;}
    const ws=new this.WS(url+(url.includes('?')?'&':'?')+'v=10&encoding=json');this.ws=ws;this.acked=true;
    ws.onmessage=ev=>{if(this.ws===ws)this.message(ev.data,resume);};
    ws.onclose=ev=>{if(this.ws!==ws)return;this.ws=null;this.ct(this.timer);const code=Number(ev?.code);
      if(NEVER_RECONNECT.has(code)){this.refuse(code);return;}if(code===1000||code===1001)this.session=null;this.later();};
    ws.onerror=()=>{};}
  message(raw,resume){let m;try{m=JSON.parse(typeof raw==='string'?raw:String(raw));}catch{return;}if(!m||typeof m!=='object')return;
    if(Number.isInteger(m.s))this.seq=m.s;
    if(m.op===OP.HELLO){const every=Number(m.d?.heartbeat_interval);if(!(every>0))return;this.every=every;this.beat(every*this.random());
      if(resume&&this.session)this.send({op:OP.RESUME,d:{token:this.tokenFor(),session_id:this.session,seq:this.seq}});
      else this.send({op:OP.IDENTIFY,d:{token:this.tokenFor(),intents:0,properties:{os:'windows',browser:'financial-portfolio-manager',device:'financial-portfolio-manager'}}});return;}
    if(m.op===OP.ACK){this.acked=true;return;}
    if(m.op===OP.HEARTBEAT){this.send({op:OP.HEARTBEAT,d:this.seq});return;}
    if(m.op===OP.RECONNECT){this.drop(4000);return;}
    if(m.op===OP.INVALID_SESSION){if(m.d!==true){this.session=null;this.seq=null;}this.drop(4000);return;}
    if(m.op===OP.DISPATCH){if(m.t==='READY'){this.session=typeof m.d?.session_id==='string'?m.d.session_id:null;this.resumeUrl=typeof m.d?.resume_gateway_url==='string'?m.d.resume_gateway_url:null;this.wait=WAIT_FIRST;this.onState({state:'ready'});return;}
      if(m.t==='RESUMED'){this.wait=WAIT_FIRST;this.onState({state:'ready'});return;}
      try{this.onDispatch(m.t,m.d);}catch{}}}
  tokenFor(){return this.auth().slice(4);}
  send(m){try{this.ws?.send(JSON.stringify(m));}catch{}}
  // A heartbeat; no ACK since the last one means a zombie connection: close with 4000 and resume.
  beat(delay){this.ct(this.timer);this.timer=this.st(()=>{if(!this.ws)return;if(!this.acked){this.drop(4000);return;}this.acked=false;this.send({op:OP.HEARTBEAT,d:this.seq});this.beat(this.every);},Math.max(0,delay));}
  drop(code){const ws=this.ws;this.ws=null;this.ct(this.timer);try{ws?.close(code);}catch{}this.later();}
  later(){if(this.stopped)return;const wait=this.wait;this.wait=Math.min(WAIT_MAX,this.wait*2);this.onState({state:'waiting',waitMs:wait});this.ct(this.retry);this.retry=this.st(()=>void this.open(Boolean(this.session)),wait);}
  refuse(code){this.stopped=true;this.ct(this.timer);this.ct(this.retry);this.onState({state:'refused',code});}
}
module.exports={Gateway,API,NEVER_RECONNECT,WAIT_FIRST,WAIT_MAX,OP};
