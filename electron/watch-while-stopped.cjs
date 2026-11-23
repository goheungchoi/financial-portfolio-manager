// Orders while stopped, B-3 (artifacts/reviews/2026-11-24-orders-while-stopped): the setting "Keep conditional orders
// working while auto trading is stopped", its consent and the switches record, kept in one row of their own.
// - The row exists only while the setting is on. Turning it on is the consent for the KIS account and environment then
//   connected; a different account or environment connected later makes it void (the row is removed: the setting reads
//   off), so the mock and the live accounts never share a consent.
// - record: the switches in force while auto trading last ran on that account (taken at Start, when the setting is turned
//   on while running, and when "Submit them automatically" is saved while running). While stopped they decide whether a
//   watched order is sent by itself, as while running; the live "Submit them automatically" can only turn that off. No
//   record, or a market not in scope at that Start: watched and only proposed.
// - everythingStopped: Stop everything, kept across a restart; cleared by Start or by turning the setting on again.
// Not part of the saved automation settings, so nothing of it reaches a review, the settings revision or the start token.
const TABLE='CREATE TABLE IF NOT EXISTS conditional_watch(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)';
const MARKETS=['KR','US'];
const inScope=(scope,market)=>market==='KR'?['kis','both'].includes(scope):market==='US'?['us','both'].includes(scope):false;
class WatchWhileStopped{
  constructor(db,clock=()=>Date.now()){this.db=db;this.clock=clock;db.exec(TABLE);}
  // The row, or null (also for a row that cannot be read: off, the safe side).
  get(){const row=this.db.prepare('SELECT payload FROM conditional_watch WHERE id=1').get();if(!row)return null;
    try{const v=JSON.parse(row.payload);return v&&typeof v.account==='string'&&v.account&&['live','mock'].includes(v.environment)?v:null;}catch{return null;}}
  put(v){this.db.prepare('INSERT INTO conditional_watch(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(v));return v;}
  clear(){this.db.prepare('DELETE FROM conditional_watch WHERE id=1').run();}
  turnOn({account,environment,record=null}){if(typeof account!=='string'||!account||!['live','mock'].includes(environment))throw new Error('KIS_NOT_CONNECTED');
    return this.put({account,environment,givenAt:this.clock(),record,everythingStopped:false});}
  // Whether the consent is for this account and environment.
  matches(connected){const v=this.get();return Boolean(v&&connected&&v.account===connected.account&&v.environment===connected.environment);}
  setRecord(record){const v=this.get();if(v)this.put({...v,record});}
  stopEverything(){const v=this.get();if(v)this.put({...v,everythingStopped:true});}
  started(record){const v=this.get();if(v)this.put({...v,record,everythingStopped:false});}
}
// The switches in force now (call it only while auto trading runs): per market, whether it was in scope with its
// trading and automatic switches on.
function recordOf({config,engines,now=Date.now()}){
  const markets=Object.fromEntries(MARKETS.map(m=>{const e=engines[m];return [m,Boolean(inScope(config.scope,m)&&e&&e.enabled===true&&e.autoEnabled===true)];}));
  return {autoSubmit:config.autoSubmit===true,conditionalAutoSubmit:config.conditionalAutoSubmit===true,scope:config.scope,markets,at:now};}
// Whether a watched order of this market is sent by itself while stopped: by the record, and only if "Submit them
// automatically" is still on (it can turn sending off, never on).
function autoWhileStopped(row,config,market){const r=row?.record;return Boolean(r&&r.autoSubmit===true&&r.conditionalAutoSubmit===true&&r.markets?.[market]===true&&config.conditionalAutoSubmit===true&&inScope(config.scope,market));}
module.exports={WatchWhileStopped,recordOf,autoWhileStopped,inScope,MARKETS};
