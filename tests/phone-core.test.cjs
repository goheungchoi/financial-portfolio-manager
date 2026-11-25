// Phone control P1 (artifacts/reviews/2026-11-25-phone-control): the command core with no network. Made-up ids, PIN and
// tokens only (the repository is public); interaction ids are built from chosen times as Discord builds them.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const P=require('../electron/phone-core.cjs');
const EPOCH=1420070400000n;let seq=0n;
const idAt=t=>String(((BigInt(Math.round(t))-EPOCH)<<22n)|(seq++&4095n));
const allow={user:'100000000000000001',server:'100000000000000002',channel:'100000000000000003',application:'100000000000000004'};
const PIN='482913',BOT_TOKEN='MTAwMDAwMDAwMDAwMDAwMDA0.FAKE.made-up-bot-token',INTERACTION_TOKEN='aW50ZXJhY3Rpb246bWFkZS11cA-made-up';
function core(now=1795600000000){const db=new DatabaseSync(':memory:');let t=now;const c=new P.PhoneCore(db,{allow,clock:()=>t});return {c,db,set:v=>{t=v;},get now(){return t;}};}
const cmd=(k,name,extra={})=>({id:idAt(k.now),type:2,applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user,command:name,options:[],token:INTERACTION_TOKEN,...extra});
// Since the P5 review every PIN command goes summary, button, PIN form: this takes one to its PIN form and gives the nonce.
const confirmed=(k,name,options=[],held={shown:'x'})=>{const s=k.c.accept(cmd(k,name,{options}));k.c.attach(s.act.nonce,held);const b=k.c.accept({...cmd(k,name),type:3,customId:'start-confirm:'+s.act.nonce,command:undefined});assert.equal(b.act.step,'ask-pin');return s.act.nonce;};

test('the snowflake gives Discord\'s time; ids are checked',()=>{
  assert.equal(P.snowflakeTime(idAt(1795600000000)),1795600000000);assert.equal(P.snowflakeTime('abc'),null);assert.equal(P.snowflakeTime('12'),null);
});

test('only the one user, server, channel and application; anything else gets no answer',()=>{
  const k=core();
  for(const [f,v] of [['userId','100000000000000099'],['serverId','100000000000000099'],['channelId','100000000000000099'],['applicationId','100000000000000099']]){
    const r=k.c.accept(cmd(k,'status',{[f]:v}));assert.equal(r.silent,true,f);assert.match(r.why,/^not-/);}
  assert.deepEqual(k.c.accept(cmd(k,'status')),{act:{command:'status',step:'run',options:{}}});
  for(const bad of [null,'x',{type:2},{id:'not-a-snowflake',type:2}])assert.equal(k.c.accept(bad).silent,true);
});

test('each interaction id once; repeats get no answer',()=>{
  const k=core();const x=cmd(k,'stop');assert.equal(k.c.accept(x).act.command,'stop');assert.deepEqual(k.c.accept(x),{silent:true,why:'repeat'});
  const k2=new P.PhoneCore(k.db,{allow,clock:()=>k.now});assert.equal(k2.accept(x).why,'repeat','the seen ids survive a restart');
});

test('the age rule: older than 60 s or more than 60 s ahead is refused with its sentence; three in a row flag the clock',()=>{
  const k=core();const late=cmd(k,'status');k.set(k.now+61000);
  assert.deepEqual(k.c.accept(late),{reply:P.SENTENCES.old,why:'old'});
  const ahead={...cmd(k,'status'),id:idAt(k.now+61000)};assert.deepEqual(k.c.accept(ahead),{reply:P.SENTENCES.future,why:'future'});
  assert.equal(k.c.clockSuspect,false);const third={...cmd(k,'status'),id:idAt(k.now+90000)};k.c.accept(third);assert.equal(k.c.clockSuspect,true,'three in a row');
  const ok=cmd(k,'status');assert.equal(k.c.accept(ok).act.command,'status');assert.equal(k.c.ageRun,0,'a good one resets the run');
  const edge=cmd(k,'status');k.set(k.now+60000);assert.equal(k.c.accept(edge).act.command,'status','exactly 60 s is still accepted');
});

