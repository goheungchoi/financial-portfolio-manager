export function usErrorMessage(code:string){
  if(code==='KIS_NOT_CONNECTED')return 'Connect your KIS account first, or wait for reconnection to finish.';
  const stage=code.startsWith('US_BALANCE_')?'U.S. holdings':code.startsWith('US_CASH_')?'USD cash':code.startsWith('US_QUOTES_')?'U.S. quotes':'U.S. account';
  if(code.endsWith('NETWORK_UNAVAILABLE'))return `${stage}: connection failed. Retrying automatically on the next refresh.`;
  if(code.endsWith('REQUEST_TIMEOUT'))return `${stage}: KIS did not respond in time. Retained balances may be stale.`;
  if(code.endsWith('SERVER_ERROR'))return `${stage}: the KIS server returned an error. Retained balances may be stale; the app will retry later.`;
  if(code.endsWith('AUTH_FAILED'))return `${stage}: authentication failed. Reconnect your KIS account.`;
  if(code.endsWith('RATE_LIMITED'))return `${stage}: KIS request limit reached. Broker requests pause with increasing backoff (up to five minutes). Last known values are retained.`;
  if(code.endsWith('BROKER_REJECTED'))return `${stage}: KIS rejected the query. Check overseas/mock-account access in KIS; Korean-market access does not establish overseas access.`;
  if(code.endsWith('INVALID_RESPONSE'))return `${stage}: KIS returned an unsupported response format. (${code})`;
  if(code.endsWith('INCOMPLETE_BALANCE'))return `${stage}: the result is incomplete. Retained values may be stale; retry refresh.`;
  if(code.endsWith('REQUEST_FAILED'))return `${stage}: the request could not complete. Check connectivity and retry. (${code})`;
  return code;
}
