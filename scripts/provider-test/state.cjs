'use strict';
// Isolated provider test: the complete state of a SQLite database, for before/after comparisons. A hash of the main
// file alone does not cover pages still in the write-ahead log, so the comparison is logical: every table's rows,
// read through one read-only connection (which sees the log), hashed per table, plus the hashes of the main file and
// the log as they are on disk. The shared-memory index (-shm) is SQLite's lock and index area, not content, and is
// listed by size only.
const fs=require('node:fs'),crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fileState(file){return fs.existsSync(file)?{bytes:fs.statSync(file).size,sha256:sha(fs.readFileSync(file))}:null;}
function logical(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{db.exec('BEGIN');const tables={};
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const q=`"${name.replace(/"/g,'""')}"`;let rows;try{rows=db.prepare(`SELECT * FROM ${q} ORDER BY rowid`).all();}catch{rows=db.prepare(`SELECT * FROM ${q}`).all().map(r=>JSON.stringify(r)).sort();}
      tables[name]={rows:rows.length,sha256:sha(JSON.stringify(rows,(k,v)=>typeof v==='bigint'?String(v):v instanceof Uint8Array?Buffer.from(v).toString('base64'):v))};}
    const schema=sha(JSON.stringify(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()));db.exec('COMMIT');
    return {schema,tables,sha256:sha(JSON.stringify([schema,tables]))};}
  finally{db.close();}
}
function snapshot(file){return {at:new Date().toISOString(),logical:logical(file),main:fileState(file),wal:fileState(file+'-wal'),shm:fs.existsSync(file+'-shm')?{bytes:fs.statSync(file+'-shm').size}:null};}
function compare(a,b){const changed=Object.keys({...a.logical.tables,...b.logical.tables}).filter(t=>JSON.stringify(a.logical.tables[t])!==JSON.stringify(b.logical.tables[t]));
  return {unchanged:a.logical.sha256===b.logical.sha256,schemaUnchanged:a.logical.schema===b.logical.schema,changedTables:changed,mainFileUnchanged:a.main?.sha256===b.main?.sha256,walUnchanged:JSON.stringify(a.wal)===JSON.stringify(b.wal)};}
module.exports={snapshot,logical,compare,fileState,sha};
