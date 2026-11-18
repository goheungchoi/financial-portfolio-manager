// Activity and Performance open with what was last read (artifacts/reviews/2026-11-18-activity-tab, step 2). The last
// successful KIS report per kind ('orders', 'profit') is kept in memory and in one row per kind (activity_last), with
// the account it belongs to, so it survives tab changes and restarts. A report of another account is never returned:
// a read for a different account clears the row.
const KINDS=['orders','profit'];
// An automatic refresh waits only five minutes since the last read.
const FRESH_MS=5*60000;
class ActivityCache {
  constructor(db){this.db=db;this.memory=new Map();try{db.exec('CREATE TABLE IF NOT EXISTS activity_last(kind TEXT PRIMARY KEY,payload TEXT NOT NULL)');}catch{}}
  // {data, account, savedAt} or null; null and cleared when it belongs to another account.
  get(kind,account){if(!KINDS.includes(kind)||!account)return null;let row=this.memory.get(kind);
    if(!row){try{const r=this.db.prepare('SELECT payload FROM activity_last WHERE kind=?').get(kind);row=r?JSON.parse(r.payload):null;}catch{row=null;}if(row)this.memory.set(kind,row);}
    if(!row)return null;if(row.account!==account){this.clear(kind);return null;}return row;}
  put(kind,account,data){if(!KINDS.includes(kind)||!account||!data)return;const row={account,data,savedAt:Date.now()};this.memory.set(kind,row);
    try{this.db.prepare('INSERT INTO activity_last VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload').run(kind,JSON.stringify(row));}catch{}}
  clear(kind){for(const k of kind?[kind]:KINDS){this.memory.delete(k);try{this.db.prepare('DELETE FROM activity_last WHERE kind=?').run(k);}catch{}}}
}
// Why an automatic refresh does not run now, or null: never ahead of an account request, a review or an order (each
// market's history read holds the KIS queue for all its pages, about 1.3 s each).
function skipReason({kisBusy=false,reviewBusy=false,orderHeld=false}={}){return orderHeld?'order':reviewBusy?'review':kisBusy?'account':null;}
const SKIP_TEXT={order:'an order is being sent',review:'an AI review is running',account:'another account request is running'};
module.exports={ActivityCache,skipReason,SKIP_TEXT,FRESH_MS,KINDS};
