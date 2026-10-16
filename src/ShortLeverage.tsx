import {Note} from './Note';
import {Card,Row,Switch,NumberField} from './SettingsUI';
import {useEffect,useState} from 'react';
type Section={enabled:boolean;auto:boolean;[key:string]:number|boolean|string};
type Policy={leveragedEtps:Section;margin:Section;short:Section};
type Position={symbol:string;name:string;factor:number;kind:string;value:number;heldDays:number|null;short:boolean};
type Loan={symbol:string;quantity:number;loanAmount:number|null;loanDate:string|null;expiry:string|null;daysToExpiry:number|null;estimatedInterest:number|null};
type Short={symbol:string;quantity:number;entryPrice:number|null;price:number;adversePct:number|null;loanDate:string|null;daysToRepay:number|null;estimatedFee:number|null};
type Credit={margin:{loanTotal:number;estimatedCollateralPct:number|null;loans:Loan[]};short:{positions:Short[]};warnings:string[]}|null;
type Market={account:boolean;policy?:Policy;summary?:{equity:number;positions:Position[];leveragedPct:number|null;effectivePct:number|null};credit?:Credit};
export type ExposureState={markets:{KR:Market;US:Market};overrides:{symbol:string;factor:number}[];environment:string|null};
export type ExposureReply={ok:boolean;error?:string;state:ExposureState};
const ERRORS:Record<string,string>={KIS_NOT_CONNECTED:'Connect the KIS account first.',INVALID_SETTINGS:'Check the limits: percentages 1–100, days 1–365.',INVALID_REQUEST:'Enter a valid symbol and a non-zero multiple between −5 and 5.',FEATURE_UNAVAILABLE:'KIS does not offer margin or short selling for U.S. stocks.'};
const pct=(n:number|null|undefined)=>n==null?'—':`${n>0?'+':''}${n.toFixed(1)}%`;
const krw=(n:number|null|undefined)=>n==null?'—':new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(n);
const factorLabel=(f:number)=>f<0?`${Math.abs(f)}x inverse`:`${f}x`;
const status=(s:Section)=>s.enabled?(s.auto?'automatic':'propose only'):'off';
type Field=[key:string,label:string,kind:'number'|'source',min?:number,max?:number];
const SECTIONS:{key:keyof Policy;title:string;allow:string;fields:Field[];note:string}[]=[
  {key:'leveragedEtps',title:'Leveraged & inverse ETFs',allow:'leveraged and inverse ETFs',fields:[['maxPctOfEquity','Max share of account (%)','number',1,100],['maxHoldingDays','Warn after holding (days)','number',1,365]],note:'Daily-reset products: over weeks their return can differ sharply from the multiple of the index return.'},
  {key:'margin',title:'Margin buying (신용매수)',allow:'margin buying',fields:[['maxLoanPctOfEquity','Max loans (% of net assets)','number',1,100],['minCollateralPct','Warn below collateral ratio (%)','number',100,1000],['source','Loan source','source'],['interestPct','Annual loan interest (%)','number',0.1,30]],note:'Borrowed money magnifies gains and losses; if the collateral ratio falls below the broker\'s maintenance level, KIS can sell holdings (반대매매). Loans mature (usually within 90–150 days).'},
  {key:'short',title:'Short selling (대주매도)',allow:'short selling',fields:[['maxGrossPctOfEquity','Max short positions (% of net assets)','number',1,100],['stopLossPct','Stop warning at adverse move (%)','number',1,100],['maxDays','Repay within (days)','number',1,365],['source','Stock loan source','source'],['feePct','Annual borrowing fee (%)','number',0.1,30]],note:'Losses on a short are unlimited if the price keeps rising. Borrowed shares must be repaid by the deadline, and availability depends on the lending pool.'}
];
function MarketCard({name,market,data,busy,environment,onSave}:{name:string;market:'KR'|'US';data:Market;busy:boolean;environment:string|null;onSave(value:Partial<Policy>):void}){
  const [draft,setDraft]=useState<Policy|null>(data.policy??null);useEffect(()=>{setDraft(data.policy??null);},[JSON.stringify(data.policy)]);
  if(!data.account||!draft)return <Card title={name} label={`${name} short and leverage`}><p className="muted">Connect this account to configure leveraged products.</p></Card>;
  const sections=SECTIONS.filter(s=>market==='KR'||s.key==='leveragedEtps');const s=data.summary!,credit=data.credit;
  const set=(section:keyof Policy,key:string,value:number|boolean|string)=>setDraft({...draft,[section]:{...draft[section],[key]:value,...(key==='enabled'&&!value?{auto:false}:{})}});
  const changed=sections.some(x=>JSON.stringify(draft[x.key])!==JSON.stringify(data.policy![x.key]));
  const saved=data.policy!.leveragedEtps;
  return <Card title={name} label={`${name} short and leverage`} aside={<span className={`state-pill ${saved.enabled?'on':''}`}>{status(saved)}</span>}>
    <div className="exposure-facts muted small-line">Leveraged {pct(s.leveragedPct)} of account · effective exposure {pct(s.effectivePct)}{credit?` · margin loans ${krw(credit.margin.loanTotal)}${credit.margin.estimatedCollateralPct!=null?` · collateral ${credit.margin.estimatedCollateralPct}%`:''}`:''}</div>
    {sections.map(x=>{const p=draft[x.key];const needsLive=x.key!=='leveragedEtps'&&environment!=='live';return <div key={x.key} className="exposure-section" aria-label={`${name} ${x.title}`}>
      <div className="exposure-title"><b>{x.title}</b><span className="muted">{status(data.policy![x.key])}</span></div>
      {needsLive&&<p className="muted small-line">Live accounts only · KIS does not offer credit orders on mock accounts.</p>}
      <Row title={`Allow ${x.allow}`} hint={x.note}><Switch label={`${name} allow ${x.allow}`} checked={p.enabled} onChange={v=>set(x.key,'enabled',v)}/></Row>
      <Row title="Submit automatically" hint="Off: each order waits for your approval"><Switch label={`${name} automatic ${x.allow}`} disabled={!p.enabled} checked={p.auto} onChange={v=>set(x.key,'auto',v)}/></Row>
      {p.enabled&&x.fields.map(([key,label,kind,min,max])=>kind==='source'?<Row key={key} title={label}><select aria-label={`${name} ${label}`} value={p[key] as string} onChange={ev=>set(x.key,key,ev.target.value)}><option value="self">KIS own (자기)</option><option value="distribution">KSFC distribution (유통)</option></select></Row>:<Row key={key} title={label.replace(/ \((%|days)\)$/,'')}><NumberField label={`${name} ${label}`} min={min!} max={max!} step={0.1} unit={/days/.test(label)?'days':'%'} value={p[key] as number} onChange={v=>set(x.key,key,v)}/></Row>)}
    </div>;})}
    <div className="card-actions"><button className="primary" disabled={busy||!changed} onClick={()=>onSave(Object.fromEntries(sections.map(x=>[x.key,draft[x.key]])) as Partial<Policy>)}>Save {name} settings</button>{changed&&<small className="muted">Unsaved changes</small>}</div>
    {s.positions.some(p=>p.kind!=='standard')&&<table className="compact-table" aria-label={`${name} leveraged positions`}><thead><tr><th>Holding</th><th>Product</th><th>Held</th></tr></thead><tbody>{s.positions.filter(p=>p.kind!=='standard').map(p=><tr key={p.symbol}><td>{p.name} <small className="muted">{p.symbol}</small></td><td>{factorLabel(p.factor)}</td><td>{p.heldDays==null?'—':`${p.heldDays} d`}{p.heldDays!=null&&p.heldDays>(draft.leveragedEtps.maxHoldingDays as number)?' · over limit':''}</td></tr>)}</tbody></table>}
    {credit&&credit.margin.loans.length>0&&<table className="compact-table" aria-label={`${name} margin loans`}><thead><tr><th>Loan</th><th>Amount</th><th>Matures</th><th>Interest (est.)</th></tr></thead><tbody>{credit.margin.loans.map(l=><tr key={l.symbol+l.loanDate}><td>{l.symbol} · {l.quantity} sh · {l.loanDate}</td><td>{krw(l.loanAmount)}</td><td>{l.expiry??'—'}{l.daysToExpiry!=null?` (${l.daysToExpiry} d)`:''}</td><td>{krw(l.estimatedInterest)}</td></tr>)}</tbody></table>}
    {credit&&credit.short.positions.length>0&&<table className="compact-table" aria-label={`${name} short positions`}><thead><tr><th>Short</th><th>Sold at</th><th>Now</th><th>Move</th><th>Repay in</th><th>Fee (est.)</th></tr></thead><tbody>{credit.short.positions.map(p=><tr key={p.symbol+p.loanDate}><td>{p.symbol} · {p.quantity} sh</td><td>{krw(p.entryPrice)}</td><td>{krw(p.price)}</td><td className={(p.adversePct??0)>0?'negative':'positive'}>{pct(p.adversePct)}</td><td>{p.daysToRepay==null?'—':`${p.daysToRepay} d`}</td><td>{krw(p.estimatedFee)}</td></tr>)}</tbody></table>}
    {credit&&credit.warnings.length>0&&<ul className="conflict-list">{credit.warnings.map(w=><li key={w} role="alert">{w}</li>)}</ul>}
  </Card>;
}
export function ShortLeverage(){
  const [state,setState]=useState<ExposureState|null>(null);const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');const [symbol,setSymbol]=useState('');const [factor,setFactor]=useState('');
  useEffect(()=>{void window.portfolio?.getExposure().then(reply=>setState(reply.state)).catch(()=>{});},[]);
  if(!window.portfolio)return null;if(!state)return <section><p className="muted">Loading…</p></section>;
  const act=async(task:()=>Promise<ExposureReply>,done?:()=>void)=>{setBusy(true);setNotice('');try{const reply=await task();setState(reply.state);if(reply.ok){setNotice('Saved.');done?.();}else setNotice(ERRORS[reply.error??'']??'The change could not be saved.');}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  return <div className="engine-settings">
    <Note summary="Off by default. The AI proposes within your caps; closing is always allowed.">These settings let the AI propose leveraged or short exposure within your caps. It never changes them. Each type is off by default and, unless you turn on automatic submission, every such order waits for your approval. Closing positions (selling, repaying a loan, covering a short) is always allowed. KIS may require investor education, a credit agreement or a minimum deposit before your account can use them.</Note>
    {notice&&<p role="status" className="notice">{notice}</p>}
    <MarketCard name="Korea" market="KR" data={state.markets.KR} busy={busy} environment={state.environment} onSave={value=>void act(()=>window.portfolio!.saveExposurePolicy('KR',value))}/>
    <MarketCard name="U.S." market="US" data={state.markets.US} busy={busy} environment={state.environment} onSave={value=>void act(()=>window.portfolio!.saveExposurePolicy('US',value))}/>
    <Card title="Product classification" hint="Fix a product the app misread. Use a negative multiple for inverse.">
      <Row block title="Set a daily multiple"><span className="control-pair"><input aria-label="Override symbol" placeholder="122630 or NASD:TQQQ" value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase().trim())}/><input aria-label="Override multiple" type="number" step="0.5" placeholder="2, 3, −1" value={factor} onChange={e=>setFactor(e.target.value)}/><button disabled={busy||!symbol||!factor} onClick={()=>void act(()=>window.portfolio!.setProductOverride(symbol,Number(factor)),()=>{setSymbol('');setFactor('');})}>Set multiple</button></span></Row>
      {state.overrides.length>0&&<table className="compact-table" aria-label="Product overrides"><thead><tr><th>Symbol</th><th>Multiple</th><th/></tr></thead><tbody>{state.overrides.map(o=><tr key={o.symbol}><td>{o.symbol}</td><td>{factorLabel(o.factor)}</td><td><button disabled={busy} onClick={()=>void act(()=>window.portfolio!.setProductOverride(o.symbol,null))}>Remove</button></td></tr>)}</tbody></table>}
      <Note summary="How products are classified">Products are classified from the KIS symbol list (for example 레버리지, 인버스2X, UltraPro, Bear 3X) and a list of common U.S. tickers.</Note>
    </Card>
  </div>;
}
