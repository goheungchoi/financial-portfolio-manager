const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {EventEmitter}=require('node:events');
const {AppUpdates,publicError,CHECK_EVERY_MS}=require('../electron/app-updates.cjs');
function fake(){const u=new EventEmitter();u.calls=[];u.checkForUpdates=async()=>{u.calls.push('check');u.emit('checking-for-update');u.emit('update-available',{version:'1.3.0',releaseNotes:'<p>Fixes</p>',releaseDate:'2026-10-20'});};u.downloadUpdate=async()=>{u.calls.push('download');u.emit('download-progress',{percent:50});u.emit('update-downloaded',{version:'1.3.0'});};u.quitAndInstall=()=>u.calls.push('install');return u;}
test('nothing downloads or installs automatically; install is blocked while trading or reviews are active',async()=>{
  const updater=fake();let blocked='AUTO_TRADING_ARMED';let now=1e12;const changes=[];
  const updates=new AppUpdates({updater,enabled:true,version:'1.2.0',db:new DatabaseSync(':memory:'),canInstall:()=>blocked,clock:()=>now,onChange:s=>changes.push(s.status)});
  assert.equal(updater.autoDownload,false);assert.equal(updater.autoInstallOnAppQuit,false);assert.equal(updater.allowDowngrade,false);
  assert.throws(()=>updates.install(),/NO_UPDATE/);await assert.rejects(updates.download(),/NO_UPDATE/);
  const checked=await updates.check();assert.equal(checked.status,'available');assert.equal(checked.available.notes,'Fixes','markup removed from notes');assert.deepEqual(updater.calls,['check']);
  const downloaded=await updates.download();assert.equal(downloaded.status,'downloaded');assert.equal(downloaded.blockedReason,'AUTO_TRADING_ARMED');
  assert.throws(()=>updates.install(),/AUTO_TRADING_ARMED/);assert.ok(!updater.calls.includes('install'));
  blocked=null;assert.equal(updates.view().blockedReason,null);updates.install();assert.equal(updater.calls.at(-1),'install');
  assert.ok(changes.includes('downloading'));
});
test('automatic checks follow the setting and the 6-hour schedule; development builds are disabled',async()=>{
  const updater=fake();let now=1e12;const updates=new AppUpdates({updater,enabled:true,version:'1.2.0',db:new DatabaseSync(':memory:'),canInstall:()=>null,clock:()=>now});
  updates.saveSettings({checkAutomatically:false});updates.tick();await new Promise(r=>setImmediate(r));assert.equal(updater.calls.length,0);
  updates.saveSettings({checkAutomatically:true});updates.tick();await new Promise(r=>setImmediate(r));assert.deepEqual(updater.calls,['check']);
  assert.throws(()=>updates.saveSettings({checkAutomatically:'yes'}),/INVALID_SETTINGS/);
  const dev=new AppUpdates({updater:null,enabled:false,version:'1.2.0',db:new DatabaseSync(':memory:'),canInstall:()=>null});assert.equal(dev.view().status,'disabled');await assert.rejects(dev.check(),/UPDATES_DISABLED/);
  assert.equal(CHECK_EVERY_MS,6*3600000);
});
test('updater errors are reduced to codes without URLs or paths',()=>{
  assert.equal(publicError(new Error('net::ERR_NAME_NOT_RESOLVED https://github.com/x')),'NETWORK_UNAVAILABLE');assert.equal(publicError(new Error('HttpError: 404 Not Found https://api.github.com/repos/a/b')),'RELEASE_NOT_FOUND');
  assert.equal(publicError(new Error('sha512 checksum mismatch, expected abc')),'CHECKSUM_MISMATCH');assert.equal(publicError(new Error('C:\\Users\\me\\x failed')),'UPDATE_FAILED');
});
