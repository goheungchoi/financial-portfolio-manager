// Screening scripts (note 5, S1): lines, names, print and log, the offset form, rank/top/bottom/filter/count over a
// universe with S as the stock, coverage, bounds that stop at their line with what was printed, errors naming the line.
// Scripts come from a model, so the second half attacks the language (the planner's first review, items 1-14).
// Made-up symbols and prices.
const test=require('node:test');const assert=require('node:assert/strict');const {run,BOUNDS,HELP}=require('../electron/formula-script.cjs');
// Five stocks with 60 closes each: 111110 rises, 222220 falls, 333330 flat, 444440 short history, 555550 no history.
const series=(start,step,n=60)=>Array.from({length:n},(_,i)=>({date:`d${i}`,close:start+step*i,value:1e9}));
const H={'111110':series(100,1),'222220':series(200,-1),'333330':series(150,0),'444440':series(100,1,5)};
const data={closes:s=>H[s]??null,price:s=>H[s]?.at(-1).close??null,previousClose:s=>H[s]?.at(-2)?.close??null};
const ctx=(extra={})=>({data,universe:spec=>spec.market==='TEST'?{name:'test',symbols:['111110','222220','333330','444440','555550']}:null,names:s=>'Name'+s.slice(0,1),...extra});
const U='u = universe(market="TEST")\n';
const big=(extra={})=>({...ctx(),universe:()=>({name:'big',symbols:Array.from({length:BOUNDS.universeSize},(_,i)=>String(100000+i))}),
  data:{closes:()=>series(100,1),price:()=>170,previousClose:()=>159},...extra});
