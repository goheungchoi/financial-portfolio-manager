'use strict';
// Isolated provider test: the test folder is kept apart from the live profile. Both paths are resolved to their real
// location first (fs.realpathSync.native follows symbolic links and Windows junctions), then compared without regard
// to case on Windows, so neither can be inside or equal to the other by any route.
const fs=require('node:fs'),path=require('node:path');
const liveProfile=()=>path.join(process.env.APPDATA??path.join(require('node:os').homedir(),'AppData','Roaming'),'Financial Portfolio Manager');
// The real path of p, or of its nearest existing ancestor with the rest appended (a folder not created yet).
function canonical(p){let at=path.resolve(p);const rest=[];while(!fs.existsSync(at)){const up=path.dirname(at);if(up===at)break;rest.unshift(path.basename(at));at=up;}
  return path.join(fs.realpathSync.native(at),...rest);}
const norm=p=>process.platform==='win32'?p.toLowerCase():p;
// a is b or inside it. Only '..' itself or '..' then a separator leaves b: a child named '..test' is inside.
const within=(a,b)=>{const rel=path.relative(norm(b),norm(a));return rel===''||!(rel==='..'||rel.startsWith('..'+path.sep))&&!path.isAbsolute(rel);};
function separate(dir,{live=liveProfile()}={}){
  const d=canonical(dir),l=canonical(live);
  if(within(d,l))throw Object.assign(new Error('ISOLATED_PATH_REFUSED'),{detail:`${d} is inside the live profile ${l}`});
  if(within(l,d))throw Object.assign(new Error('ISOLATED_PATH_REFUSED'),{detail:`the live profile ${l} is inside ${d}`});
  return {dir:d,live:l};
}
module.exports={canonical,separate,liveProfile,within};
