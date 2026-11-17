// Item 11 (artifacts/reviews/2026-11-17-not-held-price-reviews/design-note.md and the handoff's addition, cleared): the
// setting "Price reviews for stocks you don't hold" (config notHeldPriceReviews). 'default' is today's behaviour, byte
// for byte: nothing here adds a field, a note or a filter then. 'levels': a stock not held starts a price review only by
// crossing a level the AI set on it. 'never': nothing about a stock not held starts a price review, and an agent trigger
// whose stocks are all not held starts no review. Holdings, scheduled, news and order-update reviews, conditional orders
// and every trigger that uses a held stock are unchanged.
const CHOICES=Object.freeze(['default','levels','never']);
// What the AI is told, only off the default (the context's notHeldPriceReviews), in the planner's words.
const CONTEXT=Object.freeze({
  levels:'The user limited price reviews for stocks not held to entry levels: a price level you set with set_review_watch on a stock not held starts a review when the price crosses it; a price move or a percent watch on a stock not held does not. Review triggers are unchanged.',
  never:'The user turned off price reviews for stocks not held: no price move, no review watch (level or percent) and no review trigger whose conditions use only stocks not held starts a review. Holdings, scheduled and news reviews, and triggers that use a holding, are unchanged.'});
const contextText=setting=>CONTEXT[setting]??null;
// The set_review_watch result for a stock not held when the watch will not start a review: under 'never' any watch; under
// 'levels' a watch without a price (a percent only). The watch is saved either way, and applies once the stock is held.
function watchNote(setting,value,held){const symbol=value?.symbol;if(!symbol||held.has(symbol))return null;
  if(setting==='never')return `Saved, but price reviews for stocks not held are off: this watch starts no review while ${symbol} is not held.`;
  if(setting==='levels'&&value.price==null)return `Saved, but for a stock not held only a price level starts a review; this percent does not while ${symbol} is not held.`;
  return null;}
const withWatchNote=(reply,setting,value,held)=>{if(reply?.status!=='saved')return reply;const note=watchNote(setting,value,held);return note?{...reply,note}:reply;};
// A trigger's stocks are the quoted symbols of its formulas (electron/formula.cjs parse: the only way a formula reads
// market data is through a quoted listing symbol), saved on the trigger as symbols. Under 'never' a trigger starts a
// review only if one of them is held; a trigger with no symbol reads no stock and is not affected.
const triggerLive=(setting,symbols,held)=>setting!=='never'||!Array.isArray(symbols)||!symbols.length||symbols.some(s=>held.has(s));
const triggerNote=(setting,symbols,held)=>triggerLive(setting,symbols,held)?null:'Saved, but price reviews for stocks not held are off: this trigger starts no review while none of its stocks is held.';
module.exports={CHOICES,CONTEXT,contextText,watchNote,withWatchNote,triggerLive,triggerNote};
