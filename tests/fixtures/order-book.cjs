// Test fixture: an order book at the price the automation already knows for a symbol (its latest quote, else the
// quote in the latest saved review context), and an instant retry wait. In the app, electron/main.cjs sets
// automation.orderBook to the KIS order-book read.
const {Automation}=require('../../electron/automation.cjs');
Automation.prototype.orderBook=async function(symbol){let price=this.formulaData([]).price(symbol);
  if(!(price>0))try{const row=this.db.prepare('SELECT payload FROM review_contexts ORDER BY rowid DESC LIMIT 1').get();const ctx=row?(p=>p.context??p)(JSON.parse(row.payload)):null;price=(ctx?.quotes??[]).find(q=>q.symbol===symbol)?.price??null;}catch{}
  return price>0?{status:'available',retrievedAt:Date.now(),data:{bid:price,ask:price,quoteAt:Date.now()}}:{status:'unavailable',reason:'NO_TWO_SIDED_BOOK'};};
Automation.prototype.wait=async function(){};
