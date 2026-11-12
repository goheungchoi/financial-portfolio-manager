// The trading agent's desk: its own review triggers, notes and conditional orders, stored per account.
// Everything here is checked locally; conditional orders still go through the normal proposal and risk checks when they fire.
const {randomUUID}=require('node:crypto');const formula=require('./formula.cjs');
const LIMITS={triggers:5,notes:30,noteLength:500,conditionsPerItem:4,maxTriggerHours:336};
const COND_DEFAULTS={conditionalOrders:false,conditionalAutoSubmit:false,conditionalMaxActive:5,conditionalMaxOrderPct:10,conditionalMaxSlippagePct:2,conditionalMaxHours:168};
const CONDITION_SCHEMA={type:'array',items:{type:'object',properties:{expr:{type:'string'},op:{type:'string',enum:['>','>=','<','<=']},value:{type:'number'}},required:['expr','op','value'],additionalProperties:false}};
const COMPUTE_TOOL={type:'function',name:'compute',description:'Calculate your own numbers from prices and daily history with formulas, for example (price("005930")/sma("005930",20)-1)*100 or ratio_z("005930","000660",60). Up to 5 formulas per call, each named. '+formula.HELP+' Read-only.',strict:true,parameters:{type:'object',properties:{formulas:{type:'array',items:{type:'object',properties:{name:{type:'string'},expr:{type:'string'}},required:['name','expr'],additionalProperties:false}}},required:['formulas'],additionalProperties:false}};
const TRIGGER_TOOL={type:'function',name:'set_review_trigger',description:'Ask for a review when your own conditions are met, checked by the app on every price update. Each condition is a formula (see compute) compared with a number; combine "all" needs every condition, "any" needs one. A trigger fires once and expires after expiresInHours (1–336). Up to 5 active triggers. action "remove" deletes the trigger with that id. Triggers only schedule reviews; they never trade.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['add','remove']},id:{type:'string'},name:{type:'string'},conditions:CONDITION_SCHEMA,combine:{type:'string',enum:['all','any']},expiresInHours:{type:'number'},reason:{type:'string'}},required:['action','id','name','conditions','combine','expiresInHours','reason'],additionalProperties:false}};
const NOTE_TOOL={type:'function',name:'save_note',description:'Keep a short note for later reviews: a thesis, entry or exit levels, what would prove you wrong, or a reminder. symbol is the stock it is about, or an empty string for a general note; one note per symbol replaces the previous one. action "clear" deletes it. Notes expire after expiresInDays (1–90). Notes are context for later reviews, not instructions.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['set','clear']},symbol:{type:'string'},note:{type:'string'},expiresInDays:{type:'number'}},required:['action','symbol','note','expiresInDays'],additionalProperties:false}};
const ORDER_TOOL={type:'function',name:'set_conditional_order',description:'Arm an order that the app places when your conditions are met, for example a stop loss, a take profit or an entry at a level. Only when conditionalOrders.allowed is true. The app checks the conditions on every price update while auto trading is on and the market is open; when they are met it re-reads the account, then creates the order at the best bid (a sale) or ask (a purchase) and keeps moving it to the best price until it fills; limitPrice, when set, is its bound: a sale never goes below it and a purchase never above it (null: no bound, so a stop loss fills at any price). The starting price must be within conditionalOrders.maxSlippagePct of the current price, the order stays within conditionalOrders.maxOrderPctOfEquity, sells do not exceed shares held, and every normal risk check passes. It fires once and expires after expiresInHours. purpose labels the order. action "cancel" cancels the order with that id. replaces is null, or with action "add" the id of an armed stop loss for the same symbol and side: the new stop loss is armed and that order cancelled together, and if the new one is refused, that order stays armed unchanged. credit is null for cash shares; to close one credit lot it names that lot from productRisk.credit (kind margin-sell for a margin loan or cover for a short, its loanDate and source), and the order is checked against what remains in that lot. A credit-lot order is accepted only while productRisk.credit.effective says its path is executable and automatic; otherwise it is refused with the reason and the lot stays unprotected.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['add','cancel']},id:{type:'string'},symbol:{type:'string'},side:{type:'string',enum:['Buy','Sell']},quantity:{type:'integer'},limitPrice:{type:['number','null']},conditions:CONDITION_SCHEMA,combine:{type:'string',enum:['all','any']},purpose:{type:'string',enum:['stop_loss','take_profit','entry','exit','other']},expiresInHours:{type:'number'},reason:{type:'string'},replaces:{type:['string','null']},credit:{anyOf:[{type:'null'},{type:'object',properties:{kind:{type:'string',enum:['margin-sell','cover']},loanDate:{type:'string'},source:{type:'string',enum:['self','distribution']}},required:['kind','loanDate','source'],additionalProperties:false}]}},required:['action','id','symbol','side','quantity','limitPrice','conditions','combine','purpose','expiresInHours','reason','replaces','credit'],additionalProperties:false}};
const cut=(text,n)=>String(text??'').trim().replace(/\s+/g,' ').slice(0,n);
const isSymbol=s=>typeof s==='string'&&/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(s);
const fail=reason=>({status:'rejected',reason});
const TEMPORARY=/KIS_ORDER_BUSY|TIMEOUT|NETWORK|RATE_LIMIT|SERVER_ERROR|SESSION_CLOSED|temporary/;
// Broker order statuses of a sell that was sent: a stop whose sell got this far did its job.
const SENT=new Set(['Accepted','Partially filled','Filled']),LAPSED=new Set(['Canceled','Rejected','Expired']);
const describe=e=>e?.code?`${e.code}${e.detail?`: ${e.detail}`:''}`:'INVALID';
class AgentDesk {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS plan_stop_failures(id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL)');db.exec('CREATE TABLE IF NOT EXISTS agent_triggers(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS agent_notes(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol));CREATE TABLE IF NOT EXISTS agent_note_history(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,replacedAt INTEGER NOT NULL,reason TEXT NOT NULL);CREATE TABLE IF NOT EXISTS conditional_orders(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');}
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
  // A trigger that fired for a review that made no decision (a size failure) is active again, unless it has expired.
  reopenTrigger(scope,id){const t=this.rows('agent_triggers',scope,'fired').find(x=>x.id===id);if(!t||t.expiresAt<=this.clock())return false;const {firedAt,results,...rest}=t;this.write('agent_triggers',{...rest,status:'active'});return true;}
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
  // lot: for a credit-lot order, the caller's check of that lot against the account ({ok:true, lot} or {ok:false, reason}).
  // positions: {symbol: {quantity}} from the review's context, when known. A sell without credit may not leave more shares
  // under armed orders of its purpose than are held (2026-11-10: two identical one-share PNR stops for one share, because
  // the agent could not extend a stop that expired before the next U.S. open). Sending the identical order again renews
  // the armed one instead: its expiry moves, nothing new is armed. Without positions both checks are skipped, so a
  // missing balance never blocks a protective order; the fire-time check still sells at most the shares held.
  // link: {id, market, quantity} for a stop armed from a trade plan, tied to the purchase it protects (plan stop fixes
  // P1/P2, artifacts/reviews/2026-11-11-agent-tools/plan-stop-fixes.md): stored on the order, and its quantity counts
  // as shares the stops may cover besides those held. Every other caller passes none, as before.
  setOrder(scope,args,{config,universe,quotes,reviewId,lot=null,positions=null,link=null}={}){
    if(args?.action==='cancel'){const o=this.orders(scope).find(x=>x.id===args.id);if(!o)return fail('No armed order with that id.');this.write('conditional_orders',{...o,status:'cancelled',closedAt:this.clock(),closedBy:'agent'});return {status:'cancelled',id:o.id};}
    if(!config?.conditionalOrders)return fail('Conditional orders are turned off in Engine settings.');
    if(!isSymbol(args?.symbol)||universe&&!universe.includes(args.symbol))return fail('The symbol must be in the review universe.');
    if(!['Buy','Sell'].includes(args.side)||!Number.isSafeInteger(args.quantity)||args.quantity<1||args.quantity>10000)return fail('side must be Buy or Sell and quantity 1 to 10,000.');
    if(args.limitPrice!==null&&(!Number.isFinite(args.limitPrice)||args.limitPrice<=0))return fail('limitPrice must be a positive number or null.');
    let parsed;try{parsed=formula.readConditions(args.conditions,LIMITS.conditionsPerItem);}catch(e){return fail(describe(e));}
    const outside=parsed.symbols.filter(s=>universe&&!universe.includes(s));if(outside.length)return fail(`Symbols must be in the review universe: ${outside.join(', ')}`);
    const hours=Number(args.expiresInHours);if(!Number.isFinite(hours)||hours<1||hours>config.conditionalMaxHours)return fail(`expiresInHours must be 1 to ${config.conditionalMaxHours}.`);
    const quote=quotes?.find(q=>q.symbol===args.symbol);
    if(args.limitPrice!=null&&quote?.price>0&&Math.abs(args.limitPrice/quote.price-1)*100>50)return fail('limitPrice is more than 50% away from the current price.');
    // A credit lot is named by its kind, loan date and source, on this account and symbol (audit 2026-11-04, Stage 4).
    const credit=args.credit??null;if(credit){if(!['margin-sell','cover'].includes(credit.kind)||!/^\d{4}-\d{2}-\d{2}$/.test(String(credit.loanDate??''))||!['self','distribution'].includes(credit.source))return fail('credit needs kind (margin-sell or cover), loanDate (YYYY-MM-DD) and source (self or distribution).');
      if((credit.kind==='margin-sell')!==(args.side==='Sell'))return fail('A margin repayment is a Sell and a cover is a Buy.');if(!lot?.ok)return fail(lot?.reason??'The credit lot could not be checked against the account.');}
    // Replacing a stop loss in one step (step A-R, artifacts/reviews/2026-11-12-engine-settings/plan.md; finding in
    // report.md section 5: a cancel and an add in two reviews left a share without a stop for about 32 minutes). The
    // named order must be an armed cash-share stop loss of this account, symbol and side, and the new order a stop loss.
    // Every check below then runs with the replaced order's shares and slot counted as free; the new order is written
    // and the old one closed in one transaction, so on any refusal or failure the old stop stays armed as it was. A
    // stop tied to its purchase passes the link on. Without replaces nothing here changes.
    let replaced=null;const replaces=args.replaces==null||args.replaces===''?null:String(args.replaces);
    if(replaces){
      this.expire(scope);const row=this.db.prepare('SELECT payload FROM conditional_orders WHERE id=?').get(replaces);const old=row?JSON.parse(row.payload):null;
      if(!old||old.scope!==scope)return fail(`No conditional order ${replaces} on this account to replace.`);
      if(old.status==='firing')return fail(`${old.id} is being placed now and cannot be replaced.`);
      if(old.status!=='armed')return fail(`${old.id} is ${old.status}, not armed, so there is nothing to replace. Arm the new stop loss without replaces.`);
      if(old.purpose!=='stop_loss'||args.purpose!=='stop_loss')return fail('replaces works only from a stop loss to a stop loss.');
      if(old.symbol!==args.symbol||old.side!==args.side)return fail(`${old.id} is a ${old.side} stop loss for ${old.symbol}; its replacement must have the same symbol and side.`);
      if(old.credit||credit)return fail('replaces is for stop losses on cash shares; a credit-lot stop is cancelled and armed separately.');
      replaced=old;if(!link&&old.linkedBuy)link=old.linkedBuy;
    }
    const buying=Math.max(0,Number(link?.quantity)||0);
    if(args.side==='Sell'&&!credit&&positions&&typeof positions==='object'){
      const held=Math.max(0,Number(positions[args.symbol]?.quantity)||0),purpose=args.purpose??null,combine=args.combine==='any'?'any':'all';
      const same=this.orders(scope).filter(o=>o.symbol===args.symbol&&o.side==='Sell'&&!o.credit&&(o.purpose??null)===purpose&&o.id!==replaced?.id),covered=same.reduce((n,o)=>n+o.quantity,0);
      if(covered+args.quantity>held+buying){
        const key=c=>JSON.stringify(c.map(x=>[String(x.expr).replace(/\s+/g,''),x.op,Number(x.value)])),want=key(parsed.conditions);
        // A replacement never renews another order instead: it is refused, and the order it names stays armed.
        const twin=replaced?null:same.find(o=>o.quantity===args.quantity&&(o.limitPrice??null)===(args.limitPrice??null)&&(o.combine??'all')===combine&&key(o.conditions)===want);
        if(twin){const now=this.clock(),renewed=this.write('conditional_orders',{...twin,expiresAt:Math.max(twin.expiresAt,now+hours*3600000),reason:cut(args.reason,300)||twin.reason,reviewId:reviewId??twin.reviewId??null,renewedAt:now,renewals:(twin.renewals??0)+1});
          return {status:'armed',id:renewed.id,renewed:true,expiresAt:new Date(renewed.expiresAt).toISOString(),note:'An identical armed order existed; its expiry was extended. Nothing new was armed.'};}
        return fail(`${held} shares of ${args.symbol} are held${buying?` and ${buying} are being bought`:''}, and armed ${purpose??'sell'} orders already cover ${covered} (${same.map(o=>o.id).join(', ')||'none'}); this would cover ${covered+args.quantity}. Cancel one first, or send the identical order again to extend it.`);
      }
    }
    if(this.orders(scope).filter(o=>o.id!==replaced?.id).length>=config.conditionalMaxActive)return fail(`Up to ${config.conditionalMaxActive} armed conditional orders; cancel one first.`);
    const now=this.clock();const o={id:'C-'+randomUUID().slice(0,6),scope,status:'armed',symbol:args.symbol,side:args.side,quantity:args.quantity,limitPrice:args.limitPrice,conditions:parsed.conditions.map(({ast,...c})=>c),symbols:parsed.symbols,combine:args.combine==='any'?'any':'all',purpose:args.purpose,reason:cut(args.reason,300),createdAt:now,expiresAt:now+hours*3600000,priceAtCreation:quote?.price??null,reviewId:reviewId??null,...(link?{linkedBuy:{id:String(link.id),market:link.market??null,quantity:buying}}:{}),...(credit?{credit:{kind:credit.kind,loanDate:credit.loanDate,source:credit.source,account:lot.account??null}}:{}),...(replaced?{replaces:replaced.id}:{})};
    const note=config.conditionalAutoSubmit&&config.autoSubmit?'It will be submitted automatically when the conditions are met and every check passes.':'When the conditions are met it becomes a proposal that waits for approval.';
    if(!replaced){this.write('conditional_orders',o);return {status:'armed',id:o.id,expiresAt:new Date(o.expiresAt).toISOString(),note};}
    // One transaction (a savepoint, so it also nests inside a caller's transaction): both rows change, or neither.
    this.db.exec('SAVEPOINT replace_stop');
    try{this.write('conditional_orders',o);this.write('conditional_orders',{...replaced,status:'cancelled',closedAt:now,closedBy:'agent',outcome:`Replaced by ${o.id}`,replacedBy:o.id});this.db.exec('RELEASE replace_stop');}
    catch{try{this.db.exec('ROLLBACK TO replace_stop');this.db.exec('RELEASE replace_stop');}catch{}return fail(`The replacement could not be saved; ${replaced.id} stays armed unchanged.`);}
    return {status:'armed',id:o.id,replaced:replaced.id,expiresAt:new Date(o.expiresAt).toISOString(),note:`${note} ${replaced.id} was cancelled in the same step.`};
  }
  update(order,patch){return this.write('conditional_orders',{...order,...patch});}
  // A stop from a trade plan that could not be armed (P3): {symbol, quantity, reason, proposalId}. Listed for a day,
  // until a stop loss for the symbol is armed after it.
  recordPlanStopFailure(scope,{symbol,quantity,reason,proposalId=null}){const at=this.clock();const item={id:'PSF-'+randomUUID().slice(0,8),scope,symbol,quantity,reason:cut(reason,300),proposalId,at};this.db.prepare('INSERT INTO plan_stop_failures VALUES(?,?,?)').run(item.id,scope,JSON.stringify(item));return item;}
  // Never throws (release gate 1.5.51, G3): the review context and getState() read it with no try of their own. A row
  // that cannot be parsed is skipped; a failed read of the table or of the stops gives []. The first problem in a run is
  // written once to the app log (onError, set by Automation), with the error's code and the rows skipped.
  planStopFailures(scope){const now=this.clock();let stops,rows;
    try{stops=this.rows('conditional_orders',scope).filter(o=>o.side==='Sell'&&o.purpose==='stop_loss'&&(o.status==='armed'||o.status==='firing'));rows=this.db.prepare('SELECT payload FROM plan_stop_failures WHERE scope=? ORDER BY rowid DESC').all(scope);}
    catch(error){this.planStopReadProblem(error,0);return [];}
    const list=[];let skipped=0;for(const r of rows){let f=null;try{f=JSON.parse(r.payload);}catch{}if(f&&typeof f==='object'&&Number.isFinite(f.at)&&typeof f.symbol==='string')list.push(f);else skipped++;}
    if(skipped)this.planStopReadProblem(null,skipped);
    return list.filter(f=>now-f.at<86400000&&!stops.some(o=>o.symbol===f.symbol&&o.createdAt>=f.at));}
  planStopReadProblem(error,skipped){if(this.planStopProblemLogged)return;this.planStopProblemLogged=true;const code=require('./reading-failures.cjs').errorCode;
    try{this.onError?.('Error: purchases without a stop order could not be read',`${error?`The list could not be read (${code(error)}).`:'The list was read.'} Rows skipped as unreadable: ${skipped}. Until this is fixed, Home and the next review may not show a purchase whose stop order was not armed. Logged once per run.`);}catch{}}
  // Held positions whose latest stop loss was rejected: protection the AI meant to have but does not. positions:
  // {symbol: {quantity}}. Only stop losses count as protection (a take-profit or other sell does not limit a fall), and
  // they must cover the shares the rejected stop was for (its quantity, at most the shares held); fewer is reported as
  // partial with the shares covered. Each stays listed until stops cover those shares, the shares are gone, or the user
  // dismisses it: time passing does not restore protection. A later stop settles it only once its sell reached the
  // broker (sellStatus says Accepted, Partially filled or Filled); one that was cancelled, expired, is still waiting for
  // approval, or that the broker refused or cancelled does not, and is reported as replacement with that status.
  // temporary: refused for a passing reason (another order being sent, a timeout), so re-arming is expected to work.
  // A submitted stop whose sell the broker later cancelled, refused or let expire (sellOrder) protects nothing from then
  // on: its unfilled shares are listed as unprotected (lapsed), so a partial fill keeps the rest visible.
  unprotected(scope,positions){this.expire(scope);const all=this.rows('conditional_orders',scope),live=o=>o.status==='armed'||o.status==='firing';
    const broker=o=>{try{return this.sellStatus?.(o)??null;}catch{return null;}},filled=o=>{try{return Math.max(0,Number(this.sellOrder?.(o)?.filled)||0);}catch{return 0;}};
    // What a closed stop did: rejected, lapsed (sent, then cancelled, refused or expired at the broker), settled (its sell
    // is at or through the broker), or nothing yet.
    const result=o=>{if(o.status==='rejected')return 'rejected';if(o.status!=='submitted'&&o.status!=='proposed')return null;const s=broker(o);if(o.status==='submitted'&&LAPSED.has(s))return 'lapsed';return (s?SENT.has(s):o.status==='submitted')?'settled':null;};
    return Object.entries(positions??{}).filter(([,p])=>p?.quantity>0).flatMap(([symbol,p])=>{const stops=all.filter(o=>o.symbol===symbol&&o.side==='Sell'&&o.purpose==='stop_loss');const at=stops.findIndex(o=>!live(o)&&result(o)),last=stops[at];
      const how=last?result(last):null;if(!last||!['rejected','lapsed'].includes(how)||last.acknowledgedAt)return [];
      const done=how==='lapsed'?filled(last):0,needed=Math.min(p.quantity,last.quantity-done),covered=stops.filter(live).reduce((n,o)=>n+o.quantity,0);if(needed<1||covered>=needed)return [];
      const later=stops.slice(0,at).find(o=>!live(o));
      return [{symbol,orderId:last.id,quantity:needed,heldQuantity:p.quantity,coveredQuantity:covered,...(covered>0?{partial:true}:{}),rejectedAt:new Date(last.closedAt).toISOString(),
        outcome:how==='lapsed'?`Its sell reached the broker and was then ${broker(last).toLowerCase()} there with ${done} of ${last.quantity} shares filled.`:last.outcome??null,...(how==='lapsed'?{lapsed:{brokerStatus:broker(last),filled:done}}:{}),temporary:how!=='lapsed'&&TEMPORARY.test(last.outcome??''),
        ...(later?{replacement:{orderId:later.id,status:later.status,...(broker(later)?{brokerStatus:broker(later)}:{})}}:{})}];});}
  // The user has seen an unprotected holding and accepts it; the rejected stop stops being listed.
  dismissUnprotected(scope,orderId){const o=this.rows('conditional_orders',scope,'rejected').find(x=>x.id===orderId);if(!o)throw new Error('NOT_FOUND');this.update(o,{acknowledgedAt:this.clock()});}
  cancelOrder(scope,id){const o=this.orders(scope).find(x=>x.id===id);if(!o)throw new Error('NOT_FOUND');this.update(o,{status:'cancelled',closedAt:this.clock(),closedBy:'user'});}
  // What a review sees of its desk.
  context(scope,config,symbols,positions={}){
    const unprotected=this.unprotected(scope,positions);const notes=this.notes(scope);const relevant=notes.filter(n=>!n.symbol||symbols.includes(n.symbol)).slice(0,15).map(n=>({symbol:n.symbol||null,note:n.note,updated:new Date(n.updatedAt).toISOString()}));
    return {notes:relevant,triggers:this.triggers(scope).map(t=>({id:t.id,name:t.name,conditions:t.conditions,combine:t.combine,expires:new Date(t.expiresAt).toISOString()})),
      conditionalOrders:{allowed:Boolean(config.conditionalOrders),...(config.conditionalOrders?{autoSubmit:Boolean(config.conditionalAutoSubmit&&config.autoSubmit),maxActive:config.conditionalMaxActive,maxOrderPctOfEquity:config.conditionalMaxOrderPct,maxSlippagePct:config.conditionalMaxSlippagePct,maxHours:config.conditionalMaxHours}:{}),
        armed:this.orders(scope).map(o=>({id:o.id,symbol:o.symbol,side:o.side,quantity:o.quantity,limitPrice:o.limitPrice,purpose:o.purpose,conditions:o.conditions,combine:o.combine,expires:new Date(o.expiresAt).toISOString(),...(o.linkedBuy?{protectsPurchase:o.linkedBuy.id}:{})})),
        ...((f=>f.length?{planStopsNotArmed:f.map(x=>({symbol:x.symbol,quantity:x.quantity,reason:x.reason,at:new Date(x.at).toISOString(),fact:`The plan stop for ${x.symbol} was not armed: ${x.reason}`}))}:{})(this.planStopFailures(scope))),
        recent:this.recentOrders(scope,5).map(o=>({id:o.id,symbol:o.symbol,side:o.side,quantity:o.quantity,purpose:o.purpose,status:o.status,outcome:o.outcome??null,at:new Date(o.closedAt??o.createdAt).toISOString()})),
        ...(unprotected.length?{unprotected,unprotectedNote:'These holdings are not protected: their stop loss was rejected and nothing replaced it. A rejected order is not protection. Only a stop loss counts: a take-profit does not limit a fall. quantity is the shares the rejected stop was for and coveredQuantity what armed stop losses cover now (partial: true when some are). replacement is a later stop that has not protected it yet (status proposed: its sell awaits the user’s approval; brokerStatus is what the broker did with it). Re-arm a stop loss for the uncovered shares (temporary: true means the refusal was passing, such as another order being sent), sell, or say in this review why the position stays unprotected. This stays listed until stop losses cover those shares, the shares are gone, or the user dismisses it.'}:{})}};
  }
}
// Korean limit prices must sit on the exchange tick for their price band.
function krTick(price){return price<2000?1:price<5000?5:price<20000?10:price<50000?50:price<200000?100:price<500000?500:1000;}
function onTick(price,side,market){if(market==='US')return (side==='Buy'?Math.ceil:Math.floor)(price*100)/100;const t=krTick(price);return (side==='Buy'?Math.floor:Math.ceil)(price/t)*t;}
module.exports={AgentDesk,COMPUTE_TOOL,TRIGGER_TOOL,NOTE_TOOL,ORDER_TOOL,COND_DEFAULTS,LIMITS,krTick,onTick};