test('a Start that arrives 5 minutes late (after sleep or a resume) is refused and nothing is held',()=>{
  const k=core();k.c.setPin(PIN);const late=cmd(k,'start');k.set(k.now+5*60000);
  assert.deepEqual(k.c.accept(late),{reply:P.SENTENCES.old,why:'old'});assert.equal(k.c.pending.size,0);
});

test('Start: a summary step holding a nonce, the confirm button asks for the PIN, the right PIN runs it with what was held',()=>{
  const k=core();k.c.setPin(PIN);const s=k.c.accept(cmd(k,'start'));assert.equal(s.act.step,'summary');assert.match(s.act.nonce,/^[a-f0-9]{32}$/);
  k.c.attach(s.act.nonce,{launchToken:'held-token'});
  const button=k.c.accept({...cmd(k,'start'),type:3,customId:'start-confirm:'+s.act.nonce,command:undefined});assert.deepEqual(button,{act:{command:'start',step:'ask-pin',nonce:s.act.nonce,options:{}}});
  const run=k.c.accept({...cmd(k,'start'),type:5,customId:'pin:'+s.act.nonce,command:undefined,pin:PIN});
  assert.deepEqual(run,{act:{command:'start',step:'run',options:{},held:{launchToken:'held-token'}}});assert.ok(!JSON.stringify(run).includes(PIN),'the PIN is dropped');
  assert.equal(k.c.accept({...cmd(k,'start'),type:5,customId:'pin:'+s.act.nonce,command:undefined,pin:PIN}).why,'expired','once');
});

test('the 2-minute hold; the lost-order fixes show the order first (P5 review) with their options checked; the button is a gate',()=>{
  const k=core();k.c.setPin(PIN);const l=k.c.accept(cmd(k,'link',{options:[{name:'order',value:'A1b2-c3'},{name:'number',value:'0001234567'}]}));
  assert.equal(l.act.step,'summary');assert.deepEqual(l.act.options,{order:'A1b2-c3',number:'0001234567'});k.c.attach(l.act.nonce,{orderId:'o',market:'KR',shown:'x'});
  {const k2=core();k2.c.setPin(PIN);const l2=k2.c.accept(cmd(k2,'nottaken',{options:[{name:'order',value:'A1'}]}));k2.c.attach(l2.act.nonce,{shown:'x'});
    assert.equal(k2.c.accept({...cmd(k2,'x'),type:5,customId:'pin:'+l2.act.nonce,command:undefined,pin:PIN}).why,'expired','a PIN form before the button');assert.equal(k2.c.pinState().wrong,0,'no PIN checked');
    const l3=k2.c.accept(cmd(k2,'nottaken',{options:[{name:'order',value:'A1'}]}));assert.equal(k2.c.accept({...cmd(k2,'x'),type:3,customId:'start-confirm:'+l3.act.nonce,command:undefined}).why,'expired','a button with nothing attached');}
  k.set(k.now+121000);assert.equal(k.c.accept({...cmd(k,'link'),type:5,customId:'pin:'+l.act.nonce,command:undefined,pin:PIN}).why,'expired');
  assert.equal(k.c.accept(cmd(k,'link',{options:[{name:'order',value:'x y'},{name:'number',value:'1'}]})).silent,true,'bad options');
  assert.equal(k.c.accept(cmd(k,'nottaken',{options:[{name:'order',value:'A1'}]})).act.step,'summary');
  assert.deepEqual(k.c.accept(cmd(k,'sell')),{reply:P.SENTENCES.unknown,why:'unknown'});
});

