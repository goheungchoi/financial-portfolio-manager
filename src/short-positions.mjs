// The words of a short position's stop (B3f-2): its level, waiting (held, with why), or no working stop (with the cause).
// A short opened in the KIS app claims no stop of the app's: a cover stop that exists for it (the AI's or yours) is shown
// as not the app's own; with none, "No stop set". money(value): the screen's formatter.
export function shortStopText(row,money){const s=row?.stop;if(!s)return row?.byHand?'No stop set':'—';
  if(s.state==='armed'){const at=s.level==null?'Stop armed':`Stop at ${money(s.level)}`;return s.notApps||row?.byHand?`${at} (not the app's own)`:at;}
  if(row?.byHand)return 'No stop set';
  if(s.state==='waiting')return `Stop waiting: ${s.why}`;
  return `No working stop: ${s.cause}`;}
// The loan's last buy-back day and the business days left to it, as the app counts them; past it, in words.
export function shortLoanText(row){if(!row?.lastDay)return '—';if(row.pastLastDay)return `${row.lastDay}, past its last day`;
  return row.businessDaysLeft==null?row.lastDay:`${row.lastDay} (${row.businessDaysLeft} business ${row.businessDaysLeft===1?'day':'days'} left)`;}
// A result so far above zero is a gain (the price fell below the sale), below zero a loss.
export const shortResultClass=v=>typeof v==='number'&&v!==0?(v>0?'positive':'negative'):'muted';
