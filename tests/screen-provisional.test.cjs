// The provisional newest row (found in live use; the user's answer: always the latest price; the planner's ruling, step 1):
// KIS's Korean daily row for the day just closed carries the latest price in the evening and is settled later. The store
// marks it provisional, never compares it for a split, reads it once more from 06:00 KST the next day, repairs stocks
// stopped or reset by it once, and scripts label a value that uses it. Made-up symbols and prices.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const H=require('../electron/history-store.cjs');const {run}=require('../electron/formula-script.cjs');
const day=(start,i)=>new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const seoul=(d,hm)=>Date.parse(`${d}T${hm}:00+09:00`);
// Weekdays only, ending on `end`, one agreed close per day; `last` replaces the close of the last day.
const rows=(end,n,{last=null}={})=>{const out=[];for(let d=end;out.length<n;d=day(d,-1)){const w=new Date(d+'T00:00:00Z').getUTCDay();if(w===0||w===6)continue;const c=1000+(Date.parse(d)-Date.parse('2026-01-01'))/86400000;out.unshift({date:d,close:c,high:c+5,low:c-5,volume:1,value:c});}
  if(last!=null)out[out.length-1]={...out.at(-1),close:last};return out;};
const S='990010';
test('the evening row is provisional: never compared for a split, overwritten by the next night\'s page; a real split still resets',()=>{
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));const D='2026-11-24',D1='2026-11-25';
  // Night D, 21:30: the newest row of D carries a later price, 4% above where KIS settles it.
  const settled=rows(D,60).at(-1).close;s.put(S,rows(D,60,{last:settled*1.04}),{day:D,now:seoul(D,'21:30')});
  assert.equal(s.progress(S).provisional,D,'read before 06:00 the next day');
  // Night D+1: the page holds D's settled close (4% away) and D+1's evening row: no reset; D overwritten; D+1 provisional.
  const r=s.put(S,rows(D1,60,{last:rows(D1,60).at(-1).close*0.97}),{day:D1,now:seoul(D1,'21:30')});assert.equal(r.reset,false,'the provisional row is never read as a split');
  assert.equal(s.closes(S).find(x=>x.date===D).close,settled,'overwritten with the settled close');assert.equal(s.progress(S).provisional,D1);assert.equal(s.progress(S).resets,0);
  // A real split (every older row halved) still resets.
  const split=rows(D1,60).map(x=>({...x,close:x.close/2}));assert.equal(s.put(S,split,{day:D1,now:seoul(D1,'22:00')}).reset,true,'older rows differ: a split');
  // U.S. rows are never provisional.
  s.put('NASD:XYZ',rows(D,30),{day:D,now:seoul(D1,'07:00')});assert.equal(s.progress('NASD:XYZ').provisional,null);
  // A page read after 06:00 the next day (the app was closed that evening) is not provisional.
  s.put('990020',rows(D,30),{day:D,now:seoul(D1,'07:00')});assert.equal(s.progress('990020').provisional,null);
});
test('the morning re-read: from 06:00 KST the next day, once; a changed close settles it, an unchanged one stays provisional and still never resets',()=>{
  const db=new DatabaseSync(':memory:');const s=new H.HistoryStore(db);const D='2026-11-24',D1='2026-11-25';const settled=rows(D,60).at(-1).close;
  s.put(S,rows(D,60,{last:settled*1.04}),{day:D,now:seoul(D,'21:30')});s.put('990030',rows(D,60,{last:500}),{day:D,now:seoul(D,'21:30')});
  const reads=[];const R=new H.HistoryRefresher({store:s,set:()=>[S,'990030'],request:async(sym,end)=>{reads.push([sym,end]);return sym===S?rows(D,10):rows(D,10,{last:500});},allowed:()=>({ok:true}),closedDays:()=>new Set(),clock:()=>now});
  let now=seoul(D1,'05:59');assert.deepEqual(R.buildPlan(now).filter(t=>t.kind==='settle'),[],'before 06:00: no morning read');
  now=seoul(D1,'06:20');const plan=R.buildPlan(now);assert.deepEqual(plan.slice(0,2).map(t=>[t.symbol,t.kind,t.end]),[[S,'settle',D],['990030','settle',D]],'each provisional row once, before deeper pages');
  return (async()=>{for(let i=0;i<2;i++){R.tick(now);await R.reading;now+=3000;}
    assert.deepEqual(reads,[[S,D],['990030',D]]);
    assert.equal(s.closes(S).at(-1).close,settled,'the settled close replaces the evening one');assert.equal(s.progress(S).provisional,null,'changed: settled');assert.equal(s.progress(S).resets,0);
    assert.equal(s.progress('990030').provisional,D,'unchanged: still provisional');assert.equal(s.progress('990030').settleTried,D);
    assert.deepEqual(R.buildPlan(now+600000).filter(t=>t.kind==='settle'),[],'read once a day');
    // That night the page settles it at another close: no reset.
    const night=rows(D1,60);const r=s.put('990030',night,{day:D1,now:seoul(D1,'21:30')});assert.equal(r.reset,false);assert.equal(s.progress('990030').provisional,D1);
    // A failed morning read is not repeated that day.
    s.put('990040',rows(D,30),{day:D,now:seoul(D,'21:30')});s.fail('990040',{kind:'settle',day:D,now:seoul(D1,'06:30')});assert.equal(s.progress('990040').settleTried,D);
    const R2=new H.HistoryRefresher({store:s,set:()=>['990040'],request:async()=>[],allowed:()=>({ok:true}),closedDays:()=>new Set()});assert.deepEqual(R2.buildPlan(seoul(D1,'07:00')).filter(t=>t.kind==='settle'),[]);})();
});
test('the repair, once when this build first opens the store: Korean stocks stopped or reset by a moving evening row deepen again',()=>{
  const db=new DatabaseSync(':memory:');
  // A store as an earlier build left it: no provisional column.
  db.exec('CREATE TABLE screen_closes(symbol TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,high REAL,low REAL,volume REAL,value REAL,PRIMARY KEY(symbol,date)) WITHOUT ROWID;CREATE TABLE screen_progress(symbol TEXT PRIMARY KEY,newest TEXT,oldest TEXT,depth INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,readAt INTEGER,failures INTEGER NOT NULL DEFAULT 0,failedAt INTEGER,triedNewest TEXT,triedDeeper TEXT,resets INTEGER NOT NULL DEFAULT 0,resetDay TEXT,resetNights INTEGER NOT NULL DEFAULT 0,stopped TEXT);CREATE TABLE screen_requests(symbol TEXT PRIMARY KEY,at INTEGER NOT NULL);');
  const recent=new Date(Date.now()-3*86400000).toISOString().slice(0,10),old=new Date(Date.now()-60*86400000).toISOString().slice(0,10);
  const ins=db.prepare('INSERT INTO screen_progress(symbol,newest,depth,complete,resets,resetDay,resetNights,stopped,triedDeeper) VALUES(?,?,?,?,?,?,?,?,?)');
  ins.run('990010',recent,100,0,3,recent,3,'the closes KIS gives keep changing between reads',recent);
  ins.run('990020',recent,100,0,1,recent,1,null,recent);
  ins.run('990030',recent,311,1,1,old,1,null,old);
  ins.run('NASD:XYZ',recent,100,0,3,recent,3,'the closes KIS gives keep changing between reads',recent);
  const s=new H.HistoryStore(db);const p=x=>s.progress(x);
  assert.deepEqual([p('990010').stopped,p('990010').resetNights,p('990010').triedDeeper,p('990010').complete],[null,0,null,0],'the stop lifted, deepens from the next window');
  assert.deepEqual([p('990020').triedDeeper,p('990020').complete],[null,0],'reset recently: deepens again');
  assert.deepEqual([p('990030').complete,p('990030').triedDeeper],[1,old],'an old reset, full: untouched');
  assert.equal(p('NASD:XYZ').stopped,'the closes KIS gives keep changing between reads','a U.S. stock is untouched');
  assert.deepEqual(['990010','990020','990030','NASD:XYZ'].map(x=>p(x).provisional),[recent,recent,recent,null],'every Korean newest row from the earlier build is provisional for its first night');
  // Once: a stop made later (a real one) is not lifted when the store opens again.
  db.prepare("UPDATE screen_progress SET stopped='the closes KIS gives keep changing between reads',resetNights=3 WHERE symbol='990020'").run();new H.HistoryStore(db);
  assert.equal(p('990020').stopped,'the closes KIS gives keep changing between reads');
});
test('second review 1: a script that used a provisional close ends with one closing line, outside the output bound; every script that fits without it fits with it; none after the morning read',async()=>{
  const U=require('../electron/screen-universe.cjs');const db=new DatabaseSync(':memory:');const s=new H.HistoryStore(db);const D='2026-11-24';
  s.put(S,rows(D,60),{day:D,now:seoul(D,'21:30')});s.put('990020',rows(D,60),{day:D,now:seoul('2026-11-25','07:00')});
  const deps={db,store:s,clock:()=>seoul('2026-11-25','10:00'),closedDays:()=>new Set(),settings:()=>({perExchange:10}),usSize:{top:()=>({symbols:[]})},own:()=>[]};
  const {ctx}=U.screenContext(deps);assert.equal(ctx.isProvisional(S),true);assert.equal(ctx.isProvisional('990020'),false);
  const CLOSING=`Korean closes of ${D} are provisional: they may include after-hours trades until KIS settles them.`;
  const c=`close("${S}",0)`;
  // The reviewer's scripts: 38 one-value lines (OUTPUT_TOO_LONG at line 30 with a mark per value), 6 lines of six values
  // (stopped at line 5), one line of eight values (past the 200-byte suffix), and a value carried through a name.
  const scripts=[Array.from({length:38},()=>`print(${c})`).join('\n'),Array.from({length:6},()=>`print(${Array(6).fill(c).join(', ')})`).join('\n'),`print(${Array(8).fill(c).join(', ')})`,`x=${c}\nprint(x)\nprint(close("990020",0))`];
  const plain={...ctx,isProvisional:()=>false};// the same run without the label: HEAD's output
  for(const [i,text] of scripts.entries()){const out=await run(text,ctx),base=await run(text,plain);
    assert.equal(out.stopped??null,null,`script ${i+1}: `+JSON.stringify(out.stopped));assert.equal(base.stopped??null,null);
    assert.deepEqual(out.lines.slice(0,-1),base.lines,`script ${i+1}: byte for byte as without the label`);assert.equal(out.lines.at(-1),CLOSING);
    assert.equal(out.lines.filter(l=>String(l).includes('provisional')).length,1,'said once');}
  // A script that uses only settled closes: no line.
  assert.ok(!(await run('print(close("990020",0))',ctx)).lines.some(l=>String(l).includes('provisional')));
  // A script stopped by an error still ends with it, when a provisional close was used before.
  {const out=await run(`print(${c})\nprint(close("990099",0))`,ctx);assert.ok(out.stopped);assert.equal(out.lines.at(-1),CLOSING);}
  // After the morning read was tried for that day (unchanged close: still provisional in the store): no label.
  db.prepare('UPDATE screen_progress SET settleTried=provisional WHERE symbol=?').run(S);const after=U.screenContext(deps).ctx;
  assert.equal(s.progress(S).provisional,D);assert.equal(after.isProvisional(S),false);assert.ok(!(await run(`print(${c})`,after)).lines.some(l=>String(l).includes('provisional')));
});
test('second review 2 and 3: the newest stored row is never compared, whenever read, in both markets; older rows moved beyond 0.5% still reset, at a settle read too, which records the readable day and leaves triedNewest',()=>{
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));const D='2026-11-24',D1='2026-11-25',D2='2026-11-26';
  // Read in the mornings only (after 06:00: not provisional), KIS settling later: D's row moves 4% between reads.
  for(const sym of ['990050','NASD:XYZ']){s.put(sym,rows(D,60,{last:rows(D,60).at(-1).close*1.04}),{day:D,now:seoul(D1,'07:00')});assert.equal(s.progress(sym).provisional,null);
    const r=s.put(sym,rows(D1,60),{day:D1,now:seoul(D2,'07:00')});assert.equal(r.reset,false,sym+': the newest stored row is not compared');assert.equal(s.progress(sym).resets,0);
    assert.equal(s.closes(sym).find(x=>x.date===D).close,rows(D,60).at(-1).close,'overwritten');}
  // Third review: a newest page whose only overlap is the stored newest row. With older rows stored (the app away about a
  // page's length, a split meanwhile), it counts as no overlap: reset, the page kept, then deepened on one basis. With no
  // older row stored, no reset. Both markets.
  for(const sym of ['990060','NASD:XYV']){
    const old=rows('2026-07-01',120);s.put(sym,old,{day:'2026-07-01',now:seoul('2026-07-02','07:00')});
    // ~99 trading days later, a page starting exactly on the stored newest row, everything halved (a split while away).
    const later=[];for(let d='2026-07-01';later.length<99;d=day(d,1)){const w=new Date(d+'T00:00:00Z').getUTCDay();if(w===0||w===6)continue;const c=1000+(Date.parse(d)-Date.parse('2026-01-01'))/86400000;later.push({date:d,close:c/2,high:c/2+1,low:c/2-1,volume:1,value:c});}
    const end=later.at(-1).date;const r=s.put(sym,later,{day:end,now:seoul(day(end,1),'07:00')});assert.equal(r.reset,true,sym+': the only overlap is the newest row, older rows stored: a reset');
    let p=s.progress(sym);assert.deepEqual([p.depth,p.oldest,p.newest,p.complete],[99,'2026-07-01',end,0],sym+': the page kept, to deepen again');
    // Deepened the next night: the older page on the new basis (halved), overlapping five stored rows.
    const deeperEnd=s.deeperEnd(sym);const older=[];for(let d=deeperEnd;older.length<60;d=day(d,-1)){const w=new Date(d+'T00:00:00Z').getUTCDay();if(w===0||w===6)continue;const c=1000+(Date.parse(d)-Date.parse('2026-01-01'))/86400000;older.unshift({date:d,close:c/2,high:c/2+1,low:c/2-1,volume:1,value:c});}
    const r2=s.put(sym,older,{kind:'deeper',day:day(end,1),now:seoul(day(end,2),'07:00')});assert.equal(r2.reset,false,sym+': deepened');
    const all=s.closes(sym);assert.ok(all.length>99);assert.ok(all.every(x=>Math.abs(x.close-(1000+(Date.parse(x.date)-Date.parse('2026-01-01'))/86400000)/2)<1e-9),sym+': every row on one basis');
    // A stock with one stored row: that row is the only overlap and nothing older is stored: no reset.
    const one=sym==='990060'?'990061':'NASD:XYU';s.put(one,rows(D,1),{day:D,now:seoul(D,'21:30')});const r3=s.put(one,[{...rows(D,1)[0],close:1},...rows(D1,1)],{day:D1,now:seoul(D1,'21:30')});assert.equal(r3.reset,false,one+': one stored row: no reset');}
  // A one-row settle page (the morning re-read) is not judged by it.
  {s.put('990062',rows(D,30),{day:D,now:seoul(D,'21:30')});const r=s.put('990062',[rows(D,30).at(-1)],{kind:'settle',day:D,readable:D,now:seoul(D1,'06:30')});assert.equal(r.reset,false);}
  // Older rows moved by more than 0.5% reset (a split or a correction), in both markets.
  for(const sym of ['990070','NASD:XYW']){s.put(sym,rows(D,60),{day:D,now:seoul(D,'21:30')});const moved=rows(D1,60).map((x,i,a)=>i<a.length-2?{...x,close:x.close*1.01}:x);assert.equal(s.put(sym,moved,{day:D1,now:seoul(D1,'21:30')}).reset,true,sym);}
  // At a settle read: the reset records the night's readable day, and triedNewest is left as it was.
  {s.put('990080',rows(D,60),{day:D,now:seoul(D,'21:30')});assert.equal(s.progress('990080').provisional,D);const tried=s.progress('990080').triedNewest;
    const split=rows(D,60).map((x,i,a)=>i<a.length-1?{...x,close:x.close/2}:x);const r=s.put('990080',split,{kind:'settle',day:D,readable:D1,now:seoul(D1,'06:30')});
    assert.equal(r.reset,true,'older rows halved: a split, at a settle read too');const p=s.progress('990080');assert.equal(p.resetDay,D1,'the readable day');assert.equal(p.triedDeeper,D1);assert.equal(p.triedNewest,tried);}
  // A settle read with no reset leaves triedNewest as well, and the refresher passes the readable day.
  {s.put('990090',rows(D,60),{day:D,now:seoul(D,'21:30')});const before=s.progress('990090').triedNewest;s.put('990090',rows(D,10),{kind:'settle',day:D,readable:D,now:seoul(D1,'06:30')});assert.equal(s.progress('990090').triedNewest,before);
    const R=new H.HistoryRefresher({store:s,set:()=>['990090'],request:async()=>[],allowed:()=>({ok:true}),closedDays:()=>new Set()});s.db.prepare('UPDATE screen_progress SET settleTried=NULL').run();
    const t=R.buildPlan(seoul(D1,'06:30')).find(x=>x.kind==='settle');assert.deepEqual([t.day,t.readable],[D,D]);}
});
