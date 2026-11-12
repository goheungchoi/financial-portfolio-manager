import {useEffect,useState} from 'react';
import type {RuntimeConfig,RuntimeState} from './RuntimeSettings';
import {Card,Row,Switch,Limit} from './SettingsUI';
import {Note} from './Note';
import {toast} from './Toast';
// Release B, step B1 (artifacts/reviews/2026-11-12-engine-settings/b1-design.md): one card per AI provider, alike:
// whether its key is loaded (never the key), a Test that costs no tokens, data sharing for that provider, and its own
// daily limits with today's use. Keys still come from the provider file (the import row is in the keys card below).
// The sharing switch applies at once; the limits save with the card's own Save.
type Vendor='openai'|'anthropic';
const NAMES:Record<Vendor,string>={openai:'OpenAI',anthropic:'Anthropic'};
const KEYS:Record<Vendor,{share:keyof RuntimeConfig;calls:keyof RuntimeConfig;usd:keyof RuntimeConfig;unlimitedCalls:keyof RuntimeConfig;unlimitedBudget:keyof RuntimeConfig}>={
  openai:{share:'shareKisWithOpenAI',calls:'maxCallsPerDay',usd:'maxUSDPerDay',unlimitedCalls:'unlimitedCalls',unlimitedBudget:'unlimitedBudget'},
  anthropic:{share:'shareKisWithAnthropic',calls:'anthropicCallsPerDay',usd:'anthropicUSDPerDay',unlimitedCalls:'anthropicUnlimitedCalls',unlimitedBudget:'anthropicUnlimitedBudget'}};
const AGENT_NAMES:Record<string,string>={trading:'Reviews',scout:'scout',narrative:'narrative',compacting:'compacting',reflection:'reflection'};
const usd=(micro:number)=>`$${(micro/1e6).toFixed(2)}`;
export function ProviderCards({runtime,providerFile,busy,onState}:{runtime:RuntimeState|null;providerFile?:string|null;busy:boolean;onState(state:RuntimeState):void}){
  return <section className="provider-cards" id="ai-providers" aria-label="AI providers">
    <div className="section-head"><div><h2>AI providers</h2><small className="muted">Keys come from your provider file. Data sharing and limits are per provider.</small></div></div>
    {(['openai','anthropic'] as Vendor[]).map(v=><ProviderCard key={v} vendor={v} runtime={runtime} providerFile={providerFile} busy={busy} onState={onState}/>)}
  </section>;
}
function ProviderCard({vendor,runtime,providerFile,busy,onState}:{vendor:Vendor;runtime:RuntimeState|null;providerFile?:string|null;busy:boolean;onState(state:RuntimeState):void}){
  const name=NAMES[vendor],k=KEYS[vendor],config=runtime?.config;const status=runtime?.providerStatus;
  const loaded=vendor==='anthropic'?Boolean(status?.anthropicConnected):Boolean(status?.openaiConnected??status?.aiConnected);
  const [test,setTest]=useState<{text:string;ok:boolean}|null>(null);const [testing,setTesting]=useState(false);
  const [draft,setDraft]=useState<Partial<RuntimeConfig>>({});const [saving,setSaving]=useState(false);
  useEffect(()=>{setDraft({});},[config?.[k.calls],config?.[k.usd],config?.[k.unlimitedCalls],config?.[k.unlimitedBudget]]);
  if(!config)return null;
  const value=<K extends keyof RuntimeConfig>(key:K)=>(key in draft?draft[key]:config[key]) as RuntimeConfig[K];
  const dirty=Object.keys(draft).length>0;
  const save=async(patch:Partial<RuntimeConfig>)=>{const api=window.portfolio;if(!api)return false;setSaving(true);try{const r=await api.configureRuntime(patch);if(r.state)onState(r.state);toast(r.ok?`${name} settings saved`:`Not saved: ${r.message??r.error??'request failed'}`,r.ok?'ok':'error');return r.ok;}catch{toast('Not saved: could not reach the engine','error');return false;}finally{setSaving(false);}};
  const runTest=async()=>{const api=window.portfolio;if(!api?.testProviderKey)return;setTesting(true);setTest(null);try{const r=await api.testProviderKey(vendor);setTest({text:r.text,ok:r.result==='ok'});}catch{setTest({text:`Could not reach ${name}`,ok:false});}finally{setTesting(false);}};
  const today=runtime?.usageByVendor?.[vendor]??{calls:0,reservedMicro:0};
  const uses=vendor==='anthropic'?'Dry run only until release B3':(()=>{const m=runtime?.agentModels;if(!m)return 'AI reviews';const list=Object.entries(m).filter(([,x])=>!x.openaiModel.startsWith('claude-')).map(([a])=>AGENT_NAMES[a]??a);return list.length?list.join(', ').replace(/^./,c=>c.toUpperCase()):'Nothing now';})();
  return <Card title={name} label={`${name} provider`} hint={uses} aside={<span className={`status-pill ${loaded?'ok':'off'}`}><i aria-hidden="true"/>{loaded?'Key loaded':'No key'}</span>}>
    <Row block title="Key" hint={loaded?`From ${providerFile??'your provider file'}`:`Add ${vendor==='anthropic'?'anthropicApiKey':'openaiApiKey'} to your provider file and import it`}>
      <span className="control-pair"><button disabled={busy||testing||!loaded} onClick={()=>void runTest()} title="Lists the provider's models. Uses no tokens.">{testing?'Testing…':'Test'}</button></span></Row>
    {test&&<p role="status" className={test.ok?'muted':'notice error'} aria-label={`${name} key test`}>{test.text}</p>}
    <Row title={`Share KIS data with ${name}`} hint="Holdings, values and orders, sent with each request that uses this provider"><Switch label={`Share KIS data with ${name}`} disabled={busy||saving} checked={Boolean(config[k.share])} onChange={v=>void save({[k.share]:v} as Partial<RuntimeConfig>)}/></Row>
    <Row block title="Calls per day" hint={`Today: ${today.calls}`}><Limit label={`${name} calls per day`} min={1} max={200} disabled={busy||saving} unlimited={Boolean(value(k.unlimitedCalls))} value={Number(value(k.calls))} onUnlimited={v=>setDraft(d=>({...d,[k.unlimitedCalls]:v}))} onValue={v=>setDraft(d=>({...d,[k.calls]:v}))}/></Row>
    <Row block title="Spending per day" hint={`Today: ${usd(today.reservedMicro)} (local estimate)`}><Limit label={`${name} daily budget (USD)`} min={.01} max={100} step={.01} unit="USD" disabled={busy||saving} unlimited={Boolean(value(k.unlimitedBudget))} value={Number(value(k.usd))} onUnlimited={v=>setDraft(d=>({...d,[k.unlimitedBudget]:v}))} onValue={v=>setDraft(d=>({...d,[k.usd]:v}))}/></Row>
    {dirty&&<div className="card-actions"><button disabled={saving} onClick={()=>setDraft({})}>Discard</button><button className="primary" disabled={saving} onClick={()=>void save(draft).then(ok=>{if(ok)setDraft({});})}>Save limits</button></div>}
    {vendor==='anthropic'&&<Note summary="What Anthropic is used for now">Only the dry run (Dashboard → Dry run) can use Claude until release B3, and it needs this key, this sharing switch and room in these limits. Every other agent stays on OpenAI.</Note>}
  </Card>;
}
