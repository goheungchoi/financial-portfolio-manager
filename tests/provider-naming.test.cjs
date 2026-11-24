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
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'bdfca4388d263737');assert.equal(RI.fingerprint(undefined,{orders:true}),'ecd1189f47a389f2');
});
test('pins: the start token of a fixed configuration and each client\'s request body are as before P1 (computed on 3f1a720b..f7698d1f)',async()=>{
  assert.deepEqual(PINS.startToken(ROOT),{token:'0bb210a088bf48a862bea2630c5e658c7eaae3607d8cfcac2a2d54a156cc2487',config:'4eb88e1b40c61b4f'});
  assert.deepEqual(await PINS.requestBodies(ROOT),{openai:'dfc4223814d360cb',claude:'6c2985ba7acc7046'});
});
