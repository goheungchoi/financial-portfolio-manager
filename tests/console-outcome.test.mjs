// AI console: a run the app logs as one finished line is never "In progress" (the user's screenshot, 2026-11-26:
// "Sectors assigned" at 07:34 stayed "In progress"). Every one-line Program entry automation.cjs logs is covered.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {standaloneOutcome,STANDALONE_TITLES} from '../src/console-outcome.mjs';
const P=title=>({kind:'Program',title,body:''});

test('one-line runs: sectors assigned and the keep-alive are Completed; a skipped or dropped scout or narrative is Skipped',()=>{
  assert.equal(standaloneOutcome([P('Sectors assigned')]),'Completed');
  assert.equal(standaloneOutcome([P('Kept the saved instructions for the next review')]),'Completed');
  for(const t of ['Scout run skipped · markets closed','Scout run dropped · budget','Scout retry dropped · x','Market narrative skipped · y'])assert.equal(standaloneOutcome([P(t)]),'Skipped',t);
  // Anything else keeps the console's own reading.
  assert.equal(standaloneOutcome([P('Scheduled review')]),null);assert.equal(standaloneOutcome([P('Sectors assigned'),{kind:'Agent',title:'Decision',body:'{}'}]),null);
  assert.equal(standaloneOutcome([]),null);assert.equal(standaloneOutcome([{kind:'System',title:'Sectors assigned'}]),null);
});

test('every one-line Program entry in automation.cjs is listed; the console uses the rule',()=>{
  const src=fs.readFileSync(new URL('../electron/automation.cjs',import.meta.url),'utf8');
  const titles=[...src.matchAll(/log\([^,]*,'Program','([^']*)'/g)].map(m=>m[1]).filter(t=>t!=='Replay');
  const all=[...STANDALONE_TITLES.COMPLETED,...STANDALONE_TITLES.SKIPPED];
  for(const t of titles)assert.ok(all.includes(t),'listed: '+t);
  const ui=fs.readFileSync(new URL('../src/AiConsole.tsx',import.meta.url),'utf8');
  assert.ok(ui.includes("const standalone=standaloneOutcome(events);"));assert.ok(ui.includes("dry||notice||standalone?'done'"));
});
