// Short selling B3f-4 (artifacts/reviews/2026-11-24-short-selling/b3f-plan.md, rulings-b3f-plan.md): the ticket. Your own
// buy made while a short is open shows KIS's orderable cash from its preparation (the figure, or that it could not be
// read); a cover's and a short sale's costs say what they are; any other order is as before. Made-up figures.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const ROOT=path.join(__dirname,'..');
test('the orderable-cash line: the figure, or that KIS did not give it',async()=>{
  const {orderableCashText}=await import('../src/short-confirm.mjs');
  assert.equal(orderableCashText(1234567),"A short is open: KIS's orderable cash ₩1,234,567");assert.equal(orderableCashText(0),"A short is open: KIS's orderable cash ₩0");
  for(const v of [null,undefined,NaN])assert.equal(orderableCashText(v),"A short is open: KIS's orderable cash could not be read");
});
test('the engine keeps the figure on your order beside the fact it already kept; the ticket shows it only when the preparation gave it',()=>{
  const e=fs.readFileSync(path.join(ROOT,'electron','live-engine.cjs'),'utf8');
  assert.match(e,/if\(prepared\.shortCash\)order=\{\.\.\.order,shortOrderableCash:Number\.isFinite\(prepared\.shortCash\.orderableCash\)\?prepared\.shortCash\.orderableCash:null,shortCashFact:/);
  const kis=fs.readFileSync(path.join(ROOT,'electron','kis-client.cjs'),'utf8');assert.match(kis,/if\(shortOpen&&yours\)shortCash=\{orderableCash:cash\};/,'only your own buy, only while a short is open');
  const ui=fs.readFileSync(path.join(ROOT,'src','LiveTrading.tsx'),'utf8');assert.match(ui,/\{order\.shortOrderableCash!==undefined&&<small className="muted" aria-label="KIS orderable cash">\{orderableCashText\(order\.shortOrderableCash\)\}<\/small>\}/);
  assert.match(ui,/<SaleCosts value=\{\(order\.resultCosts\?\?order\.costEstimate\)!\} kind=\{order\.credit\?\.kind\}\/>/);
});
test('the costs say what they are: a cover\'s buy-back cost, a short sale\'s proceeds; a cash order as before',()=>{
  const src=fs.readFileSync(path.join(ROOT,'src','TradingCosts.tsx'),'utf8');const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null}):require(n),mod,mod.exports);
  const buy={currency:'KRW',basis:'estimate',gross:10000,commission:15,transactionTax:0,netCash:-10015,gainAfterFees:null},sale={...buy,netCash:9965,transactionTax:20};
  const draw=(value,kind)=>renderToStaticMarkup(React.createElement(mod.exports.SaleCosts,{value,kind}));
  assert.match(draw(buy,'cover'),/<summary>Buy-back cost with charges · ₩10,015 · Estimated<\/summary>/);assert.match(draw(sale,'short'),/<summary>Short sale proceeds after charges · ₩9,965 · Estimated<\/summary>/);
  assert.equal(draw(buy),draw(buy,undefined));assert.match(draw(buy),/<summary>Total purchase cost · ₩10,015/);assert.match(draw(sale),/<summary>Net proceeds · ₩9,965/);assert.equal(draw(sale,'margin-sell'),draw(sale),'other credit kinds: as before');
  // A short sale realises nothing: its proceeds after charges and no tax lines. A cover's footer says what it is.
  const taxed={...sale,gainAfterFees:300,incomeTax:{status:'estimated',missingInputs:['income-tax classification']},capitalGainsTaxKRW:null,gainAfterEstimatedTax:null};
  const cash=draw(taxed),short=draw(taxed,'short');
  assert.match(cash,/Taxable gain/);assert.match(cash,/Gain after fees/);assert.match(cash,/Net proceeds are the cash you receive; annual tax is filed and paid the next May, not deducted here\./,'a cash sale: as before');
  for(const w of [/Taxable gain/,/Income tax/,/Gain after estimated tax/,/Missing/,/Gain after fees/,/Net proceeds are the cash you receive/])assert.doesNotMatch(short,w,String(w));
  assert.match(short,/The proceeds after charges; a short sale realises nothing until it is covered\./);
  const cover=draw(buy,'cover');assert.match(cover,/What the buy-back costs with charges; the short&#x27;s result is shown when it is covered\./);assert.doesNotMatch(cover,/Net proceeds are the cash you receive/);
  assert.match(draw(buy),/Net proceeds are the cash you receive; annual tax is filed and paid the next May, not deducted here\./,'a cash buy: as before');
});
