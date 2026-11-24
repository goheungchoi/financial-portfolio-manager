// Short selling B3f-1 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md): words and counts. Covers are
// named apart from buys in every count; an outcome reads by what it did; Activity's Side filter has Short and Cover.
// Made-up codes and figures.
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {outcomeWords,shortGapsLine,isExit,effectOf} from '../src/outcome-words.mjs';import {sideKind,sideLabel} from '../src/activity.mjs';import {whileStoppedLines} from '../src/unwatched-orders.mjs';
const require=createRequire(import.meta.url);const {watchedWords}=require('../electron/auto-launch.cjs');
const money=(v,c)=>v==null?'Unknown':`${c} ${v}`;
test('the watched orders while stopped name covers apart: Home and the Stop reply',()=>{
  const w={sentByThemselves:3,proposedOnly:0,buys:2,covers:1,waiting:[]};assert.match(watchedWords(w),/^Your 3 armed orders are still watched \(2 buys, 1 cover\) and are sent by themselves/);
  assert.match(watchedWords({...w,sentByThemselves:2,buys:0,covers:2}),/still watched \(2 covers\)/);assert.match(watchedWords({...w,sentByThemselves:1,buys:1,covers:0}),/still watched \(1 buy\) and is sent/);
  assert.match(watchedWords({...w,sentByThemselves:1,buys:0,covers:0}),/still watched and is sent/,'a sale only: no count');
});
test('the loss-limit line names covers among the closing orders',()=>{
  const at=lossLimit=>({config:{conditionalOrders:true,scope:'kis'},desk:{whileStopped:{on:true,connected:true,watching:true,running:false,lossLimit}}});
  assert.match(whileStoppedLines(at({closing:2,covers:1,buysWait:1})).block,/2 closing orders are still watched \(1 cover\); 1 buy waits\./);
  assert.match(whileStoppedLines(at({closing:1,buysWait:0})).block,/1 closing order is still watched; 0 buys wait\./,'no cover: as before');
});
test('an outcome reads by what it did: a short sale\'s proceeds, a cover\'s result against them, a sale and a purchase as before',()=>{
  const short={effect:'OPEN_SHORT',side:'Sell',currency:'KRW',quantity:10,averagePrice:1000,gross:10000,gainAfterFees:null};
  assert.equal(outcomeWords(short,money),'Short sale recorded: proceeds KRW 10000');assert.equal(isExit(short),false,'no after-tax line');
  const cover={effect:'CLOSE_SHORT',side:'Buy',currency:'KRW',gainAfterFees:-2300,shortProceeds:10000,shortCosts:{interest:{amount:7,basis:'estimate'}},shortGaps:[]};
  assert.equal(outcomeWords(cover,money),'Cover: result after fees KRW -2300 against proceeds KRW 10000, borrow interest KRW 7 (estimated until KIS reports it)');assert.equal(isExit(cover),true);
  assert.equal(outcomeWords({...cover,shortCosts:{interest:{amount:9,basis:'broker'}}},money),'Cover: result after fees KRW -2300 against proceeds KRW 10000, borrow interest KRW 9','KIS\'s figure: not called an estimate');
  assert.equal(outcomeWords({...cover,gainAfterFees:null,shortProceeds:null,shortCosts:null},money),'Cover: result after fees Unknown against proceeds Unknown, borrow interest unknown');
  assert.equal(shortGapsLine({...cover,shortGaps:['Cover charges unavailable']}),'Gaps: Cover charges unavailable.');assert.equal(shortGapsLine(cover),null);assert.equal(shortGapsLine({effect:'CLOSE_LONG',shortGaps:['x']}),null);
  assert.equal(outcomeWords({side:'Sell',currency:'KRW',gainAfterFees:500},money),'KRW 500 after fees');assert.equal(outcomeWords({side:'Buy',currency:'KRW'},money),null,'a purchase keeps each screen\'s words');
  // An effect the module does not name keeps the words by side exactly (a margin repayment sale with no loan date: "unknown").
  const unknownSale={effect:'unknown',side:'Sell',currency:'KRW',gainAfterFees:500};assert.equal(outcomeWords(unknownSale,money),'KRW 500 after fees');assert.equal(isExit(unknownSale),true,'its after-tax line');
  assert.equal(outcomeWords({effect:'unknown',side:'Buy',currency:'KRW'},money),null);assert.equal(isExit({effect:'unknown',side:'Buy'}),false);
  assert.equal(outcomeWords({effect:'OPEN_LONG',side:'Buy',credit:{kind:'margin-buy'},currency:'KRW'},money),null,'a margin buy: the screen\'s purchase words');
  assert.equal(outcomeWords({effect:'CLOSE_LONG',side:'Sell',credit:{kind:'margin-sell'},currency:'KRW',gainAfterFees:-40},money),'KRW -40 after fees');
  // A record written before effect was stored: from its credit kind.
  assert.equal(effectOf({side:'Buy',credit:{kind:'cover'}}),'CLOSE_SHORT');assert.equal(effectOf({side:'Sell',credit:{kind:'short'}}),'OPEN_SHORT');assert.equal(effectOf({side:'Sell'}),'CLOSE_LONG');
});
test('Activity\'s Side filter: Short and Cover by KIS\'s kind names; Buy and Sell are the other orders',()=>{
  assert.equal(sideKind({side:'Sell',creditName:'유대신규'}),'Short');assert.equal(sideKind({side:'Buy',creditName:'유대상환'}),'Cover');
  assert.equal(sideKind({side:'Sell',creditName:'현금매도'}),'Sell');assert.equal(sideKind({side:'Buy'}),'Buy');assert.equal(sideLabel({side:'Sell',creditName:'유대신규'}),'공매도','the label as before');
  const fs=require('node:fs'),path=require('node:path');const src=fs.readFileSync(path.join(import.meta.dirname,'..','src','ActivityReport.tsx'),'utf8');
  assert.match(src,/\['All','Buy','Sell','Short','Cover'\]/);assert.match(src,/side==='All'\|\|sideKind\(order\)===side/);
});
test('the screens use the words: Trade outcomes and the Journal',()=>{
  const fs=require('node:fs'),path=require('node:path'),read=f=>fs.readFileSync(path.join(import.meta.dirname,'..','src',f),'utf8');
  assert.match(read('TradeOutcomes.tsx'),/\{outcomeWords\(row,money\)\?\?'Entry recorded'\}<\/summary>/);assert.match(read('TradeOutcomes.tsx'),/\{isExit\(row\)&&<p>After estimated tax:/);
  assert.match(read('JournalView.tsx'),/outcomeWords\(o,money\)\?\?`Bought at/);
});
