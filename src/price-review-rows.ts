// The two price-review rows of Engine settings -> Schedule and triggers (artifacts/reviews/2026-11-17-price-review-rows,
// design note cleared with the planner's rulings). The screen only: the saved keys notHeldPriceReviews, watchlistAlerts,
// watchlistMovePct and alertTrial keep their values and meanings; this maps them to one choice and back.
export type PriceRowConfig={notHeldPriceReviews?:'default'|'levels'|'never';watchlistAlerts?:'off'|'observe'|'on';alertTrial?:'off'|'on'};
export type PriceRowOption='same'|'wider'|'levels'|'never'|'trial';
export type PriceRowPatch=Partial<Pick<Required<PriceRowConfig>,'notHeldPriceReviews'|'watchlistAlerts'>>;
// The options a user can choose, in order. 'trial' is shown (disabled) only while the watchlist alert trial runs, and is
// never written.
export const CHOOSABLE:readonly PriceRowOption[]=Object.freeze(['same','wider','levels','never']);
export const LABEL:Readonly<Record<PriceRowOption,string>>=Object.freeze({same:'Same as holdings',wider:'Entry levels and wider moves',levels:'Entry levels only',never:'Never',trial:'Trial running: entry levels and wider moves'});
export const LINE:Readonly<Record<PriceRowOption,string>>=Object.freeze({same:'Any stock moving by the holdings percent, or reaching a level the AI set',wider:'A level the AI set, when crossed, or a move of the percent below',
  levels:'Only a price level the AI set, when crossed',never:'Holdings, schedule and news still start reviews',trial:'The watchlist alert trial decides until it ends (More)'});
// What the row shows. The trial first (while it runs the selective rules decide), then the not-held setting, which the
// engine reads before the watchlist mode, then the watchlist mode.
export function shown(c:PriceRowConfig):PriceRowOption{
  if(c.alertTrial==='on')return 'trial';const notHeld=c.notHeldPriceReviews??'default';
  if(notHeld==='never')return 'never';if(notHeld==='levels')return 'levels';return (c.watchlistAlerts??'off')==='on'?'wider':'same';}
// What choosing an option writes: only these keys. Same as holdings resets 'on' to 'off' and keeps 'observe' (behaviour
// is the same either way); Entry levels only and Never keep the saved watchlist mode, which still decides how holding
// reviews are grouped (a known limit of this step: the screen does not show it).
export function write(option:PriceRowOption,c:PriceRowConfig):PriceRowPatch{
  if(option==='same')return (c.watchlistAlerts??'off')==='on'?{notHeldPriceReviews:'default',watchlistAlerts:'off'}:{notHeldPriceReviews:'default'};
  if(option==='wider')return {notHeldPriceReviews:'default',watchlistAlerts:'on'};
  if(option==='levels')return {notHeldPriceReviews:'levels'};if(option==='never')return {notHeldPriceReviews:'never'};
  throw new Error('The trial option is never written');}
// The "Observe watchlist alerts" switch in More. Under Same as holdings (and the trial, disabled: the trial needs
// 'observe'). Under Entry levels only and Never only when 'observe' is already saved, so it can be turned off: turning it
// on there would replace a saved 'on' and change how holding reviews are grouped.
export function observeSwitch(c:PriceRowConfig):{shown:boolean;on:boolean;disabled:boolean}{
  const option=shown(c),on=(c.watchlistAlerts??'off')==='observe';
  if(option==='same')return {shown:true,on,disabled:false};if(option==='trial')return {shown:true,on,disabled:true};
  if(option==='levels'||option==='never')return {shown:on,on,disabled:false};return {shown:false,on:false,disabled:false};}
export const observeWrite=(on:boolean):PriceRowPatch=>({watchlistAlerts:on?'observe':'off'});
// The wider-move percent: in the row under Entry levels and wider moves; in More while Observe is on (only the
// observation log uses it then).
export const widerField=(c:PriceRowConfig):'row'|'more'|null=>shown(c)==='wider'?'row':(c.watchlistAlerts??'off')==='observe'?'more':null;
