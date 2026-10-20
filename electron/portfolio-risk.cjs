// Portfolio risk views computed locally: exposure (sectors, concentration, beta, holdings that move together),
// volatility-based position sizing and a market regime gauge from stress signals.
const r1=v=>v==null||!Number.isFinite(v)?null:Math.round(v*10)/10,r2=v=>v==null||!Number.isFinite(v)?null:Math.round(v*100)/100;
const returns=closes=>{const m=new Map();for(let i=1;i<(closes??[]).length;i++)if(closes[i].close>0&&closes[i-1].close>0)m.set(closes[i].date,closes[i].close/closes[i-1].close-1);return m;};
function corr(a,b){const days=[...a.keys()].filter(d=>b.has(d)).slice(-60);if(days.length<20)return null;const x=days.map(d=>a.get(d)),y=days.map(d=>b.get(d));const mx=x.reduce((s,v)=>s+v,0)/x.length,my=y.reduce((s,v)=>s+v,0)/y.length;let c=0,vx=0,vy=0;x.forEach((v,i)=>{c+=(v-mx)*(y[i]-my);vx+=(v-mx)**2;vy+=(y[i]-my)**2;});return vx&&vy?c/Math.sqrt(vx*vy):null;}
// holdings: [{symbol,name,market,valueKRW}]; daily(symbol) → closes; sector(symbol) → name; beta(symbol) → number|null.
function exposure(holdings,{daily,sector,beta,cashKRW=0}){
  const rows=(holdings??[]).filter(h=>h.valueKRW>0);const invested=rows.reduce((s,h)=>s+h.valueKRW,0);const total=invested+Math.max(0,cashKRW);if(!rows.length)return {holdings:0,cashPct:total?100:null};
  const w=h=>h.valueKRW/total*100;const sectors=new Map();for(const h of rows){const k=sector(h.symbol)??'Unclassified';sectors.set(k,(sectors.get(k)??0)+w(h));}
  const markets=new Map();for(const h of rows)markets.set(h.market,(markets.get(h.market)??0)+w(h));
  const betas=rows.map(h=>[h,beta(h.symbol)]).filter(([,b])=>Number.isFinite(b));const covered=betas.reduce((s,[h])=>s+w(h),0);
  const series=new Map(rows.map(h=>[h.symbol,returns(daily(h.symbol))]));const pairs=[];
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){const c=corr(series.get(rows[i].symbol),series.get(rows[j].symbol));if(c!=null)pairs.push({a:rows[i],b:rows[j],c});}
  // Holdings that move together (correlation 0.7 or more) are grouped; a group's weight is its combined share.
  const parent=new Map(rows.map(h=>[h.symbol,h.symbol]));const find=s=>parent.get(s)===s?s:find(parent.get(s));for(const p of pairs)if(p.c>=0.7)parent.set(find(p.a.symbol),find(p.b.symbol));
  const groups=new Map();for(const h of rows){const k=find(h.symbol);(groups.get(k)??groups.set(k,[]).get(k)).push(h);}
  const sorted=[...rows].sort((a,b)=>b.valueKRW-a.valueKRW);const hhi=rows.reduce((s,h)=>s+(h.valueKRW/invested)**2,0);
  return {holdings:rows.length,investedPct:r1(invested/total*100),cashPct:r1(Math.max(0,cashKRW)/total*100),largest:{symbol:sorted[0].symbol,name:sorted[0].name,weightPct:r1(w(sorted[0]))},top3WeightPct:r1(sorted.slice(0,3).reduce((s,h)=>s+w(h),0)),
    effectiveHoldings:r1(1/hhi),sectors:[...sectors].map(([name,weightPct])=>({name,weightPct:r1(weightPct)})).sort((a,b)=>b.weightPct-a.weightPct),markets:[...markets].map(([market,weightPct])=>({market,weightPct:r1(weightPct)})),
    portfolioBeta:covered>0?r2(betas.reduce((s,[h,b])=>s+w(h)*b,0)/covered*(invested/total)):null,betaCoveragePct:r1(covered),
    movesTogether:[...groups.values()].filter(g=>g.length>1).map(g=>({symbols:g.map(h=>h.symbol),names:g.map(h=>h.name),weightPct:r1(g.reduce((s,h)=>s+w(h),0))})).sort((a,b)=>b.weightPct-a.weightPct),
    note:'Weights are shares of total equity including cash. Beta is weighted over holdings with history. Holdings that move together have daily-return correlation of 0.7 or more over about 60 days.'};
}
// Volatility sizing: risk a fixed share of equity per trade, with the stop a multiple of ATR below the entry.
function sizing({equityKRW,riskPct,atrMultiple,rows}){
  if(!(equityKRW>0))return null;const budget=equityKRW*riskPct/100;
  return {riskPerTradePct:riskPct,stopAtrMultiple:atrMultiple,riskBudgetKRW:Math.round(budget),
    // A row's cashKRW, when known, also caps the shares: risk at the stop alone can allow more than the cash buys.
    rows:rows.filter(r=>r.atr>0&&r.price>0).map(r=>{const stop=r.atr*atrMultiple,fx=r.fx??1;const byRisk=Math.floor(budget/(stop*fx));const byCash=Number.isFinite(r.cashKRW)?Math.max(0,Math.floor(r.cashKRW/(r.price*fx))):Infinity;const shares=Math.min(byRisk,byCash);return {symbol:r.symbol,price:r.price,atr:r2(r.atr),stopDistance:r2(stop),suggestedStop:r2(r.price-stop),maxShares:shares,...(byCash<byRisk?{limitedBy:'cash'}:{}),maxValueKRW:Math.round(shares*r.price*fx),maxWeightPct:r1(shares*r.price*fx/equityKRW*100)};}),
    note:`Largest position whose loss at the stop (${atrMultiple}× ATR below entry) stays within ${riskPct}% of equity, and no more than the available cash buys (limitedBy: cash). A ceiling, not a target; other limits still apply.`};
}
// Regime gauge: each stress reading scores −1 (risk-off), 0 or +1 (risk-on); the total sets the regime.
function regime({vix,vix5dChangePct,hySpread,hySpreadChange,advanceRatioPct,kospiVs50dPct,sox20dPct,oil20dPct}){
  const parts=[];const add=(name,value,score,reading)=>{if(value!=null&&Number.isFinite(value))parts.push({name,value:r2(value),score,reading});};
  add('VIX',vix,vix>=25?-1:vix<=15?1:0,vix>=25?'high fear':vix<=15?'calm':'normal');
  add('VIX 5-day change %',vix5dChangePct,vix5dChangePct>=20?-1:vix5dChangePct<=-15?1:0,vix5dChangePct>=20?'fear rising fast':vix5dChangePct<=-15?'fear easing':'steady');
  add('High-yield spread %',hySpread,hySpread>=5?-1:hySpread<=3.5?1:0,hySpread>=5?'credit stress':hySpread<=3.5?'easy credit':'normal');
  add('High-yield spread change',hySpreadChange,hySpreadChange>=0.25?-1:hySpreadChange<=-0.25?1:0,hySpreadChange>=0.25?'widening':hySpreadChange<=-0.25?'tightening':'steady');
  add('KOSPI advancers %',advanceRatioPct,advanceRatioPct<=30?-1:advanceRatioPct>=70?1:0,advanceRatioPct<=30?'broad selling':advanceRatioPct>=70?'broad buying':'mixed');
  add('KOSPI vs 50-day average %',kospiVs50dPct,kospiVs50dPct<=-5?-1:kospiVs50dPct>=3?1:0,kospiVs50dPct<=-5?'below trend':kospiVs50dPct>=3?'above trend':'near trend');
  add('Semiconductor index 20-day %',sox20dPct,sox20dPct<=-10?-1:sox20dPct>=10?1:0,sox20dPct<=-10?'chips falling':sox20dPct>=10?'chips rising':'flat');
  add('Oil two-week change %',oil20dPct,oil20dPct>=12?-1:0,oil20dPct>=12?'oil spike':'no spike');
  if(parts.length<3)return null;const score=parts.reduce((s,p)=>s+p.score,0);
  return {regime:score<=-2?'risk_off':score>=2?'risk_on':'neutral',score,components:parts,note:'Rule-based from stress readings, separate from the AI-written narrative. Risk-off asks for smaller positions and stronger evidence for new buys.'};
}
module.exports={exposure,sizing,regime,corr,returns};
