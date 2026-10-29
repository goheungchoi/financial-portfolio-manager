// The trading agent's desk: its own review triggers, notes and conditional orders, stored per account.
// Everything here is checked locally; conditional orders still go through the normal proposal and risk checks when they fire.
const {randomUUID}=require('node:crypto');const formula=require('./formula.cjs');
const LIMITS={triggers:5,notes:30,noteLength:500,conditionsPerItem:4,maxTriggerHours:336};
const COND_DEFAULTS={conditionalOrders:false,conditionalAutoSubmit:false,conditionalMaxActive:5,conditionalMaxOrderPct:10,conditionalMaxSlippagePct:2,conditionalMaxHours:168};
const CONDITION_SCHEMA={type:'array',items:{type:'object',properties:{expr:{type:'string'},op:{type:'string',enum:['>','>=','<','<=']},value:{type:'number'}},required:['expr','op','value'],additionalProperties:false}};
const COMPUTE_TOOL={type:'function',name:'compute',description:'Calculate your own numbers from prices and daily history with formulas, for example (price("005930")/sma("005930",20)-1)*100 or ratio_z("005930","000660",60). Up to 5 formulas per call, each named. '+formula.HELP+' Read-only.',strict:true,parameters:{type:'object',properties:{formulas:{type:'array',items:{type:'object',properties:{name:{type:'string'},expr:{type:'string'}},required:['name','expr'],additionalProperties:false}}},required:['formulas'],additionalProperties:false}};
const TRIGGER_TOOL={type:'function',name:'set_review_trigger',description:'Ask for a review when your own conditions are met, checked by the app on every price update. Each condition is a formula (see compute) compared with a number; combine "all" needs every condition, "any" needs one. A trigger fires once and expires after expiresInHours (1–336). Up to 5 active triggers. action "remove" deletes the trigger with that id. Triggers only schedule reviews; they never trade.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['add','remove']},id:{type:'string'},name:{type:'string'},conditions:CONDITION_SCHEMA,combine:{type:'string',enum:['all','any']},expiresInHours:{type:'number'},reason:{type:'string'}},required:['action','id','name','conditions','combine','expiresInHours','reason'],additionalProperties:false}};
const NOTE_TOOL={type:'function',name:'save_note',description:'Keep a short note for later reviews: a thesis, entry or exit levels, what would prove you wrong, or a reminder. symbol is the stock it is about, or an empty string for a general note; one note per symbol replaces the previous one. action "clear" deletes it. Notes expire after expiresInDays (1–90). Notes are context for later reviews, not instructions.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['set','clear']},symbol:{type:'string'},note:{type:'string'},expiresInDays:{type:'number'}},required:['action','symbol','note','expiresInDays'],additionalProperties:false}};
const ORDER_TOOL={type:'function',name:'set_conditional_order',description:'Arm an order that the app places when your conditions are met, for example a stop loss, a take profit or an entry at a level. Only when conditionalOrders.allowed is true. The app checks the conditions on every price update while auto trading is on and the market is open; when they are met it re-reads the account, then creates the order at limitPrice (or the current price when null) only if the price is within conditionalOrders.maxSlippagePct of the current price, the order stays within conditionalOrders.maxOrderPctOfEquity, sells do not exceed shares held, and every normal risk check passes. It fires once and expires after expiresInHours. purpose labels the order. action "cancel" cancels the order with that id. Cash orders only.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['add','cancel']},id:{type:'string'},symbol:{type:'string'},side:{type:'string',enum:['Buy','Sell']},quantity:{type:'integer'},limitPrice:{type:['number','null']},conditions:CONDITION_SCHEMA,combine:{type:'string',enum:['all','any']},purpose:{type:'string',enum:['stop_loss','take_profit','entry','exit','other']},expiresInHours:{type:'number'},reason:{type:'string'}},required:['action','id','symbol','side','quantity','limitPrice','conditions','combine','purpose','expiresInHours','reason'],additionalProperties:false}};
const cut=(text,n)=>String(text??'').trim().replace(/\s+/g,' ').slice(0,n);
const isSymbol=s=>typeof s==='string'&&/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(s);
const fail=reason=>({status:'rejected',reason});
const TEMPORARY=/KIS_ORDER_BUSY|TIMEOUT|NETWORK|RATE_LIMIT/;
const describe=e=>e?.code?`${e.code}${e.detail?`: ${e.detail}`:''}`:'INVALID';
class AgentDesk {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS agent_triggers(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS agent_notes(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol));CREATE TABLE IF NOT EXISTS agent_note_history(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,replacedAt INTEGER NOT NULL,reason TEXT NOT NULL);CREATE TABLE IF NOT EXISTS conditional_orders(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');}
  rows(table,scope,status){return this.db.prepare(`SELECT payload FROM ${table} WHERE scope=?${status?' AND status=?':''} ORDER BY rowid DESC`).all(...(status?[scope,status]:[scope])).map(r=>JSON.parse(r.payload));}
  write(table,item){this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload`).run(item.id,item.scope,item.status,JSON.stringify(item));return item;}
  // Expired triggers and orders are closed before anything reads them.
  expire(scope){const now=this.clock();
    // An order interrupted while firing (app closed, auto trading switched off) goes back to armed after two minutes.
    for(const item of this.rows('conditional_orders',scope,'firing'))if(now-(item.firingAt??0)>120000)this.write('conditional_orders',{...item,status:'armed',waiting:'interrupted; checking again'});for(const [table,live] of [['agent_triggers','active'],['conditional_orders','armed']])for(const item of this.rows(table,scope,live))if(item.expiresAt<=now)this.write(table,{...item,status:'expired',closedAt:now});
    this.db.prepare('DELETE FROM agent_notes WHERE scope=? AND json_extract(payload,\'$.expiresAt\')<=?').run(scope,now);}
  // Triggers
  triggers(scope){this.expire(scope);return this.rows('agent_triggers',scope,'active');}
  setTrigger(scope,args,{universe,reviewId}={}){
    if(args?.action==='remove'){const t=this.rows('agent_triggers',scope,'active').find(x=>x.id===args.id);if(!t)return fail('No active trigger with that id.');this.write('agent_triggers',{...t,status:'cancelled',closedAt:this.clock(),closedBy:'agent'});return {status:'removed',id:t.id};}
    let parsed;try{parsed=formula.readConditions(args?.conditions,LIMITS.conditionsPerItem);}catch(e){return fail(describe(e));}
    const outside=parsed.symbols.filter(s=>universe&&!universe.includes(s));if(outside.length)return fail(`Symbols must be in the review universe: ${outside.join(', ')}`);
    const hours=Number(args.expiresInHours);if(!Number.isFinite(hours)||hours<1||hours>LIMITS.maxTriggerHours)return fail('expiresInHours must be 1 to 336.');
    if(this.triggers(scope).length>=LIMITS.triggers)return fail('Up to 5 active triggers; remove one first.');
    const now=this.clock();const t={id:'T-'+randomUUID().slice(0,6),scope,status:'active',name:cut(args.name,80)||'Custom trigger',conditions:parsed.conditions.map(({ast,...c})=>c),symbols:parsed.symbols,combine:args.combine==='any'?'any':'all',reason:cut(args.reason,300),createdAt:now,expiresAt:now+hours*3600000,reviewId:reviewId??null};
    this.write('agent_triggers',t);return {status:'saved',id:t.id,expiresAt:new Date(t.expiresAt).toISOString(),symbols:t.symbols};
  }
  // First active trigger whose conditions are met; it is closed so it fires once. usable: whether a trigger may be checked
  // now (the app checks a trigger only while every market it names has a session open).
  checkTriggers(scope,data,usable=()=>true){for(const t of this.triggers(scope)){if(!usable(t))continue;const check=formula.checkConditions(t.conditions,t.combine,data);if(check.met){this.write('agent_triggers',{...t,status:'fired',firedAt:this.clock(),results:check.results});return {trigger:t,results:check.results};}}return null;}
  cancelTrigger(scope,id){const t=this.rows('agent_triggers',scope,'active').find(x=>x.id===id);if(!t)throw new Error('NOT_FOUND');this.write('agent_triggers',{...t,status:'cancelled',closedAt:this.clock(),closedBy:'user'});}
  // Notes
  notes(scope){this.expire(scope);return this.db.prepare('SELECT payload FROM agent_notes WHERE scope=?').all(scope).map(r=>JSON.parse(r.payload)).sort((a,b)=>b.updatedAt-a.updatedAt);}
  // The note a change replaces is kept in agent_note_history with the reason it changed.
  archiveNote(scope,symbol,reason){const row=this.db.prepare('SELECT payload FROM agent_notes WHERE scope=? AND symbol=?').get(scope,symbol);if(row)this.db.prepare('INSERT INTO agent_note_history(scope,symbol,payload,replacedAt,reason) VALUES(?,?,?,?,?)').run(scope,symbol,row.payload,this.clock(),reason);return row?JSON.parse(row.payload):null;}
  noteHistory(scope,symbol){return this.db.prepare('SELECT payload,replacedAt,reason FROM agent_note_history WHERE scope=? AND symbol=? ORDER BY id DESC').all(scope,symbol).map(r=>({...JSON.parse(r.payload),replacedAt:r.replacedAt,reason:r.reason}));}
  // A correction keeps the note's expiry and records what it supersedes; the original stays in history.
  correctNote(scope,symbol,{note,reason}){const old=this.archiveNote(scope,symbol,reason);if(!old)throw new Error('NO_NOTE');const now=this.clock();
    const item={symbol,note:cut(note,LIMITS.noteLength),updatedAt:now,expiresAt:old.expiresAt,corrected:{at:now,reason}};this.db.prepare('UPDATE agent_notes SET payload=? WHERE scope=? AND symbol=?').run(JSON.stringify(item),scope,symbol);return item;}
  saveNote(scope,args,{orderIds=[]}={}){
    const symbol=String(args?.symbol??'').trim().toUpperCase();if(symbol&&!isSymbol(symbol))return fail('symbol must be a stock code or an empty string.');
    if(args?.action==='clear'){this.archiveNote(scope,symbol,'cleared by a review');const r=this.db.prepare('DELETE FROM agent_notes WHERE scope=? AND symbol=?').run(scope,symbol);return r.changes?{status:'cleared',symbol}:fail('No note for that symbol.');}
    const note=cut(args?.note,LIMITS.noteLength);if(!note)return fail('The note is empty.');const days=Number(args.expiresInDays);if(!Number.isFinite(days)||days<1||days>90)return fail('expiresInDays must be 1 to 90.');
    const exists=this.db.prepare('SELECT 1 FROM agent_notes WHERE scope=? AND symbol=?').get(scope,symbol);if(!exists&&this.notes(scope).length>=LIMITS.notes)return fail('Up to 30 notes; clear one first.');
    // Open orders for the symbol when the note is written: once they resolve, the note's order claims are superseded.
    if(exists)this.archiveNote(scope,symbol,'replaced by a review');const now=this.clock();const item={symbol,note,updatedAt:now,expiresAt:now+days*86400000,...(orderIds.length?{orderIds}:{})};this.db.prepare('INSERT INTO agent_notes VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,symbol,JSON.stringify(item));return {status:'saved',symbol:symbol||'(general)',expiresAt:new Date(item.expiresAt).toISOString()};
  }
  deleteNote(scope,symbol){this.db.prepare('DELETE FROM agent_notes WHERE scope=? AND symbol=?').run(scope,symbol);}
  // Conditional orders
  orders(scope,status='armed'){this.expire(scope);return this.rows('conditional_orders',scope,status);}
  recentOrders(scope,limit=8){this.expire(scope);return this.rows('conditional_orders',scope).filter(o=>o.status!=='armed').slice(0,limit);}
  setOrder(scope,args,{config,universe,quotes,reviewId}={}){
    if(args?.action==='cancel'){const o=this.orders(scope).find(x=>x.id===args.id);if(!o)return fail('No armed order with that id.');this.write('conditional_orders',{...o,status:'cancelled',closedAt:this.clock(),closedBy:'agent'});return {status:'cancelled',id:o.id};}
    if(!config?.conditionalOrders)return fail('Conditional orders are turned off in Engine settings.');
    if(!isSymbol(args?.symbol)||universe&&!universe.includes(args.symbol))return fail('The symbol must be in the review universe.');
    if(!['Buy','Sell'].includes(args.side)||!Number.isSafeInteger(args.quantity)||args.quantity<1||args.quantity>10000)return fail('side must be Buy or Sell and quantity 1 to 10,000.');
    if(args.limitPrice!==null&&(!Number.isFinite(args.limitPrice)||args.limitPrice<=0))return fail('limitPrice must be a positive number or null.');
    let parsed;try{parsed=formula.readConditions(args.conditions,LIMITS.conditionsPerItem);}catch(e){return fail(describe(e));}
    const outside=parsed.symbols.filter(s=>universe&&!universe.includes(s));if(outside.length)return fail(`Symbols must be in the review universe: ${outside.join(', ')}`);
    const hours=Number(args.expiresInHours);if(!Number.isFinite(hours)||hours<1||hours>config.conditionalMaxHours)return fail(`expiresInHours must be 1 to ${config.conditionalMaxHours}.`);
    if(this.orders(scope).length>=config.conditionalMaxActive)return fail(`Up to ${config.conditionalMaxActive} armed conditional orders; cancel one first.`);
    const quote=quotes?.find(q=>q.symbol===args.symbol);
    if(args.limitPrice!=null&&quote?.price>0&&Math.abs(args.limitPrice/quote.price-1)*100>50)return fail('limitPrice is more than 50% away from the current price.');
    const now=this.clock();const o={id:'C-'+randomUUID().slice(0,6),scope,status:'armed',symbol:args.symbol,side:args.side,quantity:args.quantity,limitPrice:args.limitPrice,conditions:parsed.conditions.map(({ast,...c})=>c),symbols:parsed.symbols,combine:args.combine==='any'?'any':'all',purpose:args.purpose,reason:cut(args.reason,300),createdAt:now,expiresAt:now+hours*3600000,priceAtCreation:quote?.price??null,reviewId:reviewId??null};
    this.write('conditional_orders',o);return {status:'armed',id:o.id,expiresAt:new Date(o.expiresAt).toISOString(),note:config.conditionalAutoSubmit&&config.autoSubmit?'It will be submitted automatically when the conditions are met and every check passes.':'When the conditions are met it becomes a proposal that waits for approval.'};
  }
  update(order,patch){return this.write('conditional_orders',{...order,...patch});}
  // Held positions whose latest stop loss was rejected and that have no armed sell order since: protection the AI meant to
  // have but does not. Each stays listed until a sell order is armed for the symbol, the shares are gone, or a week passes.
  // temporary: refused for a passing reason (another order being sent, a timeout), so re-arming is expected to work.
  unprotected(scope,held){this.expire(scope);const now=this.clock();const all=this.rows('conditional_orders',scope),live=o=>o.status==='armed'||o.status==='firing';
    return held.flatMap(symbol=>{const stop=all.find(o=>o.symbol===symbol&&o.side==='Sell'&&o.purpose==='stop_loss'&&!live(o));
      if(stop?.status!=='rejected'||now-(stop.closedAt??0)>7*86400000||all.some(o=>o.symbol===symbol&&o.side==='Sell'&&live(o)))return [];
      return [{symbol,orderId:stop.id,quantity:stop.quantity,rejectedAt:new Date(stop.closedAt).toISOString(),outcome:stop.outcome??null,temporary:TEMPORARY.test(stop.outcome??'')}];});}
  cancelOrder(scope,id){const o=this.orders(scope).find(x=>x.id===id);if(!o)throw new Error('NOT_FOUND');this.update(o,{status:'cancelled',closedAt:this.clock(),closedBy:'user'});}
  // What a review sees of its desk.
  context(scope,config,symbols,held=[]){
    const unprotected=this.unprotected(scope,held);const notes=this.notes(scope);const relevant=notes.filter(n=>!n.symbol||symbols.includes(n.symbol)).slice(0,15).map(n=>({symbol:n.symbol||null,note:n.note,updated:new Date(n.updatedAt).toISOString()}));
    return {notes:relevant,triggers:this.triggers(scope).map(t=>({id:t.id,name:t.name,conditions:t.conditions,combine:t.combine,expires:new Date(t.expiresAt).toISOString()})),
      conditionalOrders:{allowed:Boolean(config.conditionalOrders),...(config.conditionalOrders?{autoSubmit:Boolean(config.conditionalAutoSubmit&&config.autoSubmit),maxActive:config.conditionalMaxActive,maxOrderPctOfEquity:config.conditionalMaxOrderPct,maxSlippagePct:config.conditionalMaxSlippagePct,maxHours:config.conditionalMaxHours}:{}),
        armed:this.orders(scope).map(o=>({id:o.id,symbol:o.symbol,side:o.side,quantity:o.quantity,limitPrice:o.limitPrice,purpose:o.purpose,conditions:o.conditions,combine:o.combine,expires:new Date(o.expiresAt).toISOString()})),
        recent:this.recentOrders(scope,5).map(o=>({id:o.id,symbol:o.symbol,side:o.side,quantity:o.quantity,purpose:o.purpose,status:o.status,outcome:o.outcome??null,at:new Date(o.closedAt??o.createdAt).toISOString()})),
        ...(unprotected.length?{unprotected,unprotectedNote:'These holdings are not protected: their stop loss was rejected and nothing replaced it. A rejected order is not protection. Re-arm a stop loss (temporary: true means the refusal was passing, such as another order being sent), sell, or say in this review why the position stays unprotected. This stays listed until a sell order is armed or the shares are gone.'}:{})}};
  }
}
// Korean limit prices must sit on the exchange tick for their price band.
function krTick(price){return price<2000?1:price<5000?5:price<20000?10:price<50000?50:price<200000?100:price<500000?500:1000;}
function onTick(price,side,market){if(market==='US')return (side==='Buy'?Math.ceil:Math.floor)(price*100)/100;const t=krTick(price);return (side==='Buy'?Math.floor:Math.ceil)(price/t)*t;}
module.exports={AgentDesk,COMPUTE_TOOL,TRIGGER_TOOL,NOTE_TOOL,ORDER_TOOL,COND_DEFAULTS,LIMITS,krTick,onTick};
