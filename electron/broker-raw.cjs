// The broker's own balance figures, kept as KIS reported them (audit 2026-11-04, Stage 2), so a valuation can be
// reconciled to the broker afterwards: every numeric field of the Korean balance summary and of the U.S. USD and
// summary rows, with the time of the reading. MEANINGS documents the fields the valuation uses (electron/valuation.cjs).
// A reading is stored only when a figure changed since the last one for that account and market; readings older than 30
// days, and beyond the 3,000 most recent, are deleted.
const MEANINGS={
  KR:{dnca_tot_amt:'deposit cash today (D+0)',nxdy_excc_amt:'projected cash next business day (D+1)',prvs_rcdl_excc_amt:'projected settled cash (D+2): Korean buys and sales awaiting settlement netted; the valuation cash',
    scts_evlu_amt:'Korean holdings at the broker price',tot_evlu_amt:'KIS total evaluation (projected cash plus holdings)',nass_amt:'net assets: total less loans and short obligations',
    tot_loan_amt:'margin loan principal',tot_stln_slng_chgs:'short sale proceeds'},
  US:{frcr_dncl_amt_2:'USD deposit',frcr_sll_amt_smtl:'U.S. sale proceeds awaiting settlement, net of fees',ustl_buy_amt_smtl:'U.S. buys awaiting settlement, in KRW (funding not stated)',
    ustl_sll_amt_smtl:'U.S. sales awaiting settlement, in KRW',frcr_buy_amt_smtl:'U.S. buys today in USD'},
};
// Numeric fields of a KIS row: name -> number, at most limit of them; text fields and blanks are left out.
function numericFields(row,limit=60){const out={};if(!row||typeof row!=='object'||Array.isArray(row))return out;
  for(const [k,v] of Object.entries(row)){if(Object.keys(out).length>=limit)break;if(!/^[a-z0-9_]{1,40}$/.test(k))continue;if((typeof v==='string'||typeof v==='number')&&String(v).trim()!==''&&/^-?\d+(\.\d+)?$/.test(String(v).trim()))out[k]=Number(v);}
  return out;}
const LIMITS={days:30,rows:3000};
class BrokerBalances {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS broker_balances(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,market TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL)');}
  // snapshot: a balance as the app holds it (snapshot.raw from kis-client.cjs or kis-overseas.cjs). Returns whether it was stored.
  record(account,market,snapshot){
    if(typeof account!=='string'||!account||!['KR','US'].includes(market)||!snapshot?.raw)return false;const payload=JSON.stringify({readAt:snapshot.timestamp??null,raw:snapshot.raw});
    const last=this.db.prepare('SELECT payload FROM broker_balances WHERE account=? AND market=? ORDER BY id DESC LIMIT 1').get(account,market);
    if(last&&JSON.stringify(JSON.parse(last.payload).raw)===JSON.stringify(snapshot.raw))return false;
    const now=this.clock();this.db.prepare('INSERT INTO broker_balances(account,market,at,payload) VALUES(?,?,?,?)').run(account,market,now,payload);
    this.db.prepare('DELETE FROM broker_balances WHERE at<?').run(now-LIMITS.days*86400000);
    this.db.prepare('DELETE FROM broker_balances WHERE id NOT IN (SELECT id FROM broker_balances ORDER BY id DESC LIMIT ?)').run(LIMITS.rows);return true;
  }
  list(account,market,limit=50){return this.db.prepare('SELECT at,payload FROM broker_balances WHERE account=? AND market=? ORDER BY id DESC LIMIT ?').all(account,market,limit).map(r=>({at:r.at,...JSON.parse(r.payload)}));}
}
module.exports={MEANINGS,numericFields,BrokerBalances,LIMITS};
