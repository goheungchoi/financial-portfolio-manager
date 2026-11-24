'use strict';
// npm test: runs every file of tests/test-list.txt, in order, in one `node --test` run (the same run the command line
// gave). The files go to node directly, not through a shell, so the list's length is not bound by cmd's limit.
const {spawnSync}=require('node:child_process');const {testFiles,root}=require('./test-list.cjs');
let files;try{files=testFiles();}catch(error){console.error(`tests/test-list.txt: ${error.message}`);process.exit(1);}
console.log(`${files.length} test files from tests/test-list.txt`);
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});
if(r.error){console.error(r.error.message);process.exit(1);}
process.exit(r.status??1);
