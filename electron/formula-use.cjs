// How a review used formulas (agent tools T0, artifacts/reviews/2026-11-11-agent-tools): formulas evaluated by compute
// (count per function name), formula errors (count per code), and the function names in each review trigger,
// conditional order and cancelIf set in that review. Counting only: it never changes a tool result, the context or a
// decision, and any failure in it is swallowed (a review never fails because of it). Stored on the review as
// formulaUse; a review without it is "not recorded", not zero.
const VERSION=1;
function functionsOf(expr){try{const out=new Set();const walk=node=>{if(!node||typeof node!=='object')return;if(node.fn)out.add(node.fn);for(const v of [node.a,node.b,...(node.args??[])])walk(v);};walk(require('./formula.cjs').parse(expr).ast);return [...out].sort();}catch{return [];}}
const add=(map,key,n=1)=>{map[key]=(map[key]??0)+n;};
class FormulaUse{
  constructor(){this.computeCalls=0;this.formulas=0;this.functions={};this.errors={};this.items=[];this.failed=false;}
  guard(fn){try{fn();}catch{this.failed=true;}}
  // One compute call: its parsed formulas and the results it returned.
  compute(parsed,results){this.guard(()=>{this.computeCalls++;for(const p of parsed??[]){this.formulas++;if(p.ast)for(const f of functionsOf(p.expr))add(this.functions,f);}
    for(const r of results??[])if(r?.error)add(this.errors,String(r.error).split(':')[0]);});}
  // A trigger or conditional order this review saved or armed.
  item(kind,id,conditions){this.guard(()=>{this.items.push({kind,id:id??null,functions:[...new Set((conditions??[]).flatMap(c=>functionsOf(c.expr)))].sort()});});}
  // The summary saved on the review; the final decision's execution.cancelIf conditions are read here.
  summary(decision){let out=null;try{const cancelIf=(Array.isArray(decision?.execution?.cancelIf)?decision.execution.cancelIf:[]);const items=[...this.items];if(cancelIf.length)items.push({kind:'cancelIf',id:null,functions:[...new Set(cancelIf.flatMap(c=>functionsOf(c?.expr)))].sort()});
    out={version:VERSION,computeCalls:this.computeCalls,formulas:this.formulas,functions:{...this.functions},errors:{...this.errors},items,...(this.failed?{incomplete:true}:{})};}catch{out=null;}return out;}
}
// A stored review's formula use, or null when it was not recorded (reviews before T0): never read as zero.
const recordedUse=review=>review?.formulaUse&&typeof review.formulaUse==='object'?review.formulaUse:null;
module.exports={FormulaUse,functionsOf,recordedUse,VERSION};
