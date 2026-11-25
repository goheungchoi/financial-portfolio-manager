// Phone control (1.6.0), stage P2: the phone worker, a utility process of its own (artifacts/reviews/2026-11-25-phone-control).
// It reads the five Discord keys from the provider file itself (so the bot token never enters the main process), keeps
// the gateway connection (discord-gateway.cjs), registers the seven commands for the one server when they changed,
// answers every interaction within Discord's 3 seconds itself (an ephemeral "thinking" reply, or the PIN form once the
// main process gives its nonce), and hands the main process only the checked fields of an interaction from the allowed
// user, server, channel and application. The interaction tokens stay here; the main process refers to an interaction by a
// local ref. Replies are built from what the main process sends: a fixed sentence or the app's own state, never anything
// echoed from Discord.
const crypto=require('node:crypto');
const {Gateway}=require('./discord-gateway.cjs');
const KEYS=Object.freeze(['discordBotToken','discordApplicationId','discordServerId','discordChannelId','discordUserId']);
const SNOWFLAKE=/^\d{17,20}$/,TOKEN=/^[A-Za-z0-9._-]{20,200}$/;
const REF_MS=14*60000,MODAL_WAIT_MS=2500,TEXT_MAX=1900;
const PIN_FORM_FIRST=new Set(['link','nottaken']);
// No message the bot posts or edits can ever mention anyone (P2 review, change 2).
const NO_MENTIONS=Object.freeze({parse:[]});
// The commands, for the one server only; usable by the server's administrators only (default_member_permissions "0").
const s=(name,description,required=true)=>({type:3,name,description,required,max_length:64});
const COMMANDS=Object.freeze([
  {name:'status',description:'Auto trading status, armed orders and lost order replies'},
  {name:'stop',description:'Stop auto trading'},
  {name:'stopall',description:'Stop everything, including the watch on armed orders'},
  {name:'start',description:'Start auto trading (shows what would start; confirm with your PIN)'},
  {name:'orders',description:'Orders whose KIS reply was lost'},
  {name:'link',description:'Link a lost order reply to a KIS order number (PIN)',options:[s('order','The app order id'),s('number','The KIS order number')]},
  {name:'nottaken',description:'Mark a lost order as never placed (PIN)',options:[s('order','The app order id')]}].map(c=>({...c,type:1,default_member_permissions:'0'})));
const commandsHash=()=>crypto.createHash('sha256').update(JSON.stringify(COMMANDS)).digest('hex').slice(0,16);
// The five keys, checked; errors name the key, never the value.
function readKeys(text){let v;try{v=JSON.parse(text);}catch{return {ok:false,problems:['the provider file is not valid JSON']};}
  const missing=KEYS.filter(k=>v?.[k]==null||v[k]===''),invalid=KEYS.filter(k=>!missing.includes(k)&&!(typeof v[k]==='string'&&(k==='discordBotToken'?TOKEN:SNOWFLAKE).test(v[k])));
  if(missing.length||invalid.length)return {ok:false,missing,invalid};
  return {ok:true,keys:{token:v.discordBotToken,allow:{application:v.discordApplicationId,server:v.discordServerId,channel:v.discordChannelId,user:v.discordUserId}}};}
