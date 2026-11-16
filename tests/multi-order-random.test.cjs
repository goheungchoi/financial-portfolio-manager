// M-1.6d (multi-order, ruling R5): seeded random lifecycles of several U.S. orders filled in one review, both sides,
// end to end through the path main.cjs wires (loss-funding-e2e.test.cjs's e2e). Prices and the rate are fixed and no
// fee is charged, so the true value is known at every reading.
// Each seed draws: 1 to 30 orders (random or equal amounts); for buys USD, KRW or mixed funding; KIS's report in 1 to 3
// random parts (not prefixes) and its settlement in parts that are unions of them, in any order (KIS reports and settles
// by U.S. trade date, so the buys it reported together settle together); the report reaching 0 a reading
// before KIS's debit, or with it; a mixed debit held (cash below 0, then the exchange) or taking U.S. cash to 0 with the
// exchange in the same reading or the next; for sales the proceeds pending at the fill or a reading later; a withdrawal
// before the fill, between the zero and the debit, or in the zero's own reading.
// Invariants at every reading: no market's low above its true value, nor the combined low (and, for sales, the combined
// high never below it); from the last settlement on, the combined low right. At the end: nothing in flight, no credit,
// every funding group closed, and the detected flows exactly the withdrawal (in total only when it came in the zero's
// own reading: an accepted limit).
// MULTI_ORDER_SEEDS=n raises the number of seeds per side; MULTI_ORDER_SEED=s runs one seed (both sides) and prints it.
const test=require('node:test');const assert=require('node:assert/strict');
const {e2e}=require('./loss-funding-e2e.test.cjs');const {InFlight}=require('../electron/valuation.cjs');
const A='acct',FX=1340,KR0=3000000,MIN=60000,HOUR=3600000,DAY=86400000,K=s=>Date.parse(s+'+09:00');
const c2=v=>Math.round(v*100)/100;
function rng(seed){let a=seed>>>0;return ()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
const order=(side,id,usd,at)=>({id,market:'US',symbol:'NYSE:'+id,side,status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:side==='Buy'?-usd:usd},createdAt:at,filledObservedAt:at});
// Each order to one of k parts, every part non-empty (k at most the number of orders).
function split(r,list,k){k=Math.min(k,list.length);for(;;){const a=list.map(()=>Math.floor(r()*k));if(new Set(a).size===k)return Array.from({length:k},(_,i)=>list.filter((_,j)=>a[j]===i));}}
const sum=l=>c2(l.reduce((s,x)=>s+x.fillPrice,0));

