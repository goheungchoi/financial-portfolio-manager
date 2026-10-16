const net=require('node:net');const readline=require('node:readline');
const pipe=process.argv[2];
const tools=[{name:'paper_snapshot',description:'Read the local paper portfolio and risk policy. No KIS credentials or live account data are exposed.',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'propose_paper_trade',description:'Create a risk-checked paper proposal for user review. Does not submit an order.',inputSchema:{type:'object',properties:{symbol:{type:'string'},side:{type:'string',enum:['Buy','Sell']},quantity:{type:'integer',minimum:1,maximum:1000}},required:['symbol','side','quantity'],additionalProperties:false}},{name:'submit_external_decision',description:'Submit a structured paper decision to the application review journal. Paper auto-submission follows the user-configured mode.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['Hold','Buy','Sell']},symbol:{type:'string'},quantity:{type:'integer'},explanation:{type:'string'}},required:['action','symbol','quantity','explanation'],additionalProperties:false}}];
function request(method,args) {return new Promise((resolve,reject)=>{
  const socket=net.connect(pipe);let buffer='';socket.setTimeout(10000,()=>{socket.destroy();reject(new Error('APP_UNAVAILABLE'));});
  socket.on('connect',()=>socket.write(JSON.stringify({method,...(method==='propose_paper_trade'?{command:args}:method==='submit_external_decision'?{decision:args}:{})})+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>1000000){socket.destroy();reject(new Error('INVALID_RESPONSE'));return;}if(buffer.includes('\n')){socket.end();try{resolve(JSON.parse(buffer.split('\n')[0]));}catch{reject(new Error('INVALID_RESPONSE'));}}});
  socket.on('error',()=>reject(new Error('APP_UNAVAILABLE')));
});}
readline.createInterface({input:process.stdin}).on('line',async line=>{
  let message;try{message=JSON.parse(line);if(!message.id)return;let result;
    if(message.method==='initialize')result={protocolVersion:message.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'portfolio-paper-bridge',version:'1.0.0'}};
    else if(message.method==='tools/list')result={tools};
    else if(message.method==='tools/call'&&tools.some(tool=>tool.name===message.params?.name))result={content:[{type:'text',text:JSON.stringify(await request(message.params.name,message.params.arguments??{}))}]};
    else if(message.method==='ping')result={};else throw 0;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  }catch{if(message?.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'REQUEST_FAILED'}})+'\n');}
});
