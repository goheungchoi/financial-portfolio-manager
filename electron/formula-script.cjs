'use strict';
// Screening scripts (note 5, cleared; the user: "the agents can send a script excerpt and it includes multiple lines of
// print or log function calls"): several lines of the formula language with names, print and log, an offset form for
// slopes, and ranking, filtering and counting over a universe with S as the stock. Run by this parser and the formula
// engine's own functions (formula.cjs evaluate); nothing is passed to eval. No loops, recursion, user functions, I/O,
// network, time, randomness or state between calls: each run starts empty.
// Scripts come from a model, so every input is treated as hostile: every node and every per-stock step counts against
// the bounds and the clock; a universe function is never evaluated inside a per-stock expression or at(); every string
// the script can grow is bounded; every callback is guarded and no callback's message reaches the output; nothing
// throws out of run. A run that passes a bound stops at that line, says which bound, and returns what it printed so far.
// The existing single formulas (conditions, triggers, compute) are unchanged: this module only calls formula.cjs.
// The data contract (the app builds the data and must honour it): data.closes are completed daily closes, oldest first,
// up to and including the day the data is as of (in a screen, each market's last completed close: screen-universe.cjs),
// never the current trading day until it is rolled; data.price is the last of them, used only inside the formula
// functions that take "the latest price" (ret, change, zscore, ratio_z). A script cannot call price(): it writes
// close(S, 0) for the last completed close or live(S) for the live quote, which comes only through ctx.live(symbol) →
// {price, readAt, closed} or null (screen-run.cjs reads it from KIS). at(x, k) is x as of the close k completed days
// before; at(live(S), k ≥ 1) is close(S, k-1), so at(live(S), 1) is the last completed close. If ctx.today (the current trading day, in the closes' date form) is
// given, closes dated on or after it are left out here as well. The module expects at most 311 closes a
// stock (the engine's 250-day window, the 60-day offset and one more) and keeps the last HISTORY of them.
const F=require('./formula.cjs');
const BOUNDS=Object.freeze({input:4000,lines:40,lineLength:300,outputBytes:4000,universes:3,universeSize:400,screens:20,evaluations:20000,rankN:50,ms:2000,offset:60,args:8,depth:24,name:40});
const HISTORY=400;
// Window arguments: [argument position, least, most]. A constant one out of range is the script's error, naming the line.
const WINDOWS={close:[1,0,F.LIMITS.window-1],ret:[1,1,F.LIMITS.window],sma:[1,1,F.LIMITS.window],ema:[1,1,F.LIMITS.window],std:[1,2,F.LIMITS.window-1],high:[1,1,F.LIMITS.window],low:[1,1,F.LIMITS.window],
  rsi:[1,1,F.LIMITS.window-1],zscore:[1,2,F.LIMITS.window],avgvalue:[1,1,F.LIMITS.window],atr:[1,1,F.LIMITS.window],adx:[1,1,F.LIMITS.window],cci:[1,2,F.LIMITS.window],stochrsi:[1,2,F.LIMITS.window],
  ratio_z:[2,2,F.LIMITS.window],corr:[2,2,F.LIMITS.window]};
class ScriptError extends Error{constructor(code,detail=null,line=null){super(code);this.code=code;this.detail=detail;this.line=line;}}
// A soft error is one stock's arithmetic or data: inside a screen it is counted in the coverage and the screen goes on.
const soft=(code,line,noHistory=false)=>Object.assign(new ScriptError(code,null,line),{soft:true,noHistory});
const SYMBOL=/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/;// the app's symbol rule (agent-desk isSymbol)
const NO_HISTORY=new Set(['NO_DATA','NOT_ENOUGH_HISTORY','NO_PRICE']);
const marketOf=s=>/:/.test(s)?'US':'KR';
const PRICE_FUNCS=new Set(['ret','change','zscore','ratio_z']);
// The first pass's unknown value (screen-run.cjs): a value that depends on a live quote not yet read.
const U=Object.freeze({unknown:true});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
// Names of Object.prototype are refused anywhere in a script, as names, functions or argument names.
const BANNED=new Set([...Object.getOwnPropertyNames(Object.prototype),'prototype'].map(n=>n.toLowerCase()));
const SCRIPT_FUNCS=new Set(['universe','list','union','rank','top','bottom','filter','count','at','live','print','log']);
const UNIVERSE_KEYS=['market','type','top_cap','own','list'];
const isReserved=name=>{const n=name.toLowerCase();return name==='S'||SCRIPT_FUNCS.has(n)||own(F.FUNCS,n)||n==='and'||n==='or'||n==='not';};
// Control, zero-width, line-separator and direction characters are replaced in anything printed: the output is read by
// a model and shown to the user.
// Also soft hyphen, Arabic letter mark, Mongolian vowel separator, interlinear annotation, tag characters and lone
// surrogates. Cuts are made on code points, so a pair is never split.
const CONTROL=new RegExp('['+[[0x00,0x1f],[0x7f,0x9f],[0xad,0xad],[0x61c,0x61c],[0x180e,0x180e],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0xd800,0xdfff],[0xfeff,0xfeff],[0xfff9,0xfffb],[0xe0000,0xe007f]]
  .map(([a,b])=>String.fromCodePoint(a)+'-'+String.fromCodePoint(b)).join('')+']','gu');
const clean=(s,max)=>{const t=Array.from(String(s).replace(CONTROL,' '));return t.length>max?t.slice(0,max-1).join('')+'…':t.join('');};
const bytes=s=>Buffer.byteLength(s,'utf8');
// Numbers: whole numbers below 10^15 print in full; any other is rounded to 8 significant digits, in plain decimal from
// 1e-6 up to 1e8 and in exponent form outside it (so a large value that rounding changed never looks exact).
const fmt=v=>{if(v===0)return '0';if(Number.isInteger(v)&&Math.abs(v)<1e15)return String(v);const r=Number(v.toPrecision(8));const a=Math.abs(r);
  return a>=1e-6&&a<1e8?String(r):r.toExponential(7).replace(/\.?0+e/,'e');};
const CMP=['>','<','>=','<=','==','!='];
// The app's fixed refusals for a universe (screen-universe.cjs), in this module's words.
const REFUSALS=Object.freeze(Object.assign(Object.create(null),{SIZE_ORDER_UNAVAILABLE:'no size order is available for that market or type',UNKNOWN_UNIVERSE:'no such universe',REVIEW_UNIVERSE_ONLY:'a review screens only its own stocks: use universe(own="review"), an own list or list(...) of its stocks'}));
// Tokens: numbers, text, names, and the operators of the language.
function tokenize(text,line){const out=[];let i=0;
  while(i<text.length){const c=text[i];
    if(/\s/.test(c)){i++;continue;}
    if(c==='#')break;
    if(/[0-9.]/.test(c)){const m=/^\d*\.?\d+(e[+-]?\d+)?/i.exec(text.slice(i));if(!m)throw new ScriptError('BAD_NUMBER',null,line);const v=Number(m[0]);if(!Number.isFinite(v))throw new ScriptError('BAD_NUMBER','too large',line);out.push({t:'num',v});i+=m[0].length;continue;}
    if(c==='"'||c==="'"){const end=text.indexOf(c,i+1);if(end<0)throw new ScriptError('UNCLOSED_TEXT',null,line);out.push({t:'str',v:text.slice(i+1,end)});i=end+1;continue;}
    if(/[a-z_]/i.test(c)){const m=/^[a-z_][a-z0-9_]*/i.exec(text.slice(i));if(BANNED.has(m[0].toLowerCase()))throw new ScriptError('RESERVED_NAME',m[0],line);out.push({t:'id',v:m[0]});i+=m[0].length;continue;}
    const two=text.slice(i,i+2);if(['==','!=','>=','<='].includes(two)){out.push({t:two});i+=2;continue;}
    if('+-*/^(),[]=<>'.includes(c)){out.push({t:c});i++;continue;}
    throw new ScriptError('BAD_CHARACTER','U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0'),line);}
  return out;}