// One generated case: the readings, and the truth at each (combined KRW; the U.S. true value in USD; the Korean cash).
// profile 'plain': no withdrawals, one report per U.S. trade date (each part on its own day), settlement per report in
// order, unequal amounts, KIS's observed settlement shape (a debit below 0 held, then the exchange), the report falling
// with the debit.
// The plain profile: what daily batches look like. Part i (one U.S. trade date) fills on day i, KIS reports it the
// next Korean morning and settles it the morning after (a debit below 0 held, then the exchange, for KRW or mixed
// funding). Parts overlap in time: a later part may fill while an earlier one settles. No withdrawals, unequal amounts.
function plainGenerate(seed,side){const r=rng(seed*2+(side==='Buy'?0:1)+1e6),pick=a=>a[Math.floor(r()*a.length)];
  const n=1+Math.floor(r()*30),k=Math.min(n,1+Math.floor(r()*3)),day0=K('2026-11-09T23:40:00');
  const parts=Array.from({length:k},()=>[]);for(let i=0;i<n;i++)parts[i<k?i:Math.floor(r()*k)].push(i);
  const o=[];for(const [d,p] of parts.entries())for(const i of p)o.push({...order(side,(side==='Buy'?'B':'S')+i,c2(5+r()*55),day0+d*DAY+i*1000),part:d});
  const T=sum(o),fund=side==='Buy'?pick(['usd','krw','mixed']):'usd';let cash=side==='Sell'?1000:fund==='usd'?c2(T+300+r()*500):fund==='krw'?0:c2(Math.max(0.01,Math.min(T-0.01,r()*T)));
  const cash0=cash,desc={seed,side,profile:'plain',independent:false,n,equal:false,fund,cash0,T,report:parts.map(p=>p.length),settle:parts.map(p=>p.length),zeroFirst:false,lateProceeds:false,heldDebit:true,exchangeLater:false,W:0,wAt:null};
  // Events: [time, kind, part]; fill at day d 23:40 (+ seconds), report at d+1 09:00, settle at d+2 08:24 (exchange 08:25).
  const ev=[];for(let d=0;d<k;d++){ev.push([day0+d*DAY+60000,'fill',d],[K('2026-11-17T09:00:00')+d*DAY,'report',d],[K('2026-11-18T08:24:00')+d*DAY,'settle',d]);}ev.sort((a,b)=>a[0]-b[0]);
  let kr=KR0,rep=0,pending=0,proceedsIn=0;const filled=new Set(),settled=new Set(),steps=[];
  const partSum=d=>sum(o.filter(x=>x.part===d)),seen=()=>o.filter(x=>filled.has(x.part));
  const usdStillOwed=()=>{let c=cash,owed=0;for(let d=0;d<k;d++){if(settled.has(d)||!filled.has(d))continue;const u=Math.min(Math.max(0,c),partSum(d));owed+=u;c-=u;}return owed;};
  const truth=()=>{const F=sum(seen());return {combined:KR0+(side==='Buy'?cash0:1000+T)*FX,us:side==='Buy'?cash+F-usdStillOwed():cash+(F-proceedsIn)+(T-F),kr,held:cash<-0.001};};
  const push=(at,note)=>{const F=seen();const holdings=side==='Buy'?F.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})):o.filter(x=>!filled.has(x.part)).map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice}));
    steps.push({at,note,fx:FX,kr:{settled:kr,holdings:[]},us:{cash:c2(cash),holdings,...(pending>0.001?{pending:c2(pending)}:{}),buyKRW:side==='Buy'?Math.max(0,rep):0,sellKRW:side==='Sell'?Math.max(0,rep):0},orders:F.map(({part,...x})=>x),truth:truth()});};
  push(K('2026-11-09T23:00:00'),'before');
  for(const [at,kind,d] of ev){const P=partSum(d);
    if(kind==='fill'){filled.add(d);if(side==='Sell')pending=c2(pending+P);push(at,`fill ${d+1}`);}
    else if(kind==='report'){rep+=Math.round(P*FX);push(at,`report ${d+1}`);}
    else{rep-=Math.round(P*FX);if(rep<2)rep=0;if(side==='Sell'){pending=c2(pending-P);if(pending<0.005)pending=0;cash=c2(cash+P);proceedsIn=c2(proceedsIn+P);settled.add(d);push(at,`settle ${d+1}`);continue;}
      const usd=Math.min(Math.max(0,cash),P),short=c2(P-usd);cash=c2(cash-P);settled.add(d);
      if(short<=0.005){push(at,`debit ${d+1}`);continue;}push(at,`debit ${d+1} (held)`);cash=c2(cash+short);kr-=Math.round(short*FX);push(at+60000,`exchange ${d+1}`);}}
  const settledAt=steps.length,end=steps.at(-1).at;push(end+DAY,'next day');push(end+9*DAY,'after age');return {desc,steps,settledAt};}
