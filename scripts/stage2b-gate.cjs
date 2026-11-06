// Stage 2b.6 gate report: runs the stage 2b test files and lists, for every test id the gate requires (design v3.3 §6:
// T1-T18, T25a-b, T26-T30, T34-T36, T38-T39, T42-T46 and the stage 2a history tests T4-T6), the tests that cover it and
// whether they passed. Offline; writes a Markdown table to the path given (default: stdout).
// Usage: node scripts/stage2b-gate.cjs [out.md]
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const FILES=['tests/settlement-strict.test.cjs','tests/settlement-evidence.test.cjs','tests/settlement-reconciliation.test.cjs','tests/settlement-baseline.test.cjs','tests/settlement-panel.test.cjs','tests/stage2b-gate.test.cjs','tests/trade-history.test.cjs','tests/valuation.test.cjs','tests/shared-funding.test.cjs'];
const IDS=['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12','T13','T14','T15','T16','T17','T18','T25a','T25b','T26','T27','T28','T29','T30','T34','T35','T36','T38','T39','T42','T43','T44','T45','T46'];
// Stage 2a history tests carry descriptive names; these name what they cover of T4-T6.
const EXTRA={T4:[/^pagination:/,/^tax: an incomplete history range/,/^settlement: dates read incompletely/,/^review P2: a job stops at its page budget/],
  T5:[/^review P1: a failed read midway through splitting/,/^review P2: a job stops when its time is up/,/^review round 2: unread dates are reported/],
  T6:[/^review P2: a job stops at its page budget/]};
// Every file's run must be whole and passing (stage 2b.6 review, P2: a failed process and skipped tests were reported as
// passing): the process exits 0 with no spawn error; the TAP output has its plan, and as many top-level results as
// planned; nothing is cancelled; and a result with a SKIP or TODO directive is not a pass. A file that fails any of these
// is listed under "runs" and fails the gate.
const results=[],runs=[];
for(const file of FILES){const r=spawnSync(process.execPath,['--test','--test-reporter=tap',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
  const out=typeof r.stdout==='string'?r.stdout:'',lines=out.split(/\r?\n/),own=[];
  for(const line of lines){const m=/^(not ok|ok) (\d+) - (.*)$/.exec(line);if(!m)continue;
    // A directive follows an unescaped " # " (names escape their own "#" as "\#").
    const d=/ # (SKIP|TODO)\b/i.exec(m[3]),name=(d?m[3].slice(0,d.index):m[3]).replace(/\\#/g,'#');
    own.push({file,ok:m[1]==='ok'&&!d,directive:d?d[1].toUpperCase():null,name});}
  const plan=lines.map(l=>/^1\.\.(\d+)$/.exec(l)).find(Boolean),cancelled=lines.map(l=>/^# cancelled (\d+)$/.exec(l)).find(Boolean);
  const problems=[...(r.error?[`spawn error: ${r.error.message}`]:[]),...(r.status!==0?[`exit ${r.status??r.signal}`]:[]),...(plan?[]:['no TAP plan']),
    ...(plan&&Number(plan[1])!==own.length?[`${own.length} results for a plan of ${plan[1]}`]:[]),...(!own.length?['no results']:[]),...(cancelled&&Number(cancelled[1])>0?[`${cancelled[1]} cancelled`]:[]),
    ...own.filter(x=>x.directive).map(x=>`${x.directive}: ${x.name}`),...own.filter(x=>!x.ok&&!x.directive).map(x=>`failed: ${x.name}`)];
  runs.push({file,ok:!problems.length,problems});
  // A test of a run that did not finish whole is not evidence of anything.
  results.push(...own.map(x=>({...x,ok:x.ok&&!problems.some(p=>/^(spawn error|exit|no TAP plan|no results)|results for a plan|cancelled/.test(p))})));}
const covers=(id,name)=>new RegExp(`(^|[^A-Za-z0-9])${id}([^0-9a-z]|$)`).test(name)||(EXTRA[id]??[]).some(x=>x.test(name));
const rows=IDS.map(id=>{const hits=results.filter(x=>covers(id,x.name));return {id,hits,ok:hits.length>0&&hits.every(x=>x.ok)};});
const esc=s=>s.replace(/\|/g,'\\|');
const report=['| Test | Status | Covered by |','|---|---|---|',...rows.map(r=>`| ${r.id} | ${r.ok?'pass':r.hits.length?'**FAIL**':'**MISSING**'} | ${r.hits.map(h=>`${path.basename(h.file)}: ${esc(h.name.length>110?h.name.slice(0,107)+'…':h.name)}${h.ok?'':' (failed)'}`).join('<br>')} |`),
  '',...runs.filter(r=>!r.ok).map(r=>`**Run failed: ${r.file}**: ${r.problems.join('; ')}`),
  `Files: ${FILES.length}, all run whole and passing: ${runs.every(r=>r.ok)?'yes':'**no**'}; tests run: ${results.length}; passed: ${results.filter(x=>x.ok).length}; not passed (failed, skipped, todo or from a failed run): ${results.filter(x=>!x.ok).length}.`,
  `Gate ids: ${rows.length}; covered and passing: ${rows.filter(r=>r.ok).length}.`];
const text=report.join('\n')+'\n';if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
process.exitCode=runs.every(r=>r.ok)&&rows.every(r=>r.ok)&&results.every(x=>x.ok)?0:1;