const addsUp=r=>r.coverage.forEach(c=>assert.equal(c.evaluated+c.noHistory+c.stale+c.errors,c.size,'each stock lands in exactly one count'));
test('lines, names, print and log in order; formula functions with a named stock',()=>{
  const r=run('x = price("111110")\ny = x * 2\nprint("double", y)\nlog("done")',ctx());assert.deepEqual(r.lines,['double 318','log: done']);assert.equal(r.stopped,undefined);
});
test('rank, top, bottom, filter and count over a universe; history too short or missing is counted, never ranked',()=>{
  const r=run([U+'print("up", top(u, ret(S,20), 2))','print("down", bottom(u, ret(S,20), 1))','f = filter(u, ret(S,20) > 0)','print("rising", count(f))','print("all", count(u))'].join('\n'),ctx());
  assert.match(r.lines[0],/^up 1\. 111110 Name1 \d/);assert.match(r.lines[0],/2\. 333330/);assert.match(r.lines[1],/^down 1\. 222220/);assert.equal(r.lines[2],'rising 1');assert.equal(r.lines[3],'all 5');
  const c=r.coverage[0];assert.deepEqual({size:c.size,evaluated:c.evaluated,noHistory:c.noHistory,line:c.line},{size:5,evaluated:3,noHistory:2,line:2},'444440 (5 closes) and 555550 (none) are counted, not ranked');addsUp(r);
  assert.match(run(U+'print(rank(u, ret(S,20), "lowest", 1))',ctx()).lines[0],/^1\. 222220/);assert.equal(run(U+'print(top(u, ret(S,20)))',ctx()).stopped,undefined,'n defaults to 10');
});
test('the offset form writes a slope: the 20-day average now against five days ago',()=>{
  const r=run(U+'print(top(u, sma(S,20) - at(sma(S,20),5), 1))',ctx());assert.match(r.lines[0],/^1\. 111110 Name1 5 /,'rising by 1 a day: a slope of 5 over five days');
  assert.equal(run('print(at(price("111110"), 3))',ctx()).lines[0],'157','at k the price is the close k completed days ago');
  assert.equal(run('print(at(price("111110"), 99))',ctx()).stopped.code,'BAD_OFFSET');
});
test('a stale stock is counted and not ranked',()=>{
  const r=run(U+'print(top(u, ret(S,20), 5))',ctx({isStale:s=>s==='111110'}));assert.doesNotMatch(r.lines[0],/111110/);assert.equal(r.coverage[0].stale,1);addsUp(r);
});
test('errors name the line; a bound stops at its line and returns what was printed',()=>{
  const e=run('print("a")\nx = rsi(S,14)',ctx());assert.deepEqual(e.lines,['a']);assert.equal(e.stopped.line,2);assert.match(e.stopped.words,/^line 2: S is used outside rank/);
  assert.equal(run('print(nope)',ctx()).stopped.code,'UNKNOWN_NAME');assert.equal(run('x = 1 +',ctx()).stopped.code,'SYNTAX_ERROR');assert.equal(run('rsi = 1',ctx()).stopped.code,'RESERVED_NAME');
  const p=run(Array.from({length:BOUNDS.lines},(_,i)=>`print(${i})`).join('\n'),ctx());assert.equal(p.lines.length,BOUNDS.lines,'within the line bound all print');
  assert.equal(run(Array.from({length:BOUNDS.lines+1},()=>'print(1)').join('\n'),ctx()).stopped.code,'TOO_MANY_LINES');
  assert.equal(run(U+'print(top(u, ret(S,20), 99))',ctx()).stopped.code,'BAD_N');
  assert.equal(run('print(top(universe(market="NONE"), price(S), 1))',ctx()).stopped.code,'BAD_UNIVERSE');
  let t=0;const slow=run(U+'print(count(u))\nprint(top(u, price(S), 1))',ctx({now:()=>(t+=1500)}));assert.equal(slow.stopped.code,'TOO_SLOW');
  const over={...ctx(),universe:()=>({name:'big',symbols:Array.from({length:BOUNDS.universeSize+1},(_,i)=>String(100000+i))})};assert.equal(run('u = universe(market="X")',over).stopped.code,'UNIVERSE_TOO_LARGE');
  assert.equal(run('a = universe(market="TEST")\nb = universe(market="TEST")\nc = universe(market="TEST")\nd = universe(market="TEST")',ctx()).stopped.code,'TOO_MANY_UNIVERSES');
});
test('no loops, no I/O, no state between calls; the existing single formulas are unchanged',()=>{
  assert.equal(run('while(1)',ctx()).stopped.code,'NOT_A_STATEMENT');assert.equal(run('x = require("fs")',ctx()).stopped.code,'UNKNOWN_FUNCTION');
  run('x = 5',ctx());assert.equal(run('print(x)',ctx()).stopped.code,'UNKNOWN_NAME','each run starts empty');
  const F=require('../electron/formula.cjs');assert.equal(F.evaluate(F.parse('price("111110")').ast,data),159);
  assert.match(run('u = list("111110","222220")\nprint(top(u, price(S), 1))',ctx()).lines[0],/^1\. 111110/,'an explicit list is a universe');
  assert.match(run('print(top(universe(list=["111110","222220"]), price(S), 1))',ctx()).lines[0],/^1\. 111110/,'universe(list=[…]) is the same, counted once');
  assert.equal(run('print(log(price("111110")) > 0)',ctx()).lines[0],'yes','log() inside an expression is the natural log; a log line is the statement');
});
// Item 1: hangs and memory.
test('item 1: a universe function inside a per-stock expression is refused; every node and stock counts; screens are bounded',()=>{
  assert.equal(run(U+'print(count(u, count(u, count(u, 1>0) > 0) > 0))',ctx()).stopped.code,'NO_S_IN_EXPRESSION');
  const nested=run(U+'print(count(u, count(u, price(S) > 0) > 0))',ctx());assert.equal(nested.stopped.code,'NESTED_UNIVERSE');assert.equal(nested.stopped.line,2);
  assert.equal(run(U+'print(top(u, count(u) + price(S), 1))',ctx()).stopped.code,'NESTED_UNIVERSE');
  const started=Date.now();const heavy=run('u = universe(market="BIG")\n'+Array.from({length:10},()=>'print(count(u, price(S) + price(S) + price(S) + price(S) > 0))').join('\n'),big());
  assert.equal(heavy.stopped.code,'TOO_MANY_EVALUATIONS');assert.ok(Date.now()-started<BOUNDS.ms,'stopped by the evaluation bound, quickly');assert.ok(heavy.coverage.length<=BOUNDS.screens);addsUp(heavy);
  const screens=run(U+Array.from({length:BOUNDS.screens+1},()=>'print(count(u, price(S) > 0))').join('\n'),ctx());
  assert.equal(screens.stopped.code,'TOO_MANY_SCREENS');assert.equal(screens.stopped.line,BOUNDS.screens+2);assert.equal(screens.coverage.length,BOUNDS.screens);assert.equal(screens.lines.length,BOUNDS.screens);addsUp(screens);
});
test('item 1: the real 2-second clock stops a slow screen inside its loop',()=>{
  const spin=ms=>{const end=Date.now()+ms;while(Date.now()<end);};
  const slow=big({data:{closes:()=>{spin(10);return series(100,1);},price:()=>170,previousClose:()=>159}});const started=Date.now();
  const r=run('u = universe(market="BIG")\nprint("start")\nprint(top(u, sma(S,20), 1))',slow);const took=Date.now()-started;
  assert.equal(r.stopped.code,'TOO_SLOW');assert.equal(r.stopped.line,3);assert.deepEqual(r.lines,['start']);assert.ok(took<BOUNDS.ms+500,`stopped near the bound (${took} ms)`);
});
// Item 2: names and lists.
test('item 2: universe names stay short; lists count toward the universe bound; the output bound covers the coverage',()=>{
  const r=run(['u = ["111110"]',...Array.from({length:8},()=>'u = union(u,u,u,u,u,u,u,u)'),'print(count(u, price(S) > 0))'].join('\n'),ctx());
  assert.equal(r.stopped,undefined);assert.ok(r.coverage[0].universe.length<=BOUNDS.name);assert.ok(JSON.stringify(r).length<1000);
  assert.equal(run('a = ["111110"]\nb = list("222220")\nc = universe(market="TEST")\nd = ["333330"]',ctx()).stopped.code,'TOO_MANY_UNIVERSES');
  const long=run(U+'t = "'+'x'.repeat(120)+'"\n'+Array.from({length:15},()=>'print(t, t, count(u, price(S) > 0))').join('\n'),ctx());assert.equal(long.stopped.code,'OUTPUT_TOO_LONG');
  const returned=long.lines.reduce((n,l)=>n+l.length+1,0)+long.coverage.reduce((n,c)=>n+JSON.stringify(c).length+1,0);assert.ok(returned<=BOUNDS.outputBytes,`${returned} characters returned`);
});
// Item 3: at() against a live price that differs from the last close.
test('item 3: at(expr, k) is expr as of the close k completed days ago, spanning the same sessions at every k',()=>{
  const live={...data,price:s=>s==='111110'?170:data.price(s)};const c=ctx({data:live});const one=t=>{const r=run(t,c);assert.equal(r.stopped,undefined,t);return Number(r.lines[0]);};
  assert.equal(one('print(price("111110"))'),170);assert.equal(one('print(at(price("111110"),1))'),159,'k=1 is yesterday\'s close');
  assert.equal(one('print(at(ret("111110",1),1))'),Number(((159/158-1)*100).toPrecision(8)),'a one-day return a day ago is not zero');
  assert.equal(one('print(ret("111110",20))'),Number(((170/140-1)*100).toPrecision(8)),'now: the live price against the close 20 completed days back');
  assert.equal(one('print(at(ret("111110",20),5))'),Number(((155/135-1)*100).toPrecision(8)),'five days ago: 20 sessions as well');
  const w=Array.from({length:20},(_,i)=>139+i),m=w.reduce((a,b)=>a+b)/20,sd=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/19);
  assert.equal(one('print(at(zscore("111110",20),1))'),Number(((159-m)/sd).toPrecision(8)),'the window is the 20 closes before the price, never the price itself');
  assert.equal(one('print(at(at(price("111110"),30),30))'),100);assert.equal(run('print(at(at(price("111110"),30),31))',c).stopped.code,'BAD_OFFSET','nested offsets add up to at most 60');
  assert.equal(run('print(at(price("111110"),1.5))',c).stopped.code,'BAD_OFFSET');
});
// Items 4 and 5: fixed signatures.
test('items 4-5: named, extra or missing arguments are WRONG_ARGUMENTS naming the function and the line',()=>{
  const wrong=(t,fn)=>{const r=run(t,ctx());assert.equal(r.stopped?.code,'WRONG_ARGUMENTS',t);assert.match(r.stopped.words,new RegExp(`^line \\d+: wrong arguments \\(.*${fn}`),t);assert.doesNotMatch(r.stopped.words,/Cannot|undefined|TypeError/,t);};
  wrong(U+'print(top(u, price(S), n=1))','top');wrong(U+'print(top(u, price(S), 1, "lowest"))','top');wrong('print(x=1)','print');
  wrong('x = 1\nprint(at(x,1,2))','at');wrong(U+'print(top(u, price(S,5), 1))','price');wrong(U+'print(count(u, price(S) > 0, 1))','count');wrong('u = universe("TEST")','universe');
  wrong(U+'print(rank(u, price(S)))','rank');wrong('print(at(1))','at');wrong('print(top())','top');wrong('print(rank())','rank');wrong(U+'print(filter(u))','filter');wrong(U+'print(union(u))','union');
  wrong('print(count())','count');wrong('print(list())','list');wrong('print()','print');wrong('u = universe(market="TEST", size=3)','universe');wrong('u = universe(market="TEST", market="TEST")','universe');
  wrong(U+'print(rank(u, price(S), "up", 3))','direction');
  let called=0;run('u = universe("TEST")',ctx({universe:()=>{called++;return null;}}));assert.equal(called,0,'the app is never asked for a malformed universe');
});
// Item 6: Object.prototype names.
test('item 6: Object.prototype names are refused as functions, names and argument names',()=>{
  let called=0;const c=ctx({universe:()=>{called++;return null;}});
  for(const t of ['print(constructor(1))','print(count(u, constructor() == 1))','u = universe(__proto__="x")','u = universe(constructor="x", hasOwnProperty="y")','x = __proto__','toString = 1','print(valueOf)'])
    assert.equal(run(t,c).stopped?.code,'RESERVED_NAME',t);
  assert.equal(called,0);
});
// Item 7: one stock's arithmetic error.
test('item 7: one stock\'s arithmetic error is counted in the coverage; the screen goes on',()=>{
  const r=run(U+'print(top(u, (price(S)-sma(S,20))/std(S,20), 3))',ctx());assert.equal(r.stopped,undefined);
  assert.doesNotMatch(r.lines[0],/333330/,'the flat stock is not ranked');assert.match(r.lines[0],/111110/);assert.equal(r.coverage[0].errors,1);addsUp(r);
  const top=run('print("a")\nprint(1/0)',ctx());assert.deepEqual(top.lines,['a']);assert.equal(top.stopped.code,'DIVIDE_BY_ZERO');assert.equal(top.stopped.line,2);
});
// Item 8: conditions and numbers.
test('item 8: a non-condition in filter or count and a non-number in rank are refused',()=>{
  assert.equal(run(U+'print(count(filter(u, rsi(S,14))))',ctx()).stopped.code,'NOT_A_CONDITION');assert.equal(run(U+'print(count(u, price(S)))',ctx()).stopped.code,'NOT_A_CONDITION');
  assert.equal(run(U+'print(top(u, price(S) > 100, 3))',ctx()).stopped.code,'NOT_A_NUMBER');
  const r=run(U+'print(count(u, ret(S,20) > 0))',ctx());assert.equal(r.lines[0],'1');assert.equal(r.coverage[0].evaluated,3,'evaluated counts the values used');addsUp(r);
});
// Item 9: number printing.
test('item 9: a non-finite value is an error naming the line; numbers print with significant digits',()=>{
  const p=t=>run(`print(${t})`,ctx());
  assert.equal(p('1e999').stopped.code,'BAD_NUMBER');assert.equal(p('1e305 * 1e10').stopped.code,'NOT_FINITE');assert.equal(p('1e305 * 1e10').stopped.line,1);
  assert.equal(p('1e305').lines[0],'1e+305');assert.equal(p('0.00004').lines[0],'0.00004');assert.equal(p('1e21').lines[0],'1e+21');assert.equal(p('1/3').lines[0],'0.33333333');
  assert.equal(p('123456789').lines[0],'123456789');assert.equal(p('-0').lines[0],'0');assert.match(HELP,/8 significant digits, in plain decimal from 1e-6 up to 1e8/);
});
// Item 10: unary minus.
test('item 10: -2^2 is -4 in the script language; formula.cjs is unchanged',()=>{
  const p=t=>run(`print(${t})`,ctx()).lines[0];assert.equal(p('-2^2'),'-4');assert.equal(p('(-2)^2'),'4');assert.equal(p('2^-1'),'0.5');assert.equal(p('2^3^2'),'512');assert.equal(p('-price("111110")'),'-159');
  const F=require('../electron/formula.cjs');assert.equal(F.evaluate(F.parse('-2^2').ast,data),4,'conditions keep their behaviour');
});
// Item 11: symbols validated before any callback.
test('item 11: every symbol from a list or from the app is checked before any callback',()=>{
  const seen=[];const spy={closes:s=>{seen.push(s);return null;},price:s=>{seen.push(s);return null;},previousClose:()=>null};
  assert.equal(run('print(top(["../../x","a b"], price(S), 2))',ctx({data:spy})).stopped.code,'BAD_SYMBOL');assert.equal(run(U+'print(list(u))',ctx({data:spy})).stopped.code,'BAD_SYMBOL');
  assert.equal(run('u = universe(market="X")\nprint(top(u, price(S), 1))',ctx({data:spy,universe:()=>({name:'x',symbols:['111110','../../etc']})})).stopped.code,'BAD_UNIVERSE');
  assert.equal(run('print(price("../x"))',ctx({data:spy})).stopped.code,'BAD_SYMBOL');assert.deepEqual(seen,[]);
});
// Item 12: line-by-line runs and reachable bounds.
test('item 12: a bad line keeps what printed before it; the total length is checked first; no dead bounds',()=>{
  const r=run('print(1)\nprint(2)\nprint(3 +)\nprint(4)',ctx());assert.deepEqual(r.lines,['1','2']);assert.equal(r.stopped.code,'SYNTAX_ERROR');assert.equal(r.stopped.line,3);
  assert.deepEqual(run('print(1)\nprint("'+'x'.repeat(BOUNDS.lineLength)+'")',ctx()).lines,['1'],'a long line stops at its turn');
  const total=run(Array.from({length:20},()=>'# '+'x'.repeat(250)).join('\n'),ctx());assert.equal(total.stopped.code,'SCRIPT_TOO_LONG');
  assert.equal(BOUNDS.statements,undefined);assert.equal(BOUNDS.prints,undefined);assert.ok(BOUNDS.input<BOUNDS.lines*BOUNDS.lineLength,'the total bound is below what the line bounds allow');
  assert.equal(run('print(1)\n',ctx()).stopped,undefined,'a final newline is not a line');
});
// Item 13: callbacks and caller edges.
test('item 13: no callback message reaches the output and nothing escapes run',()=>{
  const secret='C:\\Users\\someone\\secret\\path '+'y'.repeat(5000);
  for(const thrown of [new Error(secret),secret,null]){const boom=()=>{throw thrown;};
    const cases=[
      [U+'print(1)',ctx({universe:boom})],[U+'print(top(u, price(S), 3))',ctx({isStale:boom})],[U+'print(top(u, price(S), 3))',ctx({names:boom})],
      [U+'print(top(u, ret(S,20), 3))',ctx({data:{price:boom,closes:boom,previousClose:boom}})],['print(price("111110"))',ctx({data:{price:boom,closes:boom}})],['print(1)',ctx({now:boom})]];
    for(const [t,c] of cases){let r;assert.doesNotThrow(()=>{r=run(t,c);});const all=JSON.stringify(r);assert.doesNotMatch(all,/secret|Users|yyyy/,t);assert.ok(all.length<2000);}}
  const failed=run(U+'print(top(u, ret(S,20), 3))',ctx({isStale:()=>{throw new Error('x');}}));assert.equal(failed.coverage[0].errors,5);addsUp(failed);
  assert.deepEqual(run('print(1)',null).lines,['1']);assert.deepEqual(run('print(1)').lines,['1']);assert.equal(run(null,null).stopped.code,'EMPTY_SCRIPT');assert.equal(run(42,{}).stopped.code,'EMPTY_SCRIPT');
  const getter=Object.defineProperty({},'data',{get(){throw new Error(secret);}});const g=run('print(price("111110"))',getter);assert.doesNotMatch(JSON.stringify(g),/secret/);
});
// Item 14: the answers in words, as tests where they were faults.
test('item 14: offsets add up; stale reads are marked; at() takes no universe; S is required; == compares like with like; control characters are stripped',()=>{
  const st=ctx({isStale:s=>s==='111110'});assert.equal(run('print(price("111110"))',st).lines[0],'159 (stale data: 111110)');
  assert.equal(run('x = price("111110")\nprint("x", x)',st).lines[0],'x 159 (stale data: 111110)','the mark travels with a named value');
  assert.equal(run(U+'print(at(top(u, price(S), 1), 5))',ctx()).stopped.code,'NESTED_UNIVERSE');
  assert.equal(run(U+'s = "111110"\nprint(top(u, price(s), 3))',ctx()).stopped.code,'NO_S_IN_EXPRESSION');
  assert.equal(run('print(["111110"] == ["111110"])',ctx()).stopped.code,'NOT_COMPARABLE');assert.equal(run('print("1" == 1)',ctx()).stopped.code,'NOT_COMPARABLE');
  assert.equal(run('print("a" == "a", 1 == 1, (1 > 0) == (2 > 1))',ctx()).lines[0],'yes yes yes');
  const cr=run('print("a\rlog: fake\u202e\u0007")',ctx());assert.equal(cr.lines.length,1);assert.doesNotMatch(cr.lines[0],/[\u0000-\u001f\u202e]/);assert.match(cr.lines[0],/^a log: fake/);
  const n=run(U+'print(top(u, price(S), 1))',ctx({names:()=>'Bad\nname\u0000'+'z'.repeat(100)})).lines[0];assert.doesNotMatch(n,/[\u0000-\u001f]/);assert.ok(n.length<120);
});
// The planner's second review, items A-F.
test('A: a screen with nothing evaluated says so; a constant window out of range is the script\'s error',()=>{
  for(const t of ['print(top(u, close(S,-1), 3))','print(top(u, close(S,9999), 3))','print(top(u, sma(S,0), 3))','print(top(u, sma(S,2.5), 3))']){const r=run(U+t,ctx());assert.equal(r.stopped?.code,'BAD_WINDOW',t);assert.equal(r.stopped.line,2);}
  assert.equal(run(U+'print(top(u, log(0-price(S)), 3))',ctx()).lines[0],'(none: 0 of 5 evaluated; 1 no history, 4 not computable)');
  assert.equal(run(U+'print(count(u, 1/(price(S)-price(S)) > 0))',ctx()).lines[0],'0 (count: 0 of 5 evaluated; 1 no history, 4 not computable)');
  assert.equal(run(U+'print(filter(u, sqrt(0-1-price(S)) > 0))',ctx()).lines[0],'filter of test: 0 stocks (0 of 5 evaluated; 1 no history, 4 not computable)');
  assert.equal(run(U+'print(top(u, ret(S,20), 3))',ctx({isStale:()=>true})).lines[0],'(none: 0 of 5 evaluated; 5 stale)');
  assert.equal(run(U+'c = count(u, ret(S,90) > 0)\nprint("n", c)',ctx()).lines[0],'n 0 (count: 0 of 5 evaluated; 5 no history)','the note travels with a name');
  assert.equal(run(U+'print(count(u, ret(S,20) > 0))',ctx()).lines[0],'1','a screen that evaluated stocks prints its value alone');
});
test('B: one data shape: closes exclude the current day, so a slope means the same before and after the close',()=>{
  const day=i=>new Date(Date.UTC(2030,0,1)+i*86400000).toISOString().slice(0,10);const rows=n=>Array.from({length:n},(_,i)=>({date:day(i),close:100+i,value:1e9}));
  const before={data:{closes:()=>rows(60),price:()=>160,previousClose:()=>159}};
  const after={data:{closes:()=>rows(61),price:()=>160,previousClose:()=>160},today:day(60)};
  const t='print(sma("111110",20) - at(sma("111110",20),5), at(price("111110"),1), ret("111110",20), change("111110"), close("111110",0))';
  const a=run(t,before),b=run(t,after);assert.equal(a.stopped,undefined);assert.deepEqual(b.lines,a.lines);assert.equal(a.lines[0].split(' ')[1],'159','at(x,1) is the last completed close at any hour');
  assert.match(HELP,/closes are completed days only/);
});
test('C: one in-bounds ranking always prints, cut with "… N more not shown" when long',()=>{
  const c=big({names:s=>'N'.repeat(BOUNDS.name+10)+s});const r=run('u = universe(market="BIG")\nprint(top(u, ret(S,20), 50))',c);
  assert.equal(r.stopped,undefined);assert.match(r.lines[0],/; … \d+ more not shown$/);assert.ok(Buffer.byteLength(r.lines[0])<=BOUNDS.outputBytes);
  assert.match(r.lines[0],/^1\. 100000 N{39}… 21\.428571 \(price 170\); 2\. /,'names cut to 40');assert.doesNotMatch(run(U+'print(top(u, ret(S,20), 50))',ctx()).lines[0],/not shown/,'a short ranking is whole');
});
test('D: offsets keep no copy per day and stock; a long history gives the same values',()=>{
  const long=Array.from({length:2500},(_,i)=>({date:`x${i}`,close:100+i,value:1e9}));
  const c={...big(),universe:()=>({name:'big',symbols:Array.from({length:150},(_,i)=>String(100000+i))}),data:{closes:()=>long,price:()=>3000,previousClose:()=>2599}};
  assert.equal(run('print(at(price("111110"),60), at(sma("111110",250),60))',c).lines[0],`${100+2500-60} ${100+2500-60-1-124.5}`);
  const sum=Array.from({length:18},(_,i)=>`at(price(S),${i+1})`).join('+');const t=`u = universe(market="BIG")\nprint(top(u, ${sum}, 1))`;
  const before=process.memoryUsage().heapUsed;const r=run(t,c);const grew=process.memoryUsage().heapUsed-before;
  assert.equal(r.stopped,undefined);assert.ok(grew<20*1024*1024,`${Math.round(grew/1048576)} MB`);
});
test('E: tag characters, soft hyphen and other invisible marks are stripped; cuts keep pairs whole; the bound counts bytes',()=>{
  const odd=[0xad,0x61c,0x180e,0xfff9,0xfffb,0xe0041,0xe007f].map(c=>String.fromCodePoint(c)).join('');
  const r=run(`print("a${odd}b")`,ctx());assert.equal(r.lines[0],'a'+' '.repeat(7)+'b');
  const face=String.fromCodePoint(0x1f600);const n=run(U+'print(top(u, price(S), 1))',ctx({names:()=>face.repeat(60)})).lines[0];assert.ok(n.isWellFormed(),'no lone surrogate');
  const ko=String.fromCodePoint(0xac00).repeat(100);const k=run(`t = "${ko}"\n`+Array.from({length:10},()=>'print(t, t)').join('\n'),ctx());
  assert.equal(k.stopped.code,'OUTPUT_TOO_LONG');assert.ok(k.lines.reduce((s,l)=>s+Buffer.byteLength(l)+1,0)<=BOUNDS.outputBytes);assert.equal(k.lines.length,6,'600 bytes a line');
});
test('F: a failed stale check is not called stale; HELP states lists, print\'s values and the screens\' real cost',()=>{
  const r=run('print(price("111110"))',ctx({isStale:()=>{throw new Error('x');}}));assert.equal(r.lines[0],'159 (freshness unknown: 111110)');
  assert.match(HELP,/lists included/);assert.match(HELP,/1 to 8 values/);assert.match(HELP,/over 400 stocks a 4-value expression uses 2,000/);
  const p=t=>run(`print(${t})`,ctx()).lines[0];
  assert.equal(p('1/3'),'0.33333333');assert.equal(p('155/135-1'),'0.14814815');assert.equal(p('1234.56789'),'1234.5679');assert.equal(p('123456789012.5'),'1.2345679e+11','rounded at 1e8 or more: exponent form');
  assert.equal(p('2^53'),'9.0071993e+15','a whole number at or above 10^15');assert.equal(p('0.00004'),'0.00004');assert.equal(p('0.0000001234'),'1.234e-7');assert.equal(p('-0'),'0');assert.equal(p('-1/3'),'-0.33333333');
});