function generate(seed,side,profile='mix'){if(profile==='plain')return plainGenerate(seed,side);const plain=false,r=rng(seed*2+(side==='Buy'?0:1)+(plain?1e6:0)),pick=a=>a[Math.floor(r()*a.length)];
  const n=1+Math.floor(r()*30),equal=!plain&&r()<0.25,A0=c2(10+r()*30);
  const o=Array.from({length:n},(_,i)=>order(side,(side==='Buy'?'B':'S')+i,equal?A0:c2(5+r()*55),K('2026-11-09T23:40:00')+i*1000)),T=sum(o);
  const fund=side==='Buy'?pick(['usd','krw','mixed']):'usd',reportParts=split(r,o,1+Math.floor(r()*3)),independent=!plain&&seed%5===0,settleParts=plain?reportParts:independent?split(r,o,1+Math.floor(r()*3)):split(r,reportParts,1+Math.floor(r()*3)).map(g=>g.flat());
  const zeroFirst=!plain&&r()<0.4,lateProceeds=side==='Sell'&&r()<0.5,heldDebit=plain||r()<0.5,exchangeLater=!plain&&r()<0.5;
  let cash=side==='Sell'?1000:fund==='usd'?c2(T+300+r()*500):fund==='krw'?0:c2(Math.max(0.01,Math.min(T-0.01,r()*T)));
  const W=!plain&&(side==='Sell'||fund==='usd')&&r()<0.5?c2(50+r()*250):0,wAt=W?pick(['early',...(zeroFirst?['between','same']:['same'])]):null;
  const desc={seed,side,profile,independent,n,equal,fund,cash0:cash,T,report:reportParts.map(p=>p.length),settle:settleParts.map(p=>p.length),zeroFirst,lateProceeds,heldDebit,exchangeLater,W,wAt};
  const held=side==='Buy'?o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})):[],sold=side==='Sell'?o.map(x=>({symbol:x.symbol,quantity:1,price:x.fillPrice})):[];
  let kr=KR0,t=K('2026-11-09T23:00:00'),rep=0,pending=0,gone=0,proceedsIn=0,settledParts=0;const steps=[];
  // The U.S. true value: cash, plus holdings at cost, less the USD KIS will still take for buys not yet debited (it
  // takes U.S. cash first), plus proceeds of sales not yet in cash.
  const usdStillOwed=()=>{let c=cash,owed=0;for(const p of settleParts.slice(settledParts)){const P=sum(p),u=Math.min(Math.max(0,c),P);owed+=u;c-=u;}return owed;};
  const truth=()=>({combined:KR0+((side==='Buy'?{usd:desc.cash0,krw:0,mixed:desc.cash0}[fund]:1000+T)-gone)*FX,
    us:side==='Buy'?cash+T-usdStillOwed():cash+(T-proceedsIn)+(steps.length&&!filled?T:0),kr});
  let filled=false;
  const push=(note,extra={})=>{const holdings=side==='Buy'?(filled?held:[]):(filled?[]:sold);
    steps.push({at:t,note,fx:FX,kr:{settled:kr,holdings:[]},us:{cash:c2(cash),holdings,...(pending>0.001?{pending:c2(pending)}:{}),buyKRW:side==='Buy'?Math.max(0,rep):0,sellKRW:side==='Sell'?Math.max(0,rep):0},orders:filled?o:[],truth:{...truth(),held:cash<-0.001},...extra});t+=MIN;};
  const withdraw=()=>{cash=c2(cash-W);gone=W;};
  push('before');
  if(wAt==='early'){withdraw();push('withdrawal');}
  t=K('2026-11-09T23:45:00');filled=true;if(side==='Sell'&&!lateProceeds)pending=T;push('filled');
  if(side==='Sell'&&lateProceeds){pending=T;push('proceeds shown');}
  t=K('2026-11-10T09:00:00');for(const [i,p] of reportParts.entries()){rep+=Math.round(sum(p)*FX);push(`report ${i+1}`);t+=plain?DAY:HOUR;}
  t=Math.max(K('2026-11-11T08:20:00'),t+HOUR);
  for(const [i,p] of settleParts.entries()){const P=sum(p),last=i===settleParts.length-1;rep-=Math.round(P*FX);if(last)rep=0;
    if(last&&zeroFirst){push('zero',{zero:true});if(wAt==='between'){withdraw();push('withdrawal');}}
    if(side==='Sell'){pending=c2(pending-P);if(pending<0.005)pending=0;cash=c2(cash+P);proceedsIn=c2(proceedsIn+P);settledParts++;if(last&&wAt==='same'&&!zeroFirst)withdraw();push(`settle ${i+1}`);
      if(last&&zeroFirst&&wAt==='same'){/* the withdrawal came with the zero: see below */}continue;}
    const usd=Math.min(Math.max(0,cash),P),short=c2(P-usd);
    if(last&&wAt==='same'&&!zeroFirst)withdraw();
    if(short<=0.005){cash=c2(cash-P);settledParts++;push(`debit ${i+1}`);continue;}
    if(heldDebit){cash=c2(cash-P);settledParts++;push(`debit ${i+1} (held)`);cash=c2(cash+short);kr-=Math.round(short*FX);push(`exchange ${i+1}`);}
    else{cash=c2(cash-usd);settledParts++;if(!exchangeLater)kr-=Math.round(short*FX);push(`debit ${i+1}`);if(exchangeLater){kr-=Math.round(short*FX);push(`exchange ${i+1}`);}}}
  const settledAt=steps.length;
  t+=DAY;push('next day');t+=8*DAY;push('after age');
  // The withdrawal in the zero's own reading: moved into that reading.
  if(wAt==='same'&&zeroFirst){const z=steps.findIndex(s=>s.zero);for(const s of steps.slice(z)){s.us.cash=c2(s.us.cash-W);s.truth.combined-=W*FX;s.truth.us-=W;}}
  return {desc,steps,settledAt};}

