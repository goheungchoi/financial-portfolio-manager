// Stage 2b.6 gate report: runs the stage 2b test files and lists, for every test id the gate requires (design v3.3 §6:
// T1-T18, T25a-b, T26-T30, T34-T36, T38-T39, T42-T46 and the stage 2a history tests T4-T6), the tests that cover it and
// whether they passed. Offline; writes a Markdown table to the path given (default: stdout). The run rules are in
// scripts/gate-core.cjs (shared with the stage 3 gate since stage 3.5).
// Usage: node scripts/stage2b-gate.cjs [out.md]
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const {runGate}=require(path.join(__dirname,'gate-core.cjs'));
const root=path.resolve(__dirname,'..');
const FILES=['tests/settlement-strict.test.cjs','tests/settlement-evidence.test.cjs','tests/settlement-reconciliation.test.cjs','tests/settlement-baseline.test.cjs','tests/settlement-panel.test.cjs','tests/stage2b-gate.test.cjs','tests/trade-history.test.cjs','tests/valuation.test.cjs','tests/shared-funding.test.cjs'];
const IDS=['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12','T13','T14','T15','T16','T17','T18','T25a','T25b','T26','T27','T28','T29','T30','T34','T35','T36','T38','T39','T42','T43','T44','T45','T46'];
// Stage 2a history tests carry descriptive names; these name what they cover of T4-T6.
const EXTRA={T4:[/^pagination:/,/^tax: an incomplete history range/,/^settlement: dates read incompletely/,/^review P2: a job stops at its page budget/],
  T5:[/^review P1: a failed read midway through splitting/,/^review P2: a job stops when its time is up/,/^review round 2: unread dates are reported/],
  T6:[/^review P2: a job stops at its page budget/]};
const {code,text}=runGate({root,files:FILES,ids:IDS,extra:EXTRA,spawnSync});
if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
process.exitCode=code;
