'use strict';
// Step A3 (artifacts/reviews/2026-11-12-engine-settings/plan.md): Engine settings in four tabs. Rows move; no setting
// changes meaning. These checks read the screen's source: every control of the one-page screen at 410d5b6 is on
// exactly one tab, the tab the A0 inventory gave it, and keeps its label and setting key. The desktop suite checks
// that each tab opens, its rows save, and the layout in dark, light and at the minimum width.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const src=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8').replace(/\r\n/g,'\n');
const engine=src('src/EngineSettings.tsx');
// The source of one top-level function, up to the next one.
const fn=name=>{const i=engine.indexOf(`\nfunction ${name}(`);assert.ok(i>=0,name);const j=engine.indexOf('\nfunction ',i+1);return engine.slice(i,j<0?undefined:j);};
const TABS={
  'Trading':fn('TradingTab')+fn('ExtendedSessions')+fn('StartWithWindows')+src('src/Guardrails.tsx'),
  'Agents':fn('AgentsTab')+fn('AgentModelRows'),
  'Schedule and triggers':fn('ScheduleTab')+src('src/TokenSaving.tsx'),
  'Alerts':fn('AlertsTab'),
};
// Every control and labelled block of the one-page screen (EngineSettings, TokenSaving and Guardrails at 410d5b6), by
// its label, with its setting key and the tab from the A0 inventory (report.md section 1).
const CONTROLS=[
  ['Trading','Agent guidelines','guidelines'],['Trading','Portfolio scope','scope'],['Trading','Decision provider','provider'],
  ['Trading','Scheduled reviews','enabled'],['Trading','Place orders automatically','autoSubmit'],['Trading','Risk per trade','sizingRiskPct'],
  ['Trading','Stop distance in ATR','sizingAtrMultiple'],['Trading','Start with Windows',null],
  ['Trading',"'Korea · Nextrade (NXT)'",'sessionKrNxt'],['Trading',"'U.S. · KIS daytime session'",'sessionUsDaytime'],['Trading',"'U.S. · Pre-market'",'sessionUsPre'],
  ['Trading',"'U.S. · After-market'",'sessionUsAfter'],['Trading','Largest extended-session order','extendedMaxOrderPct'],
  ['Trading','Loss-limit response','lossAction'],['Trading','Automatic orders per day','maxAutoOrdersPerDay'],['Trading','Stop after consecutive failed reviews','maxConsecutiveFailures'],
  ['Trading','Follow the best price','orderTracking'],['Trading','Let the AI set conditional orders','conditionalOrders'],
  ['Trading','Submit conditional orders automatically','conditionalAutoSubmit'],['Trading','Most armed conditional orders','conditionalMaxActive'],
  ['Trading','Largest conditional order','conditionalMaxOrderPct'],['Trading','Conditional order price drift','conditionalMaxSlippagePct'],['Trading','Conditional order lifetime','conditionalMaxHours'],
  ['Agents','Trading model','setModel'],['Agents','Reasoning effort','reasoningEffort'],['Agents','Post-trade reflection','reflectionEnabled'],

  ['Agents','Reflection calls per day','reflectionCallsPerDay'],['Agents','Daily reflection budget (USD)','reflectionUSDPerDay'],['Agents','Recent API calls',null],
  ['Schedule and triggers','Auto review interval','autoReviewInterval'],['Schedule and triggers','Review interval','intervalMinutes'],
  ['Schedule and triggers','Reviews while markets are closed','closedMarketReviews'],['Schedule and triggers','Price move trigger','eventTolerancePct'],
  ['Schedule and triggers','Watchlist alerts','watchlistAlerts'],['Schedule and triggers','Watchlist move trigger','watchlistMovePct'],['Schedule and triggers','Watchlist alert trial','alertTrial'],
  ['Schedule and triggers','Scheduled scout runs','scoutEnabled'],['Schedule and triggers','Reviews can request a scout run','scoutAiRequests'],['Schedule and triggers','Minutes after the Korean open','scoutAfterOpenMinutes'],
  ['Schedule and triggers','Skip unchanged reviews','skipUnchanged'],['Schedule and triggers','Review gate','reviewGate'],['Schedule and triggers','Research suppression','researchSuppression'],
  ['Schedule and triggers','Routine review scope','routineReviews'],['Schedule and triggers','Maximum skip minutes','maxSkipMinutes'],
  ['Schedule and triggers','Slow down near the budget','degradeNearBudget'],['Schedule and triggers','Recent review cost',null],
  ['Alerts','Desktop alerts','desktopAlerts'],['Alerts','Phone alerts','mobileAlerts'],['Alerts','Snapshot on each trade','phoneSnapshots'],
  ['Alerts','Show amounts in snapshots','phoneAmounts'],['Alerts','Send a daily digest','digestEnabled'],['Alerts','Daily digest time','digestHour'],
  ['Alerts','Digest preview',null],['Alerts','AI review alerts',null],
];
const labelled=(text,label)=>label.startsWith("'")?text.includes(label):new RegExp(`label="${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"|title="${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`).test(text);