// One seed: every invariant, with the failures it shows classed. Safety (at every reading): no low above the true
// value. Its known classes: the accepted limit (a withdrawal in the zero's or the debit's own reading at least as large
// as what is still owed), the batch band (M-1.6b: a group booked within 5% of KIS's part, so an excess within 5% of the
// batch), mixed funding's U.S. low alone with the combined value right (the K1 convention books a buy's KRW part as a
// transfer into the U.S., so the split between the markets is the app's, not KIS's USD-first one), and one open class
// (a combined excess beyond those; traced for seed 69: a reported fall of buys KIS carries, resolved by their report,
// matched to flagged buys in flight). Liveness: right after age. End: nothing in flight, no credit.
// Counted: groups by end state, detected Korean flows, withdrawals not detected as exactly one flow.
// The open class's seeds at 600 (A3/A4 with unattributed KRW: the recorder's provisional KRW leaves Korea's deduction
// when KIS's report falls, before the Korean exchange): a new one fails.
const OPEN_SEEDS=[69,184,240,280,368,434,470,482];
const SAFETY_CLASSES=['limit: withdrawal in the zero or debit reading','band: batch set within 5% (M-1.6b)','open: carried and flagged buys mixed (A3/A4)','attribution: mixed funding, the U.S. low alone (combined right; the K1 transfer convention)'];
function check(seed,side,profile='mix'){const {desc,steps}=generate(seed,side,profile),run=e2e(steps.map(({truth,zero,...s})=>s)),out={seed,side,desc,safety:[],afterAge:true,end:true,groups:{},krFlows:0,flowsOff:null};
  const classOf=ex=>desc.wAt==='same'?SAFETY_CLASSES[0]:ex<=0.05*desc.T*FX+2?SAFETY_CLASSES[1]:SAFETY_CLASSES[2];
  for(const [i,row] of run.out.entries()){const tr=steps[i].truth,v=row.value,low=v.KR.low+v.US.low*FX,high=v.KR.high+v.US.high*FX;
    const exC=Math.max(low-tr.combined-2,v.KR.low-tr.kr-1,side==='Sell'?tr.combined-2-high:0),exU=tr.held?0:(v.US.low-tr.us-0.02)*FX;
    if(exC>0)out.safety.push({at:row.note,ex:Math.round(exC),cls:classOf(exC)});
    else if(exU>0)out.safety.push({at:row.note,ex:Math.round(exU),combinedOff:Math.round(Math.abs(low-tr.combined)),cls:desc.fund==='mixed'?SAFETY_CLASSES[3]:classOf(exU)});}
  {const from=steps.findIndex((x,i)=>i>=steps.length-2)-1;out.settledRight=run.out.slice(Math.max(0,steps.length-3)).every((row,j)=>{const tr=steps[Math.max(0,steps.length-3)+j].truth;return tr.held||Math.abs(row.value.KR.low+row.value.US.low*FX-tr.combined)<=2;});}
  const last=run.out.at(-1),lastLow=last.value.KR.low+last.value.US.low*FX;out.afterAge=Math.abs(lastLow-steps.at(-1).truth.combined)<=2;
  const st=JSON.parse(run.db.prepare('SELECT payload FROM inflight_settlement').get().payload),ss=st[A]??st;out.end=(ss.open??[]).length===0&&['Buy','Sell'].every(k=>InFlight.creditCents(ss,k)===0);
  for(const r of run.rec.rows(A).filter(r=>(r.orders??[]).length))out.groups[r.state]=(out.groups[r.state]??0)+1;
  const flows=run.flows().filter(f=>f.detected);out.krFlows=flows.filter(f=>f.market==='KR').length;
  const total=c2(flows.filter(f=>f.market==='US').reduce((n,f)=>n+f.amount,0)),one=!desc.W||flows.length===1;
  if(Math.abs(total+desc.W)>0.02||!one||out.krFlows)out.flowsOff=out.krFlows?'a detected Korean flow':desc.wAt==='same'?'withdrawal in a settlement reading (the detector skips a reading where unattributed KRW settles)':!desc.W?'a detected U.S. flow with no withdrawal':'a withdrawal (early or between) not exactly one flow';
  return out;}
