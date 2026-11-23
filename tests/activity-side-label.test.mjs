// Activity names a short sale and its cover by KIS's kind name (found in live use: they read as a plain sale and purchase).
import test from 'node:test';import assert from 'node:assert/strict';import {sideLabel} from '../src/activity.mjs';
test('공매도 and 공매도 상환 from KIS\'s kind name; Buy or Sell otherwise',()=>{
  assert.equal(sideLabel({side:'Sell',creditName:'유대신규'}),'공매도');assert.equal(sideLabel({side:'Sell',creditName:'유대매도거부'}),'공매도','a refused short is still a short');
  assert.equal(sideLabel({side:'Buy',creditName:'유대상환'}),'공매도 상환');assert.equal(sideLabel({side:'Sell',creditName:'현금매도'}),'Sell');assert.equal(sideLabel({side:'Buy'}),'Buy');
});
