import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {nextChange,priceBasis} from '../src/live-change.mjs';
const require=createRequire(import.meta.url);
test('opening the app: a holding moving from its balance price to a live quote settles silently; later moves still show',()=>{
  // 2026-10-23 22:28: balance priced Samsung E&A at ₩59,600, the live quote a second later at ₩59,100.
  const rows=src=>[{symbol:'028050',priceSource:src}];const at=src=>priceBasis(rows(src),{krLoaded:true,withUS:false});
  let s=nextChange(null,1498481,at('balance'));assert.equal(s.delta,null,'first value');
  s=nextChange(s.state,1496381,at('quote'));assert.equal(s.delta,null,'the ₩2,100 source change is not a red tick');
  s=nextChange(s.state,1496381,at('quote'));assert.equal(s.delta,0);
  s=nextChange(s.state,1494881,at('quote'));assert.equal(s.delta,-1500,'a real later move still shows');
  assert.notEqual(priceBasis(rows('quote'),{krLoaded:true,withUS:false}),priceBasis(rows('quote'),{krLoaded:true,withUS:true}),'a market loading is a new basis');
});
test('holdings are tagged with where their price came from',()=>{
  const {buildKisMarket}=require('../electron/kis-market.cjs');const now=Date.now();
  const state={status:'connected',error:null,snapshot:{environment:'live',timestamp:new Date(now).toISOString(),cash:1,reportedTotal:1,holdings:[{symbol:'028050',name:'E&A',quantity:3,cost:60300,price:59600},{symbol:'005930',name:'S',quantity:1,cost:1,price:2}]}};
  const m=buildKisMarket(state,new Map([['028050',{price:59100,retrievedAt:now,timestamp:now}]]),now);
  assert.deepEqual(m.snapshot.holdings.map(h=>[h.symbol,h.price,h.priceSource]),[['028050',59100,'quote'],['005930',2,'balance']]);
});
test('the console shows a finished dry run as a dry run, not in progress',async()=>{
  const fs=await import('node:fs');const src=fs.readFileSync(new URL('../src/AiConsole.tsx',import.meta.url),'utf8');
  assert.match(src,/Dry run · inputs checked'\|\|e\.title==='Dry-run review · nothing applied'/);assert.match(src,/dry\?'Dry run'/);
  const auto=fs.readFileSync(new URL('../electron/automation.cjs',import.meta.url),'utf8');assert.match(auto,/'Dry-run review · nothing applied':'Dry run · inputs checked'/,'titles the console matches are the ones dry runs log');
});