test('the four tabs, in order, with Trading first',()=>{
  assert.ok(engine.includes("export const ENGINE_TABS=['Trading','Agents','Schedule and triggers','Alerts'] as const;"));
  assert.ok(engine.includes("useDraftState<string>('engine:tab','Trading')"),'the open tab is kept for the session; Trading by default');
  assert.ok(engine.includes('role="tablist" aria-label="Engine sections"')&&engine.includes('role="tab" aria-selected={tab===t}')&&engine.includes('role="tabpanel" aria-label={tab}'));
  for(const [tab,f] of [['Trading','TradingTab'],['Agents','AgentsTab'],['Schedule and triggers','ScheduleTab'],['Alerts','AlertsTab']])assert.ok(engine.includes(`{tab==='${tab}'&&<${f} {...props}/>}`),tab);
  assert.ok(engine.includes("'Run portfolio review'"),'the review button stays above the tabs');
});

test('every control of the old screen is on exactly one tab, the A0 one, with its setting key',()=>{
  for(const [tab,label,key] of CONTROLS){
    const on=Object.entries(TABS).filter(([,text])=>labelled(text,label)).map(([t])=>t);
    assert.deepEqual(on,[tab],`${label}: on ${on.join(', ')||'no tab'}`);
    if(key&&key!=='setModel'&&!/^session/.test(key))assert.ok(new RegExp(`'${key}'`).test(TABS[tab]),`${label} still edits ${key}`);
  }
  assert.ok(fn('TradingTab').includes('<ExtendedSessions ')&&fn('TradingTab').includes('<StartWithWindows/>')&&fn('TradingTab').includes('<Guardrails '),'the Trading tab renders its parts');
  assert.ok(fn('ScheduleTab').includes('<TokenSaving '),'the Schedule tab renders token saving');
  assert.ok(fn('AgentsTab').includes('onChange={e=>setModel(e.target.value)}'),'the trading model still goes through setModel');
});

test('Start with Windows moves with the other Trading rows',()=>{
  const t=fn('TradingTab');assert.ok(t.indexOf('<StartWithWindows/>')>t.indexOf('title="Data sharing"')&&t.indexOf('<StartWithWindows/>')<t.indexOf('</Card>',t.indexOf('id="eng-trading"')));
});

