// Every name the app's JavaScript reads must be declared. Audit 2026-11-04: fireConditional read an undeclared market,
// so every conditional Buy threw a ReferenceError at run time, and no test reached that line. The TypeScript compiler the
// project already uses parses each CommonJS and module file with Node's globals and reports only names it cannot find
// (2304, 2552 "did you mean"); type errors are not checked here. A line that must read an undefined name on purpose
// carries // @ts-ignore with its reason.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ts=require('typescript');
const root=path.join(__dirname,'..');
const UNDEFINED=[2304,2552];
function undefinedNames(files){
  const program=ts.createProgram(files,{allowJs:true,checkJs:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    lib:['lib.es2022.d.ts','lib.dom.d.ts'],types:['node'],typeRoots:[path.join(root,'node_modules','@types')],maxNodeModuleJsDepth:0});
  return ts.getPreEmitDiagnostics(program).filter(d=>UNDEFINED.includes(d.code)&&d.file).map(d=>`${path.relative(root,d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line+1} ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);
}
const sources=()=>[['electron','.cjs'],['scripts','.cjs'],['tests','.cjs'],[path.join('tests','fixtures'),'.cjs'],['src','.mjs']].flatMap(([dir,ext])=>{
  const at=path.join(root,dir);return fs.existsSync(at)?fs.readdirSync(at).filter(f=>f.endsWith(ext)).map(f=>path.join(at,f)):[];});
test('no file reads an undeclared name',()=>{
  const files=sources();assert.ok(files.some(f=>f.endsWith('automation.cjs'))&&files.length>100,'the app sources are found');
  assert.deepEqual(undefinedNames(files),[]);
});
test('the check finds an undeclared name inside an async method, and accepts declared ones and Node globals',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fpm-undef-'));const file=path.join(dir,'fixture.cjs');
  try{fs.writeFileSync(file,"class A{async fire(order){const us=/:/.test(order.symbol);if(us)return [market].includes(order.market);return Buffer.byteLength(require('node:path').sep)+process.pid;}}\nmodule.exports={A};\n");
    const found=undefinedNames([file]);assert.equal(found.length,1);assert.match(found[0],/fixture\.cjs:1 Cannot find name 'market'/);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
