'use strict';
// The npm test list (tests/test-list.txt): one test file per line, in order; blank lines and lines starting with # are
// skipped. It replaced the list on npm test's command line, which had reached Windows' 8,191-character limit.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
function testFiles(){const text=fs.readFileSync(path.join(__dirname,'test-list.txt'),'utf8');
  const files=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  const odd=files.filter(f=>!/^tests\/[^\s]+\.test\.(c|m)?js$/.test(f));if(odd.length)throw new Error(`not a test file: ${odd.join(', ')}`);
  const twice=files.filter((f,i)=>files.indexOf(f)!==i);if(twice.length)throw new Error(`listed twice: ${twice.join(', ')}`);
  const missing=files.filter(f=>!fs.existsSync(path.join(root,f)));if(missing.length)throw new Error(`missing: ${missing.join(', ')}`);
  return files;}
module.exports={testFiles,root};
