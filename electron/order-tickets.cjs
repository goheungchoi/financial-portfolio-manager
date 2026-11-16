// The prepared-order tickets of the broker worker (electron/kis-worker.cjs): an order is placed only with the ticket of
// its own preparation, used once, within 15 seconds. M-1c: a ticket that is missing, of the other market or expired is
// refused before anything is sent to KIS, so the order was not sent (TICKET_EXPIRED, marked notSent), never unclear.
const TICKET_MS=15000;
function takeTicket(prepared,ticket,market,now=Date.now()){const entry=prepared.get(ticket);prepared.delete(ticket);
  const wrongMarket=market==='US'?entry?.market!=='US':Boolean(entry?.market);
  if(!entry||wrongMarket||now>entry.expiresAt){const error=new Error('TICKET_EXPIRED');error.code='TICKET_EXPIRED';error.notSent=true;throw error;}
  return entry;}
module.exports={takeTicket,TICKET_MS};
