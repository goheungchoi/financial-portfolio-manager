// A small, safe formula language for the agents: arithmetic over prices and daily history, parsed into a tree and
// evaluated with a fixed set of functions. Nothing is passed to eval, and inputs are bounded in size and depth.
const LIMITS={length:300,tokens:120,depth:12,symbols:6,window:250};
const SYMBOL=/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/;
class FormulaError extends Error{constructor(code,detail){super(code);this.code=code;this.detail=detail;}}
// Name → [argument kinds ('s' symbol, 'n' number), required count, description]. Series functions use completed daily closes.
const FUNCS={
  price:['s',1,'latest price'],close:['sn',1,'daily close n days ago (0 = latest completed day)'],change:['s',1,'day change % from the previous close'],
  ret:['sn',2,'% return from the close n days ago to the latest price'],sma:['sn',2,'simple average of the last n closes'],ema:['sn',2,'exponential average of closes over n'],
  std:['sn',2,'standard deviation of daily % returns over n days'],high:['sn',2,'highest close over n days'],low:['sn',2,'lowest close over n days'],
  rsi:['sn',1,'relative strength index over n days (default 14)'],zscore:['sn',2,'(price − average) / standard deviation of closes over n days'],
  ratio_z:['ssn',3,'z-score of the price ratio of two symbols against its n-day history'],corr:['ssn',3,'correlation of daily returns of two symbols over n days'],
  avgvalue:['sn',2,'average daily traded value over n days (KRW for Korean listings)'],atr:['sn',1,'average true range over n days (default 14), in price units'],adx:['sn',1,'trend strength over n days (default 14); above about 25 is a strong trend'],macd:['s',1,'MACD histogram (12, 26, 9); above zero means upward momentum'],
  abs:['n',1],min:['n*',2],max:['n*',2],round:['nn',1],log:['n',1],sqrt:['n',1]};
