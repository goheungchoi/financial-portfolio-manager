// Shorts on, stages 2a-2c (artifacts/reviews/2026-11-25-shorts-on/review-stage2.md): the app's shorts are tied to their
// lots once, recorded on the order (short-stops tieShorts), closed when the lot leaves, never re-derived; the switch-off
// buy-back counts open covers but never the order being sent; with the switch off a stop takes only the app's shares.
// Made-up codes (99xxxx), quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const SS=require('../electron/short-stops.cjs');const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const lot=(loanDate,quantity,symbol='990010')=>({symbol,quantity,loanDate});
const sold=(id,lotLoanDate,filled,extra={})=>({id,side:'Sell',symbol:'990010',filled,quantity:filled,status:'Filled',credit:{kind:'short'},lotLoanDate,fillPrice:1000,filledObservedAt:1000,createdAt:Number(id.replace(/\D/g,''))||1,...extra});
const covered=(id,loanDate,filled,extra={})=>({id,side:'Buy',symbol:'990010',filled,quantity:filled,status:'Filled',credit:{kind:'cover',loanDate},createdAt:50,...extra});
const at=t=>new Date(t).toISOString();
// Readings applied in turn, as the engine writes them: the orders after each.
function read(orders,balances){let list=orders.map(o=>({...o}));for(const b of balances){for(const c of SS.tieShorts({orders:list,balance:b})){const i=list.findIndex(o=>o.id===c.id);list[i]={...list[i],...c.set};if(list[i].lotTieAmbiguous===null)delete list[i].lotTieAmbiguous;}}return list;}
test('2c-4: an exact date wins over a counterpart whatever the order; two app shorts of one stock tie to their own lots',()=>{
  // G0 (row 10-09, counterpart of 10-13) and G1 (row 10-13, exact): one lot 10-13. G1 takes it, in either order.
  for(const orders of [[sold('G0','2026-10-09',2),sold('G1','2026-10-13',3)],[sold('G1','2026-10-13',3),sold('G0','2026-10-09',2)]]){
    const tied=read(orders,[{timestamp:at(5000),shorts:[lot('2026-10-13',3)]}]);assert.equal(tied.find(o=>o.id==='G1').lotTie.loanDate,'2026-10-13');assert.equal(tied.find(o=>o.id==='G0').lotTie,undefined);}
  // The stage 2 case: rows 10-09 and 10-13, lots 10-13 (5) and 10-15 (3). G1 is exact for 10-13; G0's only other counterpart is 10-07, not held: G0 stays untied and is listed with the stock's untied lot 10-15.
  const t=read([sold('G0','2026-10-09',5),sold('G1','2026-10-13',3)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5),lot('2026-10-15',3)]}]);
  assert.equal(t.find(o=>o.id==='G1').lotTie.loanDate,'2026-10-13');assert.equal(t.find(o=>o.id==='G0').lotTie,undefined);
  const r=SS.appLots({orders:t,balance:{timestamp:at(5000),shorts:[lot('2026-10-13',5),lot('2026-10-15',3)]}});assert.deepEqual(r.unmatched.map(u=>u.orderId),['G0']);assert.deepEqual(r.leftovers,[{symbol:'990010',loanDate:'2026-10-15'}],'never silent');
});
test('2c-4: two counterpart lots are not decided by their order: ambiguous and listed, unless one grew by the fill since the send',()=>{
  const two=[lot('2026-10-07',4),lot('2026-10-13',4)];// both counterparts of 10-09
  for(const shorts of [two,[...two].reverse()]){const t=read([sold('G0','2026-10-09',4)],[{timestamp:at(5000),shorts}]);assert.equal(t[0].lotTie,undefined);assert.deepEqual(t[0].lotTieAmbiguous.candidates,['2026-10-07','2026-10-13']);
    const r=SS.appLots({orders:t,balance:{timestamp:at(5000),shorts}});assert.deepEqual(r.ambiguous.map(x=>x.candidates),[['2026-10-07','2026-10-13']]);assert.equal(r.leftovers.length,2);}
  const grew=read([sold('G0','2026-10-09',4,{shortLotsAtSend:{'2026-10-07':4}})],[{timestamp:at(5000),shorts:two}]);assert.deepEqual([grew[0].lotTie.loanDate,grew[0].lotTie.how],['2026-10-13','counterpart'],'stage 2d: 10-07 was there, unchanged, at the send: not a candidate, so one counterpart is left');
  // A later reading that settles it: the tie is recorded then, and the ambiguity is dropped.
  const settled=read([sold('G0','2026-10-09',4)],[{timestamp:at(5000),shorts:two},{timestamp:at(6000),shorts:[lot('2026-10-13',4)]}]);assert.equal(settled[0].lotTie.loanDate,'2026-10-13');assert.equal(settled[0].lotTieAmbiguous,undefined);
});
test('2c-2: a cover of a gone lot closes its own short\'s tie; a later live short ties to its own lot',()=>{
  // G1 (row 10-09) tied to 10-13, covered in full by the app; G2 (row 10-13) filled later, its lot at 10-15.
  let orders=read([sold('G1','2026-10-09',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);assert.equal(orders[0].lotTie.how,'counterpart');
  orders=[...orders,covered('C1','2026-10-13',5),sold('G2','2026-10-13',3,{createdAt:60,filledObservedAt:6000})];
  orders=read(orders,[{timestamp:at(7000),shorts:[lot('2026-10-15',3)]}]);
  assert.deepEqual(orders.find(o=>o.id==='G1').lotTie.closed.reason,'covered');assert.equal(orders.find(o=>o.id==='G2').lotTie.loanDate,'2026-10-15');
  const r=SS.appLots({orders,balance:{timestamp:at(7000),shorts:[lot('2026-10-15',3)]}});assert.deepEqual([...r.lots],[['990010|2026-10-15',{quantity:3,open:0,fillPrice:1000}]]);assert.deepEqual(r.unmatched,[]);
});
test('2c-4: a lot bought back in KIS\'s app closes the tie for good: never unmatched, never tied to a later hand lot',()=>{
  let orders=read([sold('G1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);
  orders=read(orders,[{timestamp:at(6000),shorts:[]}]);assert.equal(orders[0].lotTie.closed,undefined,'one absence: not closed');assert.equal(orders[0].lotTie.absentSince,6000);
  orders=read(orders,[{timestamp:at(6000+SS.ABSENT_MS),shorts:[]}]);assert.equal(orders[0].lotTie.closed.reason,'gone','absent again 10 minutes later: closed');
  orders=read(orders,[{timestamp:at(7000),shorts:[lot('2026-10-15',7)]}]);assert.equal(orders[0].lotTie.loanDate,'2026-10-13','not re-tied');
  const r=SS.appLots({orders,balance:{timestamp:at(7000),shorts:[lot('2026-10-15',7)]}});assert.equal(r.lots.size,0);assert.deepEqual(r.unmatched,[]);assert.deepEqual(r.leftovers,[]);
});
test('2c: the same result for every order of the shorts and the lots (36 orderings)',()=>{
  const shorts=[sold('A1','2026-10-09',2),sold('B2','2026-10-13',3),sold('C3','2026-10-20',1)],lots=[lot('2026-10-13',3),lot('2026-10-07',2),lot('2026-10-20',1)];
  const perms=xs=>xs.length<=1?[xs]:xs.flatMap((x,i)=>perms([...xs.slice(0,i),...xs.slice(i+1)]).map(p=>[x,...p]));let first=null,n=0;
  for(const os of perms(shorts))for(const ls of perms(lots)){const t=read(os,[{timestamp:at(5000),shorts:ls}]);const key=JSON.stringify(t.map(o=>[o.id,o.lotTie?.loanDate??null,o.lotTieAmbiguous?.candidates??null]).sort());first??=key;assert.equal(key,first);n++;}
  assert.equal(n,36);assert.equal(first,JSON.stringify([['A1','2026-10-07',null],['B2','2026-10-13',null],['C3','2026-10-20',null]].sort()),'B2 and C3 exact; A1 (10-09) then its one free counterpart, 10-07 (10-13 is held by B2)');
});
// An engine with a wholly app lot, switch off.
function engine({lotQty=5,sold:q=5}={}){const d=new DatabaseSync(':memory:');const snapshot={environment:'live',reportedTotal:1e7,cash:2e6,loanTotal:0,holdings:[],shorts:[{symbol:'990010',quantity:lotQty,loanDate:'2026-10-13',source:'distribution',price:1000,proceeds:lotQty*1000,loanAmount:lotQty*1000}],accountKey:'acct',timestamp:at(Date.now()+60000)};
  const placed=[];const l=new LiveEngine(d,{request:async(op,p)=>{if(op==='prepare-order')return {ticket:'t',balance:snapshot};if(op==='place-order'){placed.push(p);return {brokerOrderId:String(9+placed.length)};}throw new Error(op);}},()=>({status:'connected',snapshot}));
  l.exposure=new Exposure(d);l.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');l.enableAuto('ENABLE AUTO LIVE');l.exposure.savePolicy('acct',{short:{enabled:false}});l.closedKrDays=()=>[];
  l.writeOrder({id:'S0',accountKey:'acct',...sold('S0','2026-10-13',q),filledObservedAt:Date.now(),expiresAt:1});l.observeBalance(snapshot);return {l,placed};}
const cover=q=>({symbol:'990010',side:'Buy',quantity:q,limitPrice:1000,credit:{kind:'cover',loanDate:'2026-10-13'}});
test('2c-1: switch off, a wholly app lot of 5: the cover of 5 is sent, by your approval and automatically; the order itself is not counted against it',async()=>{
  {const {l,placed}=engine();const p=l.propose(cover(5));const o=await l.submit(p.id,'PLACE LIVE ORDER');assert.equal(o.status,'Accepted');assert.equal(placed.length,1);}
  {const {l,placed}=engine();const p=l.propose(cover(5),{conditional:true});const o=await l.autoSubmit(p.id);assert.equal(o.status,'Accepted','the cover stop\'s own order');assert.equal(placed.length,1);}
  // Two covers of 3 against 5: the second is refused at the proposal (the first, waiting, takes 3).
  {const {l}=engine();l.propose(cover(3));assert.throws(()=>l.propose(cover(3)),/EXCEEDS_LOT/);}
});
test('2c-3: switch off, a mixed lot (the app sold 5, the lot holds 9): the stop is armed for 5 and the cover of 5 is sent; 9 is refused',async()=>{
  const {l,placed}=engine({lotQty:9,sold:5});assert.throws(()=>l.propose(cover(9)),/EXCEEDS_LOT/);const o=await l.submit(l.propose(cover(5)).id,'PLACE LIVE ORDER');assert.equal(o.status,'Accepted');assert.equal(placed.length,1);
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});a.configure({scope:'kis',conditionalOrders:true});
  const e2=engine({lotQty:9,sold:5}).l;a.live=e2;a.syncShortStops(a.watchScope());const [stop]=a.desk.orders(a.watchScope());assert.equal(stop.quantity,5,'the app\'s own 5, not the lot\'s 9');
  // A stop armed for 9 (with the switch on earlier) is reduced to 5 once the switch is off.
  a.desk.update(stop,{quantity:9});a.syncShortStops(a.watchScope());assert.equal(a.desk.orders(a.watchScope())[0].quantity,5);
});
test('small: the cache of the app\'s lots follows the engine\'s order writes; the Claude refusal only where the Korean context is sent',()=>{
  const {Automation}=require('../electron/automation.cjs');const b=Object.create(Automation.prototype);let reads=0;const raw={shorts:[]};b.live={orders:()=>{reads++;return [];},riskBalance:raw,ordersVersion:1};b.closedDays=[];b.officialClosedDays=()=>[];
  b.appLotsNow();b.appLotsNow();assert.equal(reads,1,'cached for the same reading');b.live.ordersVersion=2;b.appLotsNow();assert.equal(reads,2,'an order write: read again');
  const a=Object.create(Automation.prototype);a.config={scope:'us'};a.autoTradingRuns=()=>true;a.vendorOf=()=>'anthropic';a.agentModel=()=>({openaiModel:'claude-opus-5-5'});
  const AM=require('../electron/ai-models.cjs'),was=AM.decisionMaker;AM.decisionMaker=()=>'ai';try{assert.equal(a.shortsSwitchRefusal({was:false,next:true}),null);a.config={scope:'kis'};assert.equal(a.shortsSwitchRefusal({was:false,next:true}),'CLAUDE_SHORTS_RUNNING');}finally{AM.decisionMaker=was;}
  const fs=require('fs'),path=require('path');assert.match(fs.readFileSync(path.join(__dirname,'..','src','ShortLeverage.tsx'),'utf8'),/CLAUDE_SHORTS_RUNNING:'Nothing was saved\. Stop auto trading first:/);
});
// Stage 2d (review-stage2c-3.md 1 and 2).
test('2d-1: one reading without the lot never closes a tie: an empty reading, a stale one, another stock\'s lots; readings out of time order change nothing',()=>{
  const tied=read([sold('G1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);assert.equal(tied[0].lotTie.at,5000);
  for(const b of [{timestamp:at(6000),shorts:[]},{timestamp:at(6000),shorts:[lot('2026-10-13',9,'990020')]}]){const t=read(tied,[b]);assert.equal(t[0].lotTie.closed,undefined,JSON.stringify(b));
    const r=SS.appLots({orders:read(t,[{timestamp:at(7000),shorts:[lot('2026-10-13',5)]}]),balance:{timestamp:at(7000),shorts:[lot('2026-10-13',5)]}});assert.deepEqual([...r.lots.keys()],['990010|2026-10-13'],'the lot back: still the app\'s');}
  // A stale snapshot (before the tie) and a reading older than the first absence: nothing.
  assert.deepEqual(SS.tieShorts({orders:tied,balance:{timestamp:at(4000),shorts:[]}}),[],'older than the tie');
  const once=read(tied,[{timestamp:at(6000),shorts:[]}]);assert.deepEqual(read(once,[{timestamp:at(5500),shorts:[]}])[0].lotTie.absentSince,6000,'out of order: the first absence stands');
  assert.equal(read(once,[{timestamp:at(6000+SS.ABSENT_MS-1),shorts:[]}])[0].lotTie.closed,undefined,'less than 10 minutes: still open');
  // A short rows read that failed (not an array) is not a reading.
  assert.deepEqual(SS.tieShorts({orders:tied,balance:{timestamp:at(9e9)}}),[]);
});
test('2d-1: a cover filling the shares closes at once; a tie closed gone reopens when its lot comes back, and Home is told once while it is closed',()=>{
  let o=read([sold('G1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);
  const cov=read([...o,covered('C1','2026-10-13',5)],[{timestamp:at(6000),shorts:[]}]);assert.equal(cov[0].lotTie.closed.reason,'covered','explained by the app\'s cover: at once');
  o=read(o,[{timestamp:at(6000),shorts:[]},{timestamp:at(6000+SS.ABSENT_MS),shorts:[]}]);assert.equal(o[0].lotTie.closed.reason,'gone');
  const back=read(o,[{timestamp:at(7000+SS.ABSENT_MS),shorts:[lot('2026-10-13',5)]}]);assert.equal(back[0].lotTie.closed,undefined,'reopened');assert.ok(back[0].lotTie.reopenedAt);
  assert.deepEqual([...SS.appLots({orders:back,balance:{timestamp:at(7000+SS.ABSENT_MS),shorts:[lot('2026-10-13',5)]}}).lots.keys()],['990010|2026-10-13']);
  assert.deepEqual(SS.goneShorts(o).map(x=>[x.orderId,x.loanDate]),[['G1','2026-10-13']],'closed gone, not acknowledged: told');assert.deepEqual(SS.goneShorts(back),[],'reopened: nothing');
  assert.deepEqual(SS.goneShorts([{...o[0],lotTie:{...o[0].lotTie,closed:{...o[0].lotTie.closed,acknowledgedAt:1}}}]),[],'dismissed: once');assert.deepEqual(SS.goneShorts(cov),[],'covered by the app: nothing to say');
});
test('2d-2: the exact pass skips a lot the stock already had, unchanged, at the short\'s send',()=>{
  // Rows 10-09 (G0, filled first) and 10-13 (G1); the lot 10-13 of 5 was there at G1's send; G1's own 3 are in 10-15.
  const t=read([sold('G0','2026-10-09',5),sold('G1','2026-10-13',3,{shortLotsAtSend:{'2026-10-13':5}})],[{timestamp:at(5000),shorts:[lot('2026-10-13',5),lot('2026-10-15',3)]}]);
  assert.equal(t.find(x=>x.id==='G1').lotTie.loanDate,'2026-10-15','G1: its counterpart that grew');assert.equal(t.find(x=>x.id==='G0').lotTie.loanDate,'2026-10-13','G0: the lot G1 did not take');
});
test('2d small: a cover\'s result and cash find its short by the recorded tie (the settlement world); a stop closed because open covers take the app\'s shares says so',()=>{
  const {shortResult}=require('../electron/short-result.cjs');const {cashEffect}=require('../electron/flow-detector.cjs');
  const short={id:'S1',accountKey:'a',side:'Sell',symbol:'990010',filled:5,fillPrice:1000,credit:{kind:'short'},lotLoanDate:'2026-10-09',lotTie:{loanDate:'2026-10-13',at:1,how:'counterpart'},createdAt:1};
  const cover={id:'C1',accountKey:'a',side:'Buy',symbol:'990010',filled:5,fillPrice:900,credit:{kind:'cover',loanDate:'2026-10-13'},createdAt:2};
  assert.doesNotMatch(JSON.stringify(shortResult(cover,[short,cover])?.gaps??[]),/proceeds of the covered lot unavailable/,'found by the tie, though the row says 10-09');
  assert.equal(cashEffect(cover,[short,cover]),500,'proceeds 5,000 less the buy-back 4,500');
  const C=SS.lotChanges({shorts:[lot('2026-10-13',9)],deskOrders:[{side:'Buy',purpose:'stop_loss',status:'armed',quantity:5,symbol:'990010',credit:{kind:'cover',loanDate:'2026-10-13'}}],capOf:()=>0});assert.deepEqual(C.close.map(x=>x.why),['capped']);
  assert.deepEqual(SS.lotChanges({shorts:[],deskOrders:[{side:'Buy',purpose:'stop_loss',status:'armed',quantity:5,symbol:'990010',credit:{kind:'cover',loanDate:'2026-10-13'}}]}).close.map(x=>x.why),['covered']);
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(src,/already being bought back by an open cover; it is armed again if that cover does not take them\./);
});
test('2d: main lists a gone short until dismissed and writes one Activity line when its tie closes gone',()=>{
  const fs=require('fs'),path=require('path');const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(main,/for\(const g of require\('\.\/short-stops\.cjs'\)\.goneShorts\(live\.orders\(\)\)\)items\.push\(\{id:'short-gone-'\+g\.orderId,tone:'warning'/);
  assert.match(main,/live\.acknowledgeGoneShort\(id\.slice\('short-gone-'\.length\)\)/);assert.match(main,/live\.onShortGone=order=>\{try\{const SS=require\('\.\/short-stops\.cjs'\);const g=SS\.goneShorts\(live\.orders\(\)\)\.find\(x=>x\.orderId===order\.id\);if\(g\)automation\.log\(order\.id,'System','Short no longer in the balance',SS\.goneWords\(g\)\);/,'stage 4: the same words as Home');
  const d=new DatabaseSync(':memory:');const snap={accountKey:'acct',environment:'live',shorts:[lot('2026-10-13',5)],holdings:[],timestamp:at(5000)};const l=new LiveEngine(d,{request:async()=>({})},()=>({status:'connected',snapshot:snap}));
  const seen=[];l.onShortGone=o=>seen.push(o.id);l.writeOrder({accountKey:'acct',...sold('G1','2026-10-13',5)});l.tieShorts(snap);
  l.tieShorts({...snap,shorts:[],timestamp:at(6000)});l.tieShorts({...snap,shorts:[],timestamp:at(6000+SS.ABSENT_MS)});l.tieShorts({...snap,shorts:[],timestamp:at(7000+SS.ABSENT_MS)});
  assert.deepEqual(seen,['G1'],'one line');assert.equal(SS.goneShorts(l.orders()).length,1);assert.equal(l.acknowledgeGoneShort('G1'),true);assert.deepEqual(SS.goneShorts(l.orders()),[]);
});
