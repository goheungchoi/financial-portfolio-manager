import test from 'node:test';
import assert from 'node:assert/strict';
import { allocations, totals, demoEvents, holdings, cash } from '../src/domain.mjs';
test('valuation includes cash without treating deposits as investment profit', () => {
  assert.deepEqual(totals([{quantity:2,price:150,cost:100}],500), {equity:800,invested:300,cost:200,unrealized:100,returnPct:50});
});
test('sector grouping aggregates holdings and retains cash', () => {
  const result = allocations(holdings,cash,'Sector');
  assert.equal(result.find(b=>b.label==='Technology').value,9720000);
  assert.ok(Math.abs(result.reduce((s,b)=>s+b.percent,0)-100)<1e-9);
  assert.equal(allocations([],0,'Company')[0].percent,0);
});
test('demo run carries correlation and explicitly blocks execution', () => {
  const events=demoEvents('run-1','2026-10-14T00:00:00Z');
  assert.equal(new Set(events.map(e=>e.id)).size,events.length);
  assert.ok(events.every(e=>e.runId==='run-1'));
  assert.ok(events.some(e=>e.kind==='Risk' && e.body.includes('prohibits all order')));
  const context=JSON.parse(events.find(e=>e.kind==='Context').body);
  assert.equal(context.environment,'synthetic');
  assert.deepEqual(Object.keys(context).sort(),['cashKRW','environment','holdings','policy','snapshotVersion']);
});
test('scripted review uses supplied portfolio prices and freshness metadata',()=>{
  const snapshot={cash:100,holdings:[{symbol:'005930',quantity:2,price:150,cost:100}],market:{source:'synthetic',status:'paused'}};
  const events=demoEvents('r','2026-10-14',snapshot);
  const context=JSON.parse(events.find(e=>e.kind==='Context').body);
  assert.equal(context.holdings[0].price,150);
  assert.equal(context.market.status,'paused');
  assert.ok(events.find(e=>e.kind==='Tool').body.includes('Equity KRW 400'));
});
