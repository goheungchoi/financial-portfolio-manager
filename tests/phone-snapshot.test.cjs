const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const P=require('../electron/phone-snapshot.cjs');const {Notifications}=require('../electron/notifications.cjs');
const portfolio={totals:{KRW:10500000,USD:null,equityKRW:null},cash:{KRW:2100000,USD:null},fx:null,rows:[{symbol:'005930',name:'Samsung Electronics',price:70000,cost:60000,quantity:60,valueKRW:4200000},{symbol:'105560',name:'KB Financial',price:84000,cost:90000,quantity:50,valueKRW:4200000}]};
const daily=[{day:'2026-10-15',value:10000000},{day:'2026-10-16',value:10200000}];
const intraday=[{at:Date.parse('2026-10-19T00:05:00Z'),equity:10200000},{at:Date.parse('2026-10-19T01:00:00Z'),equity:10500000}];
test('intraday samples are throttled to one per two minutes and kept for three days',()=>{
  const store=new P.IntradayValues(new DatabaseSync(':memory:'));const t=Date.now();
  assert.equal(store.record('acct',100,t),true);assert.equal(store.record('acct',101,t+60000),false);assert.equal(store.record('acct',102,t+130000),true);assert.equal(store.record('acct',NaN,t+400000),false);
  assert.deepEqual(store.day('acct').map(r=>r.equity),[100,102]);
});
test('figures show amounts or only percentages, with today against the previous day',()=>{
  const prev={'005930':68000,'105560':85000};const shown=P.portfolioFigures({portfolio,daily,intraday,previousClose:s=>prev[s],amounts:true,today:'2026-10-19'});
  assert.ok(Math.abs(shown.todayPct-2.941)<0.01);assert.match(shown.fields[0].value,/₩10,500,000 · \+2\.94% today/);assert.match(shown.fields[1].value,/₩2,100,000 · 20\.0%/);
  assert.match(shown.fields[2].value,/Samsung Electronics \+2\.94% today · 40%/);assert.deepEqual(shown.chart.today.v,[10200000,10500000]);
  const hidden=P.portfolioFigures({portfolio,daily,intraday,previousClose:s=>prev[s],amounts:false,today:'2026-10-19'});
  assert.ok(!hidden.fields.some(f=>/₩/.test(f.value)),'no won amounts');assert.equal(hidden.chart.days.v[0],0);assert.ok(Math.abs(hidden.chart.days.v[1]-2)<1e-9);assert.equal(hidden.chart.label,'% change');
});
test('a trade snapshot names the fill and carries the reason, plan and agent state',()=>{
  const figures=P.portfolioFigures({portfolio,daily,intraday,amounts:true,today:'2026-10-19'});
  const review={id:'r1',proposalId:'o1',trigger:'Scheduled review',decision:{action:'Buy',symbol:'005930',quantity:3,explanation:'Memory prices are recovering.',plan:{stopPrice:65000,targetPrice:80000,horizonDays:20,confidence:0.6,invalidation:'HBM orders slip.'}}};
  const order={id:'o1',source:'kis',environment:'mock',status:'Filled',side:'Buy',filled:3,quantity:3,symbol:'005930',fillPrice:70000};
  const s=P.tradeSnapshot({order,review,figures,regime:'neutral',conditional:2,name:'Samsung Electronics'});
  assert.equal(s.id,'fill:o1:Filled:3');assert.equal(s.title,'Bought 3 Samsung Electronics @ ₩70,000');
  assert.deepEqual(s.fields.map(f=>f.name),['Portfolio','Cash','Holdings','Trade plan','Agent']);assert.match(s.fields[4].value,/MOCK account · Regime neutral · 2 conditional orders armed/);
  assert.match(s.text,/^Bought 3 Samsung Electronics @ ₩70,000 \(\d\d:\d\d KST\)\nMemory prices/);assert.ok(s.text.length<=1500);
  const e=P.discordEmbed(s);assert.equal(e.fields.length,5);assert.ok(e.footer.text.includes('KST'));assert.equal(e.color,0x66d9c0);
  const sold=P.tradeSnapshot({order:{...order,id:'o2',side:'Sell',status:'Partially filled',filled:1,reason:'Stop-loss conditional order.'},figures,name:'Samsung Electronics'});
  assert.equal(sold.title,'Sold 1/3 Samsung Electronics @ ₩70,000');assert.match(sold.description,/^Stop-loss conditional order\.\nPartly filled so far\./);assert.equal(sold.color,0xd96c6c);assert.ok(!sold.fields.some(f=>f.name==='Trade plan'));
});
test('completed fills become snapshots in place of one-line phone alerts; partial fills and other updates stay alerts',async()=>{
  const db=new DatabaseSync(':memory:');let config={mobileAlerts:true,desktopAlerts:false,pushConnected:true};const n=new Notifications(db,{request:async()=>({})},()=>config,()=>{});
  const fills=[];n.onFill=o=>{fills.push(o.status);return true;};const at=Date.now()+1000;const o={id:'o1',source:'paper',createdAt:at,side:'Buy',symbol:'A',filled:0,quantity:2};
  n.observe([{...o,status:'Accepted'}]);n.observe([{...o,status:'Partially filled',filled:1}]);n.observe([{...o,status:'Filled',filled:2}]);n.observe([{...o,id:'o2',status:'Rejected'}]);
  assert.deepEqual(fills,['Filled']);assert.deepEqual(n.status().map(r=>r.id).sort(),['o1:Accepted','o1:Partially filled','o2:Rejected']);
  n.onFill=()=>false;n.observe([{...o,id:'o3',status:'Filled',filled:2}]);assert.ok(n.status().some(r=>r.id==='o3:Filled'),'falls back to a one-line alert when snapshots are off');
});
test('snapshots go only to the webhook, with the chart drawn at send time and text only when stale',async()=>{
  const db=new DatabaseSync(':memory:');const sent=[],desktop=[];let config={mobileAlerts:true,desktopAlerts:true,pushConnected:true};
  const n=new Notifications(db,{request:async(op,payload)=>{sent.push([op,payload]);return {delivered:true};}},()=>config,m=>desktop.push(m));n.render=async spec=>'PNG:'+spec.label;
  const figures=P.portfolioFigures({portfolio,daily,intraday,amounts:true});
  assert.equal(n.post(P.testSnapshot({figures})),true);await n.tick();
  assert.equal(sent.length,1);assert.equal(sent[0][1].image,'PNG:KRW');assert.equal(sent[0][1].embed.title,'Test snapshot');assert.equal(desktop.length,0,'no desktop alert');
  n.post(P.testSnapshot({figures,now:Date.now()-3600000}));await n.tick();assert.equal(sent[1][1].image,undefined,'stale snapshots skip the chart');assert.ok(sent[1][1].embed);
  n.render=async()=>{throw new Error('no window');};n.post(P.testSnapshot({figures,now:Date.now()+1}));await n.tick();assert.equal(sent[2][1].image,undefined,'a failed drawing still sends the post');
  config={...config,mobileAlerts:false};assert.equal(n.post(P.testSnapshot({figures,now:Date.now()+2})),false);
});
test('the engine accepts the snapshot settings',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{throw new Error('no AI');}},()=>{});
  a.configure({phoneSnapshots:false,phoneAmounts:false});assert.equal(a.config.phoneSnapshots,false);assert.throws(()=>a.configure({phoneAmounts:'yes'}),/INVALID_SETTINGS/);
});
test('Discord webhooks get an embed with the chart attached; other webhooks get text; mentions are off',async()=>{
  const hook='https://discord.com/api/webhooks/1/abc';const r=P.pushRequest(hook,{message:'hi @everyone',embed:{title:'T'},image:Buffer.from('png').toString('base64')});
  assert.equal(r.discord,true);assert.equal(r.headers,undefined);const payload=JSON.parse(r.body.get('payload_json'));
  assert.deepEqual(payload.allowed_mentions,{parse:[]});assert.equal(payload.embeds[0].image.url,'attachment://portfolio.png');const file=r.body.get('files[0]');assert.equal(file.name,'portfolio.png');assert.equal(Buffer.from(await file.arrayBuffer()).toString(),'png');
  const plain=P.pushRequest(hook,{message:'hi'});assert.deepEqual(JSON.parse(plain.body),{content:'hi',allowed_mentions:{parse:[]}});
  const slack=P.pushRequest('https://hooks.slack.com/services/x',{message:'hi',embed:{title:'T'}});assert.equal(slack.discord,false);assert.deepEqual(JSON.parse(slack.body),{content:'hi',text:'hi'});
  assert.equal(P.pushRequest('https://discord.com.evil.test/api/webhooks/1/a',{message:'x',embed:{}}).discord,false);
});
test('alerts still queued after 12 hours expire unsent',async()=>{
  const db=new DatabaseSync(':memory:');const sent=[];const n=new Notifications(db,{request:async(op,p)=>{sent.push(p.message);return {};}},()=>({mobileAlerts:true,desktopAlerts:false,pushConnected:true}),()=>{});
  n.notify('digest:old','Old digest');db.prepare('UPDATE notification_outbox SET createdAt=?,nextAt=? WHERE id=?').run(Date.now()-13*3600000,Date.now()-13*3600000,'digest:old');
  n.notify('digest:new','New digest');await n.tick();await n.tick();
  assert.deepEqual(sent,['New digest']);assert.equal(n.status().find(r=>r.id==='digest:old').attempts,99);
});
test('the digest falls back to recorded account values when no trading session is on',()=>{
  const {buildDigest}=require('../electron/daily-digest.cjs');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');
  const a={db,config:{scope:'kis'},paper:{orders:()=>[]},live:{getState:()=>({loss:null}),orders:()=>[]},usLive:null,guardrails:{eventsOn:()=>[],failuresOn:()=>0},
    accountValues:()=>[{market:'KR',currency:'KRW',label:'Korea',equity:10288754,baseline:10291800},{market:'US',currency:'USD',label:'U.S.',equity:100,baseline:100}]};
  const d=buildDigest(a);assert.equal(d.markets.length,1,'U.S. is outside the Korea scope');assert.match(d.text,/Korea ₩10,288,754 \(-₩3,046, -0\.03% today\)/);
  assert.match(buildDigest({...a,accountValues:()=>[]}).text,/No account valuation/);
});