test('the PIN: 6 to 12 digits, a salted scrypt hash, 5 wrong entries lock it until the desktop unlocks; Stop and Status still work',()=>{
  const k=core();assert.throws(()=>k.c.setPin('12345'),/INVALID_PIN/);assert.throws(()=>k.c.setPin('abcdef'),/INVALID_PIN/);
  assert.equal(k.c.accept(cmd(k,'start')).why,'noPin');k.c.setPin(PIN);
  const s=JSON.parse(k.db.prepare('SELECT payload FROM phone_pin').get().payload);assert.equal(s.params.N,32768);assert.ok(!JSON.stringify(s).includes(PIN));
  const other=core();other.c.setPin(PIN);assert.notEqual(JSON.parse(other.db.prepare('SELECT payload FROM phone_pin').get().payload).hash,s.hash,'salted');
  const ask=()=>{k.set(k.now+25000);return confirmed(k,'nottaken',[{name:'order',value:'A1'}]);};
  for(let i=1;i<=4;i++)assert.equal(k.c.accept({...cmd(k,'x'),type:5,customId:'pin:'+ask(),command:undefined,pin:'000000'}).why,'wrongPin',String(i));
  const fifth=k.c.accept({...cmd(k,'x'),type:5,customId:'pin:'+ask(),command:undefined,pin:'000000'});assert.deepEqual([fifth.why,fifth.justLocked],['locked',true]);
  k.set(k.now+61000);assert.equal(k.c.accept(cmd(k,'start')).why,'locked');assert.equal(k.c.accept(cmd(k,'stop')).act.command,'stop');assert.equal(k.c.accept(cmd(k,'status')).act.command,'status');
  k.c.unlock();const n=ask();assert.equal(k.c.accept({...cmd(k,'x'),type:5,customId:'pin:'+n,command:undefined,pin:PIN}).act.step,'run');
  // A right PIN resets the count.
  assert.equal(JSON.parse(k.db.prepare('SELECT payload FROM phone_pin').get().payload).wrong,0);
});

test('at most 10 commands a minute are acted on',()=>{
  const k=core();for(let i=0;i<10;i++)assert.equal(k.c.accept(cmd(k,'status')).act.command,'status');
  assert.equal(k.c.accept(cmd(k,'status')).why,'busy');k.set(k.now+60001);assert.equal(k.c.accept(cmd(k,'status')).act.command,'status');
});

