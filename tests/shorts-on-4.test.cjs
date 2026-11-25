// Shorts on, stage 4 (artifacts/reviews/2026-11-25-shorts-on/review-stage2d-3b.md): a same-day second short ties to its
// shared lot whatever the lot's growth; the gone words count the app's covers; the saved-switch notice is for live
// accounts, recorded at the reading; a gone tie does not reopen for a new same-day short. Made-up codes and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const SS=require('../electron/short-stops.cjs');
const lot=(loanDate,quantity,symbol='990010')=>({symbol,quantity,loanDate});
const sold=(id,lotLoanDate,filled,extra={})=>({id,side:'Sell',symbol:'990010',filled,quantity:filled,status:'Filled',credit:{kind:'short'},lotLoanDate,fillPrice:1000,filledObservedAt:1000,createdAt:Number(id.replace(/\D/g,''))||1,...extra});
const covered=(id,loanDate,filled,extra={})=>({id,side:'Buy',symbol:'990010',filled,quantity:filled,status:'Filled',credit:{kind:'cover',loanDate},createdAt:50,...extra});
const at=t=>new Date(t).toISOString();
function read(orders,balances){let list=orders.map(o=>({...o}));for(const b of balances){for(const c of SS.tieShorts({orders:list,balance:b})){const i=list.findIndex(o=>o.id===c.id);list[i]={...list[i],...c.set};if(list[i].lotTieAmbiguous===null)delete list[i].lotTieAmbiguous;}}return list;}
test('4-1: a same-day second short ties to the lot its first already holds, though a cover shrank it before the reading',()=>{
  // A (5) tied to 10-13. B (3) sent with the lot at 5; 2 shares bought back before the reading: the lot reads 6.
  let o=read([sold('A1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);
  o=read([...o,sold('B2','2026-10-13',3,{shortLotsAtSend:{'2026-10-13':5},filledObservedAt:6000,createdAt:60}),covered('C1','2026-10-13',2,{createdAt:70})],[{timestamp:at(7000),shorts:[lot('2026-10-13',6)]}]);
  assert.equal(o.find(x=>x.id==='B2').lotTie.loanDate,'2026-10-13');const r=SS.appLots({orders:o,balance:{timestamp:at(7000),shorts:[lot('2026-10-13',6)]}});
  assert.deepEqual([...r.lots],[['990010|2026-10-13',{quantity:6,open:0,fillPrice:1000}]],'8 sold less 2 covered');assert.deepEqual(r.unmatched,[]);
});
test('4-2: the gone words count the app\'s covers and the shares not accounted for',()=>{
  let o=read([sold('A1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);o=[...o,covered('C1','2026-10-13',2,{createdAt:60})];
  o=read(o,[{timestamp:at(6000),shorts:[]},{timestamp:at(6000+SS.ABSENT_MS),shorts:[]}]);const [g]=SS.goneShorts(o);
  assert.deepEqual([g.quantity,g.covered,g.unaccounted],[5,2,3]);
  assert.equal(SS.goneWords(g),"The app sold 5 990010 short (loan 2026-10-13) and its covers bought back 2, but KIS's balance has not shown that lot for over 10 minutes, so 3 shares are not accounted for. If you bought them back in KIS's app, nothing more is needed; otherwise check it in KIS's app. The app arms its stop again if the lot comes back.");
  assert.match(SS.goneWords({...g,covered:0,unaccounted:5}),/and did not buy it back, .* so 5 shares are not accounted for\. If you bought it back/);
});
test('4-4: a gone tie does not reopen when a new same-day app short explains the lot; it does when none does',()=>{
  let o=read([sold('A1','2026-10-13',5)],[{timestamp:at(5000),shorts:[lot('2026-10-13',5)]}]);o=read(o,[{timestamp:at(6000),shorts:[]},{timestamp:at(6000+SS.ABSENT_MS),shorts:[]}]);
  const closedAt=o[0].lotTie.closed.at;const fresh=sold('N9','2026-10-13',2,{createdAt:closedAt+1,filledObservedAt:closedAt+2});
  const r=read([...o,fresh],[{timestamp:at(closedAt+5000),shorts:[lot('2026-10-13',2)]}]);assert.equal(r.find(x=>x.id==='A1').lotTie.closed.reason,'gone','not reopened: the new short explains it');assert.equal(r.find(x=>x.id==='N9').lotTie.loanDate,'2026-10-13');
  const back=read(o,[{timestamp:at(closedAt+5000),shorts:[lot('2026-10-13',5)]}]);assert.equal(back[0].lotTie.closed,undefined,'no new short: reopened');
});
test('4-3: the saved-switch notice: Home reads the record only; recorded at a live reading; never on a mock account',()=>{
  const N=require('../electron/shorts-live-notice.cjs');const n=new N.ShortsLiveNotice(new DatabaseSync(':memory:'));
  assert.equal(n.listed('acct',true),false,'no reading yet: nothing, and nothing written');assert.equal(n.state('acct'),null);
  assert.deepEqual(n.due('acct',true),{listed:true,first:true});assert.equal(n.listed('acct',true),true);assert.equal(n.listed('acct',false),false,'switch off: not listed');
  const main=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(main,/kisState\.snapshot\?\.environment==='live'\?kisState\.snapshot\.accountKey:null/,'Home: live only');assert.match(main,/if\(snapshot\?\.environment!=='live'\|\|!snapshot\.accountKey\)return;/,'the reading: live only');
  const read=main.slice(main.indexOf('const attentionState=()=>{'),main.indexOf('return {items,counts};'));assert.doesNotMatch(read,/shortsLiveNotice\.due\(|shortsLiveNotice\.note\(/,'no write on Home\'s read path');
});