test('the Agents tab: one card per agent, each with Model and Effort; the narrative gets its first switch',()=>{
  const a=fn('AgentsTab');
  for(const [agent,name] of [['scout','Scout'],['narrative','Market narrative'],['compacting','Context compacting'],['reflection','Reflection']])assert.ok(a.includes(`<AgentModelRows agent="${agent}" name="${name}" {...props}/>`),agent);
  for(const card of ['title="Trading review"','title="AI scout"','title="Market narrative"','title="Context compacting"','title="Reflection"','title="Daily AI budget"'])assert.ok(a.includes(card),card);
  assert.ok(a.includes("<Switch label=\"Scheduled market narrative\" disabled={busy} checked={config.narrativeEnabled} onChange={v=>edit('narrativeEnabled',v)}/>"),'narrativeEnabled gates the scheduled runs only (automation.cjs tick); a manual update runs either way');
  const rows=fn('AgentModelRows');
  assert.ok(engine.includes("const AGENT_KEYS=DRAFT_KEYS as Record<AgentKey,[keyof RuntimeConfig,keyof RuntimeConfig]>;"),'the keys come from src/agentDraft.mjs, checked against electron/agent-models.cjs in agent-draft.test.mjs');
  assert.deepEqual(require('../electron/agent-models.cjs').KEYS,{scout:['scoutModel','scoutEffort'],narrative:['narrativeModel','narrativeEffort'],compacting:['routineModel','routineEffort'],reflection:['reflectionModel','reflectionEffort']});
  assert.ok(rows.includes('aria-label={`${name} model`}')&&rows.includes('aria-label={`${name} effort`}'));
  assert.ok(rows.includes('<option value="same">Same as the trading agent</option>'));
  assert.ok(rows.includes('const efforts=effortOptions(config,agent);'),'None is not offered where the engine refuses it (agent-draft.test.mjs)');
  assert.ok(rows.includes('value={effort} onChange')&&rows.includes('{!efforts.includes(effort)&&<option value={effort} disabled>{cap(effort)} · not allowed with this model</option>}'),'the select always shows the draft value (review F1)');
  // B3: Claude Opus 5.5 is listed, and can be chosen only once the key is loaded and a Claude dry run completed here.
  assert.ok(rows.includes('const claudeOpen=anthropicKey&&measured;')&&rows.includes("<option value=\"claude-opus-5-5\" disabled={!claudeOpen&&model!=='claude-opus-5-5'}>{claudeLabel}</option>"),'the Claude option is gated');
});

test('the condensing model row is now the Context compacting card; token saving lost only that row',()=>{
  const ts=src('src/TokenSaving.tsx');assert.ok(!ts.includes('Condensing model')&&!ts.includes('routineModel')&&!ts.includes('routineEffort'));
  for(const keep of ['Skip unchanged reviews','Review gate','Research suppression','Routine review scope','Maximum skip minutes','Slow down near the budget','Recent review cost'])assert.ok(ts.includes(keep),keep);
});

test('two edits in one event both apply (an agent model and its effort)',()=>{
  const rs=src('src/RuntimeSettings.tsx');
  assert.ok(rs.includes('setConfig(current=>{const next={...(current??config),...patch} as RuntimeConfig;const fix=correctAgents(next) as Partial<RuntimeConfig>;'),'edit is a functional update and runs the correction');
  assert.ok(rs.includes("const edit=(key:keyof RuntimeConfig,value:string|number|boolean)=>apply({[key]:value} as Partial<RuntimeConfig>);")&&rs.includes('setModel={model=>apply({openaiModel:model,'),'both the trading model and every other edit go through it');
  assert.ok(!engine.includes('aria-pressed'),'tabs use aria-selected only');
  assert.ok(rs.includes("INVALID_MODEL_SETTINGS:'A model and its effort don’t go together"),'a refused pair says why');
});

test('B1: the KIS consent is per provider in Connections; Engine → Trading shows both and links there',()=>{
  assert.ok(!engine.includes('shareKisWithAI')&&!engine.includes('Share KIS data'),'no consent switch left in Engine settings');
  const t=fn('TradingTab');assert.ok(t.includes('title="Data sharing"')&&t.includes("setDraft('connections:ai-providers',true);onNavigate?.('Connections');"));
  const cards=src('src/ProviderCards.tsx');assert.ok(cards.includes("share:'shareKisWithOpenAI'")&&cards.includes("share:'shareKisWithAnthropic'")&&cards.includes('<Switch label={`Share KIS data with ${name}`}'));
});

test('step A4: the scout timing switches and the after-open offset are on Schedule and triggers, keyed as in scout-timing.cjs',()=>{
  const s=fn('ScheduleTab');const T=require('../electron/scout-timing.cjs');
  assert.ok(s.includes('{SCOUT_SLOTS.map(([key,title,hint])=><Row key={key} title={title} hint={hint}><Switch label={title} disabled={busy} checked={config[key]} onChange={v=>edit(key,v)}/></Row>)}'));
  for(const slot of T.SLOTS)assert.ok(engine.includes(`['${slot.key}','${slot.label}',`),slot.key);
  assert.ok(s.includes('<details className="inline-help"><summary>More</summary>')&&s.includes(`label="Minutes after the Korean open" min={${T.OFFSET.min}} max={${T.OFFSET.max}}`)&&s.includes("edit('scoutAfterOpenMinutes',v)"),'the offset is behind More with the engine range');
  assert.ok(!engine.includes('scoutSchedule'),'the preset select is gone');
});