function tokenize(text){
  if(typeof text!=='string'||!text.trim())throw new FormulaError('EMPTY_FORMULA');if(text.length>LIMITS.length)throw new FormulaError('FORMULA_TOO_LONG');
  const tokens=[];let i=0;
  while(i<text.length){const c=text[i];
    if(/\s/.test(c)){i++;continue;}
    if(/[0-9.]/.test(c)){const m=/^\d*\.?\d+(e[+-]?\d+)?/i.exec(text.slice(i));if(!m)throw new FormulaError('BAD_NUMBER',text.slice(i,i+8));tokens.push({t:'num',v:Number(m[0])});i+=m[0].length;continue;}
    if(c==='"'||c==="'"){const end=text.indexOf(c,i+1);if(end<0)throw new FormulaError('UNCLOSED_TEXT');tokens.push({t:'str',v:text.slice(i+1,end).trim().toUpperCase()});i=end+1;continue;}
    if(/[a-z_]/i.test(c)){const m=/^[a-z_][a-z0-9_]*/i.exec(text.slice(i));tokens.push({t:'id',v:m[0].toLowerCase()});i+=m[0].length;continue;}
    if('+-*/^(),'.includes(c)){tokens.push({t:c});i++;continue;}
    throw new FormulaError('BAD_CHARACTER',c);
  }
  if(tokens.length>LIMITS.tokens)throw new FormulaError('FORMULA_TOO_LONG');return tokens;
}
function parse(text){
  const tokens=tokenize(text);let pos=0;const symbols=new Set();
  const peek=()=>tokens[pos],take=t=>{const tok=tokens[pos];if(!tok||t&&tok.t!==t)throw new FormulaError('SYNTAX_ERROR',tok?tok.t:'end');pos++;return tok;};
  const expr=d=>{if(d>LIMITS.depth)throw new FormulaError('FORMULA_TOO_DEEP');let left=term(d);while(peek()&&(peek().t==='+'||peek().t==='-')){const op=take().t;left={op,a:left,b:term(d)};}return left;};
  const term=d=>{let left=power(d);while(peek()&&(peek().t==='*'||peek().t==='/')){const op=take().t;left={op,a:left,b:power(d)};}return left;};
  const power=d=>{const base=unary(d);if(peek()?.t==='^'){take();return {op:'^',a:base,b:unary(d)};}return base;};
  const unary=d=>{if(peek()?.t==='-'){take();return {op:'neg',a:unary(d+1)};}if(peek()?.t==='+'){take();return unary(d+1);}return primary(d);};
  const primary=d=>{
    const tok=take();
    if(tok.t==='num')return {num:tok.v};
    if(tok.t==='('){const inner=expr(d+1);take(')');return inner;}
    if(tok.t==='str'){if(!SYMBOL.test(tok.v))throw new FormulaError('BAD_SYMBOL',tok.v);symbols.add(tok.v);if(symbols.size>LIMITS.symbols)throw new FormulaError('TOO_MANY_SYMBOLS');return {sym:tok.v};}
    if(tok.t==='id'){
      const spec=FUNCS[tok.v];if(!spec)throw new FormulaError('UNKNOWN_FUNCTION',tok.v);take('(');const args=[];
      if(peek()?.t!==')'){args.push(expr(d+1));while(peek()?.t===','){take();args.push(expr(d+1));}}take(')');
      const [kinds,required]=spec;const variadic=kinds.endsWith('*');
      if(args.length<required||!variadic&&args.length>kinds.length||args.length>8)throw new FormulaError('WRONG_ARGUMENTS',tok.v);
      args.forEach((arg,i)=>{const kind=variadic?'n':kinds[i];if(kind==='s'&&!arg.sym)throw new FormulaError('WRONG_ARGUMENTS',`${tok.v} needs a symbol in quotes`);if(kind==='n'&&arg.sym)throw new FormulaError('WRONG_ARGUMENTS',`${tok.v} needs a number`);});
      return {fn:tok.v,args};
    }
    throw new FormulaError('SYNTAX_ERROR',tok.t);
  };
  const ast=expr(0);if(pos<tokens.length)throw new FormulaError('SYNTAX_ERROR',tokens[pos].t);
  return {ast,symbols:[...symbols]};
}
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
const sd=v=>{if(v.length<2)return null;const m=mean(v);return Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));};
// data: {price(symbol), closes(symbol) → [{date,close,value}] oldest first, previousClose(symbol)}; missing data raises NO_DATA.
function evaluate(ast,data){
  const series=sym=>{const s=data.closes(sym);if(!Array.isArray(s)||!s.length)throw new FormulaError('NO_DATA',sym);return s;};
  const last=(sym,n)=>{const s=series(sym);if(!Number.isInteger(n)||n<1||n>LIMITS.window)throw new FormulaError('BAD_WINDOW',String(n));if(s.length<n)throw new FormulaError('NOT_ENOUGH_HISTORY',sym);return s.slice(-n);};
  const px=sym=>{const p=data.price(sym);if(!Number.isFinite(p)||p<=0)throw new FormulaError('NO_PRICE',sym);return p;};
  const returns=(sym,n)=>{const s=last(sym,n+1);return s.slice(1).map((r,i)=>r.close/s[i].close-1);};
  const num=v=>{if(!Number.isFinite(v))throw new FormulaError('NOT_A_NUMBER');return v;};
  const go=node=>{
    if('num' in node)return node.num;
    if(node.op){const a=go(node.a);if(node.op==='neg')return -a;const b=go(node.b);
      if(node.op==='+')return a+b;if(node.op==='-')return a-b;if(node.op==='*')return a*b;if(node.op==='/'){if(b===0)throw new FormulaError('DIVIDE_BY_ZERO');return a/b;}return num(a**b);}
    const args=node.args;const s=i=>args[i].sym,n=(i,fallback)=>{if(args[i]===undefined)return fallback;const v=go(args[i]);if(!Number.isFinite(v))throw new FormulaError('NOT_A_NUMBER');return v;},w=(i,f)=>Math.round(n(i,f));
    switch(node.fn){
      case 'price':return px(s(0));
      case 'close':{const lag=w(1,0);const r=series(s(0));if(lag<0||lag>=r.length)throw new FormulaError('NOT_ENOUGH_HISTORY',s(0));return r[r.length-1-lag].close;}
      case 'change':{const prev=data.previousClose?.(s(0))??series(s(0)).at(-1).close;return (px(s(0))/prev-1)*100;}
      case 'ret':{const lag=w(1);const r=series(s(0));if(lag<1||lag>r.length)throw new FormulaError('NOT_ENOUGH_HISTORY',s(0));return (px(s(0))/r[r.length-lag].close-1)*100;}
      case 'sma':return mean(last(s(0),w(1)).map(r=>r.close));
      case 'ema':{const k=w(1);const r=last(s(0),Math.min(series(s(0)).length,Math.max(k,Math.min(LIMITS.window,k*3))));const a=2/(k+1);let e=r[0].close;for(const x of r.slice(1))e=a*x.close+(1-a)*e;return e;}
      case 'std':{const v=sd(returns(s(0),w(1)));if(v==null)throw new FormulaError('NOT_ENOUGH_HISTORY',s(0));return v*100;}
      case 'high':return Math.max(...last(s(0),w(1)).map(r=>r.close));
      case 'low':return Math.min(...last(s(0),w(1)).map(r=>r.close));
      case 'rsi':{const r=returns(s(0),w(1,14));const up=mean(r.map(x=>Math.max(0,x))),down=mean(r.map(x=>Math.max(0,-x)));return down===0?100:100-100/(1+up/down);}
      case 'zscore':{const c=last(s(0),w(1)).map(r=>r.close);const v=sd(c);if(!v)throw new FormulaError('NOT_ENOUGH_HISTORY',s(0));return (px(s(0))-mean(c))/v;}
      case 'ratio_z':{const k=w(2);const a=series(s(0)),b=new Map(series(s(1)).map(r=>[r.date,r.close]));const ratios=a.filter(r=>b.has(r.date)).slice(-k).map(r=>r.close/b.get(r.date));if(ratios.length<Math.min(k,20))throw new FormulaError('NOT_ENOUGH_HISTORY',s(0)+'/'+s(1));const v=sd(ratios);if(!v)throw new FormulaError('NOT_ENOUGH_HISTORY');return (px(s(0))/px(s(1))-mean(ratios))/v;}
      case 'corr':{const k=w(2);const b=new Map(series(s(1)).map(r=>[r.date,r.close]));const a=series(s(0)).filter(r=>b.has(r.date)).slice(-(k+1));if(a.length<Math.min(k,20)+1)throw new FormulaError('NOT_ENOUGH_HISTORY');
        const x=a.slice(1).map((r,i)=>r.close/a[i].close-1),y=a.slice(1).map((r,i)=>b.get(r.date)/b.get(a[i].date)-1);const mx=mean(x),my=mean(y);let c=0,vx=0,vy=0;x.forEach((v,i)=>{c+=(v-mx)*(y[i]-my);vx+=(v-mx)**2;vy+=(y[i]-my)**2;});if(!vx||!vy)throw new FormulaError('NOT_ENOUGH_HISTORY');return c/Math.sqrt(vx*vy);}
      case 'avgvalue':{const v=last(s(0),w(1)).map(r=>r.value).filter(Number.isFinite);if(!v.length)throw new FormulaError('NO_DATA',s(0));return mean(v);}
      case 'atr':case 'adx':case 'macd':{const ind=require('./indicators.cjs');const c=series(s(0));const v=node.fn==='atr'?ind.atr(c,w(1,14)):node.fn==='adx'?ind.adx(c,w(1,14))?.adx:ind.macd(c.map(x=>x.close))?.histogram;if(v==null)throw new FormulaError('NOT_ENOUGH_HISTORY',s(0));return v;}
      case 'abs':return Math.abs(n(0));case 'min':return Math.min(...args.map((_,i)=>n(i)));case 'max':return Math.max(...args.map((_,i)=>n(i)));
      case 'round':{const d=Math.max(0,Math.min(8,w(1,0)));return Math.round(n(0)*10**d)/10**d;}
      case 'log':{const v=n(0);if(v<=0)throw new FormulaError('NOT_A_NUMBER');return Math.log(v);}
      case 'sqrt':{const v=n(0);if(v<0)throw new FormulaError('NOT_A_NUMBER');return Math.sqrt(v);}
    }
    throw new FormulaError('UNKNOWN_FUNCTION',node.fn);
  };
  return num(go(ast));
}
const OPS={'>':(a,b)=>a>b,'>=':(a,b)=>a>=b,'<':(a,b)=>a<b,'<=':(a,b)=>a<=b};
// Conditions are formula-op-value triples combined with all/any; an unevaluable condition counts as not met.
function checkConditions(conditions,combine,data){
  const results=conditions.map(c=>{try{const value=evaluate(c.ast??parse(c.expr).ast,data);return {expr:c.expr,op:c.op,value:c.value,actual:Math.round(value*10000)/10000,met:OPS[c.op](value,c.value)};}catch(error){return {expr:c.expr,op:c.op,value:c.value,actual:null,met:false,error:error.code??'FORMULA_ERROR'};}});
  return {met:results.length>0&&(combine==='any'?results.some(r=>r.met):results.every(r=>r.met)),results};
}
// Validates agent-written conditions; returns the parsed list with every symbol used.
function readConditions(list,maxConditions=4){
  if(!Array.isArray(list)||!list.length||list.length>maxConditions)throw new FormulaError('BAD_CONDITIONS',`1 to ${maxConditions} conditions`);
  const symbols=new Set();const out=list.map(c=>{if(!c||!OPS[c.op]||!Number.isFinite(c.value))throw new FormulaError('BAD_CONDITIONS','each condition needs expr, op (>, >=, <, <=) and a number value');const {ast,symbols:s}=parse(c.expr);s.forEach(x=>symbols.add(x));return {expr:c.expr.trim(),op:c.op,value:c.value,ast};});
  if(symbols.size>LIMITS.symbols)throw new FormulaError('TOO_MANY_SYMBOLS');return {conditions:out,symbols:[...symbols]};
}
const HELP='Formulas use numbers, + - * / ^, parentheses and functions on symbols in quotes ("005930", "NASD:AAPL"): '+Object.entries(FUNCS).filter(([,v])=>v[2]).map(([k,v])=>`${k}(${v[0].split('').map(t=>t==='s'?'sym':'n').join(',')}): ${v[2]}`).join('; ')+'; plus abs, min, max, round, log, sqrt. Daily functions use completed daily closes; price() is the latest quote.';
module.exports={parse,evaluate,checkConditions,readConditions,FormulaError,FUNCS,LIMITS,HELP,OPS};