const tokenWord=k=>k.t==='id'?'a name':k.t==='num'?'a number':k.t==='str'?'text':`"${k.t}"`;
// Expressions: or / and / not, comparisons, + - * /, unary minus, ^, calls (with name=value arguments), lists, names, S.
// Unary minus binds looser than ^ here: -2^2 is -4 (formula.cjs, which conditions use, is unchanged).
function parseExpr(tokens,line){let pos=0;const peek=()=>tokens[pos];
  const take=t=>{const k=tokens[pos];if(!k)throw new ScriptError('SYNTAX_ERROR','the line ends early',line);if(t&&k.t!==t)throw new ScriptError('SYNTAX_ERROR',`${tokenWord(k)} where "${t}" belongs`,line);pos++;return k;};
  const deep=d=>{if(d>BOUNDS.depth)throw new ScriptError('TOO_DEEP',null,line);};
  const word=w=>peek()?.t==='id'&&peek().v.toLowerCase()===w;
  const or=d=>{deep(d);let a=and(d);while(word('or')){take();a={t:'op',op:'or',a,b:and(d)};}return a;};
  const and=d=>{let a=not(d);while(word('and')){take();a={t:'op',op:'and',a,b:not(d)};}return a;};
  const not=d=>{if(word('not')){take();deep(d+1);return {t:'op',op:'not',a:not(d+1)};}return cmp(d);};
  const cmp=d=>{const a=add(d);if(CMP.includes(peek()?.t)){const op=take().t;return {t:'op',op,a,b:add(d)};}return a;};
  const add=d=>{let a=mul(d);while(peek()?.t==='+'||peek()?.t==='-'){const op=take().t;a={t:'op',op,a,b:mul(d)};}return a;};
  const mul=d=>{let a=unary(d);while(peek()?.t==='*'||peek()?.t==='/'){const op=take().t;a={t:'op',op,a,b:unary(d)};}return a;};
  const unary=d=>{if(peek()?.t==='-'){take();deep(d+1);return {t:'op',op:'neg',a:unary(d+1)};}if(peek()?.t==='+'){take();deep(d+1);return unary(d+1);}return pow(d);};
  const pow=d=>{const a=primary(d);if(peek()?.t==='^'){take();deep(d+1);return {t:'op',op:'^',a,b:unary(d+1)};}return a;};
  const primary=d=>{const k=take();
    if(k.t==='num')return {t:'num',v:k.v};if(k.t==='str')return {t:'str',v:k.v};
    if(k.t==='('){deep(d+1);const e=or(d+1);take(')');return e;}
    if(k.t==='['){deep(d+1);const items=[];if(peek()?.t!==']'){items.push(or(d+1));while(peek()?.t===','){take();items.push(or(d+1));}}take(']');return {t:'list',items};}
    if(k.t==='id'){if(peek()?.t==='('){take();deep(d+1);const args=[],named=[];
        if(peek()?.t!==')'){const one=()=>{if(peek()?.t==='id'&&tokens[pos+1]?.t==='='){const n=take().v;take('=');named.push([n.toLowerCase(),or(d+1)]);}else args.push(or(d+1));};one();while(peek()?.t===','){take();one();}}
        take(')');return {t:'call',fn:k.v.toLowerCase(),args,named};}
      return k.v==='S'?{t:'stock'}:{t:'name',v:k.v};}
    throw new ScriptError('SYNTAX_ERROR',`${tokenWord(k)} cannot start a value`,line);};
  const e=or(0);if(pos<tokens.length)throw new ScriptError('SYNTAX_ERROR',`${tokenWord(tokens[pos])} after a complete value`,line);return e;}
// One line: `name = expr`, `print(...)`, `log(...)`, or blank / # comment (null).
function parseLine(raw,line){const tokens=tokenize(raw,line);if(!tokens.length)return null;
  if(tokens[0].t==='id'&&tokens[1]?.t==='='){const name=tokens[0].v;if(isReserved(name))throw new ScriptError('RESERVED_NAME',name,line);return {line,assign:name,expr:parseExpr(tokens.slice(2),line)};}
  const expr=parseExpr(tokens,line);if(expr.t!=='call'||!(expr.fn==='print'||expr.fn==='log'))throw new ScriptError('NOT_A_STATEMENT','a line is name = expression, print(...) or log(...)',line);
  if(expr.named.length||!expr.args.length||expr.args.length>BOUNDS.args)throw new ScriptError('WRONG_ARGUMENTS',`${expr.fn}(value, …) takes 1 to ${BOUNDS.args} values`,line);return {line,out:expr.fn,expr};}
// The whole-script bounds, checked before any line runs: the total length first, then the line count.
function splitScript(text){if(typeof text!=='string'||!text.trim())throw new ScriptError('EMPTY_SCRIPT');
  if(text.length>BOUNDS.input)throw new ScriptError('SCRIPT_TOO_LONG',`at most ${BOUNDS.input} characters`);
  const lines=text.split(/\r?\n/);if(lines.length>1&&lines.at(-1)==='')lines.pop();
  if(lines.length>BOUNDS.lines)throw new ScriptError('TOO_MANY_LINES',`at most ${BOUNDS.lines} lines`);return lines;}
const checkLine=(raw,line)=>{if(raw.length>BOUNDS.lineLength)throw new ScriptError('LINE_TOO_LONG',`at most ${BOUNDS.lineLength} characters`,line);};
// Every line parsed (for a check without running); run() parses each line as it reaches it.
function parseScript(text){return splitScript(text).map((raw,i)=>{checkLine(raw,i+1);return parseLine(raw,i+1);}).filter(Boolean);}
const usesStock=node=>{switch(node.t){case 'stock':return true;case 'op':return usesStock(node.a)||(node.b?usesStock(node.b):false);
  case 'list':return node.items.some(usesStock);case 'call':return node.args.some(usesStock)||node.named.some(([,v])=>usesStock(v));default:return false;}};
const FAIL=Symbol('fail');
const USAGE={rank:'rank(universe, expression, "highest" or "lowest"[, n])',top:'top(universe, expression[, n])',bottom:'bottom(universe, expression[, n])',filter:'filter(universe, condition)',
  count:'count(universe[, condition])',live:'live(stock): S or a code in quotes',union:`union(universe, universe, …) with 2 to ${BOUNDS.args}`,list:'list("code", …)',at:'at(expression, days)',
  universe:'universe(market="…", type="…", top_cap=…, own="…") or universe(list=[…])'};
