// Freshness policy for intraday Korean market readings (breadth and flows from the market overview).
// While the KRX regular session is open, a reading is current only if it was taken during this session and is at most
// 30 minutes old. Outside the session, a reading taken during the last session is labeled with its time as the latest
// available one; a reading from an earlier session is stale. Stale readings are shown with their time, never as current.
const S=require('./market-sessions.cjs');
const MAX_AGE=30*60000;
const kst=t=>new Date(t+9*3600000).toISOString().slice(0,16).replace('T',' ');
// The current or most recent KRX regular session: {startAt,endAt} or null.
function lastSession(now,{closedDays=new Set()}={}){
  for(let i=0;i<10;i++){const day=S.localDay(now-i*86400000,'Asia/Seoul');const reg=S.sessionsOn('KR',day,{closedDays}).find(x=>x.regular);if(reg&&reg.startAt<=now)return {startAt:reg.startAt,endAt:reg.endAt};}
  return null;
}
const krOpen=(now,opts)=>{const s=lastSession(now,opts);return Boolean(s&&now<s.endAt);};
function breadthFreshness(at,now,opts={}){
  if(!Number.isFinite(at))return {asOf:null,stale:true,note:'time of reading unknown'};
  const s=lastSession(now,opts);const asOf=kst(at)+' KST';
  if(s&&now<s.endAt){if(at<s.startAt)return {asOf,stale:true,note:`from an earlier session (${asOf}); this session's reading is not available`};
    if(now-at>MAX_AGE)return {asOf,stale:true,note:`${Math.round((now-at)/60000)} minutes old`};return {asOf,stale:false};}
  if(s&&at>=s.startAt)return {asOf,stale:false,note:`latest reading of the last session (market closed), as of ${asOf}`};
  return {asOf,stale:true,note:`from an earlier session (${asOf})`};
}
module.exports={breadthFreshness,krOpen,lastSession,MAX_AGE};
