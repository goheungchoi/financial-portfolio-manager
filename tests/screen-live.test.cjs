// Live prices in screens (note 6, addition, as the planner ruled, with its first review of the live diff, items 1-7):
// live(S) and close(S,0) apart, price() refused, a planning pass whose set covers the second pass by construction, one
// round of reads, the bounds a script and a run (owned by the run), the marks of each value and row, no live price
// counted and said, the previous close from the history, and the reader: 30 Korean stocks a request, U.S. one a
// request, waiting for orders and the queue, a 30-second bound, stopping on an order or a rate limit, a 60-second cache,
// no volume in a session, read times, a request that timed out. Made-up symbols and prices.
const test=require('node:test');const assert=require('node:assert/strict');
const {runScreen,openRun,makeLiveReader,newRun,LIVE_LIMITS}=require('../electron/screen-run.cjs');const {run}=require('../electron/formula-script.cjs');
const series=(start,step,n=60)=>Array.from({length:n},(_,i)=>({date:`d${String(i).padStart(2,'0')}`,close:start+step*i,value:1e9}));
const H={'111110':series(100,1),'222220':series(200,-1),'333330':series(150,0),'069500':series(50,0.5),'NASD:AAA':series(10,0.1)};
const data={closes:s=>H[s]??null,price:s=>H[s]?.at(-1).close??null,previousClose:s=>H[s]?.at(-2)?.close??null};
const ctx=(extra={})=>({data,universe:spec=>spec.market==='TEST'?{name:'test',symbols:['111110','222220','333330','444440']}:null,names:()=>null,asOf:{KR:'2030-01-02',US:'2030-01-01'},...extra});
const READ=Date.UTC(2030,0,2,0,41,5);
const quotes=prices=>{let calls=0;const fn=async symbols=>{calls++;return new Map(symbols.filter(s=>s in prices).map(s=>[s,{price:prices[s],readAt:READ}]));};return {fn,get calls(){return calls;}};};
test('live(S) is the quote, close(S,0) the last completed close; at(live(S),1) is the last completed close; price() is refused with words',async()=>{
  const q=quotes({'111110':170});const r=await runScreen('print(live("111110"), close("111110",0), at(live("111110"),1), at(live("111110"),3))\nprint(live("111110") / at(live("111110"),1) - 1)',ctx(),{readLive:q.fn});
  assert.equal(r.lines[0],'170 (live: read 09:41:05 KST) 159 (as of close 2030-01-02) 159 (as of close 2030-01-02) 157 (as of close 2030-01-02)','each value carries its own mark; at(live,k) = close(S,k-1)');
  assert.equal(r.lines[1].split(' ')[0],String(Number((170/159-1).toPrecision(8))),'today\'s move, not two days\'');assert.equal(q.calls,1);
  const p=run('print(price("111110"))',ctx());assert.equal(p.stopped.code,'PRICE_AMBIGUOUS');assert.match(p.stopped.words,/use live\(S\) for the live price or close\(S,0\) for the last completed close/);
  assert.equal((await runScreen('print(close("111110",0))',ctx(),{readLive:q.fn})).live,null,'no live(): no reads');assert.equal(q.calls,1);
});
const all={'111110':170,'222220':180,'333330':151,'444440':9,'069500':80};
class LogMap extends Map{constructor(e,gets){super(e);this.gets=gets;}get(k){this.gets.add(k);return super.get(k);}}
const covered=async t=>{const gets=new Set();let asked=null;const readLive=async symbols=>{asked=[...symbols];return new LogMap(symbols.filter(s=>s in all).map(s=>[s,{price:all[s],readAt:READ}]),gets);};
  const r=await runScreen(t,ctx(),{readLive});for(const g of gets)assert.ok(asked.includes(g),`pass 2 asked for ${g}, which pass 1 did not record`);return {r,asked,gets};};
