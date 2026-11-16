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
function generate(seed,side){const r=rng(seed*2+(side==='Buy'?0:1)),pick=a=>a[Math.floor(r()*a.length)];
  const n=1+Math.floor(r()*30),equal=r()<0.25,A0=c2(10+r()*30);
  const o=Array.from({length:n},(_,i)=>order(side,(side==='Buy'?'B':'S')+i,equal?A0:c2(5+r()*55),K('2026-11-09T23:40:00')+i*1000)),T=sum(o);
  const fund=side==='Buy'?pick(['usd','krw','mixed']):'usd',reportParts=split(r,o,1+Math.floor(r()*3)),settleParts=split(r,reportParts,1+Math.floor(r()*3)).map(g=>g.flat());
  const zeroFirst=r()<0.4,lateProceeds=side==='Sell'&&r()<0.5,heldDebit=r()<0.5,exchangeLater=r()<0.5;
  let cash=side==='Sell'?1000:fund==='usd'?c2(T+300+r()*500):fund==='krw'?0:c2(Math.max(0.01,Math.min(T-0.01,r()*T)));
  const W=(side==='Sell'||fund==='usd')&&r()<0.5?c2(50+r()*250):0,wAt=W?pick(['early',...(zeroFirst?['between','same']:['same'])]):null;
  const desc={seed,side,n,equal,fund,cash0:cash,T,report:reportParts.map(p=>p.length),settle:settleParts.map(p=>p.length),zeroFirst,lateProceeds,heldDebit,exchangeLater,W,wAt};
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
  t=K('2026-11-17T09:00:00');for(const [i,p] of reportParts.entries()){rep+=Math.round(sum(p)*FX);push(`report ${i+1}`);t+=HOUR;}
  t=K('2026-11-18T08:20:00');
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

function check(seed,side){const {desc,steps,settledAt}=generate(seed,side),run=e2e(steps.map(({truth,zero,...s})=>s)),say=m=>`seed ${seed} ${side}: ${m} ${JSON.stringify(desc)}`;
  for(const [i,row] of run.out.entries()){const tr=steps[i].truth,v=row.value,low=v.KR.low+v.US.low*FX,high=v.KR.high+v.US.high*FX;
    assert.ok(low<=tr.combined+2,say(`at ${row.note}: the combined low ${Math.round(low)} is above the true ${Math.round(tr.combined)}`));
    assert.ok(v.KR.low<=tr.kr+1,say(`at ${row.note}: the Korean low ${v.KR.low} is above its cash ${tr.kr}`));
    if(!tr.held&&!steps.slice(0,i+1).some(s=>s.truth.held&&s===steps[i]))assert.ok(v.US.low<=tr.us+0.02,say(`at ${row.note}: the U.S. low ${v.US.low} is above its true ${c2(tr.us)}`));
    if(side==='Sell')assert.ok(high>=tr.combined-2,say(`at ${row.note}: the combined high ${Math.round(high)} is below the true ${Math.round(tr.combined)}`));
    if(i>=settledAt-1&&!tr.held)assert.ok(Math.abs(low-tr.combined)<=2,say(`at ${row.note}: the combined low ${Math.round(low)} is not the true ${Math.round(tr.combined)}`));}
  const st=JSON.parse(run.db.prepare('SELECT payload FROM inflight_settlement').get().payload),s=st[A]??st;
  assert.equal((s.open??[]).length,0,say('something is still in flight at the end'));
  for(const k of ['Buy','Sell'])assert.equal(InFlight.creditCents(s,k),0,say(`a ${k} credit is left at the end`));
  const open=run.rec.rows(A).filter(r=>(r.orders??[]).length&&!['booked','none'].includes(r.state));assert.deepEqual(open.map(r=>r.state),[],say('a funding group is not closed'));
  const flows=run.flows().filter(f=>f.detected);assert.ok(flows.every(f=>f.market==='US'),say(`a Korean flow was detected: ${JSON.stringify(flows)}`));
  const total=c2(flows.reduce((n,f)=>n+f.amount,0));assert.ok(Math.abs(total+desc.W)<=0.02,say(`detected flows ${JSON.stringify(flows.map(f=>f.amount))} do not total the withdrawal`));
  if(desc.W&&desc.wAt!=='same')assert.equal(flows.length,1,say(`the withdrawal is not one detected flow: ${JSON.stringify(flows.map(f=>f.amount))}`));}

module.exports={generate,check};
if(require.main===module){
const one=process.env.MULTI_ORDER_SEED,N=Number(process.env.MULTI_ORDER_SEEDS)||150;
for(const side of ['Buy','Sell'])test(`R5: ${one?`seed ${one}`:`${N} seeded random lifecycles`} of U.S. ${side==='Buy'?'buys':'sales'} filled together (1 to 30, parts, funding, withdrawals): never above the true value, right once settled, nothing left`,t=>{
  const seeds=one?[Number(one)]:Array.from({length:N},(_,i)=>i+1);const kinds={};
  for(const seed of seeds){if(one)t.diagnostic(JSON.stringify(generate(seed,side).desc));check(seed,side);const d=generate(seed,side).desc;const key=side==='Buy'?d.fund:(d.lateProceeds?'late':'at fill');kinds[key]=(kinds[key]??0)+1;}
  t.diagnostic(`${seeds.length} seeds: ${JSON.stringify(kinds)}`);});}
