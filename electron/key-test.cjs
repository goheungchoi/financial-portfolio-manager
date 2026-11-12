'use strict';
// Release B, step B1 (artifacts/reviews/2026-11-12-engine-settings/b1-design.md and its review, condition d): the Test
// button on each AI provider card. One request that costs no tokens (the provider's model list), made only when the
// user presses Test: never at start, import or reconnect. One attempt, a 10-second timeout. The answer the app keeps
// and shows is one of four fixed results; the provider's response body is never read, and the key never leaves the
// provider worker (each client holds it in a private field).

const TIMEOUT_MS=10000;
const VENDORS={openai:'OpenAI',anthropic:'Anthropic'};
// The only texts the renderer receives.
const TEXT={ok:'Key works',refused:'Key refused (authentication)',unreachable:vendor=>`Could not reach ${VENDORS[vendor]}`,limited:'Rate limited, try later',missing:'No key loaded'};
const RESULTS=['ok','refused','unreachable','limited','missing'];
/** The result for an HTTP status: 2xx ok; 401 and 403 refused; 429 limited; anything else unreachable. */
function classify(status){if(status>=200&&status<300)return 'ok';if(status===401||status===403)return 'refused';if(status===429)return 'limited';return 'unreachable';}
/** The fixed text for a result, whatever else came back. */
function text(vendor,result){const r=RESULTS.includes(result)?result:'unreachable';const t=TEXT[r];return typeof t==='function'?t(vendor):t;}
module.exports={TIMEOUT_MS,VENDORS,RESULTS,classify,text};
