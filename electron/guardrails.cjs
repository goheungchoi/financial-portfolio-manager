const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
// Autopilot guardrails: hard responses to loss limits, automatic-order caps and repeated review failures.
const LOSS_ACTIONS=['review','block-buys','stop'];
function validateGuardrails(next){
  if(!LOSS_ACTIONS.includes(next.lossAction)||!Number.isInteger(next.maxAutoOrdersPerDay)||next.maxAutoOrdersPerDay<0||next.maxAutoOrdersPerDay>100||!Number.isInteger(next.maxConsecutiveFailures)||next.maxConsecutiveFailures<0||next.maxConsecutiveFailures>20||typeof next.digestEnabled!=='boolean'||!Number.isInteger(next.digestHour)||next.digestHour<0||next.digestHour>23)throw new Error('INVALID_SETTINGS');
}
class Guardrails {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS guardrail_events(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS review_failures(day TEXT PRIMARY KEY,count INTEGER NOT NULL);');this.failureStreak=0;}
  record(kind,detail,now=Date.now()){const event={id:randomUUID(),kind,detail,timestamp:now};this.db.prepare('INSERT INTO guardrail_events VALUES(?,?,?)').run(event.id,seoulDate(now),JSON.stringify(event));return event;}
  events(limit=20){return this.db.prepare('SELECT payload FROM guardrail_events ORDER BY rowid DESC LIMIT ?').all(limit).map(row=>JSON.parse(row.payload));}
  eventsOn(day){return this.db.prepare('SELECT payload FROM guardrail_events WHERE day=? ORDER BY rowid').all(day).map(row=>JSON.parse(row.payload));}
  // Automatic submissions today, counted from recorded reviews so the cap survives restart.
  autoOrdersToday(now=Date.now()){const day=seoulDate(now);return this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.orderId') IS NOT NULL").all().map(row=>JSON.parse(row.payload)).filter(row=>seoulDate(row.timestamp)===day).length;}
  failuresOn(day){return this.db.prepare('SELECT count FROM review_failures WHERE day=?').get(day)?.count??0;}
  failed(now=Date.now()){const day=seoulDate(now);this.db.prepare('INSERT INTO review_failures VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);return ++this.failureStreak;}
  succeeded(){this.failureStreak=0;}
  state(config,now=Date.now()){const today=this.eventsOn(seoulDate(now));return {events:this.events(),autoOrdersToday:this.autoOrdersToday(now),failureStreak:this.failureStreak,trippedToday:today.some(event=>event.kind==='auto-stopped'),lossAction:config.lossAction};}
}
module.exports={Guardrails,validateGuardrails,LOSS_ACTIONS};
