// Which AI client serves a call (Anthropic provider design 3 and 6.2): the model id alone selects the vendor; claude-*
// goes to Anthropic, everything else to OpenAI. No model (an older caller) means OpenAI, as before. A vendor without
// a key is AI_NOT_CONNECTED. Pure: the worker builds it from the provider file and tests build it from fakes.
const models=require('./ai-models.cjs');
const KEY=/^[A-Za-z0-9_\-]{10,512}$/;
// Claude call timeouts (design 5.6): Opus thinks before answering, so a call may run longer than GPT's 75 to 85 s.
const CLAUDE_TIMEOUT_MS=Object.freeze({decide:150000,scout:150000,narrative:120000,compact:90000,reflect:120000});
const METHOD={decision:'decide',reflection:'reflect',scout:'scout',narrative:'narrative',compact:'compact'};
// The worker's hard cap for one request (kis-service.cjs): 90 s as before, or for a Claude call its own timeout plus
// 15 s, so the client's timeout ends the call first and is reported as AI_TIMEOUT, not a broken worker.
function workerCapMs(operation,payload){const method=METHOD[operation];if(!method)return 90000;let vendor;try{vendor=payload?.options?.openaiModel==null?'openai':models.vendorOf(payload.options.openaiModel);}catch{return 90000;}
  return vendor==='anthropic'?Math.max(90000,CLAUDE_TIMEOUT_MS[method]+15000):90000;}
const FILE_KEYS=['openaiApiKey','anthropicApiKey','dartApiKey','pushWebhookURL','ecosApiKey','fredApiKey','secContactEmail'];
const EMAIL=/^[^\s@<>()"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
function createRouter({openai=null,anthropic=null}={}){
  return {
    clientFor(model){const vendor=model==null?'openai':models.vendorOf(model);const client=vendor==='anthropic'?anthropic:openai;if(!client)throw new Error('AI_NOT_CONNECTED');return client;},
    flags(){return {aiConnected:Boolean(openai||anthropic),openaiConnected:Boolean(openai),anthropicConnected:Boolean(anthropic)};},
    // B1: the key Test of one provider (key-test.cjs); 'missing' without a key.
    async testKey(vendor){if(!['openai','anthropic'].includes(vendor))throw new Error('INVALID_REQUEST');const client=vendor==='anthropic'?anthropic:openai;if(!client?.testKey)return {result:'missing'};return client.testKey();},
  };
}
// Until the Claude client exists (step A3, then stage B for the other calls): every Claude call is refused as an
// unavailable model with a named rule, before anything is sent. It holds no key.
function pendingClaudeClient(){
  const fail=async()=>{throw Object.assign(new Error('AI_MODEL_UNAVAILABLE'),{detail:{rule:'Claude calls are not built yet'}});};
  return {pending:true,decide:fail,scout:fail,narrative:fail,compact:fail,reflect:fail};
}
// Step A3: the Claude client for the portfolio decision; scout, condensing, summary and reflection stay refused until
// stage B. The key lives only inside AnthropicClient (a private field); this object holds none.
function claudeClient(key,transport){const client=new (require('./anthropic-client.cjs').AnthropicClient)(key,transport);return {...pendingClaudeClient(),pending:false,decide:(context,options)=>client.decide(context,options),testKey:()=>client.testKey()};}
// The provider file, checked whole before anything is used: only known keys, each in its expected form. Any problem
// rejects the file (the caller reports it as a failed import); nothing is half-applied. Values are never logged.
function parseProviderFile(text){
  const value=JSON.parse(text);if(!value||typeof value!=='object'||Object.keys(value).some(key=>!FILE_KEYS.includes(key)))throw new Error('INVALID_PROVIDER_FILE');
  // An empty or missing AI key means "not connected", as before; anything else must look like a key.
  for(const key of ['openaiApiKey','anthropicApiKey'])if(value[key]!=null&&value[key]!==''&&!(typeof value[key]==='string'&&KEY.test(value[key])))throw new Error('INVALID_PROVIDER_FILE');
  if(value.ecosApiKey&&!/^[A-Za-z0-9]{10,100}$/.test(value.ecosApiKey))throw new Error('INVALID_PROVIDER_FILE');if(value.fredApiKey&&!/^[a-z0-9]{32}$/.test(value.fredApiKey))throw new Error('INVALID_PROVIDER_FILE');
  if(value.secContactEmail&&!EMAIL.test(value.secContactEmail))throw new Error('INVALID_PROVIDER_FILE');
  if(value.dartApiKey&&!/^[A-Za-z0-9]{20,100}$/.test(value.dartApiKey))throw new Error('INVALID_PROVIDER_FILE');
  let pushURL=null;if(value.pushWebhookURL){const url=new URL(value.pushWebhookURL);if(url.protocol!=='https:'||url.username||url.password)throw new Error('INVALID_PROVIDER_FILE');pushURL=url.href;}
  return {openaiApiKey:value.openaiApiKey||null,anthropicApiKey:value.anthropicApiKey||null,dartApiKey:value.dartApiKey??null,pushURL,ecosApiKey:value.ecosApiKey??null,fredApiKey:value.fredApiKey??null,secContactEmail:value.secContactEmail??null};
}
module.exports={CLAUDE_TIMEOUT_MS,workerCapMs,createRouter,pendingClaudeClient,claudeClient,parseProviderFile,FILE_KEYS,EMAIL};