// The PIN from a form submit: the text input with custom_id "pin", inside a Label (type 18) or an Action Row.
function pinOf(components){const out=[];const walk=c=>{if(!c||typeof c!=='object')return;if(Array.isArray(c)){c.forEach(walk);return;}if(c.custom_id==='pin'&&typeof c.value==='string')out.push(c.value);walk(c.component);walk(c.components);};walk(components);return out.length===1?out[0].slice(0,32):null;}
class PhoneWorker{
  constructor({readFile,readState=()=>null,writeState=()=>{},post,fetch:f=globalThis.fetch,WebSocket:WS=globalThis.WebSocket,setTimeout:st=setTimeout,clearTimeout:ct=clearTimeout,random=Math.random,clock=Date.now,Gateway:G=Gateway}){
    Object.assign(this,{readFile,readState,writeState,post,fetch:f,WS,st,ct,random,clock,G});this.refs=new Map();this.gateway=null;this.keys=null;}
  start(providerPath){this.stop(false);let text;try{text=this.readFile(providerPath);}catch{this.post({type:'state',state:'not-set-up',problems:['the provider file could not be read']});return;}
    const r=readKeys(text);if(!r.ok){this.post({type:'state',state:'not-set-up',missing:r.missing??[],invalid:r.invalid??[],...(r.problems?{problems:r.problems}:{})});return;}
    this.keys=r.keys;const allow=r.keys.allow;this.post({type:'state',state:'keys-ok',allow:{...allow}});
    this.gateway=new this.G({token:r.keys.token,fetch:this.fetch,WebSocket:this.WS,setTimeout:this.st,clearTimeout:this.ct,random:this.random,
      onState:st=>{this.post({type:'state',state:st.state,...(Number.isInteger(st.code)?{code:st.code}:{}),...(Number.isFinite(st.waitMs)?{waitMs:st.waitMs}:{})});if(st.state==='ready')void this.register();},
      onDispatch:(t,d)=>{if(t==='INTERACTION_CREATE')void this.interaction(d,allow);}});
    this.gateway.start();}
  stop(say=true){try{this.gateway?.stop();}catch{}this.gateway=null;for(const r of this.refs.values())this.ct(r.timer);this.refs.clear();if(say)this.post({type:'state',state:'stopped'});}
  // The seven commands for the one server, only when they changed (Discord allows 200 creates a day per server).
  async register(){const want=commandsHash();if(this.readState()?.commandsHash===want)return;
    try{await this.gateway.api('PUT',`/applications/${this.keys.allow.application}/guilds/${this.keys.allow.server}/commands`,COMMANDS);this.writeState({commandsHash:want});this.post({type:'state',state:'commands-registered'});}
    catch(error){this.post({type:'state',state:'commands-refused',status:Number.isInteger(error?.status)?error.status:null});}}
  callback(ref,body){const r=this.refs.get(ref);return this.gateway.api('POST',`/interactions/${r.id}/${r.token}/callback`,body);}
  original(ref,method,body){const r=this.refs.get(ref);return this.gateway.api(method,`/webhooks/${this.keys.allow.application}/${r.token}/messages/@original`,body);}
  replyFailed(error){this.post({type:'state',state:'reply-refused',status:Number.isInteger(error?.status)?error.status:null});}
  // An interaction: only from the allowed application, server, channel and user (anything else: no answer at all, nothing
  // handed over); answered at once; the checked fields handed to the main process under a local ref.
  async interaction(d,allow){if(!d||typeof d!=='object')return;const userId=d.member?.user?.id;
    if(d.application_id!==allow.application||d.guild_id!==allow.server||d.channel_id!==allow.channel||userId!==allow.user)return;
    if(typeof d.id!=='string'||typeof d.token!=='string'||![2,3,5].includes(d.type))return;
    for(const [k,r] of this.refs)if(this.clock()-r.at>REF_MS){this.ct(r.timer);this.refs.delete(k);}
    const ref=crypto.randomBytes(12).toString('hex');const name=d.type===2&&typeof d.data?.name==='string'?d.data.name:null;
    const formFirst=(d.type===2&&PIN_FORM_FIRST.has(name))||d.type===3;this.refs.set(ref,{id:d.id,token:d.token,at:this.clock(),deferred:false,timer:null});
    const data={id:d.id,type:d.type,applicationId:d.application_id,serverId:d.guild_id,channelId:d.channel_id,userId,
      ...(name?{command:name.slice(0,20)}:{}),...(Array.isArray(d.data?.options)?{options:d.data.options.slice(0,5).map(o=>({name:String(o?.name??'').slice(0,20),value:typeof o?.value==='string'?o.value.slice(0,64):null}))}:{}),
      ...(typeof d.data?.custom_id==='string'?{customId:d.data.custom_id.slice(0,100)}:{}),...(d.type===5?{pin:pinOf(d.data?.components)}:{})};
    if(formFirst){const r=this.refs.get(ref);r.timer=this.st(()=>{if(!this.refs.has(ref)||this.refs.get(ref).answered)return;this.refs.get(ref).answered=true;
        void this.callback(ref,{type:4,data:{content:'The app did not answer in time. Try again.',flags:64,allowed_mentions:NO_MENTIONS}}).catch(e=>this.replyFailed(e)).finally(()=>this.refs.delete(ref));},MODAL_WAIT_MS);}
    else{try{await this.callback(ref,{type:5,data:{flags:64}});this.refs.get(ref).deferred=true;}catch(error){this.replyFailed(error);this.refs.delete(ref);return;}}
    this.post({type:'interaction',ref,interaction:data});}
  // The main process's answer: the PIN form, a sentence, the Start summary with its confirm button, or nothing.
  async reply(m){const r=this.refs.get(m?.ref);if(!r||r.answered)return;r.answered=true;this.ct(r.timer);const text=typeof m.text==='string'?m.text.slice(0,TEXT_MAX):'';
    try{if(m.kind==='modal'&&!r.deferred&&/^[a-f0-9]{32}$/.test(m.nonce))await this.callback(m.ref,{type:9,data:{custom_id:'pin:'+m.nonce,title:'Enter your PIN',components:[{type:18,label:'PIN',description:'Shows on your screen as you type; it is not posted.',component:{type:4,custom_id:'pin',style:1,min_length:6,max_length:12,required:true}}]}});
      else if(m.kind==='summary'&&r.deferred&&/^[a-f0-9]{32}$/.test(m.nonce))await this.original(m.ref,'PATCH',{content:text,allowed_mentions:NO_MENTIONS,components:[{type:1,components:[{type:2,style:1,label:'Confirm with PIN',custom_id:'start-confirm:'+m.nonce}]}]});
      else if(m.kind==='message')await(r.deferred?this.original(m.ref,'PATCH',{content:text,allowed_mentions:NO_MENTIONS,components:[]}):this.callback(m.ref,{type:4,data:{content:text,flags:64,allowed_mentions:NO_MENTIONS}}));
      else if(m.kind==='drop'&&r.deferred)await this.original(m.ref,'DELETE');}
    catch(error){this.replyFailed(error);}finally{this.refs.delete(m.ref);}}
}
// As a utility process: messages from the main process.
if(require.main===module&&process.parentPort){const fs=require('node:fs');let statePath=null;
  const worker=new PhoneWorker({readFile:p=>{const st=fs.statSync(p);if(st.size>65536)throw new Error('too large');return fs.readFileSync(p,'utf8');},
    readState:()=>{try{return statePath?JSON.parse(fs.readFileSync(statePath,'utf8')):null;}catch{return null;}},writeState:v=>{try{if(statePath)fs.writeFileSync(statePath,JSON.stringify(v));}catch{}},
    post:m=>process.parentPort.postMessage(m)});
  process.parentPort.on('message',({data})=>{if(!data||typeof data!=='object')return;
    if(data.op==='start'&&typeof data.providerPath==='string'){statePath=typeof data.statePath==='string'?data.statePath:null;worker.start(data.providerPath);}
    else if(data.op==='reply')void worker.reply(data);else if(data.op==='stop')worker.stop();});}
module.exports={PhoneWorker,readKeys,pinOf,KEYS,COMMANDS,commandsHash,MODAL_WAIT_MS};
