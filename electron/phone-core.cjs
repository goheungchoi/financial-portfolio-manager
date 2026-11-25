// Phone control (1.6.0), stage P1: the command core, with no network (artifacts/reviews/2026-11-25-phone-control).
// It turns a Discord interaction (as the phone worker hands it over) into one of the seven commands, or refuses it:
// only the one allowed user, server, channel and application; each interaction id once; no older than 60 seconds and no
// more than 60 seconds ahead of this PC's clock (Discord's own time from the id); the PIN for Start and the lost-order
// fixes, checked against a salted scrypt hash and locked after 5 wrong entries until the desktop unlocks it; every command
// recorded without the PIN, the tokens or the ids. The PIN is a field of its own: compared, then dropped; it is in no
// returned object, record, log line or error. The commands themselves are wired in later stages to the desktop's own
// functions.
const crypto=require('node:crypto');
const COMMANDS=Object.freeze(['status','stop','stopall','start','orders','link','nottaken']);
const PIN_COMMANDS=new Set(['start','link','nottaken']);
const MAX_AGE_MS=60000,PENDING_MS=120000,PENDING_MAX=20,RECORD_KEEP=1000,LOCK_AFTER=5,CLOCK_WARN_AFTER=3,PER_MINUTE=10,SEEN_KEEP_MS=3600000;
// scrypt cost: N 2^15, r 8, p 1 (about 32 MB and some tens of milliseconds per check on a desktop); 64-byte key.
const SCRYPT={N:32768,r:8,p:1,maxmem:64*1024*1024},KEY_LEN=64;
const DISCORD_EPOCH=1420070400000n;
const SNOWFLAKE=/^\d{17,20}$/;
// Fixed sentences: nothing from Discord is echoed back.
const SENTENCES=Object.freeze({
  old:'This command is more than a minute old, so it was not acted on. Send it again.',
  future:'This command is dated more than a minute ahead of this PC\'s clock, so it was not acted on. The PC\'s clock may be wrong.',
  busy:'Too many commands in the last minute; this one was not acted on. Try again shortly.',
  locked:'Commands that need the PIN are locked after 5 wrong entries. Unlock them in Engine settings on the PC. Status and Stop still work.',
  wrongPin:'Wrong PIN. Nothing was done.',
  noPin:'No PIN is set. Set one in Engine settings on the PC first.',
  expired:'This confirmation has expired or was already used. Send the command again.',
  unrecorded:'The app could not record this command, so it was not acted on.',
  unknown:'That command is not known.'});
// Discord's time for an interaction, from its snowflake id: (id >> 22) + Discord's epoch (docs: Reference, Snowflakes).
const snowflakeTime=id=>{if(!SNOWFLAKE.test(String(id??'')))return null;return Number((BigInt(id)>>22n)+DISCORD_EPOCH);};
const str=(v,n)=>typeof v==='string'&&v.length<=n?v:null;

