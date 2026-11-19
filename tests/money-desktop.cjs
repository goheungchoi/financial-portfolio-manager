// Item 8: the desktop hook for the money field. On a made-up KIS account (fixture replies only; nothing reaches a real
// service) Performance -> Deposits & withdrawals -> Amount is typed into (in the middle too), pasted into in three forms,
// refused an unreadable paste, switched to U.S. dollars, and recorded as a deposit and a withdrawal; the 10x note shows;
// and the paper "Maximum order (KRW)" cap saves the same number. Typing goes through the page's own insertText (the
// beforeinput and input events of a keystroke); a paste is a paste event carrying its own text, so the clipboard is
// never touched.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const seedDay=offset=>new Date(Date.now()+9*3600000-offset*86400000).toISOString().slice(0,10);
// The account is worth 10,000,000 won: a deposit over 100,000,000 gets the note.
process.env.PORTFOLIO_PERFORMANCE_SEED=JSON.stringify({account:'money-fixture',history:[[3,10000000],[2,10000000],[1,10000000]].map(([offset,value])=>({day:seedDay(offset),at:0,KRW:{equity:value,cash:value},USD:null,fx:null,equityKRW:value})),reviews:[]});
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/money-desktop');fs.mkdirSync(output,{recursive:true});
const domestic={accountKey:'money-fixture',environment:'mock',source:'kis',cash:10000000,reportedTotal:10000000,holdings:[]};
const overseas={accountKey:'money-fixture:US',environment:'mock',source:'kis-us',currency:'USD',cash:0,reportedTotal:0,holdings:[]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-money-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:false,dartConnected:false,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='refresh')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='live-context')return {balance:{...domestic,timestamp:new Date().toISOString()},quotes:[],marketSession:{open:false,status:'closed'}};
  if(operation==='us-context')return {balance:{...overseas,timestamp:new Date().toISOString()},quotes:[],warnings:[],marketSession:{open:false,status:'closed'}};
  if(operation==='orders'||operation==='us-orders')return {orders:[]};if(operation==='quotes')return (payload?.symbols??[]).map(symbol=>({symbol,price:1000,retrievedAt:Date.now()}));
  if(operation==='index-history')return Array.from({length:4},(_,i)=>({day:seedDay(3-i),close:5000+i*20}));if(operation==='news')return [];
  throw new Error('FEATURE_UNAVAILABLE');};
