// The values provider-naming must not move (artifacts/reviews/2026-11-24-provider-naming): the start token of a fixed
// configuration, and the request body each client sends for a fixed context. Fake transports only; made-up data.
const {createHash}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex').slice(0,16);
const CONTEXT={environment:'kis',universe:[{symbol:'990010'}],positions:{},quotes:[{symbol:'990010',price:1000}],marketSession:{open:true},agentDesk:{conditionalOrders:{allowed:true}}};
function startToken(root){const {Automation}=require(root+'/electron/automation.cjs');const {PaperEngine}=require(root+'/electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
  a.live={getState:()=>({environment:'live',policy:{symbols:[],maxOrderKRW:1000000,maxDailyTurnoverKRW:5000000,maxCompanyPct:20,lossLimit:{mode:'off'}}}),identity:()=>'acct',enabled:false,autoEnabled:false};
  return {token:require(root+'/electron/auto-launch.cjs').launchState(a).token,config:sha(a.config)};}
async function requestBodies(root){const A=require(root+'/electron/ai-client.cjs');let openai=null;
  const client=new A.AiClient('k'.repeat(20),async(url,init)=>{openai=init.body;return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  try{await client.decide(CONTEXT,{openaiModel:'gpt-6-sol',reasoningEffort:'low'});}catch{}
  const {AnthropicClient}=require(root+'/electron/anthropic-client.cjs');let claude=null;
  const c=new AnthropicClient('sk-ant-api03-'+'k'.repeat(40),async(url,init)=>{claude=init.body;return new Response('{}',{status:400,headers:{'content-type':'application/json'}});});
  try{await c.decide(CONTEXT,{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'});}catch{}
  return {openai:openai&&sha(openai),claude:claude&&sha(claude)};}
module.exports={startToken,requestBodies,sha};
if(require.main===module)(async()=>{const root=process.argv[2]??require('node:path').join(__dirname,'..','..');console.log(JSON.stringify({...startToken(root),...await requestBodies(root)}));})();
