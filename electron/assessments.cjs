// Research conclusions a trading review can reuse: one concise, source-linked assessment per holding or candidate,
// written by the review with save_assessment and given back to later reviews with the sections that need refreshing.
// They are the agent's conclusions, never account state: holdings, cash, orders and protection always come from the
// context. Kept per account and per instruction version (guidelines and objective), so they cannot leak across either.
// 2026-10-29: 68 of 71 reviews used the full research allowance; 28 fetched nothing new and read cached material again.
const {createHash}=require('node:crypto');
const SECTIONS=['thesis','financials','valuation','catalysts'];
const DAY=86400000,STALE_DAYS=14,DROP_DAYS=30,LIMIT=8;
const TOOL={type:'function',name:'save_assessment',description:'Save or refresh your assessment of a holding or candidate so later reviews can reuse it instead of researching again. sections lists the parts this call covers; the others keep their earlier content. thesis: strategy, horizon, thesis, invalidation, unresolved questions and conflict. financials: the decisive evidence, each item with the source it came from (sourceId: a filing receipt number, a report or article URL, or the tool and section that returned it), its publication date and when you read it. valuation: the valuation and scenario assumptions. catalysts: the next catalyst and what should prompt a refresh. Set conflict when sources disagree on something that matters. An assessment is your conclusion, not account data. Use ISO dates, or empty strings when unknown. Keep it concise: the whole call must stay under 6,000 characters.',strict:true,
  parameters:{type:'object',properties:{symbol:{type:'string'},sections:{type:'array',items:{type:'string',enum:SECTIONS}},strategy:{type:'string'},horizon:{type:'string'},thesis:{type:'string'},invalidation:{type:'string'},
    evidence:{type:'array',items:{type:'object',properties:{claim:{type:'string'},sourceId:{type:'string'},published:{type:'string'},retrieved:{type:'string'}},required:['claim','sourceId','published','retrieved'],additionalProperties:false}},
    assumptions:{type:'string'},unresolved:{type:'array',items:{type:'string'}},nextCatalyst:{type:'object',properties:{event:{type:'string'},date:{type:'string'}},required:['event','date'],additionalProperties:false},
    refreshWhen:{type:'string'},conflict:{type:'boolean'},conflictNote:{type:'string'}},
    required:['symbol','sections','strategy','horizon','thesis','invalidation','evidence','assumptions','unresolved','nextCatalyst','refreshWhen','conflict','conflictNote'],additionalProperties:false}};
const FIELDS={thesis:['strategy','horizon','thesis','invalidation','unresolved','conflict','conflictNote'],financials:['evidence'],valuation:['assumptions'],catalysts:['nextCatalyst','refreshWhen']};
const s=(v,n)=>String(v??'').trim().slice(0,n);
const day=t=>new Date(t+9*3600000).toISOString().slice(0,10);
// The instruction version an assessment was written under.
function version(context){return createHash('sha256').update(JSON.stringify([context.userGuidelines??null,context.objective??null])).digest('hex').slice(0,12);}
// Which sections need refreshing and why. events: stored news events; calendar: context.eventCalendar; price: the
// current price; movePct: the move that makes valuation stale.
function staleness(a,{now,events=[],calendar=[],price=null,movePct=3}){const stale=new Set(),why=[];const mark=(list,reason)=>{for(const x of list)stale.add(x);why.push(reason);};
  for(const k of SECTIONS)if(a.sectionsAt?.[k]!=null&&now-a.sectionsAt[k]>STALE_DAYS*DAY)mark([k],`${k} is over ${STALE_DAYS} days old`);
  const news=events.filter(e=>(e.symbols??[]).includes(a.symbol)&&(e.kind==='disclosure'||e.importance==='high')&&e.firstSeenAt>(a.sectionsAt?.thesis??0));
  if(news.length)mark(['thesis','financials'],`New ${news.some(e=>e.kind==='disclosure')?'filing':'news'} since: ${s(news[0].title,80)}`);
  const results=calendar.filter(e=>e.symbol===a.symbol&&/earnings|results|실적/i.test(`${e.kind} ${e.title}`)&&e.date>day(a.sectionsAt?.financials??0)&&e.date<=day(now));
  if(results.length)mark(['financials','valuation'],`Results due ${results[0].date} since the financials were read`);
  if(price>0&&a.priceAt>0&&Math.abs(price/a.priceAt-1)*100>=movePct)mark(['valuation'],`Price ${price} vs ${a.priceAt} when assessed (${Math.round((price/a.priceAt-1)*1000)/10}%)`);
  const catalyst=Date.parse(a.nextCatalyst?.date??'');if(Number.isFinite(catalyst)&&catalyst<=now)mark(['catalysts'],`The catalyst date ${a.nextCatalyst.date} has passed`);
  if(a.conflict)mark(['thesis'],`Sources conflict: ${a.conflictNote||'investigate before relying on it'}`);
  return {stale:SECTIONS.filter(k=>stale.has(k)),why};}