test('nothing secret is kept: the PIN, the tokens and the ids are in no record, no state and no returned object',()=>{
  const k=core();k.c.setPin(PIN);const out=[];
  const s=k.c.accept(cmd(k,'start'));out.push(s);out.push(k.c.accept({...cmd(k,'start'),type:5,customId:'pin:'+s.act.nonce,command:undefined,pin:'999999'}));
  out.push(k.c.accept({...cmd(k,'status'),userId:'100000000000000099'}));out.push(k.c.accept(cmd(k,'status')));
  const tables=['phone_commands','phone_pin','phone_seen'].map(t=>JSON.stringify(k.db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
  const everything=JSON.stringify(out)+tables+JSON.stringify(k.c.records())+JSON.stringify([...k.c.pending.values()]);
  for(const secret of [PIN,'999999',BOT_TOKEN,INTERACTION_TOKEN,allow.user,allow.server,allow.channel,allow.application])assert.ok(!everything.includes(secret),'leaked: '+secret.slice(0,4));
  assert.deepEqual(k.c.records().map(r=>Object.keys(r).sort()),k.c.records().map(()=>['at','command','result']));
});

// Review of P1: five changes.
test('review 1: every id is a snowflake string before any comparison; a malformed allow-list accepts nothing',()=>{
  for(const bad of [[allow.user],{toString:()=>allow.user},100000000000000001,' '+allow.user,allow.user+' ',null,undefined]){
    const k=core();const r=k.c.accept(cmd(k,'stop',{userId:bad}));assert.deepEqual(r,{silent:true,why:'shape'},String(typeof bad));}
  const k=core();assert.equal(k.c.accept(cmd(k,'stop',{id:[idAt(k.now)]})).why,'shape','the interaction id too');
  for(const broken of [{...allow,user:undefined},{...allow,server:'12'},{...allow,channel:[allow.channel]},null]){
    const db=new DatabaseSync(':memory:');const c=new P.PhoneCore(db,{allow:broken,clock:()=>1795600000000});
    assert.deepEqual(c.accept({...cmd({now:1795600000000},'stop')}),{silent:true,why:'not-configured'});}
});

test('review 2: once-only fails closed: a seen table that cannot be read or written acts on nothing; an unwritable wrong-PIN count fails the check',()=>{
  const k=core();const x=cmd(k,'stop');const prep=k.db.prepare.bind(k.db);
  k.db.prepare=sql=>{if(/phone_seen/.test(sql))throw new Error('disk');return prep(sql);};
  assert.deepEqual(k.c.accept(x),{reply:P.SENTENCES.unrecorded,why:'unrecorded'});assert.deepEqual(k.c.accept(x),{reply:P.SENTENCES.unrecorded,why:'unrecorded'},'never acted on twice');
  k.db.prepare=sql=>{if(/INSERT INTO phone_seen/.test(sql))throw new Error('disk');return prep(sql);};assert.equal(k.c.accept(cmd(k,'stop')).why,'unrecorded','read works, write fails');
  k.db.prepare=prep;const p=core();p.c.setPin(PIN);const n=confirmed(p,'nottaken',[{name:'order',value:'A1'}]);const pp=p.db.prepare.bind(p.db);
  p.db.prepare=sql=>{if(/INSERT INTO phone_pin/.test(sql))throw new Error('disk');return pp(sql);};
  assert.equal(p.c.accept({...cmd(p,'x'),type:5,customId:'pin:'+n,command:undefined,pin:'000000'}).why,'unrecorded','the wrong entry could not be counted: the check fails');
});

test('review 3: the record keeps the last 1,000 rows; silent refusals once a minute with the others counted; the held commands are pruned and capped',()=>{
  const k=core();for(let i=0;i<5;i++)k.c.accept(cmd(k,'status',{userId:'100000000000000099'}));
  assert.equal(k.c.records().filter(r=>r.result==='not-user').length,1,'one row in the minute');k.set(k.now+61000);k.c.accept(cmd(k,'status',{userId:'100000000000000099'}));
  assert.deepEqual(k.c.records()[0],{at:k.now,command:'-',result:'not-user',alsoRefused:4});
  for(let i=0;i<1100;i++)k.c.record({command:'status',result:'run'});assert.equal(k.db.prepare('SELECT COUNT(*) n FROM phone_commands').get().n,P.RECORD_KEEP);
  const h=core();h.c.setPin(PIN);const first=h.c.hold('start',{});h.set(h.now+121000);h.c.hold('start',{});assert.ok(!h.c.pending.has(first),'expired dropped on hold');
  for(let i=0;i<30;i++)h.c.hold('link',{order:'A'+i,number:'1'});assert.equal(h.c.pending.size,P.PENDING_MAX);
});

test('review 4: a nonce answers only its own step: start-confirm as a button for a held Start, pin as a form; a Start with no launch token never runs',()=>{
  const k=core();k.c.setPin(PIN);const s=k.c.accept(cmd(k,'start'));const n=s.act.nonce;
  const sub=(type,prefix,extra={})=>k.c.accept({...cmd(k,'start'),type,customId:prefix+':'+n,command:undefined,...extra});
  assert.equal(sub(3,'start-confirm').why,'expired','no launch token attached yet: no PIN form');
  k.c.attach(n,{launchToken:'t'});
  assert.deepEqual(sub(5,'start-confirm',{pin:PIN}),{silent:true,why:'shape'},'start-confirm as a form');
  assert.deepEqual(sub(3,'pin'),{silent:true,why:'shape'},'pin as a button');
  assert.equal(sub(3,'start-confirm').act.step,'ask-pin');assert.equal(sub(5,'pin',{pin:PIN}).act.step,'run');
  const l=k.c.accept(cmd(k,'link',{options:[{name:'order',value:'A1'},{name:'number',value:'1'}]})).act.nonce;
  assert.equal(k.c.accept({...cmd(k,'x'),type:3,customId:'start-confirm:'+l,command:undefined}).why,'expired','a confirm button only for a held Start');
  const s2=k.c.accept(cmd(k,'start')).act.nonce;assert.equal(k.c.accept({...cmd(k,'x'),type:5,customId:'pin:'+s2,command:undefined,pin:PIN}).why,'expired','a held Start without its token never comes out as run');
  assert.equal(k.c.pending.has(s2),false,'and it is gone');
});
