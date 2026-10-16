const path=require('node:path');
class RememberedFiles {
  constructor(db){this.db=db;this.progress={kis:'idle',providers:'idle'};this.errors={kis:null,providers:null};}
  key(kind){if(!['kis','providers'].includes(kind))throw new Error('INVALID_REQUEST');return 'connection-file:'+kind;}
  get(kind){return this.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key(kind))?.value??null;}
  remember(kind,file){if(typeof file!=='string'||!path.isAbsolute(file)||file.length>32768)throw new Error('INVALID_REQUEST');this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(kind),file);}
  forget(kind){this.db.prepare('DELETE FROM settings WHERE key=?').run(this.key(kind));this.errors[kind]=null;this.progress[kind]='idle';}
  state(){return Object.fromEntries(['kis','providers'].map(kind=>{const file=this.get(kind);return [kind,{remembered:Boolean(file),name:file?path.basename(file):null,status:this.progress[kind],error:this.errors[kind]}];}));}
  async restore(connectors){await Promise.allSettled(['kis','providers'].map(async kind=>{const file=this.get(kind);if(file)await connectors[kind](file);}));}
}
module.exports={RememberedFiles};
