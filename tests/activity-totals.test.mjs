// Activity tab step 1 (artifacts/reviews/2026-11-18-activity-tab): the three period totals. Before, any corrected order
// (originalOrderId) made a currency's buy, sell and flow "Unavailable". KIS gives each revision or cancellation its own
// row with its own fills, so every row is summed, each currency on its own. Guard (planner): where the app knows an
// order's chain, rows filling more than the order are left out of the totals and counted.
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import fs from 'node:fs';
import {executionSummary} from '../src/activity.mjs';
const require=createRequire(import.meta.url);const {markChains}=require('../electron/activity-chains.cjs');
const r=(orderId,extra={})=>({id:orderId,orderId,originalOrderId:null,side:'Buy',quantity:1,filled:0,executionAmount:0,market:'KR',currency:'KRW',...extra});

test('a revised order: the original keeps its fills, the revision carries the rest, nothing is counted twice',()=>{
  // 5 to buy: 2 filled at 100 on the original, the price revised, 3 filled at 101 on the revision; a cancel row has none.
  const rows=[r('0001',{quantity:5,filled:2,executionAmount:200}),r('0002',{originalOrderId:'0001',quantity:3,filled:3,executionAmount:303}),r('0003',{originalOrderId:'0002',quantity:0,filled:0,status:'Canceled'}),
    r('0009',{side:'Sell',quantity:1,filled:1,executionAmount:150})];
  const s=executionSummary(rows);assert.deepEqual([s.buy,s.sell,s.grossFlow,s.corrected,s.excluded],[503,150,-353,2,0]);});

test('each currency on its own: a corrected U.S. order does not touch the Korean totals, and neither hides',()=>{
  const rows=[r('k1',{filled:1,executionAmount:1000}),r('u1',{market:'US',currency:'USD',filled:1,executionAmount:280}),r('u2',{market:'US',currency:'USD',originalOrderId:'u1',side:'Sell',filled:1,executionAmount:290})];
  const kr=executionSummary(rows.filter(o=>o.currency!=='USD')),us=executionSummary(rows.filter(o=>o.currency==='USD'));
  assert.deepEqual([kr.buy,kr.corrected],[1000,0]);assert.deepEqual([us.buy,us.sell,us.grossFlow,us.corrected],[280,290,10,1]);});

test('an executed row with no amount from KIS leaves that side without a total, with its count; never a zero',()=>{
  const s=executionSummary([r('a',{filled:1,executionAmount:null}),r('b',{filled:1,executionAmount:500}),r('c',{side:'Sell',filled:1,executionAmount:700})]);
  assert.equal(s.buy,null);assert.equal(s.missing.buy,1);assert.equal(s.sell,700);assert.equal(s.grossFlow,null);});

test('guard, within the order: the app\'s chain fills no more than its quantity, so its rows are summed',()=>{
  // A one-share buy corrected once: quantity 1, an original and a corrected order number, filled 1.
  const rows=[r('1234500',{filled:0,executionAmount:0}),r('1239900',{originalOrderId:'1234500',filled:1,executionAmount:60000})];
  const marked=markChains(rows,[{id:'i1',market:'KR',quantity:1,brokerOrderId:'0001234500',brokerOrderIds:['0001234500','0001239900']}]);
  assert.equal(marked.some(x=>x.chainOverfill),false);assert.equal(executionSummary(marked).buy,60000);});

test('guard, past the order: a chain filling more than its quantity is left out and counted once',()=>{
  const rows=[r('100',{quantity:1,filled:1,executionAmount:60000}),r('101',{originalOrderId:'100',quantity:1,filled:1,executionAmount:60000}),r('200',{filled:1,executionAmount:5000})];
  const marked=markChains(rows,[{id:'i2',market:'KR',quantity:1,brokerOrderId:'0000100'}]);
  assert.deepEqual(marked.map(x=>Boolean(x.chainOverfill)),[true,true,false],'leading zeros compared away; the revision followed');
  const s=executionSummary(marked);assert.equal(s.buy,5000);assert.equal(s.excluded,1,'one order, two rows');
  assert.equal(s.corrected,0,'the left-out chain\'s revision is not also counted as included');
  const mixed=executionSummary([...marked,r('300',{originalOrderId:'299',filled:1,executionAmount:10})]);assert.deepEqual([mixed.corrected,mixed.excluded],[1,1],'an included correction still counts');
  assert.equal(markChains(rows,[{id:'i2',market:'US',quantity:1,brokerOrderId:'100'}]).some(x=>x.chainOverfill),false,'another market\'s rows are not its chain');
  assert.equal(markChains(rows,[]),rows,'no records: rows as they are');});

test('the screen: no "Unavailable" for a corrected period, the counts are said, the old notice is gone',()=>{
  const src=fs.readFileSync(new URL('../src/ActivityReport.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(src,/cash-flow totals are hidden/);assert.match(src,/Includes \$\{plural\(summary\.corrected,'corrected order'\)\}\./);
  assert.match(src,/not included: KIS reports more filled shares than the order had/);assert.match(src,/Not reported for/);
  assert.match(fs.readFileSync(new URL('../electron/main.cjs',import.meta.url),'utf8'),/require\('\.\/activity-chains\.cjs'\)\.markChains\(data\.orders,intents\)/);});
