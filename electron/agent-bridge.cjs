const net=require('node:net');const {createHash}=require('node:crypto');
function startBridge(userData,paper,review) {
  const pipe='\\\\.\\pipe\\portfolio-manager-'+createHash('sha256').update(userData).digest('hex').slice(0,12);
  const server=net.createServer(socket=>{
    let buffer='';let calls=0;socket.setTimeout(10000,()=>socket.destroy());
    socket.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>32768){socket.destroy();return;}
      const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){if(++calls>20){socket.destroy();return;}void(async()=>{
        let response;
        try{
          const message=JSON.parse(line);
          if(message.method==='paper_snapshot')response={ok:true,data:paper.getState()};
          else if(message.method==='propose_paper_trade')response={ok:true,data:paper.propose(message.command)};
          else if(message.method==='submit_external_decision')response={ok:true,data:await review(message.decision)};
          else throw 0;
        }catch{response={ok:false,error:'REQUEST_REJECTED'};}
        if(!socket.destroyed)socket.write(JSON.stringify(response)+'\n');
      })();}
    });
  });
  server.on('error',()=>{});server.listen(pipe);return {pipe,close:()=>server.close()};
}
module.exports={startBridge};
