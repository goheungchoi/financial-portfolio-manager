// The Home line while armed conditional orders are not watched (found in live use). Made-up orders.
import test from 'node:test';import assert from 'node:assert/strict';import {unwatchedLine} from '../src/unwatched-orders.mjs';
const st=(orders,extra={},config={conditionalOrders:true,scope:'kis'})=>({desk:{monitoringActive:false,orders,...extra},config});
test('only stops: "stops"; buys or take-profits: "armed conditional orders"; nothing when watched, off, paper or none',()=>{
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'},{purpose:'stop_loss'}])),'2 stops are not watched until auto trading is started.');
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'}])),'1 stop is not watched until auto trading is started.');
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'},{purpose:'take_profit'}])),'2 armed conditional orders are not watched until auto trading is started.');
  assert.equal(unwatchedLine(st([{purpose:'entry',side:'Buy'}])),'1 armed conditional order is not watched until auto trading is started.');
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'}],{monitoringActive:true})),null,'watched');
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'}],{},{conditionalOrders:false,scope:'kis'})),null,'conditional orders off');
  assert.equal(unwatchedLine(st([{purpose:'stop_loss'}],{},{conditionalOrders:true,scope:'paper'})),null,'paper');
  assert.equal(unwatchedLine(st([])),null);assert.equal(unwatchedLine({}),null);
});
