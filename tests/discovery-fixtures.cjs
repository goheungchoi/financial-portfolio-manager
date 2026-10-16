// Synthetic KIS master files in the published layouts (fixed-width EUC-KR for Korea, tab-separated for U.S.).
const zlib=require('node:zlib');
const EUC_KR={'삼성전자':[0xBB,0xEF,0xBC,0xBA,0xC0,0xFC,0xC0,0xDA]};
const pad=(buffer,length)=>Buffer.concat([buffer,Buffer.alloc(Math.max(0,length-buffer.length),0x20)]).subarray(0,length);
function domesticRow(code,name,group,tail,industry='0027'){
  const nameBytes=EUC_KR[name]?Buffer.from(EUC_KR[name]):Buffer.from(name,'latin1');
  return Buffer.concat([pad(Buffer.from(code,'latin1'),9),pad(Buffer.from('KR7'+code+'000','latin1'),12),pad(nameBytes,40),pad(Buffer.from(group+'1'+industry,'latin1'),tail)]);
}
function domesticFile(rows,tail){return Buffer.concat(rows.flatMap(([code,name,group])=>[domesticRow(code,name,group,tail),Buffer.from('\n')]));}
function overseasFile(exchange,rows){return Buffer.from(rows.map(([ticker,name,english,type,etp=''])=>['US','22',exchange,'x',ticker,'D'+exchange+ticker,name,english,type,'USD','4','','10.0','1','1','930','1600','N','','000','0','0',etp,''].join('\t')).join('\n')+'\n','latin1');}
function zip(name,data){
  const compressed=zlib.deflateRawSync(data),header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0,6);header.writeUInt16LE(8,8);header.writeUInt32LE(0,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);header.writeUInt16LE(0,28);
  return Buffer.concat([header,Buffer.from(name,'latin1'),compressed]);
}
const filler=(prefix,count,start)=>Array.from({length:count},(_,i)=>[String(start+i).padStart(6,'0'),prefix+' '+i,'ST']);
// Each market needs at least 10 rows to be accepted.
function masterFiles(){
  return {
    'kospi_code.mst.zip':zip('kospi_code.mst',domesticFile([['005930','삼성전자','ST'],['069500','KODEX 200','EF'],['F70100','Skipped ETN','EN'],...filler('Kospi Fixture',10,100000)],227)),
    'kosdaq_code.mst.zip':zip('kosdaq_code.mst',domesticFile([['247540','EcoPro BM','ST'],...filler('Kosdaq Fixture',10,200000)],221)),
    'nasmst.cod.zip':zip('NASMST.COD',overseasFile('NAS',[['AAPL','Apple','APPLE INC','2'],['QQQ','INVESCO QQQ','INVESCO QQQ TRUST','3','001'],['SEATW','WARRANT','VIVID SEATS WTS','4'],...Array.from({length:10},(_,i)=>['NF'+String.fromCharCode(65+i),'Fixture','NAS FIXTURE '+i,'2'])])),
    'nysmst.cod.zip':zip('NYSMST.COD',overseasFile('NYS',[['KO','Coca-Cola','COCA-COLA CO','2'],...Array.from({length:10},(_,i)=>['YF'+String.fromCharCode(65+i),'Fixture','NYS FIXTURE '+i,'2'])])),
    'amsmst.cod.zip':zip('AMSMST.COD',overseasFile('AMS',Array.from({length:11},(_,i)=>['AF'+String.fromCharCode(65+i),'Fixture','AMS FIXTURE '+i,'2'])))};
}
function fetcherFor(files,{fail=[]}={}){return async url=>{const name=url.split('/').pop();if(fail.includes(name)||!files[name])return {ok:false};const buffer=files[name];return {ok:true,arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length)};};}
module.exports={masterFiles,fetcherFor,zip,domesticFile,overseasFile};
