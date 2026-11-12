'use strict';
// How the app last stopped (restart part 1, step 1; artifacts/reviews/2026-11-12-restart). One row: when this run started,
// its last heartbeat (every 60 s while running), and how it ended when the app was told: a clean quit by the user, or a
// Windows session end (restart, shutdown, sign-out) with Windows' reasons. A run that ended with no word (crash, kill,
// power loss, a forced restart that sent nothing) keeps no stop, and its last heartbeat is the best known time.
// Nothing here throws: a failed read or write is ignored, so it can never stop the app from starting or closing.

const TABLE='CREATE TABLE IF NOT EXISTS app_exit(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)';
const KINDS=['clean','windows-shutdown'];
const knownScope=s=>typeof s==='string'&&s.includes(':')&&!s.endsWith(':disconnected');

class ExitRecord {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;try{db.exec(TABLE);}catch{}}
  read(){try{const row=this.db.prepare('SELECT payload FROM app_exit WHERE id=1').get();const p=row?JSON.parse(row.payload):null;return p&&typeof p==='object'?p:null;}catch{return null;}}
  write(record){try{this.db.prepare('INSERT INTO app_exit VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(record));return true;}catch{return false;}}
  // At start: the previous run's record (null on a first start), then this run's row.
  begin(){const previous=this.read();const now=this.clock();this.current={startedAt:now,heartbeatAt:now,stop:null};this.write(this.current);return previous;}
  // A heartbeat while the stop is still tentative means the shutdown was cancelled (the app is still running): the
  // tentative stop is cleared. After a confirmed stop there is no heartbeat.
  // scope: the account scope being watched (e.g. 'both:<account>'), so the next start counts that account's stops only
  // (step 2 review); a disconnected or missing scope keeps the last known one.
  heartbeat(scope=null){if(!this.current)return false;if(this.current.stop&&!this.current.stop.tentative)return false;
    const {stop:_,...rest}=this.current;this.current={...rest,stop:null,heartbeatAt:this.clock(),...(knownScope(scope)?{scope}:{})};return this.write(this.current);}
  // stop(kind, reasons, tentative): Windows asking whether the session may end (query-session-end) is a question, and
  // the shutdown can still be cancelled, so it writes a tentative stop; session-end confirms it. The first confirmed word
  // wins: a Windows session end is not overwritten by the quit that follows it, and a clean quit does not replace a
  // tentative Windows stop (with no session-end and no heartbeat after it, it still reads as a Windows shutdown).
  stop(kind,reasons=null,tentative=false){if(!this.current||!KINDS.includes(kind))return false;const prior=this.current.stop;
    if(prior&&!prior.tentative)return true;
    if(prior?.tentative&&!(kind==='windows-shutdown'&&!tentative))return true;
    const why=Array.isArray(reasons)&&reasons.length?reasons.map(String).slice(0,4):prior?.reasons??null;
    this.current={...this.current,stop:{kind,at:this.clock(),...(why?{reasons:why}:{}),...(tentative?{tentative:true}:{})}};return this.write(this.current);}
  // The shutdown phone alert was confirmed sent (step 2). Best effort: the process may end before this is written.
  markPhoneSent(){if(!this.current?.stop)return false;this.current={...this.current,stop:{...this.current.stop,phoneSent:true}};return this.write(this.current);}
}

/**
 * How the previous run ended, from its record, or null on a first start (no record).
 * kind: 'clean' (the user quit), 'windows-shutdown' (Windows ended the session), or 'unexpected' (no word: crash, kill,
 * power loss); at: the stop time, or for 'unexpected' the last heartbeat. timeUncertain: the recorded time is later than
 * now (the clock moved backwards since), so the time is shown as recorded but not relied on.
 */
function lastStop(record,now=Date.now()){
  if(!record||typeof record!=='object')return null;
  const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;
  const stop=record.stop&&KINDS.includes(record.stop.kind)?record.stop:null;
  const at=stop?finite(stop.at)??finite(record.heartbeatAt):finite(record.heartbeatAt)??finite(record.startedAt);
  return {kind:stop?stop.kind:'unexpected',at,...(knownScope(record.scope)?{scope:record.scope}:{}),...(stop?.reasons?{reasons:stop.reasons}:{}),...(stop?.phoneSent?{phoneSent:true}:{}),...(at!=null&&at>now?{timeUncertain:true}:{})};
}
module.exports={ExitRecord,lastStop,knownScope};