module.exports={generate,check};
if(require.main===module){
const one=process.env.MULTI_ORDER_SEED,N=Number(process.env.MULTI_ORDER_SEEDS)||150;
// The R4 guard (seed 84): a buy KIS carried after its own report (A3) settling by USD gives no paired credit, so the
// combined value is never above the true one; and the one open class is exactly seed 69 (named, for its fix).
test('R5 pins: seed 84 has no combined excess (the R4 guard); the open class is seed 69 alone',()=>{
  assert.deepEqual(check(84,'Buy').safety.filter(x=>!x.cls.startsWith('attribution')),[],'seed 84');
  const open=Array.from({length:150},(_,i)=>i+1).filter(seed=>check(seed,'Buy').safety.some(x=>x.cls.startsWith('open')));assert.deepEqual(open,[69]);
  // A batch KIS debits in one fall after its report's zero (several groups awaiting): the withdrawal is one flow.
  for(const seed of [312,478,553,596])assert.equal(check(seed,'Buy').flowsOff,null,`seed ${seed}`);
});
// The plain profile (what daily batches look like): no safety failure and no detected Korean flow, at all. Reported:
// unmatched groups, and seeds not right at the last settlement (right only after age).
for(const side of ['Buy','Sell'])test(`R5 plain: ${N} daily-batch lifecycles of U.S. ${side==='Buy'?'buys':'sales'} (one trade date per part, reported and settled by it): no safety failure, no Korean flow, every group closed, right at settlement, no false flow`,t=>{
  const count={},bump=(k,seed)=>{if(k.startsWith('BOUND'))k=k.replace(/[$]?[0-9][0-9.,]*/g,'#');const l=(count[k]??=[]);if(!l.includes(seed))l.push(seed);};
  for(let seed=1;seed<=N;seed++){const r=check(seed,side,'plain');assert.deepEqual(r.safety.filter(x=>!x.cls.startsWith('attribution')),[],`plain seed ${seed} ${side}: ${JSON.stringify(r.safety.slice(0,3))} ${JSON.stringify(r.desc)}`);
    // The U.S. low alone above its USD-first value (mixed funding: K1 books a part U.S. cash cannot pay in full as KRW, so
    // the U.S. side shows the USD KIS will still take, until the settlement's reversal); bound: the U.S. cash, per reading.
    const attr=r.safety.filter(x=>x.cls.startsWith('attribution'));if(attr.length){bump('the U.S. low alone above its USD-first value (K1 on a part U.S. cash cannot pay in full)',seed);
      const worst=Math.max(...attr.map(x=>x.ex))/FX;(count.attrWorst??=[]).push(Math.round(worst*100)/100);assert.ok(worst<=r.desc.cash0+0.05,`plain seed ${seed}: the U.S. excess ${worst.toFixed(2)} is beyond its U.S. cash ${r.desc.cash0}`);(count.attrShare??=[]).push(Math.round(100*worst/r.desc.T));}assert.equal(r.krFlows,0,`plain seed ${seed} ${side}: a Korean flow ${JSON.stringify(r.desc)}`);
    assert.ok(r.afterAge&&r.end,`plain seed ${seed} ${side}: not right after age, or left in flight`);for(const [k] of Object.entries(r.groups))if(!['booked','none'].includes(k))bump('group ends '+k,seed);
    // Daily batches: every group closed, right from the last settlement on, no detected flow (all 0 at 500 seeds a side).
    assert.deepEqual(Object.keys(r.groups).filter(k=>!['booked','none'].includes(k)),[],`plain seed ${seed} ${side}: a group left open`);
    assert.ok(r.settledRight,`plain seed ${seed} ${side}: not right at the last settlement`);assert.equal(r.flowsOff,null,`plain seed ${seed} ${side}: ${r.flowsOff}`);}
  const W=count.attrWorst,P=count.attrShare;delete count.attrWorst;delete count.attrShare;
  for(const [k,v] of Object.entries(count))t.diagnostic(`${k}: ${v.length} of ${N} (${Math.round(100*v.length/N)}%), seeds ${v.slice(0,12).join(', ')}${v.length>12?', ...':''}`);
  if(W)t.diagnostic(`U.S.-only excess, largest per seed: up to ${Math.max(...W).toFixed(2)}; as a share of the batch up to ${Math.max(...P)}% (median ${[...P].sort((a,b)=>a-b)[P.length>>1]}%)`);});
for(const side of ['Buy','Sell'])test(`R5: ${one?`seed ${one}`:`${N} seeded random lifecycles`} of U.S. ${side==='Buy'?'buys':'sales'} filled together (1 to 30, parts, funding, withdrawals): every failure classed and counted; right after age; nothing left`,t=>{
  const seeds=one?[Number(one)]:Array.from({length:N},(_,i)=>i+1),count={},bump=(k,seed)=>{if(k.startsWith('BOUND'))k=k.replace(/[$]?[0-9][0-9.,]*/g,'#');const l=(count[k]??=[]);if(!l.includes(seed))l.push(seed);};
  for(const seed of seeds){const r=check(seed,side);if(one)t.diagnostic(JSON.stringify(r));
    for(const c of new Set(r.safety.map(x=>x.cls)))bump('safety, '+c,seed);
    // Bounds (ruling 1): a seed in a class still fails when its error is larger or longer than the class allows.
    const of=c=>r.safety.filter(x=>x.cls===c),say=m=>`seed ${seed} ${side}: ${m} ${JSON.stringify(r.desc)}`;
    {const x=of(SAFETY_CLASSES[1]);if(x.length){assert.ok(Math.max(...x.map(y=>y.ex))<=0.05*r.desc.T*FX+2,say('band beyond 5% of the batch'));assert.ok(x.length<=2,say(`band over ${x.length} readings`));}}
    {const x=of(SAFETY_CLASSES[0]);if(x.length)assert.ok(x.length<=1,say(`limit over ${x.length} readings`));}
    {const x=of(SAFETY_CLASSES[3]);for(const y of x){// The combined value below true at that reading (a false loss): a named class until the K1 step; never above
      // true (the combined check fails any such reading).
      if(y.combinedOff>2)bump('attribution, the combined value below true at that reading (until the K1 step)',seed);assert.ok(y.ex/FX<=r.desc.cash0+0.05,say(`attribution beyond the U.S. cash: ${(y.ex/FX).toFixed(2)}`));}}
    if(of(SAFETY_CLASSES[2]).length)assert.ok(OPEN_SEEDS.includes(seed),say('a combined false gain outside the open list'));
    if(!r.desc.independent){assert.ok(r.afterAge,`seed ${seed} ${side}: not right after age ${JSON.stringify(r.desc)}`);assert.ok(r.end,`seed ${seed} ${side}: something left in flight or credited ${JSON.stringify(r.desc)}`);}
    else bump('independent split (safety only)',seed);
    for(const [k,v] of Object.entries(r.groups))if(!['booked','none'].includes(k))bump('group ends '+k,seed);
    if(r.flowsOff)bump('flows: '+r.flowsOff,seed);}
  // Sales: no class at all.
  if(side==='Sell')assert.deepEqual(Object.keys(count).filter(k=>!k.startsWith('independent')),[],JSON.stringify(count));
  for(const [k,v] of Object.entries(count))t.diagnostic(`${k}: ${v.length} of ${seeds.length} (${Math.round(100*v.length/seeds.length)}%), seeds ${v.slice(0,12).join(', ')}${v.length>12?', ...':''}`);});}