const formulaUsage=fn=>{const [kinds,required]=F.FUNCS[fn];if(kinds.endsWith('*'))return `${fn} takes ${required} to ${BOUNDS.args} numbers`;
  const all=kinds.split('').map(k=>k==='s'?'stock':'number');return `${fn}(${all.slice(0,required).join(', ')}${all.length>required?`[, ${all.slice(required).join(', ')}]`:''})`;};
// ctx: {data: formula data (price, closes, previousClose), universe(spec) → {name, symbols} (S2 builds it), names(symbol) →
// display name, isStale(symbol), now}. Returns {lines, coverage, stopped?}. Nothing throws out of run.
function run(text,ctx){const c=ctx!==null&&typeof ctx==='object'?ctx:{};
  try{return execute(text,c);}catch{return {lines:[],coverage:[],stopped:stopFor(new ScriptError('SCRIPT_ERROR'),null)};}}
function stopFor(e,current){const code=e instanceof ScriptError&&own(WORDS,e.code)?e.code:'SCRIPT_ERROR';const line=(e instanceof ScriptError?e.line:null)??current??null;
  const detail=code!=='SCRIPT_ERROR'&&typeof e.detail==='string'&&e.detail?clean(e.detail,120):null;
  return {code,line,detail,words:`${line?`line ${line}: `:''}${WORDS[code]}${detail?` (${detail})`:''}`};}
