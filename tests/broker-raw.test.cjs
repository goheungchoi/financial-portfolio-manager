// The broker's own balance figures (audit 2026-11-04, Stage 2): kept as reported, numbers only, stored when they change.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {numericFields,BrokerBalances,LIMITS,MEANINGS}=require('../electron/broker-raw.cjs');
test('numeric fields are kept as numbers; text, blanks and odd names are left out',()=>{
  assert.deepEqual(numericFields({dnca_tot_amt:'407651',prvs_rcdl_excc_amt:'407651',tot_evlu_amt:'705451.00',name:'홍길동',blank:'  ',neg:'-12',bad:'1e9','Bad Key':'1'}),{dnca_tot_amt:407651,prvs_rcdl_excc_amt:407651,tot_evlu_amt:705451,neg:-12});
  assert.deepEqual(numericFields(null),{});assert.deepEqual(numericFields([1]),{});assert.equal(Object.keys(numericFields(Object.fromEntries(Array.from({length:100},(_,i)=>['f'+i,'1'])))).length,60);
  for(const k of ['dnca_tot_amt','prvs_rcdl_excc_amt','tot_evlu_amt','nass_amt','scts_evlu_amt'])assert.ok(MEANINGS.KR[k],k);for(const k of ['frcr_dncl_amt_2','frcr_sll_amt_smtl','ustl_buy_amt_smtl'])assert.ok(MEANINGS.US[k],k);
});
test('a reading is stored only when a figure changed, per account and market, within the retention limits',()=>{
  let now=Date.parse('2026-11-04T00:00:00Z');const store=new BrokerBalances(new DatabaseSync(':memory:'),()=>now);const s=raw=>({timestamp:new Date(now).toISOString(),raw});
  assert.equal(store.record('acct','KR',s({dnca_tot_amt:1})),true);now+=60000;assert.equal(store.record('acct','KR',s({dnca_tot_amt:1})),false,'unchanged');assert.equal(store.record('acct','US',s({dnca_tot_amt:1})),true,'another market');
  assert.equal(store.record('acct','KR',s({dnca_tot_amt:2})),true);assert.deepEqual(store.list('acct','KR').map(r=>r.raw.dnca_tot_amt),[2,1]);
  assert.equal(store.record('acct','KR',{timestamp:'x'}),false,'no raw figures');assert.equal(store.record('acct','XX',s({a:1})),false);
  now+=(LIMITS.days+1)*86400000;store.record('acct','KR',s({dnca_tot_amt:3}));assert.deepEqual(store.list('acct','KR').map(r=>r.raw.dnca_tot_amt),[3],'older than 30 days: deleted');
});
test('the Korean balance keeps the broker summary figures it was read from',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/kis-client.cjs'),'utf8');assert.match(src,/raw:require\('\.\/broker-raw\.cjs'\)\.numericFields\(summary\)/);
  const us=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/kis-overseas.cjs'),'utf8');assert.match(us,/numericFields\(usd\)/);assert.match(us,/numericFields\(present\.body\.output3\)/);
});
