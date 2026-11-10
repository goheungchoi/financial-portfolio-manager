'use strict';
// Settlement simplification S1b: a balance reading whose settlement step fails (the tracker's reading, which rolls back
// whole, or the Korean funding release) leaves a trace: one System line with the error's code only (never its message
// or data), at most once a minute for each kind of reading.
const code=e=>{const m=String(e?.message??'');return /^[A-Z][A-Z0-9_]{2,40}$/.test(m)?m:/^[A-Z][A-Z0-9_]{2,40}$/.test(String(e?.code??''))?String(e.code):'READ_FAILED';};
function readingFailures(log,{clock=Date.now,everyMs=60000}={}){const last=new Map();
  return (title,e)=>{const t=clock();if(last.has(title)&&t-last.get(title)<everyMs)return false;last.set(title,t);
    try{log(title,`A reading failed (${code(e)}); it is tried again at the next balance reading.`);}catch{}return true;};}
module.exports={readingFailures,errorCode:code};
