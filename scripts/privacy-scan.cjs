'use strict';
// Pre-release privacy scan (docs/SPEC.md, "Public repository"; Part 4 §6). Run before every push or release:
//   npm run privacy:scan -- [--notes <release-notes file>] [--range <git range, default origin/main..HEAD>]
// It checks the commits to be pushed (their messages, and that every author and committer e-mail is the GitHub
// no-reply address), every tracked file at HEAD, and the release notes draft, for:
// - key shapes, personal e-mail domains and dated account events (the same rules as tests/no-personal-data.test.cjs);
// - the owner's known values, from artifacts/reviews/2026-11-19-privacy/rewrite/patterns.cjs when that git-ignored
//   list is present;
// - values read from the live database, when PRIVACY_VALUES_FILE names a file of them (one per line, written by the
//   planner and deleted afterwards). Each is matched plain, comma-grouped and in the Korean unit form.
// A hit prints its location only, never the value. The exit code is 1 on any hit, 0 when clean.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..');const git=(...a)=>execFileSync('git',a,{cwd:ROOT,maxBuffer:1<<30}).toString();
const arg=(name,def=null)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:def;};
const range=arg('--range','origin/main..HEAD');const notes=arg('--notes');const NOREPLY=/^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/;
const rules=[
  ['key',/\bsk-(?:ant-|proj-|openai-)?[A-Za-z0-9_-]{20,}/g,m=>!/fixture|test|0000|abcdefghij|AbCdEfGh|should-not|fake|dummy|example/i.test(m)],
  ['email',/[A-Za-z0-9._%+-]+@(gmail|googlemail|naver|daum|hanmail|kakao|outlook|hotmail|live|yahoo|icloud|me|proton(mail)?)\.(com|net|me)\b|[A-Za-z0-9._%+-]+@[a-z0-9-]+\.(edu|ac\.kr)\b/gi,()=>true],
];
const pfile=path.join(ROOT,'artifacts','reviews','2026-11-19-privacy','rewrite','patterns.cjs');
if(fs.existsSync(pfile))for(const [n,re] of require(pfile))rules.push([n,re,()=>true]);
const group=s=>{const [i,d]=s.split('.');return i.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(d!=null?'.'+d:'');};
const man=n=>{const e=Math.floor(n/1e8),m=Math.floor(n%1e8/1e4),w=n%1e4;return [e&&e.toLocaleString('en-US')+'억',m&&m.toLocaleString('en-US')+'만',w&&w.toLocaleString('en-US')+'원'].filter(Boolean).join(' ');};
if(process.env.PRIVACY_VALUES_FILE){const raw=fs.readFileSync(process.env.PRIVACY_VALUES_FILE,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s.length>=5);
  const vals=[...new Set(raw.flatMap(v=>{const p=v.replace(/^-/,'');const out=[v];if(/^[0-9]+(\.[0-9]+)?$/.test(p)){const g=group(p);if(g!==p)out.push(g);if(!p.includes('.')&&Number(p)>=1e4&&/만/.test(man(Number(p))))out.push(man(Number(p)));}return out;}))];
  const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');rules.push(['live',new RegExp(`(?<![0-9A-Za-z.,])(${vals.map(esc).join('|')})(?![0-9A-Za-z]|[.,][0-9])`,'g'),()=>true]);}
const EVENT_DATE=/20[0-9]{2}-[01][0-9]-[0-3][0-9]|\b(Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)[a-z]* [0-3]?[0-9]\b/,EVENT=/\b(bought|sold|filled|deposit(ed)?|withdr[ae]w\w*|refused|sale|purchase[ds]?)\b/i,WHAT=/NASD:|NYSE:|AMEX:|\b[0-9]{6}\b|₩ ?[0-9]|\$[0-9]/;
const hits=[];const scan=(label,text,lineEvents)=>{for(const [n,re,keep] of rules){re.lastIndex=0;let m;while((m=re.exec(text)))if(keep(m[0]))hits.push(`${n}\t${label}:${text.slice(0,m.index).split('\n').length}`);}
  if(lineEvents)text.split('\n').forEach((l,i)=>{if(lineEvents(l)&&EVENT_DATE.test(l)&&EVENT.test(l)&&WHAT.test(l)&&!/artifacts\/reviews\//.test(l))hits.push(`event\t${label}:${i+1}`);});};
// 1. the commits to be pushed
let commits=[];try{commits=git('rev-list',range).split('\n').filter(Boolean);}catch{console.error(`range ${range} could not be read`);process.exit(2);}
for(const c of commits){const [ae,ce]=git('log','-1','--format=%ae%n%ce',c).trim().split('\n');if(!NOREPLY.test(ae)||!NOREPLY.test(ce))hits.push(`author\tcommit ${c.slice(0,7)}: not the no-reply address`);
  scan(`message ${c.slice(0,7)}`,git('log','-1','--format=%B',c),()=>true);}
// 2. every tracked file at HEAD
for(const f of git('ls-files','-z').split('\0').filter(f=>f&&f!=='package-lock.json')){const p=path.join(ROOT,f);if(!fs.existsSync(p))continue;const b=fs.readFileSync(p);if(b.includes(0))continue;
  scan(f,b.toString('utf8'),/\.(c?js|mjs|ts|tsx)$/.test(f)?l=>/^\s*(\/\/|\*|\/\*)/.test(l):null);}
// 3. the release notes draft
if(notes)scan('notes',fs.readFileSync(notes,'utf8'),()=>true);
for(const h of hits)console.log(h);
console.log(`privacy scan: ${commits.length} commits (${range}), ${notes?'notes, ':''}tracked files${fs.existsSync(pfile)?', known values':''}${process.env.PRIVACY_VALUES_FILE?', live values':''}: ${hits.length} hits`);
process.exit(hits.length?1:0);