class PhoneCore{
  // allow: {user, server, channel, application}, each a Discord id (from the phone worker's validated keys). A missing or
  // malformed one leaves the core accepting nothing.
  constructor(db,{allow,clock=Date.now}){this.db=db;this.clock=clock;this.pending=new Map();this.recent=[];this.ageRun=0;this.clockSuspect=false;this.quiet={at:0,count:0};
    const ok=v=>typeof v==='string'&&SNOWFLAKE.test(v);this.allow=allow&&['user','server','channel','application'].every(k=>ok(allow[k]))?{user:allow.user,server:allow.server,channel:allow.channel,application:allow.application}:null;
    db.exec('CREATE TABLE IF NOT EXISTS phone_pin(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS phone_seen(id TEXT PRIMARY KEY,at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS phone_commands(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,payload TEXT NOT NULL)');}
  // ---- The PIN: set on the desktop only (6 to 12 digits), a salted scrypt hash; 5 wrong entries lock it. One check takes
  // about 41 ms on the development PC at N 2^15 (measured 2026-11-25), so it stays synchronous, behind the 10-a-minute limit.
  pinState(){try{const row=this.db.prepare('SELECT payload FROM phone_pin WHERE id=1').get();return row?JSON.parse(row.payload):null;}catch{return null;}}
  hasPin(){return Boolean(this.pinState()?.hash);}
  locked(){return Boolean(this.pinState()?.locked);}
  setPin(pin){if(typeof pin!=='string'||!/^\d{6,12}$/.test(pin))throw new Error('INVALID_PIN');const salt=crypto.randomBytes(16);
    const hash=crypto.scryptSync(pin,salt,KEY_LEN,SCRYPT);this.writePin({salt:salt.toString('base64'),hash:hash.toString('base64'),params:{N:SCRYPT.N,r:SCRYPT.r,p:SCRYPT.p,keyLen:KEY_LEN},wrong:0,locked:false,setAt:this.clock()});}
  unlock(){const s=this.pinState();if(s)this.writePin({...s,wrong:0,locked:false});}
  writePin(s){this.db.prepare('INSERT INTO phone_pin VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(s));}
  // ok, or a refusal: no PIN set, locked, wrong (counted; the fifth locks), or unrecorded (the count could not be written:
  // the check fails, so a broken table can never give unlimited tries).
  checkPin(pin){const s=this.pinState();if(!s?.hash)return {ok:false,why:'noPin'};if(s.locked)return {ok:false,why:'locked'};
    let good=false;try{const got=crypto.scryptSync(typeof pin==='string'?pin:'',Buffer.from(s.salt,'base64'),s.params.keyLen,{N:s.params.N,r:s.params.r,p:s.params.p,maxmem:SCRYPT.maxmem});good=crypto.timingSafeEqual(got,Buffer.from(s.hash,'base64'));}catch{good=false;}
    if(good){if(s.wrong)try{this.writePin({...s,wrong:0});}catch{}return {ok:true};}
    const wrong=(s.wrong??0)+1,locked=wrong>=LOCK_AFTER;try{this.writePin({...s,wrong,locked});}catch{return {ok:false,why:'unrecorded'};}return {ok:false,why:locked?'locked':'wrongPin',justLocked:locked};}
  // ---- An interaction from the phone worker: {id, type, applicationId, serverId, channelId, userId, command, options,
  // customId, pin}. Returns {act} for a command to carry out, {reply} for a fixed sentence to answer, or {silent} for one
  // that gets no answer (another user, server, channel or application; a repeat; a malformed one).
  accept(x){const now=this.clock();
    if(!this.allow)return this.silent('not-configured');
    if(!x||typeof x!=='object')return this.silent('shape');
    // Every id is a snowflake string before anything is compared (an array or an object with toString is malformed).
    for(const k of ['id','applicationId','serverId','channelId','userId'])if(typeof x[k]!=='string'||!SNOWFLAKE.test(x[k]))return this.silent('shape');
    const id=x.id;
    // Who: every id must match; a mismatch is not answered.
    for(const [k,want] of [['applicationId','application'],['serverId','server'],['channelId','channel'],['userId','user']])
      if(x[k]!==this.allow[want])return this.silent('not-'+want);
    // Once, failing closed: an id already seen is not acted on again; an id that cannot be read or recorded as seen is not
    // acted on at all.
    const seen=this.seen(id);if(seen===null)return {reply:SENTENCES.unrecorded,why:'unrecorded'};if(seen)return this.silent('repeat');
    if(!this.markSeen(id,now))return {reply:SENTENCES.unrecorded,why:'unrecorded'};
    const at=snowflakeTime(id),skew=now-at;
    if(skew>MAX_AGE_MS||skew<-MAX_AGE_MS){this.ageRun++;const why=skew>0?'old':'future';
      if(this.ageRun>=CLOCK_WARN_AFTER&&!this.clockSuspect)this.clockSuspect=true;this.record({command:this.nameOf(x),result:'refused-'+why});return {reply:SENTENCES[why],why};}
    this.ageRun=0;
    // At most PER_MINUTE commands a minute are acted on (ahead of any PIN check).
    this.recent=this.recent.filter(t=>now-t<60000);if(this.recent.length>=PER_MINUTE){this.record({command:this.nameOf(x),result:'refused-busy'});return {reply:SENTENCES.busy,why:'busy'};}this.recent.push(now);
    // What: a slash command (type 2), the Start confirm button (type 3, 'start-confirm:' only), or a PIN form submit (type
    // 5, 'pin:' only).
    let command,options={};
    if(x.type===2){command=str(x.command,20);if(!COMMANDS.includes(command))return {reply:SENTENCES.unknown,why:'unknown'};options=this.optionsOf(command,x.options);if(!options)return this.silent('shape');}
    else if(x.type===3||x.type===5){const m=/^(start-confirm|pin):([a-f0-9]{32})$/.exec(typeof x.customId==='string'?x.customId:'');if(!m)return this.silent('shape');
      const prefix=m[1],nonce=m[2];if((x.type===3)!==(prefix==='start-confirm'))return this.silent('shape');
      const p=this.takePending(nonce,{peek:x.type===3});
      // A held Start answers only with its launch token attached; a confirm button only for a held Start.
      // The confirm button is a gate (P4 review, 4): a PIN form for a Start is accepted only after its button was pressed.
      if(!p||(p.command==='start'&&!p.held)||(x.type===3&&p.command!=='start')||(x.type===5&&p.command==='start'&&p.confirmed!==true)){if(p&&x.type===5)this.pending.delete(nonce);this.record({command:'confirm',result:'expired'});return {reply:SENTENCES.expired,why:'expired'};}
      command=p.command;options=p.options;
      if(x.type===3){p.confirmed=true;return {act:{command,step:'ask-pin',nonce,options}};}// the confirm button: the worker answers with the PIN form
      // The PIN form: checked here and dropped; it goes no further than this function.
      if(PIN_COMMANDS.has(command)){const c=this.checkPin(x.pin);if(!c.ok){this.record({command,result:c.why});return {reply:SENTENCES[c.why],why:c.why,...(c.justLocked?{justLocked:true}:{})}}}
      return {act:{command,step:'run',options,...(p.held?{held:p.held}:{})}};}
    else return this.silent('shape');
    // A slash command that needs the PIN: Start first shows what would start (step 'summary'); the lost-order fixes go
    // straight to the PIN form. Either way a nonce holds the command for 2 minutes.
    if(PIN_COMMANDS.has(command)){if(!this.hasPin())return {reply:SENTENCES.noPin,why:'noPin'};if(this.locked())return {reply:SENTENCES.locked,why:'locked'};
      const n=this.hold(command,options);return {act:{command,step:command==='start'?'summary':'ask-pin',nonce:n,options}};}
    return {act:{command,step:'run',options}};}
  // The launch token (or other data) the main process kept for a held command, for its run.
  attach(nonce,held){const p=this.pending.get(nonce);if(p)p.held=held;}
  optionsOf(command,raw){const o=Array.isArray(raw)?Object.fromEntries(raw.filter(v=>v&&typeof v.name==='string').map(v=>[v.name,v.value])):{};
    if(command==='link'){const order=str(o.order,64),number=str(o.number,32);return order&&/^[A-Za-z0-9-]{1,64}$/.test(order)&&number&&/^[A-Za-z0-9-]{1,32}$/.test(number)?{order,number}:null;}
    if(command==='nottaken'){const order=str(o.order,64);return order&&/^[A-Za-z0-9-]{1,64}$/.test(order)?{order}:null;}
    return {};}
  // Held commands: expired ones dropped on every hold; at most PENDING_MAX (the oldest goes).
  hold(command,options){const now=this.clock();for(const [k,p] of this.pending)if(now-p.at>PENDING_MS)this.pending.delete(k);
    while(this.pending.size>=PENDING_MAX)this.pending.delete(this.pending.keys().next().value);
    const nonce=crypto.randomBytes(16).toString('hex');this.pending.set(nonce,{command,options,at:now});return nonce;}
  takePending(nonce,{peek=false}={}){const p=this.pending.get(nonce);if(!p)return null;if(this.clock()-p.at>PENDING_MS){this.pending.delete(nonce);return null;}if(!peek)this.pending.delete(nonce);return p;}
  nameOf(x){return x.type===2&&COMMANDS.includes(x.command)?x.command:x.type===3?'confirm':x.type===5?'pin':'unknown';}
  // true or false, or null when the table cannot be read (the caller then does not act).
  seen(id){try{return Boolean(this.db.prepare('SELECT 1 FROM phone_seen WHERE id=?').get(id));}catch{return null;}}
  // true once recorded as seen; false when it cannot be (the caller then does not act).
  markSeen(id,now){try{this.db.prepare('INSERT INTO phone_seen VALUES(?,?)').run(id,now);}catch{return false;}try{this.db.prepare('DELETE FROM phone_seen WHERE at<?').run(now-SEEN_KEEP_MS);}catch{}return true;}
  // Silent refusals are recorded at most once a minute; the ones in between are counted and carried in the next row.
  silent(why){const now=this.clock();if(now-this.quiet.at<60000){this.quiet.count++;}else{this.record({command:'-',result:why,...(this.quiet.count?{alsoRefused:this.quiet.count}:{})});this.quiet={at:now,count:0};}return {silent:true,why};}
  // The record: the command name and the result only; never the PIN, a token, an id or anything typed. The last 1,000 rows.
  record({command,result,alsoRefused}){try{this.db.prepare('INSERT INTO phone_commands(at,payload) VALUES(?,?)').run(this.clock(),JSON.stringify({command:String(command).slice(0,20),result:String(result).slice(0,40),...(Number.isInteger(alsoRefused)?{alsoRefused}:{})}));
    this.db.prepare('DELETE FROM phone_commands WHERE id<=(SELECT MAX(id) FROM phone_commands)-?').run(RECORD_KEEP);}catch{}}
  records(limit=50){try{return this.db.prepare('SELECT at,payload FROM phone_commands ORDER BY id DESC LIMIT ?').all(limit).map(r=>({at:r.at,...JSON.parse(r.payload)}));}catch{return [];}}
}
module.exports={PENDING_MAX,RECORD_KEEP,PhoneCore,COMMANDS,PIN_COMMANDS,SENTENCES,snowflakeTime,MAX_AGE_MS,PENDING_MS,LOCK_AFTER,CLOCK_WARN_AFTER,PER_MINUTE,SCRYPT};
