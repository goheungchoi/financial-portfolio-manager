// M-7 (a): runs every scenario file in a folder as an injected review through the real AI client (tests/helpers/
// scenario.cjs), on the mock KIS, and prints one line per file. Exit code 1 if any file fails, including a file with a
// field the runner does not know. Nothing reaches a real service.
//   node tests/run-scenarios.cjs artifacts/reviews/2026-11-16-multi-order/m7/scenarios
const fs=require('node:fs'),path=require('node:path');const {checkScenario}=require('./helpers/scenario.cjs');
(async()=>{const dir=path.resolve(process.argv[2]??path.join(__dirname,'fixtures','m7'));
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort();if(!files.length){console.log(`No scenario files in ${dir}`);process.exit(1);}
  let failed=0;for(const file of files){let s;try{s=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));}catch(e){console.log(`FAIL ${file}: not valid JSON (${e.message})`);failed++;continue;}
    try{await checkScenario(s);console.log(`pass ${file}: ${s.name}`);}catch(e){console.log(`FAIL ${file}: ${String(e.message).split('\n')[0]}`);failed++;}}
  console.log(`${files.length-failed} of ${files.length} passed`);process.exit(failed?1:0);})();
