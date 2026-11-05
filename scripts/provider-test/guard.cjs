'use strict';
// Isolated provider test (artifacts/reviews/2026-11-05-provider-test-design.md): the whole-process network guard.
// Installed by the runner before any application module loads. Every way this Node process could reach the network or
// start another process is replaced by a function that refuses and records the attempt: fetch, WebSocket, EventSource,
// http, https, http2, net, tls, dns, dgram, child_process and worker_threads. The one permitted path is the controlled
// transport (transport.cjs), which receives the original fetch from install() and nothing else does. While one of its
// requests is in flight (enter/leave), the socket and lookup that request needs are let through for the permitted
// host and port only; anything else is still refused.
const HOST='api.openai.com',PORT=443;
const attempts=[];let open=0,installed=null;
function refuse(api,detail){const at=Date.now();attempts.push({api,detail:String(detail??'').slice(0,200),at});throw Object.assign(new Error('ISOLATED_NETWORK_DENIED'),{api,detail:String(detail??'')});}
// Where a net or tls call would connect: (port, host), (options), or (path) for a pipe.
function target(args){const [a,b]=args;if(a&&typeof a==='object')return {host:a.host??a.hostname??a.servername??null,port:Number(a.port),path:a.path??null};
  if(typeof a==='string'&&!/^\d+$/.test(a))return {path:a};return {port:Number(a),host:typeof b==='string'?b:'localhost'};}
const permitted=t=>open>0&&!t.path&&t.host===HOST&&t.port===PORT;
function install(){
  if(installed)return installed;
  const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'),http=require('node:http'),https=require('node:https'),http2=require('node:http2'),dgram=require('node:dgram'),cp=require('node:child_process'),wt=require('node:worker_threads');
  const original={fetch:globalThis.fetch.bind(globalThis),netConnect:net.connect,netCreate:net.createConnection,socketConnect:net.Socket.prototype.connect,tlsConnect:tls.connect,lookup:dns.lookup,lookupPromise:dns.promises.lookup};
  globalThis.fetch=(input)=>refuse('fetch',typeof input==='string'?input:input?.url);
  for(const name of ['WebSocket','EventSource'])if(name in globalThis)globalThis[name]=class{constructor(url){refuse(name,url);}};
  for(const [mod,label] of [[http,'http'],[https,'https']]){mod.request=(...a)=>refuse(label+'.request',a[0]?.host??a[0]);mod.get=(...a)=>refuse(label+'.get',a[0]?.host??a[0]);}
  http2.connect=(...a)=>refuse('http2.connect',a[0]);
  const guarded=(label,fn)=>function(...a){const t=target(a);if(!permitted(t))refuse(label,t.path??`${t.host}:${t.port}`);return fn.apply(this,a);};
  net.connect=guarded('net.connect',original.netConnect);net.createConnection=guarded('net.createConnection',original.netCreate);
  net.Socket.prototype.connect=guarded('net.Socket.connect',original.socketConnect);tls.connect=guarded('tls.connect',original.tlsConnect);
  dns.lookup=function(host,...rest){if(!(open>0&&host===HOST))refuse('dns.lookup',host);return original.lookup.call(this,host,...rest);};
  dns.promises.lookup=function(host,...rest){if(!(open>0&&host===HOST))refuse('dns.promises.lookup',host);return original.lookupPromise.call(this,host,...rest);};
  for(const name of Object.keys(dns).filter(k=>/^resolve|^reverse$/.test(k)&&typeof dns[k]==='function'))dns[name]=h=>refuse('dns.'+name,h);
  for(const name of Object.keys(dns.promises).filter(k=>/^resolve|^reverse$/.test(k)))dns.promises[name]=h=>refuse('dns.promises.'+name,h);
  dgram.createSocket=()=>refuse('dgram.createSocket','udp');
  for(const name of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync'])cp[name]=(...a)=>refuse('child_process.'+name,a[0]);
  wt.Worker=class{constructor(file){refuse('worker_threads.Worker',file);}};
  installed={original,attempts,enter:()=>{open++;},leave:()=>{open=Math.max(0,open-1);},host:HOST,port:PORT};
  return installed;
}
module.exports={install,attempts,HOST,PORT};
