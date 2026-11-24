// Short selling B3f-1 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md): an outcome's words by what it did,
// for Trade outcomes and the Journal. A short sale opens a short (its proceeds, no gain yet); a cover closes it (the
// result after fees against the short's proceeds, borrow interest included, "estimated until KIS reports it" only while
// the interest is an estimate). A cash sale and a purchase keep their words.
export function effectOf(row){if(row?.effect)return row.effect;const k=row?.credit?.kind;if(k==='short')return 'OPEN_SHORT';if(k==='cover')return 'CLOSE_SHORT';return row?.side==='Sell'?'CLOSE_LONG':'OPEN_LONG';}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
// money(value, currency): the screen's own formatter. Returns null for a purchase (each screen keeps its own words).
export function outcomeWords(row,money){const e=effectOf(row),c=row?.currency;
  if(e==='OPEN_SHORT'){const p=finite(row.gross)?row.gross:finite(row.averagePrice)&&finite(row.quantity)?row.averagePrice*row.quantity:null;return `Short sale recorded: proceeds ${money(p,c)}`;}
  if(e==='CLOSE_SHORT'){const i=row.shortCosts?.interest;const interest=i&&finite(i.amount)?`${money(i.amount,c)}${i.basis==='estimate'?' (estimated until KIS reports it)':''}`:'unknown';
    return `Cover: result after fees ${money(row.gainAfterFees??null,c)} against proceeds ${money(row.shortProceeds??null,c)}, borrow interest ${interest}`;}
  // Every other effect (a sale, a purchase, a margin order, an unknown one) keeps the words by side, exactly as before.
  if(row?.side==='Sell')return `${money(row.gainAfterFees??null,c)} after fees`;
  return null;}
// A cover's gaps (short-result.cjs), shown with it; none for anything else.
export function shortGapsLine(row){return effectOf(row)==='CLOSE_SHORT'&&Array.isArray(row.shortGaps)&&row.shortGaps.length?`Gaps: ${row.shortGaps.join('; ')}.`:null;}
// Whether the after-tax line applies: a cover, or a Sell other than a short sale (as before for every other effect).
export const isExit=row=>{const e=effectOf(row);return e==='CLOSE_SHORT'||e!=='OPEN_SHORT'&&row?.side==='Sell';};
