// Stage 3.5 gate report: runs the stage 3 test files and lists, for every test id the gate requires (design v3.3 §6:
// T19-T24, T40, T41 replaced), the tests that cover it and whether they passed. tests/stage3-gate.test.cjs runs each id
// through the composition the app wires and checks every consumer agrees. Offline; the run rules (whole, passing runs
// only) are in scripts/gate-core.cjs. Writes a Markdown table to the path given (default: stdout).
// Usage: node scripts/stage3-gate.cjs [out.md]
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const {runGate}=require(path.join(__dirname,'gate-core.cjs'));
const root=path.resolve(__dirname,'..');
const FILES=['tests/stage3-gate.test.cjs','tests/performance-corrections.test.cjs','tests/performance-uncertainty.test.cjs','tests/performance-restatements.test.cjs','tests/performance-restatements-review.test.cjs','tests/performance-consumers.test.cjs','tests/performance.test.cjs'];
const IDS=['T19','T20','T21','T22','T23','T24','T40','T41'];
const {code,text}=runGate({root,files:FILES,ids:IDS,spawnSync});
if(process.argv[2])fs.writeFileSync(process.argv[2],text);else process.stdout.write(text);
process.exitCode=code;