function execute(text,ctx){const out=[],coverage=[],vars=new Map(),varMarks=new Map(),varNotes=new Map(),marks=new Set(),notes=new Set(),closeMarkets=new Set(),liveTimes=[],varLive=new Map();let used=0,evals=0,universes=0,current=null;
  const nowFn=typeof ctx.now==='function'?ctx.now:null;
  const clock=()=>{if(nowFn){try{const t=nowFn.call(ctx);if(Number.isFinite(t))return t;}catch{}}return Date.now();};
  const started=clock();
  // Every node, and every stock of a screen, is one evaluation; the clock is read at each.
  let evalLimit=BOUNDS.evaluations;try{if(typeof ctx.livePlan==='function')evalLimit=2*BOUNDS.evaluations;}catch{}
  const tick=line=>{if(++evals>evalLimit)throw new ScriptError('TOO_MANY_EVALUATIONS',`at most ${evalLimit}`,line);if(clock()-started>BOUNDS.ms)throw new ScriptError('TOO_SLOW',`at most ${BOUNDS.ms/1000} seconds`,line);};
  const addOutput=(n,line)=>{if(used+n>BOUNDS.outputBytes)throw new ScriptError('OUTPUT_TOO_LONG',`at most ${BOUNDS.outputBytes} bytes, the coverage included`,line);used+=n;};
  // The data, read once per stock through guarded callbacks; a failed read is that stock's data error, without its message.
  let src={};try{if(ctx.data!==null&&typeof ctx.data==='object')src=ctx.data;}catch{}
  const cache={price:new Map(),closes:new Map(),previousClose:new Map()};
  const read=(method,symbol)=>{const m=cache[method];let v=m.get(symbol);
    if(v===undefined){v=null;let fn=null;try{fn=src[method];}catch{}if(typeof fn==='function'){try{const r=fn.call(src,symbol);v=r==null?null:r;}catch{v=FAIL;}}m.set(symbol,v);}
    if(v===FAIL)throw soft('DATA_ERROR',current);return v;};
  // One shape of history per stock, kept once: completed closes only (a row dated on or after ctx.today is left out),
  // the last HISTORY of them.
  let today=null;try{if(typeof ctx.today==='string'&&ctx.today)today=ctx.today;}catch{}
  const shaped=new Map();
  const history=s=>{if(shaped.has(s))return shaped.get(s);const c=read('closes',s);let h=null;
    if(Array.isArray(c)){let end=c.length;if(today)while(end>0&&typeof c[end-1]?.date==='string'&&c[end-1].date>=today)end--;h=end?c.slice(Math.max(0,end-HISTORY),end):null;}
    shaped.set(s,h);return h;};
  const finite=p=>typeof p==='number'&&Number.isFinite(p)?p:null;
  // The latest price inside the formula functions and the previous close are always worked out from the history, at every k.
  const live={price:s=>finite(history(s)?.at(-1)?.close),closes:s=>history(s),previousClose:s=>finite(history(s)?.at(-2)?.close)};
  // The offset form: as of the close k completed days before, the closes up to that day are the history and that close
  // is the latest price, so every function spans the same sessions at every k. A view keeps no copy: each read cuts the kept history and
  // the cut is dropped after the formula call.
  const views=new Map([[0,live]]);
  const view=k=>{let v=views.get(k);if(v)return v;
    const closes=s=>{const c=history(s);return c&&c.length>k?c.slice(0,c.length-k):null;};
    v={price:s=>{const c=history(s);return c&&c.length>k?finite(c[c.length-k-1]?.close):null;},closes,
      previousClose:s=>{const c=history(s);return c&&c.length>k+1?finite(c[c.length-k-2]?.close):null;}};views.set(k,v);return v;};
  const splits=new Map();
  const split=k=>{let v=splits.get(k);if(v)return v;const full=view(k);
    v={price:s=>{const c=history(s);return c&&c.length>k?finite(c[c.length-k-1]?.close):null;},closes:s=>{const c=full.closes(s);return c&&c.length>1?c.slice(0,-1):null;},previousClose:full.previousClose};splits.set(k,v);return v;};
  const staleMap=new Map();
  const staleOf=s=>{if(staleMap.has(s))return staleMap.get(s);let v=false;let fn=null;try{fn=ctx.isStale;}catch{}if(typeof fn==='function'){try{v=fn.call(ctx,s)===true;}catch{v=FAIL;}}staleMap.set(s,v);return v;};
  const nameOf=s=>{let fn=null;try{fn=ctx.names;}catch{}if(typeof fn!=='function')return null;try{const n=fn.call(ctx,s);return typeof n==='string'&&n.trim()?clean(n.trim(),BOUNDS.name):null;}catch{return null;}};
  const livePrice=s=>{try{return live.price(s);}catch{return null;}};
  // ctx.live(symbol) → {price, readAt, closed} or null; read once per symbol a run, guarded.
  const liveCache=new Map();
  // The first pass (screen-run.cjs): live() records its stock and answers UNKNOWN, so every value that depends on a quote
  // is unknown and the pass visits every stock pass 2 could ask for.
  let planner=null,assume=null;try{if(typeof ctx.livePlan==='function')planner=ctx.livePlan;if(typeof ctx.livePlanAssumed==='function')assume=ctx.livePlanAssumed;}catch{}
  const assumed=()=>{try{assume?.call(ctx);}catch{}};
  // In the first pass a side is evaluated for its value or its soft error, so an unknown elsewhere can still decide.
  const BOUND_CODES=new Set(['TOO_MANY_EVALUATIONS','TOO_SLOW','OUTPUT_TOO_LONG','TOO_MANY_SCREENS','TOO_MANY_UNIVERSES']);
  const side=(node,line,sc,conv)=>{try{const v=value(node,line,sc);return {v:conv?conv(v):v};}catch(error){if(planning&&error instanceof ScriptError&&error.soft)return {err:error};throw error;}};
  const either=(A,B)=>{if(A.err||B.err){if(A.v===U||B.v===U)return {v:U};throw A.err??B.err;}return null;};
  const after=(A,node,line,sc,conv)=>{if(!A.err)return side(node,line,sc,conv);try{return side(node,line,sc,conv);}catch(error){if(!(error instanceof ScriptError)||BOUND_CODES.has(error.code))throw error;return {};}};const planning=Boolean(planner);
  let liveStopped=null;try{if(typeof ctx.liveStopped==='string'&&ctx.liveStopped)liveStopped=clean(ctx.liveStopped,80);}catch{}
  const liveOf=s=>{if(liveCache.has(s))return liveCache.get(s);let q=null;let fn=null;try{fn=ctx.live;}catch{}
    if(typeof fn==='function'){try{const r=fn.call(ctx,s);if(r&&typeof r==='object'&&typeof r.price==='number'&&Number.isFinite(r.price)&&r.price>0)q={price:r.price,readAt:Number.isFinite(r.readAt)&&Math.abs(r.readAt)<8.64e15?r.readAt:null,closed:r.closed===true};}catch{q=null;}}
    liveCache.set(s,q);return q;};
  const liveCall=(n,line,sc)=>{sig(n,line,1,1);const a=n.args[0];const v=value(a,line,sc);const sym=symbolOf(v);
    if(typeof v!=='string')throw new ScriptError('WRONG_ARGUMENTS','live needs a stock: S or a code in quotes',line);if(!SYMBOL.test(sym))throw new ScriptError('BAD_SYMBOL','in live',line);
    // at(live(S), k ≥ 1) is close(S, k-1): the live price as of the close k completed days ago is that day's close, so one
    // day back from now is the last completed close.
    if(a.t!=='stock')allowed(sym,line);
    if(sc.k>0){readFrom(sym);const p=view(sc.k-1).price(sym);if(p==null)throw soft('NO_PRICE',line,true);return p;}
    if(a.t!=='stock'){const st=staleOf(sym);if(st===FAIL)notes.add(`freshness unknown: ${sym}`);}
    if(planning){try{planner.call(ctx,sym);}catch{}return U;}
    const q=liveOf(sym);if(!q){let why=null;try{const r=typeof ctx.liveWhy==='function'?ctx.liveWhy(sym):null;if(typeof r==='string'&&r)why=clean(r,60);}catch{}const reason=why??liveStopped;if(liveStopped)notes.add(liveStopped);
      throw Object.assign(soft('NO_LIVE',line),{noLive:true,detail:reason});}liveTimes.push({at:q.readAt,closed:q.closed,market:marketOf(sym)});return q.price;};
  const number=(v,line,what)=>{if(v===U)return U;if(typeof v!=='number')throw new ScriptError('NOT_A_NUMBER',what??null,line);if(!Number.isFinite(v))throw soft('NOT_FINITE',line);return v;};
  const truth=(v,line)=>{if(v===U)return U;if(typeof v!=='boolean')throw new ScriptError('NOT_A_CONDITION','use a comparison such as rsi(S,14) < 30',line);return v;};
  const comparable=(a,b,line)=>{const ok=t=>t==='number'||t==='string'||t==='boolean';if(!ok(typeof a)||typeof a!==typeof b)throw new ScriptError('NOT_COMPARABLE','== and != compare two numbers, two texts or two conditions',line);};
  const symbolOf=v=>typeof v==='string'?v.trim().toUpperCase():'';
  // ctx.allowSymbol(s) (a review): a symbol outside the review's own stocks is refused wherever it enters the script.
  let allowFn=null;try{if(typeof ctx.allowSymbol==='function')allowFn=ctx.allowSymbol;}catch{}
  const allowed=(s,line)=>{if(!allowFn)return;let ok=false;try{ok=allowFn.call(ctx,s)===true;}catch{}if(!ok)throw new ScriptError('NOT_IN_UNIVERSE',`${s} is not one of this review's stocks`,line);};
  // ctx.isFallback(s), ctx.asOfFor(s) (a review): a stock read from the review's own daily history, with its own as-of day.
  const isFallback=s=>{try{return typeof ctx.isFallback==='function'&&ctx.isFallback(s)===true;}catch{return false;}};
  const ownDay=s=>{try{const d=typeof ctx.asOfFor==='function'?ctx.asOfFor(s):null;return typeof d==='string'?d:null;}catch{return null;}};
  // A stale stock's value is labelled with the day its history really ends (ctx.asOfFor), never the market's day.
  const fallbackDays=new Set(),staleDays=new Set();const readFrom=sym=>{const d=ownDay(sym);if(isFallback(sym)&&d&&!(staleOf(sym)===true))fallbackDays.add(d);else if(staleOf(sym)===true&&d){if(isFallback(sym))fallbackDays.add(d);else staleDays.add(d);}else closeMarkets.add(marketOf(sym));};
  // A formula function: its arguments evaluated here, then a formula.cjs tree with numbers and symbols, evaluated there.
  const formula=(n,line,sc)=>{if(n.fn==='price')throw new ScriptError('PRICE_AMBIGUOUS','use live(S) for the live price or close(S,0) for the last completed close',line);
    const [kinds,required]=F.FUNCS[n.fn];const variadic=kinds.endsWith('*');let unknownArg=false;
    if(n.named.length||n.args.length<required||n.args.length>(variadic?BOUNDS.args:kinds.length))throw new ScriptError('WRONG_ARGUMENTS',formulaUsage(n.fn),line);
    let argErr=null;const args=n.args.map((a,i)=>{if(!variadic&&kinds[i]==='s'){const v=value(a,line,sc);const sym=symbolOf(v);
        if(typeof v!=='string')throw new ScriptError('WRONG_ARGUMENTS',`${n.fn} needs a stock: S or a code in quotes`,line);if(!SYMBOL.test(sym))throw new ScriptError('BAD_SYMBOL',`in ${n.fn}`,line);
        if(a.t!=='stock'){allowed(sym,line);const st=staleOf(sym);if(st===FAIL)notes.add(`freshness unknown: ${sym}`);else if(st)marks.add(sym);}readFrom(sym);return {sym};}
      const r=side(a,line,sc,x=>number(x,line,`${n.fn} needs numbers`));if(r.err){argErr??=r.err;return {num:0};}const v=r.v;if(v===U){unknownArg=true;return {num:0};}const w=own(WINDOWS,n.fn)?WINDOWS[n.fn]:null;
      if(w&&w[0]===i&&!usesStock(a)&&!(Number.isInteger(v)&&v>=w[1]&&v<=w[2]))throw new ScriptError('BAD_WINDOW',`${n.fn} takes ${w[1]} to ${w[2]} days, a whole number`,line);
      return {num:v};});
    // ret, change, zscore and ratio_z take "the latest price": in a script that is the last kept close, and their history
    // is the closes before it, so ret(S,1) is the last day's move and a z-score's window never holds its own price.
    if(argErr){if(unknownArg)return U;throw argErr;}if(unknownArg)return U;
    try{return F.evaluate({fn:n.fn,args},PRICE_FUNCS.has(n.fn)?split(sc.k):view(sc.k));}
    catch(error){if(error instanceof ScriptError)throw error;const code=error instanceof F.FormulaError?error.code:'DATA_ERROR';
      if(code==='BAD_WINDOW')throw new ScriptError('BAD_WINDOW',`1 to ${F.LIMITS.window} days`,line);
      if(NO_HISTORY.has(code))throw soft(code,line,true);throw soft(code==='DIVIDE_BY_ZERO'?code:code==='DATA_ERROR'?code:'NO_VALUE',line);}};
  const countUniverse=line=>{if(++universes>BOUNDS.universes)throw new ScriptError('TOO_MANY_UNIVERSES',`at most ${BOUNDS.universes}`,line);};
  const makeList=(items,line,sc)=>{countUniverse(line);if(items.length>BOUNDS.universeSize)throw new ScriptError('UNIVERSE_TOO_LARGE',`at most ${BOUNDS.universeSize} stocks`,line);
    const symbols=[],seen=new Set();items.forEach((item,i)=>{const s=symbolOf(value(item,line,sc));if(!SYMBOL.test(s))throw new ScriptError('BAD_SYMBOL',`item ${i+1} of the list is not a stock code`,line);allowed(s,line);if(!seen.has(s)){seen.add(s);symbols.push(s);}});
    return Object.freeze({universe:true,name:'list',symbols});};
  const fromApp=(spec,line)=>{countUniverse(line);let fn=null;try{fn=ctx.universe;}catch{}if(typeof fn!=='function')throw new ScriptError('BAD_UNIVERSE','no universes here',line);
    let u;try{u=fn.call(ctx,Object.freeze(spec));}catch{throw new ScriptError('BAD_UNIVERSE','the app could not list it',line);}
    // The app may refuse with one of its fixed codes (said in this module's own words) or add a note to the line.
    let symbols,name;try{const refused=u!==null&&typeof u==='object'?u.refused:null;if(typeof refused==='string')throw new ScriptError('BAD_UNIVERSE',own(REFUSALS,refused)?REFUSALS[refused]:'no such universe',line);
      const note=u!==null&&typeof u==='object'?u.note:null;if(typeof note==='string'&&note.trim())notes.add(clean(note.trim(),80));
      const list=u!==null&&typeof u==='object'?u.symbols:null;if(!Array.isArray(list))throw new ScriptError('BAD_UNIVERSE','no such universe',line);
      if(list.length>BOUNDS.universeSize)throw new ScriptError('UNIVERSE_TOO_LARGE',`at most ${BOUNDS.universeSize} stocks`,line);
      symbols=[...new Set(list)];if(!symbols.every(s=>typeof s==='string'&&SYMBOL.test(s)))throw new ScriptError('BAD_UNIVERSE','a listed code is not a stock code',line);for(const s of symbols)allowed(s,line);
      name=typeof u.name==='string'&&u.name.trim()?clean(u.name.trim(),BOUNDS.name):'universe';}
    catch(error){if(error instanceof ScriptError)throw error;throw new ScriptError('BAD_UNIVERSE','the app could not list it',line);}
    return Object.freeze({universe:true,name,symbols:Object.freeze(symbols)});};
  const universeCall=(n,line,sc)=>{if(n.args.length||!n.named.length)throw new ScriptError('WRONG_ARGUMENTS',USAGE.universe,line);
    const keys=n.named.map(([k])=>k);if(keys.some(k=>!UNIVERSE_KEYS.includes(k))||new Set(keys).size!==keys.length)throw new ScriptError('WRONG_ARGUMENTS',USAGE.universe,line);
    if(keys.includes('list')){if(keys.length>1)throw new ScriptError('WRONG_ARGUMENTS','list= stands alone',line);const node=n.named[0][1];
      if(node.t==='list')return makeList(node.items,line,sc);return asUniverse(value(node,line,sc),line);}
    const spec={};for(const [k,node] of n.named){const v=value(node,line,sc);
      if(k==='top_cap'&&v===U){assumed();spec[k]=BOUNDS.universeSize;continue;}
      if(k==='top_cap'){if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>BOUNDS.universeSize)throw new ScriptError('WRONG_ARGUMENTS',`top_cap is a whole number from 1 to ${BOUNDS.universeSize}`,line);}
      else if(typeof v!=='string'||!v.trim()||v.length>BOUNDS.name)throw new ScriptError('WRONG_ARGUMENTS',`${k} is short text`,line);
      spec[k]=typeof v==='string'?v.trim():v;}
    return fromApp(spec,line);};
  const asUniverse=(v,line)=>{if(v?.universe===true)return v;if(v?.ranked===true)return Object.freeze({universe:true,name:v.name,symbols:v.rows.map(r=>r.symbol)});throw new ScriptError('NOT_A_UNIVERSE',null,line);};
  const short=s=>clean(s,BOUNDS.name);
  // A screen: the expression per stock with S bound. A stale stock, one without enough history, and one whose value
  // cannot be computed are counted, never given a value; each stock lands in exactly one count.
  const screen=(u,expr,line,check)=>{if(!usesStock(expr))throw new ScriptError('NO_S_IN_EXPRESSION','the expression must use S, or every stock gets the same value',line);
    if(coverage.length>=BOUNDS.screens)throw new ScriptError('TOO_MANY_SCREENS',`at most ${BOUNDS.screens}`,line);
    const c={line,universe:u.name,size:u.symbols.length,evaluated:0,noHistory:0,stale:0,errors:0,noLive:0,fallback:0},vals=[];const liveReasons=new Set();
    for(const symbol of u.symbols){tick(line);const st=staleOf(symbol);if(st===FAIL){c.errors++;continue;}if(st){c.stale++;continue;}
      let v;try{v=value(expr,line,{k:0,stock:symbol});}catch(error){if(error instanceof ScriptError&&error.soft){if(error.noLive){c.noLive++;if(error.detail)liveReasons.add(error.detail);continue;}else if(error.noHistory)c.noHistory++;else c.errors++;continue;}throw error;}
      check(v);vals.push({symbol,v});c.evaluated++;if(isFallback(symbol))c.fallback++;}
    if(c.noLive&&c.evaluated){const why=[...liveReasons].filter(r=>r!==liveStopped);notes.add(`${c.noLive} no live price${why.length?`: ${why.slice(0,2).join(', ')}`:''}`);}
    addOutput(bytes(JSON.stringify(c))+1,line);coverage.push(Object.freeze(c));vals.coverage=c;return vals;};
  // When no stock of a screen was evaluated the printed value says so, with the reasons, so a script mistake or an
  // empty history never reads as "none qualify".
  const reasons=c=>[c.noHistory&&`${c.noHistory} no history`,c.stale&&`${c.stale} stale`,c.errors&&`${c.errors} not computable`,c.noLive&&`${c.noLive} no live price`].filter(Boolean).join(', ');
  const emptyNote=c=>c&&c.size&&!c.evaluated?`0 of ${c.size} evaluated; ${reasons(c)}`:null;
  const sig=(n,line,min,max)=>{if(n.named.length||n.args.length<min||n.args.length>max)throw new ScriptError('WRONG_ARGUMENTS',USAGE[n.fn],line);};
  const call=(n,line,sc)=>{const fn=n.fn;
    if(own(F.FUNCS,fn))return formula(n,line,sc);
    if(!SCRIPT_FUNCS.has(fn))throw new ScriptError('UNKNOWN_FUNCTION',fn,line);
    if(fn==='print'||fn==='log')throw new ScriptError('NOT_HERE',`${fn} is a line of its own`,line);
    if(fn==='live')return liveCall(n,line,sc);
    if(fn==='at'){sig(n,line,2,2);const k=number(value(n.args[1],line,sc),line,'the days are a number');if(k===U){value(n.args[0],line,sc);return U;}
      if(!Number.isInteger(k)||k<0||sc.k+k>BOUNDS.offset)throw new ScriptError('BAD_OFFSET',`whole days, at most ${BOUNDS.offset} in all`,line);return value(n.args[0],line,{k:sc.k+k,stock:sc.stock});}
    if(sc.stock||sc.k)throw new ScriptError('NESTED_UNIVERSE',`${fn} cannot be used inside a per-stock expression or at()`,line);
    switch(fn){
      case 'universe':return universeCall(n,line,sc);
      case 'list':sig(n,line,1,BOUNDS.universeSize);return makeList(n.args,line,sc);
      case 'union':{sig(n,line,2,BOUNDS.args);const us=n.args.map(a=>asUniverse(value(a,line,sc),line));const symbols=[...new Set(us.flatMap(u=>u.symbols))];
        if(symbols.length>BOUNDS.universeSize)throw new ScriptError('UNIVERSE_TOO_LARGE',`at most ${BOUNDS.universeSize} stocks`,line);return Object.freeze({universe:true,name:`union of ${us.length}`,symbols});}
      case 'rank':case 'top':case 'bottom':{const isRank=fn==='rank';sig(n,line,isRank?3:2,isRank?4:3);const u=asUniverse(value(n.args[0],line,sc),line);
        const dir=fn==='top'?'highest':fn==='bottom'?'lowest':value(n.args[2],line,sc);if(dir!=='highest'&&dir!=='lowest')throw new ScriptError('WRONG_ARGUMENTS','the direction is "highest" or "lowest"',line);
        const nNode=n.args[isRank?3:2];const wantV=nNode?number(value(nNode,line,sc),line,'n is a number'):10;const want=wantV===U?BOUNDS.rankN:wantV;if(wantV===U)assumed();
        if(wantV!==U&&(!Number.isInteger(want)||want<1||want>BOUNDS.rankN))throw new ScriptError('BAD_N',`a whole number from 1 to ${BOUNDS.rankN}`,line);
        const vals=screen(u,n.args[1],line,v=>{if(v!==U&&typeof v!=='number')throw new ScriptError('NOT_A_NUMBER','the expression to rank must give a number',line);});
        // An unknown value or n (the first pass only): every stock is a candidate, so the ranking keeps them all.
        const unknown=wantV===U||vals.some(x=>x.v===U);if(!unknown)vals.sort((a,b)=>dir==='highest'?b.v-a.v:a.v-b.v);
        return Object.freeze({ranked:true,name:short(`${fn} of ${u.name}`),coverage:vals.coverage,rows:(unknown?vals:vals.slice(0,want)).map(x=>{const q=liveCache.get(x.symbol);return Object.freeze({symbol:x.symbol,name:nameOf(x.symbol),value:x.v,...(q?{live:q.price,liveAt:q.readAt,closed:q.closed,us:marketOf(x.symbol)==='US'}:{price:livePrice(x.symbol),asOf:isFallback(x.symbol)?`${ownDay(x.symbol)??'—'}, review history`:asOfOf(x.symbol)})});})});}
      case 'filter':{sig(n,line,2,2);const u=asUniverse(value(n.args[0],line,sc),line);const vals=screen(u,n.args[1],line,v=>truth(v,line));
        return Object.freeze({universe:true,name:short(`filter of ${u.name}`),coverage:vals.coverage,symbols:vals.filter(x=>x.v===true||x.v===U).map(x=>x.symbol)});}
      case 'count':{sig(n,line,1,2);const u=asUniverse(value(n.args[0],line,sc),line);if(n.args.length===1)return u.symbols.length;
        const vals=screen(u,n.args[1],line,v=>truth(v,line));const note=emptyNote(vals.coverage);if(note)notes.add(`count: ${note}`);return vals.some(x=>x.v===U)?U:vals.filter(x=>x.v).length;}
    }
    throw new ScriptError('UNKNOWN_FUNCTION',fn,line);};
  const op=(n,line,sc)=>{
    if(n.op==='not'){const a=truth(value(n.a,line,sc),line);return a===U?U:!a;}
    if(planning&&(n.op==='and'||n.op==='or')){const A=side(n.a,line,sc,x=>truth(x,line));const settled=n.op==='and'?A.v===false:A.v===true;
      // A branch reached only because the first pass visits both sides: any error in it is skipped, except a bound.
      if(settled){try{value(n.b,line,sc);}catch(error){if(!(error instanceof ScriptError)||BOUND_CODES.has(error.code))throw error;}return A.v;}
      const B=after(A,n.b,line,sc,x=>truth(x,line));const e=either(A,B);if(e)return e.v;const a=A.v,b=B.v;
      if(n.op==='and')return b===false?false:a===U||b===U?U:true;return b===true?true:a===U||b===U?U:false;}
    if(n.op==='and'||n.op==='or'){const a=truth(value(n.a,line,sc),line);const settled=n.op==='and'?a===false:a===true;
      if(settled){if(planning){try{value(n.b,line,sc);}catch(error){if(!(error instanceof ScriptError&&error.soft))throw error;}}return a;}
      const b=truth(value(n.b,line,sc),line);if(n.op==='and')return b===false?false:a===U||b===U?U:true;return b===true?true:a===U||b===U?U:false;}
    if(n.op==='neg'){const x=number(value(n.a,line,sc),line,'minus needs a number');return x===U?U:-x;}
    let a,b;if(planning){const A=side(n.a,line,sc),B=after(A,n.b,line,sc);const e=either(A,B);if(e)return e.v;a=A.v;b=B.v;}else{a=value(n.a,line,sc);b=value(n.b,line,sc);}
    if(a===U||b===U){if(n.op!=='=='&&n.op!=='!='){number(a,line,`${n.op} needs numbers`);number(b,line,`${n.op} needs numbers`);}return U;}
    if(n.op==='=='||n.op==='!='){comparable(a,b,line);return n.op==='=='?a===b:a!==b;}
    const what=`${n.op} needs numbers`;const x=number(a,line,what),y=number(b,line,what);let r;
    switch(n.op){case '+':r=x+y;break;case '-':r=x-y;break;case '*':r=x*y;break;case '/':if(y===0)throw soft('DIVIDE_BY_ZERO',line);r=x/y;break;case '^':r=x**y;break;
      case '>':return x>y;case '<':return x<y;case '>=':return x>=y;case '<=':return x<=y;default:throw new ScriptError('SYNTAX_ERROR',null,line);}
    if(!Number.isFinite(r))throw soft('NOT_FINITE',line);return r;};
  // sc: {k: the offset in days, stock: the symbol S stands for, or null at the top level}.
  const value=(n,line,sc)=>{tick(line);
    switch(n.t){
      case 'num':case 'str':return n.v;
      case 'stock':if(!sc.stock)throw new ScriptError('NO_STOCK',null,line);return sc.stock;
      case 'name':{if(!vars.has(n.v))throw new ScriptError('UNKNOWN_NAME',n.v,line);const m=varMarks.get(n.v);if(m)for(const s of m)marks.add(s);const o=varNotes.get(n.v);if(o)for(const s of o)notes.add(s);const l=varLive.get(n.v);if(l){for(const d of l.fallback??[])fallbackDays.add(d);for(const d of l.stale??[])staleDays.add(d);for(const m of l.markets)closeMarkets.add(m);liveTimes.push(...l.times);}return vars.get(n.v);}
      case 'list':if(sc.stock||sc.k)throw new ScriptError('NESTED_UNIVERSE','a list cannot be used inside a per-stock expression or at()',line);return makeList(n.items,line,sc);
      case 'call':return call(n,line,sc);
      case 'op':return op(n,line,sc);}
    throw new ScriptError('SYNTAX_ERROR',null,line);};
  // A ranking is cut to the bytes left, with "… N more not shown", so one in-bounds ranking always prints.
  const show=(v,line,budget)=>{if(v===U)return '?';if(typeof v==='number'){if(!Number.isFinite(v))throw new ScriptError('NOT_FINITE',null,line);return fmt(v);}
    if(typeof v==='boolean')return v?'yes':'no';if(typeof v==='string')return clean(v,BOUNDS.lineLength);
    if(v?.ranked===true){if(!v.rows.length){const note=emptyNote(v.coverage);return note?`(none: ${note})`:'(none)';}
      const rows=v.rows.map((r,i)=>`${i+1}. ${r.symbol}${r.name?` ${r.name}`:''} ${r.value===U?'?':fmt(r.value)}${r.live!=null?` (live ${fmt(r.live)}${r.liveAt?`, ${clockOf(r.liveAt).slice(0,5)}`:''}${r.closed?', market closed':''}${r.us?', unchecked':''})`:r.price!=null?` (close ${fmt(r.price)}${r.asOf?`, ${r.asOf}`:''})`:''}`);let text='',shown=0;
      for(const r of rows){const next=shown?`${text}; ${r}`:r;const rest=rows.length-shown-1;if(bytes(next)+(rest?bytes(`; … ${rest} more not shown`):0)>budget)break;text=next;shown++;}
      return shown===rows.length?text:`${text}${shown?'; ':''}… ${rows.length-shown} more not shown`;}
    if(v?.universe===true){const note=emptyNote(v.coverage);return `${v.name}: ${v.symbols.length} stocks${note?` (${note})`:''}`;}return '?';};
  const TOP=Object.freeze({k:0,stock:null});
  // The marks of a line: "(live: read 09:41:05–09:41:12 KST)" (or "market closed: last price read …") when it used live(),
  // and "(as of close 2030-01-02)" per market when it used stored closes (ctx.asOf gives each market's day).
  let asOf={};try{if(ctx.asOf&&typeof ctx.asOf==='object')asOf={KR:typeof ctx.asOf.KR==='string'?ctx.asOf.KR:null,US:typeof ctx.asOf.US==='string'?ctx.asOf.US:null};}catch{}
  function asOfOf(s){return asOf[marketOf(s)]??null;}
  function clockOf(t){try{return new Date(t+9*3600000).toISOString().slice(11,19);}catch{return '--:--:--';}}
  // Each value's marks: live (with the read times, a market closed per market, U.S. prices unchecked) and as of close.
  const sourceMark=()=>{let mark='';const times=liveTimes.map(x=>x.at).filter(Number.isFinite);
    if(liveTimes.length){const lo=times.length?clockOf(Math.min(...times)):null,hi=times.length?clockOf(Math.max(...times)):null;const span=lo?(lo===hi?lo:`${lo}–${hi}`)+' KST':'time unknown';
      const closed=[...new Set(liveTimes.filter(x=>x.closed).map(x=>x.market))];const us=liveTimes.some(x=>x.market==='US');
      mark+=` (live: read ${span}${closed.length?`; ${closed.join(' and ')} market closed, last price`:''}${us?'; U.S. unchecked':''})`;}
    if(fallbackDays.size)mark+=` (as of close ${[...fallbackDays].sort().join(', ')}, from the review's daily history)`;
    if(staleDays.size)mark+=` (as of close ${[...staleDays].sort().join(', ')}, older than the market's last close)`;
    const days=[...closeMarkets].map(m=>[m,asOf[m]]).filter(([,d])=>d);if(days.length)mark+=days.length===1?` (as of close ${days[0][1]})`:` (as of close ${days.map(([m,d])=>`${m} ${d}`).join(', ')})`;
    return mark;};
  const SUFFIX=200;// bytes kept for the marks and notes of a line
  try{const lines=splitScript(text);
    for(let i=0;i<lines.length;i++){current=i+1;checkLine(lines[i],current);const st=parseLine(lines[i],current);if(!st)continue;marks.clear();notes.clear();closeMarkets.clear();liveTimes.length=0;fallbackDays.clear();staleDays.clear();
      if(st.assign){const v=value(st.expr,current,TOP);vars.set(st.assign,v);varMarks.set(st.assign,new Set(marks));varNotes.set(st.assign,new Set(notes));varLive.set(st.assign,{markets:new Set(closeMarkets),times:[...liveTimes],fallback:[...fallbackDays],stale:[...staleDays]});continue;}
      let line=st.out==='log'?'log: ':'';
      st.expr.args.forEach((a,j)=>{closeMarkets.clear();liveTimes.length=0;fallbackDays.clear();staleDays.clear();const v=value(a,current,TOP);line+=(j?' ':'')+show(v,current,BOUNDS.outputBytes-used-bytes(line)-SUFFIX)+sourceMark();});
      if(marks.size){const stale=[...marks];line+=` (stale data: ${stale.slice(0,3).join(', ')}${stale.length>3?` and ${stale.length-3} more`:''})`;}
      const said=[...notes];if(said.length)line+=said.slice(0,3).map(s=>` (${clean(s,60)})`).join('')+(said.length>3?` (and ${said.length-3} more notes)`:'');
      addOutput(bytes(line)+1,current);out.push(line);}
    return {lines:out,coverage};}
  catch(error){return {lines:out,coverage,stopped:stopFor(error,current)};}}
