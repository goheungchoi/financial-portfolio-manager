const PUBLIC=['REQUEST_FAILED','NETWORK_UNAVAILABLE','REQUEST_TIMEOUT','SERVER_ERROR','RATE_LIMITED','AUTH_FAILED','INVALID_RESPONSE'];
function responseError(status,body){const code=body?.msg_cd;const safeCode=typeof code==='string'&&/^[A-Z0-9_-]{1,24}$/.test(code)?code:null;const reason=code==='EGW00201'||status===429?'RATE_LIMITED':status===401||status===403?'AUTH_FAILED':status>=500?'SERVER_ERROR':'REQUEST_FAILED';return {reason,brokerCode:safeCode,httpStatus:status};}
module.exports={PUBLIC,responseError};
