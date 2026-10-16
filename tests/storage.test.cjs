const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PortfolioStore } = require('../electron/storage.cjs');
test('settings, ordered events, and allowlisted snapshots survive reopening', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-storage-'));
  const filename = path.join(directory,'test.sqlite');
  let store = new PortfolioStore(filename);
  try {
    store.setTheme('light');
    assert.throws(()=>store.setTheme('invalid'));
    const event = {id:'a',runId:'r',timestamp:'2026-10-14',kind:'System',title:'Demo',body:'No orders', extra:'excluded'};
    store.appendEvent(event); store.appendEvent(event);
    store.saveSnapshot({timestamp:'2026-10-14',cash:100,holdings:[],appSecret:'excluded'});
    store.close(); store = new PortfolioStore(filename);
    assert.equal(store.getTheme(),'light');
    assert.equal(store.getEvents().length,1);
    assert.equal(store.getEvents()[0].extra,undefined);
    assert.deepEqual(store.latestSnapshot(),{timestamp:'2026-10-14',environment:'synthetic',cash:100,holdings:[]});
    for(let i=0;i<610;i++) store.appendEvent({...event,id:String(i)});
    assert.equal(store.getEvents().length,600);
    assert.equal(store.getEvents()[0].id,'10');
  } finally { store.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});