const WORDS=Object.freeze(Object.assign(Object.create(null),{EMPTY_SCRIPT:'the script is empty',SCRIPT_TOO_LONG:'the script is too long',TOO_MANY_LINES:'too many lines',LINE_TOO_LONG:'the line is too long',
  SYNTAX_ERROR:'this line cannot be read',NOT_A_STATEMENT:'not a statement',RESERVED_NAME:'that name is a function, S or a reserved word',UNKNOWN_NAME:'no value has that name yet',
  UNKNOWN_FUNCTION:'no such function',NOT_HERE:'print and log are lines of their own',WRONG_ARGUMENTS:'wrong arguments',NO_STOCK:'S is used outside rank, top, bottom, filter or count',
  NO_S_IN_EXPRESSION:'the per-stock expression does not use S',NESTED_UNIVERSE:'a universe function inside a per-stock expression or at()',NOT_A_NUMBER:'not a number',NOT_A_CONDITION:'not a condition',PRICE_AMBIGUOUS:'price() is not used in scripts',NOT_IN_UNIVERSE:'not one of this review\'s stocks',NO_LIVE:'no live price',
  NOT_COMPARABLE:'these values cannot be compared',NOT_FINITE:'the result is not a finite number',NO_VALUE:'the function has no value here',DIVIDE_BY_ZERO:'divided by zero',DATA_ERROR:'the data for a stock could not be read',
  BAD_OFFSET:'the offset is out of range',BAD_N:'the count is out of range',BAD_SYMBOL:'not a stock code',NOT_A_UNIVERSE:'not a universe',BAD_UNIVERSE:'the universe cannot be listed',
  UNIVERSE_TOO_LARGE:'the universe is too large',TOO_MANY_UNIVERSES:'too many universes',TOO_MANY_SCREENS:'too many screens',TOO_MANY_EVALUATIONS:'too many evaluations',TOO_SLOW:'the script ran too long',
  OUTPUT_TOO_LONG:'the output is too long',NO_DATA:'no history for that stock',NOT_ENOUGH_HISTORY:'not enough history',NO_PRICE:'no price',BAD_WINDOW:'the window is out of range',
  BAD_CHARACTER:'a character the language does not use',BAD_NUMBER:'a malformed number',UNCLOSED_TEXT:'unclosed text',TOO_DEEP:'nested too deeply',SCRIPT_ERROR:'the script could not be run'}));
