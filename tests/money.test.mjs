// Item 8 (artifacts/reviews/2026-11-17-amount-inputs/design-note.md, cleared): the pure money module behind every amount
// field. The plain value a field gives back is the same as today's number input; only the shown text changes.
import test from 'node:test';import assert from 'node:assert/strict';
import * as M from '../src/money.ts';
test('grouping: the whole part, with a typed "." kept',()=>{
  for(const [plain,shown] of [['',''],['0','0'],['5','5'],['999','999'],['1000','1,000'],['3000000','3,000,000'],['123456789012345','123,456,789,012,345'],['1234.5','1,234.5'],['1234.','1,234.'],['0.05','0.05']])assert.equal(M.group(plain),shown,plain);
});
test('typing: KRW whole won only, USD two decimals; letters, a minus and a second "." refused; 15 digits at most',()=>{
  const ok=(t,c)=>{const p=M.parseTyped(t,c);assert.ok(p.ok,t);return p.plain;},no=(t,c)=>{const p=M.parseTyped(t,c);assert.ok(!p.ok,t);return p.problem;};
  assert.equal(ok('3,000,000','KRW'),'3000000');assert.equal(ok('','KRW'),'');assert.equal(ok('0','KRW'),'0');assert.equal(ok('007','KRW'),'7');
  assert.equal(no('5000.','KRW'),'whole');assert.equal(no('5.5','KRW'),'whole');
  assert.equal(ok('1,234.5','USD'),'1234.5');assert.equal(ok('1234.','USD'),'1234.');assert.equal(ok('.5','USD'),'0.5');assert.equal(no('1.234','USD'),'decimals');
  for(const t of ['12a','-5','1.2.3','5e3','+5'])assert.equal(no(t,'USD'),'numbers',t);
  assert.equal(ok('9'.repeat(15),'KRW'),'9'.repeat(15));assert.equal(no('1'+'0'.repeat(15),'KRW'),'large');
  assert.ok(Number.isSafeInteger(Number('9'.repeat(15))),'every plain value is an exact number');
});
test('paste: the forms in the handoff read as 3,000,000; what cannot be read is refused, never cut',()=>{
  for(const t of ['3,000,000','₩3,000,000','3 000 000','3000000원','3,000,000 원','₩ 3,000,000','3,000,000.00','KRW 3,000,000','3000000'])assert.deepEqual(M.parsePasted(t,'KRW'),{ok:true,plain:'3000000'},t);
  assert.deepEqual(M.parsePasted('$1,234.50','USD'),{ok:true,plain:'1234.50'});assert.deepEqual(M.parsePasted('1,234.5 USD','USD'),{ok:true,plain:'1234.5'});assert.deepEqual(M.parsePasted('1234.500','USD'),{ok:true,plain:'1234.50'});
  assert.deepEqual(M.parsePasted('3,000,000.5','KRW'),{ok:false,problem:'whole'},'a won fraction is never dropped');assert.deepEqual(M.parsePasted('1.234','USD'),{ok:false,problem:'decimals'},'a third decimal is never cut');
  for(const t of ['abc','5백만','1.2.3','-5,000','','₩','five','3,000,000원원'])assert.equal(M.parsePasted(t,'KRW').ok,false,t);
  assert.deepEqual(M.parsePasted('1'+'0'.repeat(15),'KRW'),{ok:false,problem:'large'});
  // F1: a comma only between thousands; anything else may be a decimal comma or a typo.
  for(const t of ['5,00','50,00,000','1,2345',',500','500,','1.2,3','₩5,00'])assert.deepEqual(M.parsePasted(t,'KRW'),{ok:false,problem:'numbers'},t);
  for(const t of ['1,234,567','1,234,567원','₩1,234,567'])assert.deepEqual(M.parsePasted(t,'KRW'),{ok:true,plain:'1234567'},t);
  assert.deepEqual(M.parsePasted('1,234.50','USD'),{ok:true,plain:'1234.50'});assert.deepEqual(M.parsePasted('5,00','USD'),{ok:false,problem:'numbers'},'not read as 500 in dollars either');
  assert.equal(M.parseTyped('5,00','KRW').ok,true,'typed input is unaffected: the field regroups as the user types');
});
test('the plain value is the number today\'s input gave, for a table of inputs',()=>{
  for(const [typed,c] of [['3000000','KRW'],['0','KRW'],['1234.5','USD'],['0.01','USD'],['100','USD'],['12345678','KRW']]){const p=M.parseTyped(M.group(typed),c);assert.ok(p.ok);assert.equal(Number(p.plain),Number(typed),typed);}
});
test('the Korean reading: 만, 억, 조; " 원" after a unit, "원" after digits',()=>{
  for(const [n,text] of [[0,'0원'],[5000,'5,000원'],[9999,'9,999원'],[10000,'1만 원'],[3000000,'300만 원'],[12345678,'1,234만 5,678원'],[150000000,'1억 5,000만 원'],[100000000,'1억 원'],[100000001,'1억 1원'],[1200000000000,'1조 2,000억 원'],[999999999999999,'999조 9,999억 9,999만 9,999원']])assert.equal(M.koreanReading(n),text,String(n));
});
test('the read-back line',()=>{
  assert.equal(M.readBack('3000000','KRW'),'₩3,000,000 · 300만 원');assert.equal(M.readBack('12345678','KRW'),'₩12,345,678 · 1,234만 5,678원');assert.equal(M.readBack('','KRW'),'');
  assert.equal(M.readBack('1234.5','USD'),'$1,234.50');assert.equal(M.readBack('1234','USD'),'$1,234.00');assert.equal(M.readBack('1234.','USD'),'$1,234.00');assert.equal(M.readBack('0.05','USD'),'$0.05');
  assert.equal(M.problemText('whole','5.'),'Whole won only');assert.equal(M.problemText('decimals','x'),'Two decimals at most');assert.equal(M.problemText('large','x'),'Too large');assert.equal(M.problemText('numbers','abc'),'Couldn’t read “abc”: numbers only');
  // F2: a refused edit quotes only what was refused; white space is grouping, never a refused character.
  assert.equal(M.refusedPart('3,000,000a'),'a');assert.equal(M.refusedPart('3,000,000s'),'s','the letter s is refused, and quoted');
  assert.equal(M.refusedPart('3 000 000x'),'x','a space is not quoted');assert.equal(M.refusedPart('1.2.3'),'1.2.3','nothing else left: the whole text');
  assert.equal(M.problemText('numbers',M.refusedPart('12s')),'Couldn’t read “s”: numbers only');
  assert.equal(M.farBeyond('30000001',3000000),true);assert.equal(M.farBeyond('30000000',3000000),false,'exactly 10× is not beyond');assert.equal(M.farBeyond('5',null),false);assert.equal(M.farBeyond('5',0),false);
});
test('item 9 quick buttons: each press adds (empty is 0), in whole cents for dollars; past 15 digits refused',()=>{
  assert.deepEqual(M.addAmount('',1000000,'KRW'),{ok:true,plain:'1000000'});assert.deepEqual(M.addAmount('3000000',1000000,'KRW'),{ok:true,plain:'4000000'});
  assert.deepEqual(M.addAmount('1234.5',100,'USD'),{ok:true,plain:'1334.50'});assert.deepEqual(M.addAmount('0.1',1000,'USD'),{ok:true,plain:'1000.10'},'no float drift');assert.deepEqual(M.addAmount('1234',100,'USD'),{ok:true,plain:'1334'});
  assert.deepEqual(M.addAmount('9'.repeat(15),100000,'KRW'),{ok:false,problem:'large'});assert.deepEqual(M.addAmount('99999999999999.99',1,'USD'),{ok:true,plain:'100000000000000.99'});
  assert.deepEqual(M.QUICK.KRW.map(a=>M.quickLabel(a,'KRW')),['+10만','+100만','+1,000만']);assert.deepEqual(M.QUICK.USD.map(a=>M.quickLabel(a,'USD')),['+$100','+$1,000','+$10,000']);
  assert.equal(M.quickName(100000,'KRW'),'Add ₩100,000');assert.equal(M.quickName(1000,'USD'),'Add $1,000.00');
});
test('the caret stays where the user types: insert, delete and replace at the start, middle and end',()=>{
  // Type "9" between 3 and 000000 of "3,000,000" (caret after "5"): raw "39,000,000" -> shown "39,000,000", caret after "9".
  const edit=(raw,caret)=>{const p=M.parseTyped(raw,'KRW');const shown=M.group(p.plain);return [shown,M.caretAt(shown,M.significantBefore(raw,caret))];};
  assert.deepEqual(edit('39,000,000',2),['39,000,000',2]);
  assert.deepEqual(edit('3000000',7),['3,000,000',9],'typed at the end: caret at the end');
  assert.deepEqual(edit('13,000,000',1),['13,000,000',1],'at the start');
  assert.deepEqual(edit('5,00,000',4),['500,000',3],'a digit deleted in the middle: the caret after the same digits');
  assert.deepEqual(edit('5,7,000',3),['57,000',2],'a selection replaced in the middle');
  assert.equal(M.caretAt('1,234',0),0);assert.equal(M.caretAt('1,234.5',5),6,'the "." counts');
});
test('Backspace and Delete beside a comma remove the digit on the other side',()=>{
  assert.deepEqual(M.deleteAcrossComma('3,000,000',2,'Backspace'),{text:',000,000',significant:0});
  const b=M.deleteAcrossComma('12,345',3,'Backspace');assert.deepEqual(b,{text:'1,345',significant:1});assert.equal(M.group(M.parseTyped(b.text,'KRW').plain),'1,345');
  const d=M.deleteAcrossComma('12,345',2,'Delete');assert.deepEqual(d,{text:'12,45',significant:2});assert.equal(M.group(M.parseTyped(d.text,'KRW').plain),'1,245');
  assert.equal(M.deleteAcrossComma('12,345',4,'Backspace'),null,'not beside a comma: the browser deletes');assert.equal(M.deleteAcrossComma('12,345',5,'Delete'),null);
});
