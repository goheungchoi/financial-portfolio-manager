// In-app updates through electron-updater (GitHub Releases). Nothing downloads or installs without the user:
// checks run automatically (optional), the user starts the download, and installing restarts the app only when
// no auto trading is armed, no broker order is open and no review is running.
const CHECK_EVERY_MS=6*3600000;
class AppUpdates {
  constructor({updater,enabled,version,canInstall,db,clock=Date.now,onChange=()=>{}}){
    this.updater=updater;this.enabled=enabled;this.version=version;this.canInstall=canInstall;this.db=db;this.clock=clock;this.onChange=onChange;
    db.exec('CREATE TABLE IF NOT EXISTS app_update_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');
    this.state={status:enabled?'idle':'disabled',current:version,available:null,progress:null,error:null,checkedAt:null};
    if(!enabled)return;
    updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowPrerelease=false;updater.allowDowngrade=false;updater.logger=null;
    const set=patch=>{this.state={...this.state,...patch};this.onChange(this.view());};
    updater.on('checking-for-update',()=>set({status:'checking',error:null}));
    updater.on('update-available',info=>set({status:'available',checkedAt:this.clock(),available:summary(info)}));
    updater.on('update-not-available',()=>set({status:'up-to-date',checkedAt:this.clock(),available:null}));
    updater.on('download-progress',p=>set({status:'downloading',progress:Number.isFinite(p?.percent)?Math.round(p.percent):null}));
    updater.on('update-downloaded',info=>set({status:'downloaded',progress:100,available:summary(info)}));
    updater.on('error',error=>set({status:'error',error:publicError(error),checkedAt:this.clock()}));
  }
  settings(){const row=this.db.prepare('SELECT payload FROM app_update_settings WHERE id=1').get();return {checkAutomatically:true,...(row?JSON.parse(row.payload):{})};}
  saveSettings(value){if(!value||Object.keys(value).some(k=>k!=='checkAutomatically')||typeof value.checkAutomatically!=='boolean')throw new Error('INVALID_SETTINGS');this.db.prepare('INSERT INTO app_update_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));return this.view();}
  view(){return {...this.state,settings:this.settings(),blockedReason:this.state.status==='downloaded'?this.canInstall():null};}
  async check(){if(!this.enabled)throw new Error('UPDATES_DISABLED');if(['checking','downloading'].includes(this.state.status))return this.view();try{await this.updater.checkForUpdates();}catch(error){this.state={...this.state,status:'error',error:publicError(error),checkedAt:this.clock()};}return this.view();}
  async download(){if(!this.enabled)throw new Error('UPDATES_DISABLED');if(this.state.status!=='available')throw new Error('NO_UPDATE');this.state={...this.state,status:'downloading',progress:0};try{await this.updater.downloadUpdate();}catch(error){this.state={...this.state,status:'error',error:publicError(error)};}return this.view();}
  install(){if(this.state.status!=='downloaded')throw new Error('NO_UPDATE');const reason=this.canInstall();if(reason)throw new Error(reason);this.updater.quitAndInstall(false,true);return this.view();}
  // Automatic check on a schedule, when enabled in settings.
  tick(){if(this.enabled&&this.settings().checkAutomatically&&['idle','up-to-date','error'].includes(this.state.status)&&this.clock()-(this.state.checkedAt??0)>=CHECK_EVERY_MS)void this.check();}
}
function summary(info){return {version:String(info?.version??'').slice(0,40),releaseDate:typeof info?.releaseDate==='string'?info.releaseDate.slice(0,40):null,notes:typeof info?.releaseNotes==='string'?info.releaseNotes.replace(/<[^>]*>/g,'').slice(0,2000):null};}
// Updater errors can contain URLs and file paths; only a short code reaches the UI.
function publicError(error){const text=String(error?.message??error??'');if(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(text))return 'NETWORK_UNAVAILABLE';if(/404|HttpError: 4/i.test(text))return 'RELEASE_NOT_FOUND';if(/sha512|checksum/i.test(text))return 'CHECKSUM_MISMATCH';if(/signature|publisher/i.test(text))return 'SIGNATURE_INVALID';return 'UPDATE_FAILED';}
module.exports={AppUpdates,publicError,CHECK_EVERY_MS};