// The functions as a script sees them: what each computes and its range, with no reading of the value.
const FUNCTION_TEXT='Functions (sym is S or a code in quotes, such as "005930" or "NASD:AAPL"; n is a number of days): live(sym): the live quote; close(sym,n): the daily close n completed days before the last (0 = the last completed close); change(sym): % change of the last completed close from the close before it; ret(sym,n): % return from the close n sessions before the last completed close to it; sma(sym,n): average of the last n closes; ema(sym,n): exponential average of the closes over n; std(sym,n): standard deviation of daily % returns over n days; high(sym,n), low(sym,n): highest and lowest close over n days; rsi(sym,n): relative strength index over n days (default 14), 0 to 100; zscore(sym,n): (last close − average of the n closes before it) / their standard deviation; ratio_z(sym,sym,n): z-score of the ratio of two stocks\' last closes against the ratio\'s n-day history; corr(sym,sym,n): correlation of the two stocks\' daily returns over n days, −1 to 1; avgvalue(sym,n): average daily traded value over n days (KRW for Korean listings, USD for U.S. ones); atr(sym,n): average true range over n days (default 14), in price units; adx(sym,n): average directional index over n days (default 14), 0 to 100; macd(sym): MACD histogram (12, 26, 9), in price units; cci(sym,n): commodity channel index over n days (default 14); stochrsi(sym,n): stochastic RSI over n days (default 14), 0 to 100; ultimate(sym): ultimate oscillator (7, 14, 28 days), 0 to 100; and abs, min, max, round, log, sqrt.';
const HELP='Screening scripts: up to 40 lines (300 characters each, 4,000 in all) of name = expression, print(value, …) or log(value, …) with 1 to 8 values, in order; # starts a comment. '
  +'Prices: live(S) is the live quote, read from KIS during the run; close(S, 0) is the last completed close, from the stored history; price() is refused in scripts, so each value says which it is. Every other function uses the stored closes only, as of each market\'s last completed close: ret, change, zscore and ratio_z take that close as "the latest price" (unlike a trigger\'s formula, where it is the latest quote). at(live(S), k) for k of 1 or more is close(S, k-1): the live price as of the close k completed days ago is that day\'s close, so at(live(S), 1) is the last completed close and live(S) / at(live(S), 1) - 1 is today\'s move. Each printed value is marked: "(live: read 09:41:05 KST)" when it used live prices ("KR market closed, last price" when that market is closed) and "(as of close 2030-01-02)" per market when it used stored closes; ranked rows say "(live 170, 09:41)" or "(close 159, 2030-01-02)". A U.S. live price is the last price KIS gives and cannot be checked for a halt: it is marked "unchecked". A stock without a live price is counted as no live price, never given a close instead, and a line says how many and why ("no trade yet today" for a Korean stock not yet traded in a session, "the read failed", or why live reads stopped). Live reads stop for the rest of the scout run when an order is being sent, when KIS asks the app to slow down, after three failed requests in a row, when the run\'s 60 seconds of waiting are spent, or when the run is stopped. A script runs in two passes: the first plans which live prices to read; if the plan cannot be made (a bound in the first pass, which has twice the evaluations) the script stops there and reads nothing. When n or top_cap depends on a live price, the plan assumes every candidate. A script with a syntax error is not run: it prints nothing but the error naming its line. Live prices: live(S) reads at most 60 Korean and 20 U.S. stocks a script and 120 and 40 a scout run; a universe can be reduced with filter, top or bottom before live(S) is used. Closes are adjusted for splits as KIS gives them. A stock whose history is shorter than a function\'s window is counted as no history, never given a shorter window. '
  +'Expressions: numbers, "text", + - * / ^ (minus binds looser than ^, so -2^2 is -4), > >= < <= (numbers), == != (two numbers, two texts or two conditions), and, or, not, and the formula functions below with a stock argument (S or a code in quotes). '
  +'at(expression, k): the expression as of the close k completed days before the last one; k is a whole number, at most 60 in all. '
  +'Universes: universe(market=…, type=…, top_cap=…, own=…), universe(list=[…]), list("code", …) or ["code", …], union(u1, u2, …). With S as each stock of a universe: rank(u, expression, "highest" or "lowest"[, n]), top(u, expression[, n]), bottom(u, expression[, n]) (n from 1 to 50, default 10), filter(u, condition), count(u[, condition]); the expression must use S, and none of these may be used inside it or inside at(). '
  +'A stale stock, one without enough history and one whose value cannot be computed are counted in the coverage, never ranked; when no stock of a screen was evaluated the printed value says "0 of N evaluated" with the reasons; a line that read a stale stock by its code is marked, and its value says the day that stock\'s history ends: "(as of close D, older than the market\'s last close)". A constant window out of range is an error naming the line. '
  +'Bounds: 3 universes of 400 stocks (lists included), 20 screens, 20,000 evaluations (each stock of a screen is one, plus one per value of its expression: over 400 stocks a 4-value expression uses 2,000), 2 seconds, 4,000 output bytes with the coverage (a long ranking is cut with "… N more not shown"); a run past a bound stops at that line and returns what it printed. '
  +'Numbers: whole numbers below 10^15 print in full; any other is rounded to 8 significant digits, in plain decimal from 1e-6 up to 1e8 (0.33333333) and in exponent form outside it (1.2345679e+11). '+FUNCTION_TEXT;
module.exports={run,parseScript,stopFor,clean,BOUNDS,ScriptError,HELP,FUNCTION_TEXT};