const timer=setTimeout(()=>{console.error('Money desktop timed out');app.exit(1);},150000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'navigation to '+tab);};
  const q=label=>`document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  const field=label=>run(`(()=>{const e=${q(label)};const line=document.getElementById(e.getAttribute('aria-describedby'));return {value:e.value,caret:e.selectionStart,line:line?line.textContent.replace(/\\u00a0/g,' '):null,invalid:e.getAttribute('aria-invalid')};})()`);
  // Typing: focus, put the caret (or a selection), then insert as a keystroke would.
  const type=(label,text,from=null,to=from)=>run(`(()=>{const e=${q(label)};e.focus();const a=${from==null?'e.value.length':from},b=${to==null?'e.value.length':to};e.setSelectionRange(a,b);document.execCommand('insertText',false,${JSON.stringify(text)});})()`);
  const paste=(label,text)=>run(`(()=>{const e=${q(label)};e.focus();e.select();const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`);
  const pick=(label,value)=>run(`(()=>{const e=${q(label)};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const tick=()=>new Promise(r=>setTimeout(r,120));
  // F3: a money field's input sits level with its neighbours in the row (its read-back hangs below).
  const level=async(a,b)=>{const [ta,tb]=await run(`[${q(a)}.getBoundingClientRect().top,${q(b)}.getBoundingClientRect().top]`);assert.ok(Math.abs(ta-tb)<=1,`${a} at ${ta}, ${b} at ${tb}: not level`);};
  const openSection=async start=>{await until(`Array.from(document.querySelectorAll('details')).some(x=>(x.querySelector('summary')?.textContent??'').startsWith(${JSON.stringify(start)}))`,'the section '+start);return run(`(()=>{const d=Array.from(document.querySelectorAll('details')).find(x=>(x.querySelector('summary')?.textContent??'').startsWith(${JSON.stringify(start)}));for(let x=d;x;x=x.parentElement?.closest('details'))x.open=true;d.scrollIntoView({block:'center'});})()`);};
  await run('window.portfolio.importKis()');await run('window.portfolio.refreshPortfolio()');
  await navigate('Performance');await until(`Boolean(${q('Deposits and withdrawals')})`,'the flows section');await run(`${q('Deposits and withdrawals')}.open=true`);await until(`Boolean(${q('Flow amount')})`,'the amount field');
  const A='Flow amount';
  // Typed 3000000: grouped as it goes, the caret at the end; the read-back line is the field's description.
  await type(A,'3000000');await tick();let f=await field(A);assert.equal(f.value,'3,000,000');assert.equal(f.caret,9);assert.equal(f.line,'₩3,000,000 · 300만 원');
  // A digit typed in the middle (after the "5"): the caret stays after it.
  await type(A,'9',1);await tick();f=await field(A);assert.equal(f.value,'39,000,000');assert.equal(f.caret,2,'the caret stays where the user types');
  // Backspace beside a comma removes the digit before it (keydown, then the browser's own Backspace is prevented).
  await run(`(()=>{const e=${q(A)};e.focus();e.setSelectionRange(3,3);e.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));})()`);await tick();f=await field(A);assert.equal(f.value,'3,000,000','"39,|000,000" Backspace: the 9 goes');
  // A letter and a "." are refused: the field keeps its text, and the line says why.
  await type(A,'a');await tick();f=await field(A);assert.equal(f.value,'3,000,000');assert.equal(f.line,'Couldn’t read “a”: numbers only');assert.equal(f.invalid,'true');
  await type(A,'s');await tick();f=await field(A);assert.equal(f.value,'3,000,000');assert.equal(f.line,'Couldn’t read “s”: numbers only','F2: the letter s is quoted alone');
  await type(A,'.');await tick();f=await field(A);assert.equal(f.value,'3,000,000');assert.equal(f.line,'Whole won only');
  await capture('money-deposit-refused');
  // Pastes.
  for(const text of ['₩3,000,000','3000000원','3 000 000']){await paste(A,text);await tick();f=await field(A);assert.equal(f.value,'3,000,000',text);assert.equal(f.line,'₩3,000,000 · 300만 원',text);}
  await paste(A,'abc');await tick();f=await field(A);assert.equal(f.value,'3,000,000','an unreadable paste leaves the field as it was');assert.equal(f.line,'Couldn’t read “abc”: numbers only');
  await paste(A,'3000000원');await tick();await capture('money-deposit');
  // Recorded: the same number as before (3,000,000), then a withdrawal (−3,000,000), from the Type select.
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Record deposit').click()`);
  await until(`(${q('Recorded flows')}?.textContent??'').includes('3,000,000')`,'the recorded deposit');await until(`${q(A)}.value===''`,'the field cleared after recording');
  const flows=()=>run('window.portfolio.getPerformance().then(r=>r.state.flows.map(f=>f.amount))');assert.deepEqual(await flows(),[3000000]);
  await pick('Flow type','withdrawal');await paste(A,'3,000,000');await tick();await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Record withdrawal').click()`);
  await until(`window.portfolio.getPerformance().then(r=>r.state.flows.length===2)`,'the recorded withdrawal');assert.deepEqual((await flows()).sort((a,b)=>a-b),[-3000000,3000000]);
  // Item 9 quick buttons: +100만 on 3,000,000 gives 4,000,000 and its read-back; the field's undo takes it back.
  await pick('Flow type','deposit');await paste(A,'3,000,000');await tick();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[role=group][aria-label="Flow amount: quick amounts"] button')).map(b=>[b.textContent,b.getAttribute('aria-label')])`),[['+10만','Add ₩100,000'],['+100만','Add ₩1,000,000'],['+1,000만','Add ₩10,000,000']]);
  await run(`document.querySelector('[aria-label="Add ₩1,000,000"]').click()`);await tick();f=await field(A);assert.equal(f.value,'4,000,000');assert.equal(f.line,'₩4,000,000 · 400만 원');await capture('money-deposit-quick');
  await run(`(()=>{const e=${q(A)};e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));})()`);await tick();f=await field(A);assert.equal(f.value,'3,000,000','the press is one undo step');
  assert.equal(await run(`document.querySelectorAll('[aria-label$=": quick amounts"]').length`),1,'quick buttons on the deposit amount only');
  // Over 10x the account: a note in the line, never a block.
  await pick('Flow type','deposit');await paste(A,'150,000,000');await tick();f=await field(A);assert.equal(f.line,'₩150,000,000 · 1억 5,000만 원 · over 10× this account — check the amount');
  assert.equal(await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Record deposit').disabled`),false,'the note never blocks');
  await level(A,'Flow date');await level(A,'Flow type');await capture('money-deposit-far');
  // U.S. dollars: two decimals; a third refused.
  await paste(A,'');await run(`(()=>{const e=${q(A)};e.focus();e.select();document.execCommand('delete');})()`);await pick('Flow account','US');await tick();
  await type(A,'1234.5');await tick();f=await field(A);assert.equal(f.value,'1,234.5');assert.equal(f.line,'$1,234.50');
  await type(A,'0');await tick();await type(A,'1');await tick();f=await field(A);assert.equal(f.value,'1,234.50');assert.equal(f.line,'Two decimals at most');await capture('money-deposit-usd');
  // The paper Maximum order (KRW) cap: typed with grouping, saved as the same number.
  await navigate('Paper trading');await run(`(()=>{const d=Array.from(document.querySelectorAll('details')).find(x=>x.querySelector('summary')?.textContent==='Optional execution caps');for(let x=d;x;x=x.parentElement?.closest('details'))x.open=true;d.scrollIntoView({block:'center'});})()`);
  const C='Paper Maximum order (KRW)';await until(`Boolean(${q(C)})`,'the paper cap field');await type(C,'3000000');await tick();f=await field(C);assert.equal(f.value,'3,000,000');assert.equal(f.line,'₩3,000,000 · 300만 원');
  await level(C,'Paper Daily turnover (KRW)');await level(C,'Paper Maximum company allocation (%)');
  await capture('money-paper-cap');await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Save optional caps').click()`);
  const cap=`window.portfolio.getPaper().then(r=>r?.data?.policy?.maxOrderKRW??null)`;await until(`${cap}.then(v=>v===3000000)`,'the saved cap: the same number as typed');
  // The other rows where a money field shares a row (F3): the live caps, the tax ledger's opening lot, the fees row.
  await navigate('KIS trading');await openSection('Caps');const L='Maximum order (KRW)';await until(`Boolean(${q(L)})`,'the live cap field');
  await type(L,'1000000');await tick();f=await field(L);assert.equal(f.line,'₩1,000,000 · 100만 원');await level(L,'Daily turnover (KRW)');await level(L,'Maximum company allocation (%)');await capture('money-live-caps');
  await navigate('Fees & taxes');await openSection('Opening lots');const T='Opening lot KRW cost';await until(`Boolean(${q(T)})`,'the opening lot cost field');
  await type(T,'12345678');await tick();f=await field(T);assert.equal(f.line,'₩12,345,678 · 1,234만 5,678원');await level(T,'Opening lot shares');
  // The opening lots row (its checkbox and "Add" included) stays inside its card.
  const inside=await run(`(()=>{const row=${q('Opening lot stock')}.closest('.control-pair'),card=row.closest('section').getBoundingClientRect();const right=Math.max(...Array.from(row.children).map(c=>c.getBoundingClientRect().right));return {right,card:card.right};})()`);
  assert.ok(inside.right<=inside.card,`the opening lots row ends at ${inside.right}, past its card at ${inside.card}`);await capture('money-tax-ledger');
  const P='Acquisition cost per share (KRW)';await run(`${q(P)}.scrollIntoView({block:'center'})`);await type(P,'70000');await tick();f=await field(P);assert.equal(f.line,'₩70,000 · 7만 원');await level(P,'Acquisition cost stock');await capture('money-fees');
  console.log('Money desktop passed: deposits typed, pasted, refused, recorded both ways, the 10x note, dollars, and the paper cap saved as 3000000.');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