test('item 1: the planning pass covers the second by construction: short cuts, empty filters, errors and unknown n do not shrink it',async()=>{
  const U='u = universe(market="TEST")\n';
  const a=await covered(U+'print(count(u, live(S) > close(S,0) and live(S)/live("069500") > 0))');assert.ok(a.asked.includes('069500'));assert.match(a.r.lines[0],/^3 /,'111110, 222220 and 333330 are above their close; 444440 has no history');
  const b=await covered(U+'f = filter(u, live(S) > close(S,0))\nprint(top(f, live(S)/live("069500"), 3))');assert.match(b.r.lines[0],/^1\. 222220 /,'the ranking of the filtered stocks, not none');
  const c=await covered('x = 100/(live("111110")-close("111110",0))\nprint(x)\nprint(live("222220"))');assert.match(c.r.lines[1],/^180 /,'a division in the first pass does not stop it');
  const d=await covered(U+'n = count(u, live(S) > close(S,0))\nprint(top(u, close(S,0), n))');assert.equal(d.r.stopped,undefined);assert.match(d.r.lines[0],/^1\. 111110 159 .*; 3\. 222220 141 /,'n from a live count, three rows');
  const e=await covered(U+'print(count(u, close(S,0) > 1000 and live(S) > 0))\nprint(count(u, close(S,0) > 0 or live(S) > 0))');assert.ok(['111110','222220','333330'].every(s=>e.asked.includes(s)),'both sides of and/or are visited');
});
test('the bounds: more live stocks than a script may read stops before any read; a run shares one bound across its scripts',async()=>{
  const many=Array.from({length:61},(_,i)=>String(500000+i));const big={...ctx(),universe:()=>({name:'big',symbols:many}),data:{closes:()=>series(100,1)}};
  let reads=0;const r=await runScreen('u = universe(market="X")\nprint(count(u, live(S) > 0))',big,{readLive:async()=>{reads++;return new Map();}});
  assert.equal(r.stopped.code,'LIVE_TOO_MANY');assert.equal(reads,0);assert.match(r.stopped.words,/at most 60 Korean and 20 U\.S\. a script: narrow the universe first with close-based values/);
  const sixty={...big,universe:()=>({name:'b',symbols:many.slice(0,60)})};const one=openRun({readLive:async()=>new Map(),context:()=>({ctx:sixty})});const t='u = universe(market="X")\nprint(count(u, live(S) > 0))';
  assert.equal((await one(t)).stopped,undefined);assert.equal((await one(t)).stopped,undefined);const third=await one(t);assert.equal(third.stopped.code,'LIVE_TOO_MANY');assert.match(third.stopped.words,/0 Korean and 40 U\.S\. left in this run/);
  assert.equal((await openRun({readLive:async()=>new Map(),context:()=>({ctx:sixty})})(t)).stopped,undefined,'a new run has its own bound');
  assert.equal(LIVE_LIMITS.run.KR,120);assert.equal(LIVE_LIMITS.script.US,20);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','main.cjs'),'utf8'),/runScreen\(/,'main opens runs; it never runs a script with a state of its own making');
});
test('item 3: a line says how many stocks had no live price, and that live reads stopped when an order was being sent',async()=>{
  const state=newRun();const readLive=async(symbols,{runState})=>{runState.stoppedBy='ORDER';return new Map([['111110',{price:170,readAt:READ}]]);};
  const r=await runScreen('u = universe(market="TEST")\nprint(top(u, live(S) / close(S,0), 5))',ctx(),{readLive,runState:state});
  assert.match(r.lines[0],/^1\. 111110 /);assert.match(r.lines[0],/\(3 no live price\)/);assert.match(r.lines[0],/\(live reads stopped: an order was being sent\)/);assert.deepEqual(r.live.stopped,{code:'LIVE_STOPPED_BY_ORDER',words:'live reads stopped: an order was being sent'});
  const c=r.coverage[0];assert.equal(c.evaluated+c.noHistory+c.stale+c.errors+c.noLive,c.size);
});
test('item 4: the previous close comes from the history at every k, never the callback, and change() is not 0 with ctx.today',()=>{
  const wrong={...data,previousClose:()=>1};const one=t=>run(t,{data:wrong,today:'d99'}).lines[0];
  assert.equal(one('print(change("111110"))'),String(Number(((159/158-1)*100).toPrecision(8))));assert.equal(one('print(at(change("111110"),1))'),String(Number(((158/157-1)*100).toPrecision(8))));
});
test('item 5: marks per value and per market; a closed market and a U.S. price are marked in rows too',async()=>{
  const readLive=async()=>new Map([['111110',{price:170,readAt:READ,closed:false}],['NASD:AAA',{price:12,readAt:READ,closed:true}]]);
  const r=await runScreen('print(live("NASD:AAA"), live("111110"), close("NASD:AAA",0))\nprint(top(list("111110","NASD:AAA"), live(S) / close(S,0), 2))',ctx(),{readLive});
  assert.equal(r.lines[0],'12 (live: read 09:41:05 KST; US market closed, last price; U.S. unchecked) 170 (live: read 09:41:05 KST) 15.9 (as of close 2030-01-01)');
  assert.match(r.lines[1],/^1\. 111110 \S+ \(live 170, 09:41\); 2\. NASD:AAA \S+ \(live 12, 09:41, market closed, unchecked\)/);
});
test('items 6-7: the reader stops on a rate limit; a Korean quote without volume in a session is none; read times outside the last minute are the app\'s; a timed-out request is awaited first',async()=>{
  let t=1e12;const sent=[];const reader=makeLiveReader({request:async(op,p)=>{sent.push(p);if(sent.length===1)throw Object.assign(new Error('RATE_LIMITED'),{code:'RATE_LIMITED'});return [];},allowed:()=>true,orderSending:()=>false,sessionOpen:()=>true,clock:()=>t,sleep:async ms=>{t+=ms;}});
  const state=newRun();await reader([...Array.from({length:35},(_,i)=>String(600000+i))],{runState:state});assert.equal(sent.length,1,'no request after a rate limit');assert.equal(state.stoppedBy,'RATE_LIMITED');
  assert.equal((await reader(['700000'],{runState:state})).size,0);
  const vol=makeLiveReader({request:async(op,p)=>p.symbols.map((s,i)=>({symbol:s,price:100,volume:[null,undefined,0,5][i],readAt:i===3?1e20:t})),allowed:()=>true,orderSending:()=>false,sessionOpen:()=>true,clock:()=>t,sleep:async()=>{}});
  const v=await vol(['800000','800001','800002','800003']);assert.deepEqual([...v].filter(([,q])=>!q.missing).map(([k])=>k),['800003'],'missing, null or zero volume in a session: no live price');assert.equal(v.get('800000').missing,'no trade yet today');assert.equal(v.get('800003').readAt,t,'a read time outside the last minute is the app\'s');
  let release;const order=[];const slow=makeLiveReader({request:(op,p)=>{order.push(p.symbols[0]);if(p.symbols[0]==='900000')return new Promise(r=>{release=()=>r([{symbol:'900000',price:1,volume:1,readAt:t}]);});return Promise.resolve([]);},allowed:()=>true,orderSending:()=>false,sessionOpen:()=>true});
  const first=await slow(['900000'],{deadline:Date.now()+20});assert.equal(first.get('900000')?.missing,'the read took too long','timed out: its late reply is not used');
  const next=slow(['900001']);await new Promise(r=>setTimeout(r,30));assert.deepEqual(order,['900000'],'the next script waits for the request left over');release();await next;assert.deepEqual(order,['900000','900001']);
});
test('the reader: 30 Korean stocks a request, U.S. one a request, one at a time, waiting for the queue and orders, a 30-second bound, a 60-second cache',async()=>{
  let t=1e12;const sent=[];let open=0;const allowedSeq=[false,false,true];let k=0;let sending=false;
  const request=async(op,p)=>{open++;assert.equal(open,1,'never two at once');sent.push([op,p]);await null;open--;return op==='quotes-multi'?p.symbols.map(s=>({symbol:s,price:100,volume:5,readAt:t})):{symbol:p.symbol,price:10,retrievedAt:t};};
  const reader=makeLiveReader({request,allowed:()=>k<allowedSeq.length?allowedSeq[k++]:true,orderSending:()=>sending,sessionOpen:()=>true,clock:()=>t,sleep:async ms=>{t+=ms;}});
  const kr=Array.from({length:65},(_,i)=>String(600000+i));const out=await reader([...kr,'NASD:AAA','NYSE:BBB']);
  assert.deepEqual(sent.map(([op,p])=>op==='quotes-multi'?p.symbols.length:p.symbol),[30,30,5,'NASD:AAA','NYSE:BBB']);assert.equal(out.size,67);
  t+=10000;assert.equal((await reader(['600000'])).get('600000').price,100);assert.equal(sent.length,5,'kept 60 seconds');
  const stuck=makeLiveReader({request,allowed:()=>false,orderSending:()=>false,sessionOpen:()=>true,clock:()=>t,sleep:async ms=>{t+=ms;}});assert.equal((await stuck(['700000'])).size,0,'nothing after the 30-second bound');
  sending=true;const state=newRun();assert.equal((await reader(['710000'],{runState:state})).size,0);assert.equal(state.stoppedBy,'ORDER');
});
test('item 7: robustness: a huge read time, a reader that returns no Map, a script that cannot be parsed, std\'s real window',async()=>{
  assert.doesNotThrow(()=>run('print(live("111110"))',{data,live:()=>({price:170,readAt:1e20})}));assert.match(run('print(live("111110"))',{data,live:()=>({price:170,readAt:1e20})}).lines[0],/^170 \(live: read time unknown\)/);
  const odd=await runScreen('print(live("111110"))',ctx(),{readLive:async()=>({'111110':{price:1}})});assert.equal(odd.stopped.code,'NO_LIVE');
  let reads=0;const bad=await runScreen('print(live("111110"))\nprint(1 +)',ctx(),{readLive:async()=>{reads++;return new Map();}});assert.equal(reads,0,'a script that cannot be parsed reads nothing');assert.equal(bad.stopped.code,'SYNTAX_ERROR');assert.equal(bad.stopped.line,2);
  assert.equal(run('u = universe(market="TEST")\nprint(top(u, std(S,250), 1))',ctx()).stopped.code,'BAD_WINDOW');assert.equal(run('print(std("111110",59))',ctx()).stopped,undefined);
});
const {QUEUE_TIMEOUT_MS}=require('../electron/screen-run.cjs');
const bigCtx=(n=400)=>{const syms=Array.from({length:n},(_,i)=>String(300000+i));return {...ctx(),universe:spec=>spec.market==='BIG'?{name:'big',symbols:syms.slice(0,spec.top_cap??n)}:spec.market==='TEST'?{name:'test',symbols:['111110','222220','333330','444440']}:null,data:{closes:()=>series(100,1)}};};
test('A: pass 2 never runs on an incomplete plan; a branch pass 2 never reaches cannot stop the plan',async()=>{
  const heavy=Array.from({length:6},(_,i)=>`f${i} = filter(u, close(S,0) < 0 and avgvalue(S,20)+sma(S,20)+sma(S,10)+sma(S,5) > ${i})`).join('\n');
  let reads=0;const r=await runScreen(`u = universe(market="BIG")\n${heavy}\ng = top(u, close(S,0), 5)\nprint(top(g, live(S), 5))`,bigCtx(),{readLive:async()=>{reads++;return new Map();}});
  assert.equal(r.stopped.code,'PLAN_FAILED');assert.match(r.stopped.words,/the live prices could not be planned, so none were read \(line \d+: too many evaluations/);assert.equal(reads,0);assert.deepEqual(r.lines,[]);
  assert.equal(run(`u = universe(market="BIG")\n${heavy}\ng = top(u, close(S,0), 5)\nprint(top(g, close(S,0), 5))`,bigCtx()).stopped,undefined,'pass 2 alone fits its bound');
  const b=await covered('u = universe(market="TEST")\nprint(count(u, close(S,0) > 0 or sma(S,0) > 1))\nprint(live("111110"))');assert.equal(b.r.stopped,undefined);assert.match(b.r.lines[1],/^170 \(live/,'a hard error in a branch pass 2 never evaluates does not stop the plan');
});
test('B: a soft error beside an unknown keeps the stock in the plan; C: an unknown top_cap assumes every candidate, and the words say so',async()=>{
  const b=await covered('u = universe(market="TEST")\nm = live("069500")/close("069500",0)\nf = filter(u, m > 1 or 1/(close(S,0)-close(S,1)) > 0)\nprint(top(f, live(S), 5))');
  assert.ok(b.asked.includes('333330'),'333330 is flat (a division by zero beside an unknown): kept in the plan');assert.match(b.r.lines[0],/333330/);assert.doesNotMatch(b.r.lines[0],/no live price/);
  const c=await runScreen('u = universe(market="TEST")\nn = count(u, live(S) > 0)\nv = universe(market="BIG", top_cap=n)\nprint(count(v, live(S) > 0))',bigCtx(),{readLive:async()=>new Map()});
  assert.equal(c.stopped.code,'LIVE_TOO_MANY');assert.match(c.stopped.words,/the plan assumed every candidate, because n or top_cap depends on a live price/);
});
test('the lookup log over a set of scripts: pass 2 never asks outside the plan',async()=>{
  const U='u = universe(market="TEST")\n';
  for(const t of [U+'print(top(u, live(S) - close(S,0), 2))',U+'x = live("069500")\nprint(count(u, close(S,0) > x / 2 and live(S) > 0))',U+'f = filter(u, not (live(S) < close(S,0)))\ng = top(f, close(S,0), 2)\nprint(top(g, live(S), 2))',
    U+'n = count(u, live(S) > 0)\nprint(top(u, live(S), n))','print(live("111110") - at(live("222220"),1), live("333330"))',U+'f = filter(u, live(S) > close(S,0) or sma(S,250) > 0)\nprint(count(f, live(S) > 0))'])await covered(t);
});
test('D: a request that never settles holds later scripts only until the KIS queue\'s own timeout; two scripts reading at once never overlap',async()=>{
  let t=1e12;const sent=[];const never=makeLiveReader({request:(op,p)=>{sent.push(p.symbols[0]);return p.symbols[0]==='910000'?new Promise(()=>{}):Promise.resolve([{symbol:p.symbols[0],price:5,volume:1,readAt:t}]);},allowed:()=>true,orderSending:()=>false,sessionOpen:()=>true,clock:()=>t,sleep:async ms=>{t+=ms;}});
  await never(['910000'],{deadline:t+5});t+=QUEUE_TIMEOUT_MS;const second=await never(['910001'],{deadline:t+5});assert.deepEqual(sent,['910000','910001'],'after the queue\'s 90 seconds the next script reads');assert.equal(second.get('910001').price,5);
  let busy=false,open=0,most=0;const queue=makeLiveReader({request:async(op,p)=>{busy=true;open++;most=Math.max(most,open);await new Promise(r=>setTimeout(r,5));open--;busy=false;return p.symbols.map(s=>({symbol:s,price:1,volume:1,readAt:Date.now()}));},allowed:()=>!busy,orderSending:()=>false,sessionOpen:()=>true});
  const a=Array.from({length:60},(_,i)=>String(920000+i)),b=Array.from({length:60},(_,i)=>String(930000+i));const [x,y]=await Promise.all([queue(a),queue(b)]);assert.equal(most,1,'never two requests at once');assert.equal(x.size+y.size,120);
});
test('F: the reason for a missing quote; three failed requests stop the run\'s reads',async()=>{
  const top=run('print(live("111110"))',{data,live:()=>null,liveWhy:()=>'no trade yet today'});assert.equal(top.stopped.words,'line 1: no live price (no trade yet today)');
  const stopped=run('print(live("111110"))',{data,live:()=>null,liveStopped:'live reads stopped: an order was being sent'});assert.match(stopped.stopped.words,/no live price \(live reads stopped: an order was being sent\)/);
  const r=await runScreen('u = universe(market="TEST")\nprint(count(u, live(S) > 0))',ctx(),{readLive:async s=>new Map(s.map(x=>[x,x==='111110'?{price:1,readAt:READ}:{missing:'no trade yet today'}]))});assert.match(r.lines[0],/\(3 no live price: no trade yet today\)/);
  let calls=0;const failing=makeLiveReader({request:async()=>{calls++;throw new Error('BROKER_UNAVAILABLE');},allowed:()=>true,orderSending:()=>false,sessionOpen:()=>true,sleep:async()=>{}});const state=newRun();
  await failing(['NASD:AAA','NASD:AAB','NASD:AAC','NASD:AAD','NASD:AAE'],{runState:state});assert.equal(calls,3);assert.equal(state.stoppedBy,'FAILURES');
  assert.match(require('../electron/formula-script.cjs').HELP,/three failed requests in a row/);assert.match(require('../electron/formula-script.cjs').HELP,/syntax error is not run/);
});
