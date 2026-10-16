import {useEffect,useState} from 'react';
type Section={enabled:boolean;auto:boolean;[key:string]:number|boolean};
type Policy={leveragedEtps:Section;margin:Section;short:Section};
type Position={symbol:string;name:string;factor:number;kind:string;value:number;heldDays:number|null;short:boolean};
type Market={account:boolean;policy?:Policy;summary?:{equity:number;positions:Position[];leveragedPct:number|null;effectivePct:number|null}};
export type ExposureState={markets:{KR:Market;US:Market};overrides:{symbol:string;factor:number}[];environment:string|null};
export type ExposureReply={ok:boolean;error?:string;state:ExposureState};
const ERRORS:Record<string,string>={KIS_NOT_CONNECTED:'Connect the KIS account first.',INVALID_SETTINGS:'Check the limits: percentages 1–100, days 1–365.',INVALID_REQUEST:'Enter a valid symbol and a non-zero multiple between −5 and 5.',FEATURE_UNAVAILABLE:'KIS does not offer this for U.S. stocks.'};
const pct=(n:number|null|undefined)=>n==null?'—':`${n>0?'+':''}${n.toFixed(1)}%`;
const factorLabel=(f:number)=>f<0?`${Math.abs(f)}x inverse`:`${f}x`;
function MarketCard({name,market,data,busy,onSave}:{name:string;market:'KR'|'US';data:Market;busy:boolean;onSave(value:Partial<Policy>):void}){
  const [draft,setDraft]=useState<Policy|null>(data.policy??null);useEffect(()=>{setDraft(data.policy??null);},[JSON.stringify(data.policy)]);
  if(!data.account||!draft)return <section aria-label={`${name} short and leverage`}><h2>{name}</h2><p className="muted">Connect this account to configure leveraged products.</p></section>;
  const e=draft.leveragedEtps;const set=(key:string,value:number|boolean)=>setDraft({...draft,leveragedEtps:{...e,[key]:value,...(key==='enabled'&&!value?{auto:false}:{})}});const s=data.summary!;
  return <section aria-label={`${name} short and leverage`}><div className="section-head"><h2>{name}</h2><span className="badge">{e.enabled?(e.auto?'AUTOMATIC':'PROPOSE ONLY'):'OFF'}</span></div>
    <h3>Leveraged & inverse ETFs</h3>
    <div className="settings-grid">
      <label className="inline-check"><input type="checkbox" aria-label={`${name} allow leveraged and inverse ETFs`} checked={e.enabled} onChange={ev=>set('enabled',ev.target.checked)}/>Allow the AI to propose them</label>
      <label className="inline-check"><input type="checkbox" aria-label={`${name} automatic leveraged orders`} disabled={!e.enabled} checked={e.auto} onChange={ev=>set('auto',ev.target.checked)}/>Submit automatically (otherwise each order waits for your approval)</label>
      <label>Max share of account (%)<input type="number" min="1" max="100" value={e.maxPctOfEquity as number} onChange={ev=>set('maxPctOfEquity',Number(ev.target.value))}/></label>
      <label>Warn after holding (days)<input type="number" min="1" max="365" value={e.maxHoldingDays as number} onChange={ev=>set('maxHoldingDays',Number(ev.target.value))}/></label>
    </div>
    <div className="actions"><button className="primary" disabled={busy||JSON.stringify(draft.leveragedEtps)===JSON.stringify(data.policy!.leveragedEtps)} onClick={()=>onSave({leveragedEtps:draft.leveragedEtps})}>Save {name} settings</button></div>
    <div className="saved-summary"><span>Leveraged & inverse holdings <b>{pct(s.leveragedPct)}</b> of account</span><span>Effective market exposure <b>{pct(s.effectivePct)}</b></span></div>
    {s.positions.length>0&&<table aria-label={`${name} leveraged positions`}><thead><tr><th>Holding</th><th>Product</th><th>Held</th></tr></thead><tbody>{s.positions.map(p=><tr key={p.symbol}><td>{p.name} <small className="muted">{p.symbol}</small></td><td>{factorLabel(p.factor)}</td><td>{p.heldDays==null?'—':`${p.heldDays} d`}{p.heldDays!=null&&p.heldDays>(e.maxHoldingDays as number)?' · over limit':''}</td></tr>)}</tbody></table>}
    {market==='KR'&&<p className="muted small-print">Margin buying and short selling (KIS credit orders) are configured here once supported. They need a live account with a KIS credit agreement; KIS does not offer them on mock accounts.</p>}
  </section>;
}
export function ShortLeverage(){
  const [state,setState]=useState<ExposureState|null>(null);const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');const [symbol,setSymbol]=useState('');const [factor,setFactor]=useState('');
  useEffect(()=>{void window.portfolio?.getExposure().then(reply=>setState(reply.state)).catch(()=>{});},[]);
  if(!window.portfolio)return null;if(!state)return <section><h2>Short & leverage</h2><p className="muted">Loading…</p></section>;
  const act=async(task:()=>Promise<ExposureReply>,done?:()=>void)=>{setBusy(true);setNotice('');try{const reply=await task();setState(reply.state);if(reply.ok){setNotice('Saved.');done?.();}else setNotice(ERRORS[reply.error??'']??'The change could not be saved.');}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  return <>
    <section><h2>Short & leverage</h2><p>Leveraged ETFs multiply an index's <b>daily</b> move (2x, 3x); inverse ETFs move opposite to it. Because they reset every day, returns over weeks can differ sharply from the multiple of the index return, and losses can be large. When allowed, the AI may propose them within your cap; it never changes these settings. KIS may require investor education (and for Korean leveraged ETFs a minimum deposit) before your account can buy them.</p>{notice&&<p role="status" className="notice">{notice}</p>}</section>
    <MarketCard name="Korea" market="KR" data={state.markets.KR} busy={busy} onSave={value=>void act(()=>window.portfolio!.saveExposurePolicy('KR',value))}/>
    <MarketCard name="U.S." market="US" data={state.markets.US} busy={busy} onSave={value=>void act(()=>window.portfolio!.saveExposurePolicy('US',value))}/>
    <section aria-label="Product classification"><h2>Product classification</h2><p className="muted">Products are classified from the KIS symbol list (for example 레버리지, 인버스2X, UltraPro, Bear 3X) and a list of common U.S. tickers. Correct a product here if it is missed or misread.</p>
      <div className="settings-grid"><label>Symbol<input aria-label="Override symbol" placeholder="122630 or NASD:TQQQ" value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase().trim())}/></label><label>Daily multiple<input aria-label="Override multiple" type="number" step="0.5" placeholder="2, 3, −1, −2" value={factor} onChange={e=>setFactor(e.target.value)}/></label></div>
      <div className="actions"><button disabled={busy||!symbol||!factor} onClick={()=>void act(()=>window.portfolio!.setProductOverride(symbol,Number(factor)),()=>{setSymbol('');setFactor('');})}>Set multiple</button></div>
      {state.overrides.length>0&&<table aria-label="Product overrides"><thead><tr><th>Symbol</th><th>Multiple</th><th/></tr></thead><tbody>{state.overrides.map(o=><tr key={o.symbol}><td>{o.symbol}</td><td>{factorLabel(o.factor)}</td><td><button disabled={busy} onClick={()=>void act(()=>window.portfolio!.setProductOverride(o.symbol,null))}>Remove</button></td></tr>)}</tbody></table>}
    </section>
  </>;
}
