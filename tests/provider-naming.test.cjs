// Provider naming, P1 (artifacts/reviews/2026-11-24-provider-naming: note.md and the planner's rulings; the user: "Please
// fix this as well please."). A review record said provider "openai" for any AI decision, Claude's included. From P1 an
// AI decision is "ai" with its company in vendor; old records are read the same way and never rewritten. The start
// token, the request bodies, the dry-run gate and both instruction fingerprints do not move. Made-up data.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const path=require('node:path');
const N=require('../electron/decision-names.cjs');const PINS=require('./fixtures/provider-naming-pins.cjs');
const ROOT=path.join(__dirname,'..');
test('an old record reads as what it was: provider openai with a Claude model is an AI decision by Anthropic; nothing names a company it cannot know',()=>{
  assert.deepEqual(N.readRecord({id:'R1',provider:'openai',model:'claude-opus-5-5'}),{id:'R1',provider:'ai',model:'claude-opus-5-5',vendor:'anthropic'});
  assert.deepEqual(N.readRecord({id:'R2',provider:'openai',vendor:'anthropic',model:'claude-opus-5-5'}),{id:'R2',provider:'ai',model:'claude-opus-5-5',vendor:'anthropic'});
  assert.equal(N.readRecord({provider:'openai',model:'gpt-6-sol'}).vendor,'openai');
  assert.equal('vendor' in N.readRecord({provider:'openai',model:'some-future-model'}),false,'no recognisable model and no vendor: no company');assert.equal('vendor' in N.readRecord({provider:'openai'}),false);
  for(const p of ['local','external'])assert.deepEqual(N.readRecord({provider:p,model:null}),{provider:p,model:null},p+': as it is');
  assert.equal(N.decisionMakerOf('openai'),'ai');assert.equal(N.decisionMakerOf('ai'),'ai');assert.equal(N.decisionMakerOf('local'),'local');assert.equal(N.isAi('openai'),true);assert.equal(N.isAi('external'),false);
});
test('both clients return an AI decision as "ai"; no source still stamps a result "openai"',()=>{
  const fs=require('node:fs');for(const f of ['ai-client.cjs','anthropic-client.cjs']){const s=fs.readFileSync(path.join(ROOT,'electron',f),'utf8');assert.doesNotMatch(s,/provider:'openai'/,f);assert.match(s,/provider:'ai'/,f);}
});
// The review history (Home, the Journal, the export, the runtime brief) reads old and new rows alike.
test('the review history, the runtime brief and the export read an old Claude record as Claude and an old GPT record as OpenAI',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const put=r=>db.prepare('INSERT INTO reviews(id,payload) VALUES(?,?)').run(r.id,JSON.stringify(r));
  put({id:'OLD-C',timestamp:1,provider:'openai',model:'claude-opus-5-5',decision:{action:'Hold'}});put({id:'OLD-G',timestamp:2,provider:'openai',vendor:'openai',model:'gpt-6-sol',decision:{action:'Hold'}});
  put({id:'NEW-C',timestamp:3,provider:'ai',vendor:'anthropic',model:'claude-opus-5-5',decision:{action:'Hold'}});put({id:'RULES',timestamp:4,provider:'local',model:null,decision:{action:'Hold'}});
  const rows=a.reviewHistory(10,true);const by=id=>rows.find(r=>r.id===id);
  assert.deepEqual([by('OLD-C').provider,by('OLD-C').vendor],['ai','anthropic']);assert.deepEqual([by('OLD-G').provider,by('OLD-G').vendor],['ai','openai']);
  assert.deepEqual([by('NEW-C').provider,by('NEW-C').vendor],['ai','anthropic']);assert.equal(by('RULES').provider,'local');
  const brief=require('../electron/runtime-state.cjs').briefReview(by('OLD-C'));assert.equal(brief.provider,'ai');assert.equal(brief.vendor,'anthropic');
  // The export writes getState().reviews, which is this history.
  assert.match(require('node:fs').readFileSync(path.join(ROOT,'electron','main.cjs'),'utf8'),/reviews:automation\.getState\(\)\.reviews/);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM reviews WHERE id='OLD-C'").get().payload).provider,'openai','the stored row is not rewritten');
});
test('replay takes old and new AI records; the scoreboard records an AI decision as ai',()=>{
  const fs=require('node:fs');assert.match(fs.readFileSync(path.join(ROOT,'electron','replay.cjs'),'utf8'),/if\(!require\('\.\/decision-names\.cjs'\)\.isAi\(r\.provider\)\)continue/);
  assert.match(fs.readFileSync(path.join(ROOT,'electron','scoreboard.cjs'),'utf8'),/provider:require\('\.\/decision-names\.cjs'\)\.decisionMakerOf\(review\.provider\)/);
});
test('the Journal names the company from vendor, and says AI when it cannot know; never OpenAI for a Claude decision',()=>{
  const s=require('node:fs').readFileSync(path.join(ROOT,'src','JournalView.tsx'),'utf8');
  assert.match(s,/const PROVIDER:Record<string,string>=\{local:'Local rules',ai:'AI',openai:'AI',external:'External agent'\};/);assert.match(s,/const VENDOR:Record<string,string>=\{anthropic:'Claude',openai:'OpenAI'\};/);
  assert.match(s,/\{VENDOR\[\(review as \{vendor\?:string\}\)\.vendor\?\?''\]\?\?PROVIDER\[review\.provider\]\?\?review\.provider\}/);
});
test('a dry run records its model\'s company; the dry-run gate still reads the model id and the fingerprint',()=>{
  const s=require('node:fs').readFileSync(path.join(ROOT,'electron','automation.cjs'),'utf8');
  assert.match(s,/review=\{model:model\.openaiModel,vendor:require\('\.\/decision-names\.cjs'\)\.vendorOfModel\(model\.openaiModel\),effort:/);
  assert.equal(N.vendorOfModel('claude-opus-5-5'),'anthropic');assert.equal(N.vendorOfModel('gpt-6-sol'),'openai');assert.equal(N.vendorOfModel('nope'),null);
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'cef9f646decfa59a');assert.equal(RI.fingerprint(undefined,{orders:true}),'c9ff8de188f65b22');
});
test('pins: the start token of a fixed configuration and each client\'s request body are as before P1 (computed on 3f1a720b..f7698d1f)',async()=>{
  assert.deepEqual(PINS.startToken(ROOT),{token:'0bb210a088bf48a862bea2630c5e658c7eaae3607d8cfcac2a2d54a156cc2487',config:'4eb88e1b40c61b4f'});
  // The risk-off text ('review 2026-11-25.3') changed the instructions both bodies carry: the pins taken before it were
  // openai dfc4223814d360cb, claude 6c2985ba7acc7046; ai-models-vendor and claude-context-cache put the sentence back and
  // still compare every other byte.
  assert.deepEqual(await PINS.requestBodies(ROOT),{openai:'1f80fff93c755c6a',claude:'c5984315b1712590'});// '.3': 5edbc9cef56a995e / 6e179352ff3af321 before; '.2': eecdf1e0b7ea608a / 8f6cd7b5692119ff before
});
// ---- P2: the settings read through true-named accessors; one source for "which company" on every screen.
test('P2: decisionMaker reads the stored setting exactly as the old comparisons did; nothing compares the setting with "openai" any more',()=>{
  const AM=require('../electron/ai-models.cjs');
  assert.equal(AM.decisionMaker({provider:'openai'}),'ai');assert.equal(AM.decisionMaker({provider:'local'}),'rules');assert.equal(AM.decisionMaker({provider:'external'}),'external');assert.equal(AM.decisionMaker({}),null);
  for(const v of ['ai','OpenAI','anthropic',''])assert.notEqual(AM.decisionMaker({provider:v}),'ai',`a saved ${JSON.stringify(v)} is not the AI, as before`);
  assert.equal('tradingModel' in AM,false,'no unused accessor');
  // dryRunEstimate keeps its answers: an unknown claude- model is Anthropic's (dry runs), a missing model throws, as before.
  {const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
    a.config.openaiModel='claude-x-unknown';const e=a.dryRunEstimate();assert.equal(e.vendor,'Anthropic');assert.match(e.basis,/dry runs/);a.config.openaiModel=undefined;assert.throws(()=>a.dryRunEstimate());}
  const fs=require('node:fs');for(const f of ['automation.cjs','auto-launch.cjs'])assert.doesNotMatch(fs.readFileSync(path.join(ROOT,'electron',f),'utf8'),/\.provider[!=]=='openai'/,f);
});
test('P2: the start token is unchanged after a load and a save that changes nothing; the dry-run gate keeps its own model check',()=>{
  const pins=PINS.startToken(ROOT);assert.equal(pins.token,'0bb210a088bf48a862bea2630c5e658c7eaae3607d8cfcac2a2d54a156cc2487');
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
  a.live={getState:()=>({environment:'live',policy:{symbols:[],maxOrderKRW:1000000,maxDailyTurnoverKRW:5000000,maxCompanyPct:20,lossLimit:{mode:'off'}}}),identity:()=>'acct',enabled:false,autoEnabled:false};
  const L=require('../electron/auto-launch.cjs');const before=L.launchState(a).token;a.configure({});assert.equal(L.launchState(a).token,before,'a save that changes nothing');assert.equal(a.config.provider,'openai','the stored value is not rewritten');
  assert.match(require('node:fs').readFileSync(path.join(ROOT,'electron','automation.cjs'),'utf8'),/startsWith\('claude-'\)/,"the gate's own model check (completedClaudeDryRun) is left as it is");
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'cef9f646decfa59a');assert.equal(RI.fingerprint(undefined,{orders:true}),'c9ff8de188f65b22');
});
test('P2: the scoreboard and the replay selection on a mixed history of old "openai" rows and new "ai" rows',()=>{
  const {Scoreboard}=require('../electron/scoreboard.cjs');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const row=(id,provider,model,extra={})=>({id,timestamp:Date.parse('2026-11-20T01:00:00Z')+Number(id.slice(1))*60000,provider,model,account:{key:'acct'},contextEvidence:{environment:'kis'},decision:{action:'Buy',symbol:'990010',quantity:1,plan:{confidence:'medium'}},...extra});
  const rows=[row('R1','openai','claude-opus-5-5'),row('R2','openai','gpt-6-sol',{vendor:'openai'}),row('R3','ai','claude-opus-5-5',{vendor:'anthropic'}),row('R4','ai','gpt-6-sol',{vendor:'openai'}),row('R5','local',null),row('R6','external',null)];
  for(const r of rows)db.prepare('INSERT INTO reviews VALUES(?,?)').run(r.id,JSON.stringify(r));
  const sb=new Scoreboard(db,()=>Date.parse('2026-11-24T01:00:00Z'),()=>'acct');const d=sb.decisions();const by=id=>d.find(x=>x.id===id);
  for(const id of ['R1','R2','R3','R4'])assert.equal(by(id)?.provider,'ai',id+': an AI decision, old or new');assert.equal(by('R5')?.provider,'local');assert.equal(by('R6')?.provider,'external');
  assert.deepEqual([...new Set(d.filter(x=>x.provider==='ai').map(x=>x.model))].sort(),['claude-opus-5-5','gpt-6-sol'],'grouped by model as before');
  const {candidates}=require('../electron/replay.cjs');const store={context:()=>({universe:[{symbol:'990010'}]})};
  assert.deepEqual(candidates({reviews:rows,store,events:[],limit:10}).map(c=>c.review.id),['R1','R2','R3','R4'],'replay: every AI decision, old and new; rules and external left out');
});
test('P2: every screen names the company from the model table the main process sends; never OpenAI for a model it does not know',async()=>{
  const M=await import('../src/model-company.mjs');const fs=require('node:fs');
  M.setModelCompanies({});assert.equal(M.deciderName({provider:'openai',openaiModel:'claude-opus-5-5'}),'Claude','before the table arrives: the prefix, as before P2');assert.equal(M.deciderName({provider:'openai',openaiModel:'x-model'}),'AI');
  const table=Object.fromEntries(Object.entries(require('../electron/ai-models.cjs').MODELS).map(([m,r])=>[m,r.vendor]));M.setModelCompanies(table);
  assert.equal(M.deciderName({provider:'openai',openaiModel:'claude-opus-5-5'}),'Claude');assert.equal(M.deciderName({provider:'openai',openaiModel:'gpt-6-sol'}),'OpenAI');
  assert.equal(M.deciderName({provider:'openai',openaiModel:'some-future-model'}),'AI');assert.equal(M.deciderName({provider:'local'}),'Local rules');assert.equal(M.deciderName({provider:'external'}),'External agent');
  assert.equal(M.isClaudeModel('claude-haiku-5-5'),true);assert.equal(M.isClaudeModel('claude-unknown'),true,'an id the table does not know: its prefix (the safer side)');assert.equal(M.deciderName({provider:'openai',openaiModel:'gpt-7'}),'OpenAI');
  assert.match(fs.readFileSync(path.join(ROOT,'electron','automation.cjs'),'utf8'),/getState\(\)\{this\.syncLearning\(\);return \{[^\n]*modelCompanies:Object\.fromEntries\(Object\.entries\(require\('\.\/ai-models\.cjs'\)\.MODELS\)\.map\(\(\[m,r\]\)=>\[m,r\.vendor\]\)\),/);
  assert.match(fs.readFileSync(path.join(ROOT,'src','runtimeFeed.ts'),'utf8'),/setModelCompanies\(/);
  for(const f of fs.readdirSync(path.join(ROOT,'src')).filter(f=>/\.(tsx|mjs|ts)$/.test(f)&&f!=='model-company.mjs'))assert.doesNotMatch(fs.readFileSync(path.join(ROOT,'src',f),'utf8'),/startsWith\('claude-'\)/,f+': no company from a prefix');
  const ws=fs.readFileSync(path.join(ROOT,'src','WorkspaceUX.tsx'),'utf8');assert.match(ws,/deciderName\(state\.config\)/);assert.match(ws,/'AI · model not known'/);
  assert.match(fs.readFileSync(path.join(ROOT,'src','Dashboard.tsx'),'utf8'),/\{deciderName\(state\?\.config\)\}/);
  assert.match(fs.readFileSync(path.join(ROOT,'src','Connections.tsx'),'utf8'),/Importing an OpenAI or Anthropic key makes the AI the decision maker automatically\./);
});
test('P2 review: the replay panel reads the company from the part before "/" of each model/effort value; the renderer matches models as the main process does',async()=>{
  const M=await import('../src/model-company.mjs');const fs=require('node:fs');const AM=require('../electron/ai-models.cjs');
  M.setModelCompanies(Object.fromEntries(Object.entries(AM.MODELS).map(([m,r])=>[m,r.vendor])));
  const src=fs.readFileSync(path.join(ROOT,'src','ReplayPanel.tsx'),'utf8');assert.match(src,/const claude=isClaudeModel\(String\(form\.model\?\?''\)\.split\('\/'\)\[0\]\);/);
  const values=[...src.matchAll(/\['([a-z0-9.-]+)\/([a-z]+)',/g)].map(m=>[m[1],m[2]]);assert.ok(values.length>=5,'the select\'s model/effort values');
  for(const [model,effort] of values){const v=`${model}/${effort}`;assert.equal(M.isClaudeModel(v.split('/')[0]),AM.vendorOf(model)==='anthropic',v);}
  assert.equal(M.isClaudeModel('claude-opus-5-5/medium'.split('/')[0]),true,'a Claude replay keeps its confirmation and cap');
  // The table's matching as the main process's (exactly, or an OpenAI model's dated snapshot); an id it does not know
  // falls back to its prefix, as before P2: a dated id Anthropic returns still reads Claude.
  for(const [m,want] of [['gpt-6-sol','openai'],['gpt-6-sol-2026-11-01','openai'],['claude-opus-5-5','anthropic'],['claude-opus-5-5-20261101','anthropic'],['claude-unknown','anthropic'],['gpt-unknown','openai'],['other',null]])assert.equal(M.companyOfModel(m),want,m);
  // Gates: an unknown claude- id counts as Claude through each one (the safer side), as before P2.
  const unknown='claude-opus-5-5-20261101';const N=require('../electron/decision-names.cjs');assert.equal(N.isClaudeId(unknown),true,'replay onClaude');assert.equal(N.isClaudeId('gpt-6-sol'),false);
  assert.match(fs.readFileSync(path.join(ROOT,'electron','replay.cjs'),'utf8'),/onClaude=s=>require\('\.\/decision-names\.cjs'\)\.isClaudeId\(s\?\.usage\?\.model\);/);
  assert.equal(M.isClaudeModel(unknown),true,'the renderer gates (ReplayPanel, RuntimeSettings, EngineSettings, agentDraft) all ask isClaudeModel');
  const {correctAgents}=await import('../src/agentDraft.mjs');assert.ok(typeof correctAgents==='function');
  assert.equal(M.deciderName({provider:'ai',openaiModel:'claude-opus-5-5'}),'—','a saved "ai" setting is not the AI on screen either, as before');
});
