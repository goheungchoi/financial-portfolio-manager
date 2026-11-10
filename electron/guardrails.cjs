const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
// Autopilot guardrails: hard responses to loss limits, automatic-order caps and repeated review failures.
const LOSS_ACTIONS=['review','block-buys','stop'];
function validateGuardrails(next){
  if(!LOSS_ACTIONS.includes(next.lossAction)||!Number.isInteger(next.maxAutoOrdersPerDay)||next.maxAutoOrdersPerDay<0||next.maxAutoOrdersPerDay>100||!Number.isInteger(next.maxConsecutiveFailures)||next.maxConsecutiveFailures<0||next.maxConsecutiveFailures>20||typeof next.digestEnabled!=='boolean'||!Number.isInteger(next.digestHour)||next.digestHour<0||next.digestHour>23)throw new Error('INVALID_SETTINGS');
}
class Guardrails {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS guardrail_events(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS review_failures(day TEXT PRIMARY KEY,count INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS auto_order_slots(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL);');this.failureStreak=0;}
  record(kind,detail,now=Date.now()){const event={id:randomUUID(),kind,detail,timestamp:now};this.db.prepare('INSERT INTO guardrail_events VALUES(?,?,?)').run(event.id,seoulDate(now),JSON.stringify(event));return event;}
  events(limit=20){return this.db.prepare('SELECT payload FROM guardrail_events ORDER BY rowid DESC LIMIT ?').all(limit).map(row=>JSON.parse(row.payload));}
  eventsOn(day){return this.db.prepare('SELECT payload FROM guardrail_events WHERE day=? ORDER BY rowid').all(day).map(row=>JSON.parse(row.payload));}
  // Automatic submissions today (Seoul day), across every route (1.5.48 audit, A6). Each automatic submission takes a
  // durable slot before it is sent (reserveSlot): reviews and conditional orders alike, so the count survives restart and
  // two routes cannot both take the last slot. A slot counts unless it was released because nothing was sent. Reviews
  // recorded before slots existed still count, once: a review that has a slot is not counted again.
  slots(day){return this.db.prepare('SELECT payload FROM auto_order_slots WHERE day=? ORDER BY rowid').all(day).map(row=>JSON.parse(row.payload));}
  autoOrdersToday(now=Date.now()){const day=seoulDate(now),slots=this.slots(day),refs=new Set(slots.map(s=>s.ref));
    const legacy=this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.orderId') IS NOT NULL").all().map(row=>JSON.parse(row.payload)).filter(row=>seoulDate(row.timestamp)===day&&!refs.has(row.id)).length;
    return slots.filter(s=>s.state!=='released').length+legacy;}
  // Takes a slot for an automatic submission, or null when the cap is reached. Synchronous: no other route can take the
  // same slot between the count and the write. closing: a sale or cover that reduces exposure is admitted at the cap
  // (never held back by it) and still counted.
  reserveSlot({cap,source,ref,closing=false,now=Date.now()}){if(cap>0&&!closing&&this.autoOrdersToday(now)>=cap)return null;
    const slot={id:randomUUID(),day:seoulDate(now),source,ref:String(ref),closing:Boolean(closing),state:'reserved',at:now};this.db.prepare('INSERT INTO auto_order_slots VALUES(?,?,?)').run(slot.id,slot.day,JSON.stringify(slot));return slot.id;}
  // used: the order may be at the broker (sent, unclear, accepted or refused by KIS). released: the engine's record shows
  // it was never sent. A reserved slot that is never settled keeps counting.
  settleSlot(id,state,detail=null){if(!id)return;const row=this.db.prepare('SELECT payload FROM auto_order_slots WHERE id=?').get(id);if(!row)return;const slot=JSON.parse(row.payload);if(slot.state!=='reserved')return;
    this.db.prepare('UPDATE auto_order_slots SET payload=? WHERE id=?').run(JSON.stringify({...slot,state,settledAt:Date.now(),...(detail?{detail}:{})}),id);}
  failuresOn(day){return this.db.prepare('SELECT count FROM review_failures WHERE day=?').get(day)?.count??0;}
  failed(now=Date.now()){const day=seoulDate(now);this.db.prepare('INSERT INTO review_failures VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);return ++this.failureStreak;}
  succeeded(){this.failureStreak=0;}
  // autoOrders: today's count when the caller already has it (Automation caches it between writes, lag fix L1).
  state(config,now=Date.now(),{autoOrders=null}={}){const today=this.eventsOn(seoulDate(now));return {events:this.events(),autoOrdersToday:autoOrders??this.autoOrdersToday(now),failureStreak:this.failureStreak,trippedToday:today.some(event=>event.kind==='auto-stopped'),lossAction:config.lossAction};}
}
module.exports={Guardrails,validateGuardrails,LOSS_ACTIONS};
