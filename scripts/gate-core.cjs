// Shared by the stage gate reports (scripts/stage2b-gate.cjs, scripts/stage3-gate.cjs): runs the given test files and
// lists, for every required test id, the tests that cover it and whether they passed.
// Every file's run must be whole and passing (stage 2b.6 review, P2: a failed process and skipped tests were reported as
// passing): the process exits 0 with no spawn error; the TAP output has its plan, and as many top-level results as
// planned; nothing is cancelled; and a result with a SKIP or TODO directive is not a pass. A file that fails any of these
// is listed under "runs" and fails the gate. spawnSync is passed in, so the runner tests can replace the test processes.
const path=require('node:path');
function runGate({root,files,ids,extra={},spawnSync}){
  const results=[],runs=[];
  for(const file of files){const r=spawnSync(process.execPath,['--test','--test-reporter=tap',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
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
  const covers=(id,name)=>new RegExp(`(^|[^A-Za-z0-9])${id}([^0-9a-z]|$)`).test(name)||(extra[id]??[]).some(x=>x.test(name));
  const rows=ids.map(id=>{const hits=results.filter(x=>covers(id,x.name));return {id,hits,ok:hits.length>0&&hits.every(x=>x.ok)};});
  const esc=s=>s.replace(/\|/g,'\\|');
  const report=['| Test | Status | Covered by |','|---|---|---|',...rows.map(r=>`| ${r.id} | ${r.ok?'pass':r.hits.length?'**FAIL**':'**MISSING**'} | ${r.hits.map(h=>`${path.basename(h.file)}: ${esc(h.name.length>110?h.name.slice(0,107)+'…':h.name)}${h.ok?'':' (failed)'}`).join('<br>')} |`),
    '',...runs.filter(r=>!r.ok).map(r=>`**Run failed: ${r.file}**: ${r.problems.join('; ')}`),
    `Files: ${files.length}, all run whole and passing: ${runs.every(r=>r.ok)?'yes':'**no**'}; tests run: ${results.length}; passed: ${results.filter(x=>x.ok).length}; not passed (failed, skipped, todo or from a failed run): ${results.filter(x=>!x.ok).length}.`,
    `Gate ids: ${rows.length}; covered and passing: ${rows.filter(r=>r.ok).length}.`];
  return {code:runs.every(r=>r.ok)&&rows.every(r=>r.ok)&&results.every(x=>x.ok)?0:1,text:report.join('\n')+'\n'};}
module.exports={runGate};
