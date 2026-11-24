'use strict';
// Who decided a review, and which company's model (artifacts/reviews/2026-11-24-provider-naming, P1). A review record's
// provider said "openai" for any AI decision, Claude's included, and was misread as the company. From P1 an AI
// decision is recorded as provider "ai" with the company in vendor and the model in model; records written before keep
// "openai" and are read through here. Stored rows are never rewritten.
// - decisionMakerOf(provider): 'ai' for 'ai' or the old 'openai'; 'local' (rules) and 'external' as they are.
// - vendorOfRecord(record): its vendor, else for an AI decision the company of its model; null when neither is known
//   (a screen then says "AI", never a company).
// - readRecord(record): the record as screens and exports read it: provider 'ai' and its vendor when known.
const AI=new Set(['ai','openai']);
const decisionMakerOf=provider=>AI.has(provider)?'ai':provider??null;
const isAi=provider=>AI.has(provider);
function vendorOfModel(model){if(typeof model!=='string'||!model)return null;try{return require('./ai-models.cjs').vendorOf(model);}catch{return null;}}
function vendorOfRecord(r){if(['openai','anthropic'].includes(r?.vendor))return r.vendor;return isAi(r?.provider)?vendorOfModel(r?.model):null;}
function readRecord(r){if(!r||typeof r!=='object'||!isAi(r.provider))return r;const vendor=vendorOfRecord(r);const {vendor:_,...rest}=r;return {...rest,provider:'ai',...(vendor?{vendor}:{})};}
module.exports={decisionMakerOf,isAi,vendorOfModel,vendorOfRecord,readRecord};
