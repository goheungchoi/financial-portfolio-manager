// The two price-review rows (artifacts/reviews/2026-11-17-price-review-rows, design note cleared): the mapping from the
// saved keys to the row and back, over every combination. The screen only; the engine reads the keys as before.
import test from 'node:test';import assert from 'node:assert/strict';
import * as P from '../src/price-review-rows.ts';
const NOT_HELD=['default','levels','never'],MODES=['off','observe','on'],TRIAL=['off','on'];
const all=NOT_HELD.flatMap(n=>MODES.flatMap(w=>TRIAL.map(t=>({notHeldPriceReviews:n,watchlistAlerts:w,alertTrial:t}))));
// setConfig accepts the trial only with 'observe' and 'default' (electron/automation.cjs).
const savable=all.filter(c=>c.alertTrial==='off'||c.watchlistAlerts==='observe'&&c.notHeldPriceReviews==='default');
test('the table: what the row shows for each of the 18 combinations',()=>{
  const want=c=>c.alertTrial==='on'?'trial':c.notHeldPriceReviews==='never'?'never':c.notHeldPriceReviews==='levels'?'levels':c.watchlistAlerts==='on'?'wider':'same';
  assert.equal(all.length,18);assert.equal(savable.length,10);for(const c of all)assert.equal(P.shown(c),want(c),JSON.stringify(c));
  // The saved values a user has today (the user's state 2026-11-17): never + on + trial off reads Never.
  assert.equal(P.shown({notHeldPriceReviews:'never',watchlistAlerts:'on',alertTrial:'off'}),'never');
  assert.equal(P.shown({}),'same','missing keys read as the defaults');});
test('choosing each option writes only its keys, never the percent or the trial, and reads back as that option',()=>{
  for(const c of savable.filter(c=>c.alertTrial==='off'))for(const o of P.CHOOSABLE){const patch=P.write(o,c);
    assert.ok(Object.keys(patch).every(k=>k==='notHeldPriceReviews'||k==='watchlistAlerts'),`${o} ${JSON.stringify(patch)}`);
    assert.equal(P.shown({...c,...patch}),o,`round trip ${o} from ${JSON.stringify(c)}`);}
  assert.throws(()=>P.write('trial',{}),/never written/);});
test('the patch table: Same resets on to off and keeps observe; levels and never keep the watchlist mode',()=>{
  assert.deepEqual(P.write('same',{watchlistAlerts:'on',notHeldPriceReviews:'never'}),{notHeldPriceReviews:'default',watchlistAlerts:'off'});
  assert.deepEqual(P.write('same',{watchlistAlerts:'observe',notHeldPriceReviews:'levels'}),{notHeldPriceReviews:'default'});
  assert.deepEqual(P.write('same',{watchlistAlerts:'off'}),{notHeldPriceReviews:'default'});
  for(const w of MODES){assert.deepEqual(P.write('wider',{watchlistAlerts:w}),{notHeldPriceReviews:'default',watchlistAlerts:'on'});
    assert.deepEqual(P.write('levels',{watchlistAlerts:w}),{notHeldPriceReviews:'levels'});assert.deepEqual(P.write('never',{watchlistAlerts:w}),{notHeldPriceReviews:'never'});}});
test('Observe: under Same; under levels and never only when observe is saved; disabled while the trial runs; not under wider',()=>{
  for(const c of all){const s=P.observeSwitch(c),o=P.shown(c),obs=c.watchlistAlerts==='observe';
    if(o==='same')assert.deepEqual(s,{shown:true,on:obs,disabled:false});else if(o==='trial')assert.deepEqual(s,{shown:true,on:obs,disabled:true});
    else if(o==='wider')assert.equal(s.shown,false);else assert.deepEqual(s,{shown:obs,on:obs,disabled:false},JSON.stringify(c));}
  // The user's state: Observe is not offered, so it cannot replace their saved 'on'.
  assert.equal(P.observeSwitch({notHeldPriceReviews:'never',watchlistAlerts:'on'}).shown,false);
  assert.deepEqual(P.observeWrite(true),{watchlistAlerts:'observe'});assert.deepEqual(P.observeWrite(false),{watchlistAlerts:'off'});});
test('the wider-move field: in the row under wider, in More while Observe is on, otherwise hidden',()=>{
  assert.equal(P.widerField({watchlistAlerts:'on'}),'row');assert.equal(P.widerField({watchlistAlerts:'observe'}),'more');
  assert.equal(P.widerField({watchlistAlerts:'observe',notHeldPriceReviews:'never'}),'more');assert.equal(P.widerField({watchlistAlerts:'on',notHeldPriceReviews:'never'}),null);
  assert.equal(P.widerField({watchlistAlerts:'off'}),null);});
test('words: every option has a label and one line; no line pushes a choice',()=>{
  for(const o of [...P.CHOOSABLE,'trial']){assert.ok(P.LABEL[o]);assert.ok(P.LINE[o]);assert.doesNotMatch(P.LINE[o],/recommend|should|better|best/i);}});
