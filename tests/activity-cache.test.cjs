// Activity step 2 (artifacts/reviews/2026-11-18-activity-tab): Activity and Performance open with the last report and
// refresh by themselves, at most every five minutes and never ahead of an account request, a review or an order; a
// refresh keeps the rows on screen. Before, both tabs were empty until "Load history".
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {ActivityCache,skipReason,FRESH_MS,KINDS}=require('../electron/activity-cache.cjs');
const report=(n=1)=>({source:'kis',environment:'live',startDate:'2026-10-13',endDate:'2026-11-11',retrievedAt:'2026-11-11T14:00:00.000Z',orders:Array.from({length:n},(_,i)=>({id:'o'+i}))});

test('the last report per kind and account: kept across a restart, never shown for another account',()=>{
  const db=new DatabaseSync(':memory:');const c=new ActivityCache(db);assert.equal(c.get('orders','acct'),null);
  c.put('orders','acct',report(3));c.put('profit','acct',{...report(0),records:[]});assert.equal(c.get('orders','acct').data.orders.length,3);
  const restarted=new ActivityCache(db);assert.equal(restarted.get('orders','acct').data.orders.length,3,'from the table after a restart');assert.ok(restarted.get('profit','acct'));
  assert.equal(restarted.get('orders','other'),null,'another account: not returned');assert.equal(new ActivityCache(db).get('orders','acct'),null,'and cleared');
  assert.ok(restarted.get('profit','acct'),'the other kind is kept until it is read for another account');
  c.put('nonsense','acct',report());assert.equal(c.get('nonsense','acct'),null);c.put('orders',null,report());assert.equal(c.get('orders',null),null);assert.deepEqual(KINDS,['orders','profit']);});

test('the skip rule: an order first, then a review, then another account request; none: refresh',()=>{
  assert.equal(skipReason({}),null);assert.equal(skipReason({kisBusy:true}),'account');assert.equal(skipReason({reviewBusy:true,kisBusy:true}),'review');
  assert.equal(skipReason({orderHeld:true,reviewBusy:true}),'order');assert.equal(FRESH_MS,300000);});

test('main: the cached report by account; an automatic read is skipped before anything is asked of KIS; a read is kept',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/ipcMain\.handle\('kis:activity-cached',\(event,kind\)=>\{authorize\(event\);const row=activityCache\.get\(kind,kisState\.snapshot\?\.accountKey\?\?null\)/);
  const h=src.slice(src.indexOf("ipcMain.handle('kis:activity',"),src.indexOf("ipcMain.handle('kis:import'"));
  assert.ok(h.indexOf("options?.automatic===true")<h.indexOf("if(kisBusy)return {ok:false,error:'BUSY'}"),'skipped before the BUSY answer');
  assert.ok(h.indexOf("options?.automatic===true")<h.indexOf('kisService.request(kind'),'before any KIS request');
  assert.match(h,/reviewBusy:Boolean\(automation\?\.busy\),orderHeld:Boolean\(kisService\.holding\)/);
  assert.ok(h.indexOf('activityCache.put(kind,account,data)')>h.indexOf("if(generation!==kisGeneration)return"),'kept only for the account it was read for');
  assert.match(fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8'),/getActivityCached: kind => ipcRenderer\.invoke\('kis:activity-cached',kind\)/);});

test('screen: opens with the cache, refreshes by itself when stale, keeps rows, says why when not refreshed',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.doesNotMatch(src,/setData\(null\)/,'rows are never cleared by a refresh or a date change');
  assert.doesNotMatch(src,/Load history|Load performance/);assert.match(src,/\{busy\?'Refreshing…':'Refresh'\}/);
  assert.match(src,/const stale=!cached\|\|Date\.now\(\)-Date\.parse\(cached\.retrievedAt\)>FRESH_MS\|\|cached\.startDate!==start\|\|cached\.endDate!==end;/);
  assert.match(src,/if\(stale\)void load\(\{start,end\},true\)/);
  assert.match(src,/Not refreshed: \$\{why\}\. Showing the list read at \$\{hhmm\(d\.retrievedAt\)\}\./);
  assert.match(src,/order:'an order is being sent',review:'an AI review is running',account:'another account request is running'/);
  assert.match(src,/another period than the dates above/);
  assert.ok(src.includes('if(value&&range.start<=range.end)void load(range,true);'),'a date change reads as automatic: the same skips');
  assert.ok(src.includes('onClick={()=>void load()}'),'only Refresh is a manual read');assert.equal((src.match(/void load\(/g)??[]).length,3,'opening (automatic), a date change (automatic), Refresh (manual)');
  assert.match(fs.readFileSync(path.join(__dirname,'../src/main.tsx'),'utf8'),/loadCached=\{kind=>window\.portfolio\?\.getActivityCached\(kind\)/);});

// 1.5.69 pre-release check, desktop case 9: a report with no environment (a stubbed reply) made the period line throw
// and blanked the page once Activity loaded by itself. The line now shows without it.
test('the period line does not throw for a report without environment or read time',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.doesNotMatch(src,/data\.environment\.toUpperCase\(\)/);assert.ok(src.includes("KIS{data.environment?` ${String(data.environment).toUpperCase()}`:''}"));
  assert.ok(src.includes("{data.retrievedAt?` · Updated ${time(data.retrievedAt)} KST`:''}"));});
// The same class, checked once more (planner, 2026-11-18): rows, records and the Today reply missing or not lists.
test('the screen tolerates a report or Today reply with missing rows, records, counts or list',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ActivityReport.tsx'),'utf8');
  assert.ok(src.includes('const orders=Array.isArray(data?.orders)?data.orders:[];'));
  assert.ok(src.includes('const records=Array.isArray(data?.records)?data.records:[];const days=dailyRealized(records);'));assert.doesNotMatch(src,/data\.records\?\.map/);
  assert.ok(src.includes('if(!today?.counts)return null;const c=today.counts;const latest=Array.isArray(today.latest)?today.latest:[];'));assert.doesNotMatch(src,/today\.latest\.(length|map)/);
  assert.match(src,/\{data\.summary\?\.returnPct==null\?'Unavailable':/,'the one method call on a summary field is guarded');});