class Assessments {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS assessments(scope TEXT NOT NULL,symbol TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol,version))');}
  get(scope,symbol,ver){const row=this.db.prepare('SELECT payload FROM assessments WHERE scope=? AND symbol=? AND version=?').get(scope,symbol,ver);return row?JSON.parse(row.payload):null;}
  // From the save_assessment tool. symbols: those the review may assess (holdings and the review universe).
  save(scope,args,{context={},reviewId=null,symbols=[]}={}){
    const symbol=s(args?.symbol,24).toUpperCase(),sections=[...new Set((Array.isArray(args?.sections)?args.sections:[]).filter(x=>SECTIONS.includes(x)))];
    if(!symbol||!symbols.includes(symbol))return {status:'rejected',reason:'The symbol must be a holding or in the review universe.'};if(!sections.length)return {status:'rejected',reason:'Name at least one section.'};
    const evidence=(Array.isArray(args.evidence)?args.evidence:[]).slice(0,8).map(e=>({claim:s(e?.claim,240),sourceId:s(e?.sourceId,200),published:s(e?.published,32),retrieved:s(e?.retrieved,32)})).filter(e=>e.claim);
    if(sections.includes('financials')&&evidence.some(e=>!e.sourceId))return {status:'rejected',reason:'Every evidence item needs its sourceId.'};
    const ver=version(context),now=this.clock(),prev=this.get(scope,symbol,ver),value={strategy:s(args.strategy,40),horizon:s(args.horizon,60),thesis:s(args.thesis,500),invalidation:s(args.invalidation,240),unresolved:(Array.isArray(args.unresolved)?args.unresolved:[]).slice(0,4).map(x=>s(x,200)).filter(Boolean),conflict:args.conflict===true,conflictNote:s(args.conflictNote,200),
      evidence,assumptions:s(args.assumptions,400),nextCatalyst:{event:s(args.nextCatalyst?.event,120),date:s(args.nextCatalyst?.date,32)},refreshWhen:s(args.refreshWhen,240)};
    const next={...(prev??{}),symbol,scope,version:ver,sectionsAt:{...(prev?.sectionsAt??{})},updatedAt:now,reviewId};
    for(const k of sections){for(const f of FIELDS[k])next[f]=value[f];next.sectionsAt[k]=now;}
    if(sections.includes('valuation')||!prev)next.priceAt=(context.quotes??[]).find(q=>q.symbol===symbol)?.price??prev?.priceAt??null;
    this.db.prepare('INSERT INTO assessments VALUES(?,?,?,?) ON CONFLICT(scope,symbol,version) DO UPDATE SET payload=excluded.payload').run(scope,symbol,ver,JSON.stringify(next));
    return {status:'saved',symbol,sections,reused:prev?SECTIONS.filter(k=>!sections.includes(k)&&prev.sectionsAt?.[k]!=null):[]};}
  // What a review sees: the assessments of these symbols under this instruction version, with stale sections; holdings
  // first, then the most recently updated, at most LIMIT of them with at most four evidence items each (the rest stay
  // stored and come back when there is room).
  context(scope,{context={},symbols=[],events=[],movePct=3}={}){const now=this.clock(),ver=version(context),out=[];
    this.db.prepare('DELETE FROM assessments WHERE scope=? AND json_extract(payload,\'$.updatedAt\')<?').run(scope,now-DROP_DAYS*DAY);
    for(const symbol of symbols){const a=this.get(scope,symbol,ver);if(!a)continue;const price=(context.quotes??[]).find(q=>q.symbol===symbol)?.price??null;
      const {stale,why}=staleness(a,{now,events,calendar:context.eventCalendar??[],price,movePct});
      out.push({symbol,updated:new Date(a.updatedAt).toISOString(),strategy:a.strategy,horizon:a.horizon,thesis:a.thesis,invalidation:a.invalidation,evidence:(a.evidence??[]).slice(0,4),assumptions:a.assumptions,unresolved:a.unresolved??[],nextCatalyst:a.nextCatalyst,refreshWhen:a.refreshWhen,
        ...(a.conflict?{conflict:a.conflictNote||true}:{}),priceAt:a.priceAt??null,sectionsUpdated:Object.fromEntries(Object.entries(a.sectionsAt??{}).map(([k,t])=>[k,new Date(t).toISOString()])),stale,...(why.length?{staleBecause:why}:{}),held:Boolean(context.positions?.[symbol]?.quantity>0),at:a.updatedAt});}
    return out.sort((x,y)=>Number(y.held)-Number(x.held)||y.at-x.at).slice(0,LIMIT).map(({at,...rest})=>rest);}
}
module.exports={Assessments,staleness,version,TOOL,SECTIONS};
