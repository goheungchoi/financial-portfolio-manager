// Observation episodes (audit 2026-11-04, Stage 5). The observation features log a check every time they evaluate, so
// one lasting condition (a stock staying 4% above its last review price) became thousands of rows that read like
// thousands of opportunities. An episode is a run of checks with one outcome; each feature supplies what an outcome is,
// what resets it and what ends it, because routing, scheduling and price alerts measure different things.
// Terms used by every feature's report:
const TERMS={check:'one evaluation the feature logged',episode:'a run of checks with one outcome, as the feature defines it',
  reviewStarted:'a review the app actually ran',comparison:'one review evaluated two ways (routing)'};
// The 60-minute gap is a grouping convention, not evidence that the next episode is independent of the last.
const GAP_MS=60*60000;
// rows: checks sorted by time ({id, at, ...}); parts(row): the [{key, signature, ...detail}] the row contributes, one per
// symbol or subject (an unrelated subject never splits another's episode); endedBy(key, from, to): the time of an event
// between two checks that ends the episode (a review that assessed the subject), or null.
// An episode ends on a gap longer than gapMs ('gap'), a changed signature ('outcome-changed', or 'reset' when only the
// reset part changed: signature returns {outcome, reset}), an ending event ('reviewed'), or the end of the data ('open').
// Every episode keeps its checks' ids, first and last times and the reason it ended.
function group(rows,{parts,endedBy=()=>null,gapMs=GAP_MS}={}){const open=new Map(),done=[];
  const close=(ep,reason,at=null)=>{open.delete(ep.key);done.push({...ep,endReason:reason,...(at!=null?{endedAt:at}:{})});};
  for(const row of rows)for(const p of parts(row)){const ep=open.get(p.key),sig=p.signature??{};
    if(ep){const ended=endedBy(p.key,ep.last,row.at);
      if(row.at-ep.last>gapMs)close(ep,'gap');else if(ended!=null)close(ep,'reviewed',ended);
      else if(ep.signature.outcome!==sig.outcome)close(ep,'outcome-changed');else if(ep.signature.reset!==sig.reset)close(ep,'reset');
      else{ep.last=row.at;ep.count++;ep.ids.push(row.id);continue;}}
    open.set(p.key,{key:p.key,signature:sig,first:row.at,last:row.at,count:1,ids:[row.id],detail:p.detail??null});}
  for(const ep of [...open.values()])close(ep,'open');
  return done.sort((a,b)=>a.first-b.first);}
module.exports={group,TERMS,GAP_MS};
