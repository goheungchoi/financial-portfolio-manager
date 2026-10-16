import test from 'node:test';
import assert from 'node:assert/strict';
import {portfolioProfit} from '../src/portfolio-profit.mjs';
const kr={quantity:2,price:120,cost:100,currency:'KRW',valueKRW:240,costKRW:200};
const us={quantity:1,price:90,cost:100,currency:'USD',valueKRW:90000,costKRW:100000};
test('unrealized result uses invested basis and keeps native versus converted currencies distinct',()=>{
  assert.deepEqual(portfolioProfit([kr]),{amount:40,percent:20});
  assert.deepEqual(portfolioProfit([us],'USD'),{amount:-10,percent:-10});
  assert.equal(portfolioProfit([kr,us]).amount,-9960);
  assert.equal(portfolioProfit([kr,us]).percent,-9960/100200*100);
});
test('missing basis, FX or balances remain unknown while cash-only portfolios have no return percentage',()=>{
  assert.equal(portfolioProfit([{...kr,cost:0}]),null);
  assert.equal(portfolioProfit([{...us,costKRW:null}]),null);
  assert.equal(portfolioProfit([], 'KRW',false),null);
  assert.deepEqual(portfolioProfit([]),{amount:0,percent:null});
});
