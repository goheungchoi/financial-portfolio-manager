'use strict';
// The repository and its releases are public (docs/SPEC.md, "Public repository"). This guard fails the suite when a
// tracked file carries what must never be published: a real-looking API key, a personal e-mail address, or a comment
// that records an account event (a dated trade, deposit or refused order with a stock or an amount). The owner's own
// values are never listed here, not even as hashes (a hash of a short number can be reversed by trying every number):
// that list lives in artifacts/ (git-ignored), and when it is present the last test checks every tracked file
// against it, as npm run privacy:scan does before a release.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const ROOT=path.join(__dirname,'..');
const files=()=>execFileSync('git',['ls-files','-z'],{cwd:ROOT,maxBuffer:1<<28}).toString().split('\0').filter(f=>f&&f!=='package-lock.json'&&fs.existsSync(path.join(ROOT,f)));
const texts=function*(){for(const f of files()){const b=fs.readFileSync(path.join(ROOT,f));if(b.includes(0))continue;yield [f,b.toString('utf8')];}};
const where=(f,t,i)=>`${f}:${t.slice(0,i).split('\n').length}`;

test('no tracked file holds a real-looking API key (fixture keys say so: fixture, test, fake, should-not…)',()=>{
  const hits=[];for(const [f,t] of texts())for(const m of t.matchAll(/\bsk-(?:ant-|proj-|openai-)?[A-Za-z0-9_-]{20,}/g)){
    if(/fixture|test|0000|abcdefghij|AbCdEfGh|should-not|fake|dummy|example/i.test(m[0]))continue;hits.push(where(f,t,m.index));}
  assert.deepEqual(hits,[],'a key-shaped string that is not an obvious fixture');});

test('no tracked file holds a personal e-mail address (only example domains, noreply and service addresses)',()=>{
  const PERSONAL=/@(gmail|googlemail|naver|daum|hanmail|kakao|outlook|hotmail|live|yahoo|icloud|me|proton(mail)?)\.(com|net|me)\b|@[a-z0-9-]+\.(edu|ac\.kr)\b/i;
  const hits=[];for(const [f,t] of texts())for(const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))if(PERSONAL.test(m[0]))hits.push(where(f,t,m.index));
  assert.deepEqual(hits,[],'a personal address');});

test('no comment records an account event: a dated trade, deposit or refusal with a stock or an amount',()=>{
  const DATE=/20[0-9]{2}-[01][0-9]-[0-3][0-9]|\b(Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)[a-z]* [0-3]?[0-9]\b/;
  const EVENT=/\b(bought|sold|filled|deposit(ed)?|withdr[ae]w\w*|refused|sale|purchase[ds]?)\b/i;const WHAT=/NASD:|NYSE:|AMEX:|\b[0-9]{6}\b|₩ ?[0-9]|\$[0-9]/;
  const hits=[];for(const [f,t] of texts()){if(!/\.(c?js|mjs|ts|tsx)$/.test(f))continue;t.split('\n').forEach((l,i)=>{if(/^\s*(\/\/|\*|\/\*)/.test(l)&&DATE.test(l)&&EVENT.test(l)&&WHAT.test(l)&&!/artifacts\/reviews\//.test(l))hits.push(`${f}:${i+1}`);});}
  assert.deepEqual(hits,[],'write the case without the owner\'s date, stock or amount (the real case belongs in artifacts/)');});

const PATTERNS=path.join(ROOT,'artifacts','reviews','2026-11-19-privacy','rewrite','patterns.cjs');
test('none of the owner\'s known values, when that list is present (artifacts/, never tracked)',{skip:!fs.existsSync(PATTERNS)&&'the owner\'s list is not in this checkout'},()=>{
  const pats=require(PATTERNS);const hits=[];
  for(const [f,t] of texts())for(const [name,re] of pats){re.lastIndex=0;let m;while((m=re.exec(t)))hits.push(`${name} ${where(f,t,m.index)}`);}
  assert.deepEqual(hits,[],'locations only; see artifacts/reviews/2026-11-19-privacy');});
