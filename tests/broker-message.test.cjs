// KIS's refusal message kept beside its code (bounded, no long digit runs), carried through the order paths and shown
// where the code is shown. Made-up codes and text.
const test=require('node:test');const assert=require('node:assert/strict');
const K=require('../electron/kis-client.cjs');
test('the message is bounded, cleaned and masks long digit runs; it travels with the code',()=>{
  assert.equal(K.brokerText({msg1:'  주문 수량 초과\n 계좌 12345678 '}),'주문 수량 초과 계좌 …');assert.equal(K.brokerText({msg1:''}),null);assert.equal(K.brokerText({}),null);
  assert.equal(K.brokerText({msg1:'x'.repeat(300)}).length,120);
  const e=K.rejected({msg_cd:'APBK9999',msg1:'거부 사유'});assert.equal(e.code,'BROKER_REJECTED');assert.equal(e.brokerCode,'APBK9999');assert.equal(e.brokerMessage,'거부 사유');
  const o=K.orderError(e);assert.equal(o.brokerCode,'APBK9999');assert.equal(o.brokerMessage,'거부 사유','orderError keeps both');
  assert.equal(require('../electron/broker-errors.cjs').classify(e).brokerMessage,'거부 사유');
});
test('a review order refused by KIS names the message beside the code',()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  const fn=new Function('require',src.match(/function refusedNote\(d,code,error=null\)\{[\s\S]*?\n  return `Not sent: \$\{what\}: \$\{require\('\.\/activity-today\.cjs'\)\.reasonText\(code\)\}\.`;\}/)[0]+';return refusedNote;')(require);
  assert.equal(fn({action:'Buy',quantity:1,symbol:'123450'},'BROKER_REJECTED',{brokerCode:'APBK9999',brokerMessage:'거부 사유'}),'Rejected by KIS: Buy 1 123450 (KIS APBK9999: 거부 사유).');
  assert.equal(fn({action:'Buy',quantity:1,symbol:'123450'},'BROKER_REJECTED',{brokerCode:'APBK9999'}),'Rejected by KIS: Buy 1 123450 (KIS APBK9999).');
});
