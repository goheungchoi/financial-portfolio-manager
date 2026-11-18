// The prepared-order tickets of the broker worker (electron/kis-worker.cjs): an order is placed only with the ticket of
// its own preparation, used once, within 15 seconds. M-1c: a ticket that is missing, of the other market or expired is
// refused before anything is sent to KIS, so the order was not sent (TICKET_EXPIRED, marked notSent), never unclear.
// F6 (2026-11-18 order not sent): how old the ticket was when it was taken, on success (ageMs) and on refusal
// (error.ticketAgeMs; absent for a missing ticket).
const TICKET_MS=15000;
function takeTicket(prepared,ticket,market,now=Date.now()){const entry=prepared.get(ticket);prepared.delete(ticket);
  const wrongMarket=market==='US'?entry?.market!=='US':Boolean(entry?.market);const ageMs=entry&&Number.isFinite(entry.expiresAt)?now-(entry.expiresAt-TICKET_MS):null;
  if(!entry||wrongMarket||now>entry.expiresAt){const error=new Error('TICKET_EXPIRED');error.code='TICKET_EXPIRED';error.notSent=true;if(ageMs!=null)error.ticketAgeMs=ageMs;throw error;}
  return {...entry,ageMs};}
module.exports={takeTicket,TICKET_MS};
