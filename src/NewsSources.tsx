import {useEffect,useState} from 'react';
import type {RuntimeConfig} from './RuntimeSettings';
import {Switch} from './SettingsUI';
// News sources beyond DART: your feeds (saved right away), suggested public feeds, KIS headlines and U.S. ticker headlines.
export function NewsSources({config}:{config:RuntimeConfig}){
  const [feeds,setFeeds]=useState(config.newsFeeds??[]);const [suggested,setSuggested]=useState<{label:string;url:string}[]>([]);const [url,setUrl]=useState('');const [note,setNote]=useState('');
  const [kis,setKis]=useState(config.kisNews);const [us,setUs]=useState(config.usTickerNews);
  useEffect(()=>{void window.portfolio?.getSuggestedFeeds().then(setSuggested).catch(()=>{});},[]);
  const save=async(patch:Partial<RuntimeConfig>)=>{setNote('');try{const reply:any=await window.portfolio?.configureRuntime(patch);if(reply&&reply.ok===false)setNote('Could not save. Check the address.');}catch{setNote('Could not save.');}};
  const setList=(next:{url:string;label?:string}[])=>{setFeeds(next);void save({newsFeeds:next});};
  const add=(feed:{url:string;label?:string})=>{if(feeds.some(f=>f.url===feed.url)||feeds.length>=10)return;setList([...feeds,feed]);};
  const missing=suggested.filter(s=>!feeds.some(f=>f.url===s.url));
  return <div className="news-sources">
    <h3 className="research-sub">Feeds · {feeds.length}/10</h3>
    {feeds.length>0&&<ul className="desk-list compact" aria-label="News feeds">{feeds.map(f=><li key={f.url}><div><b>{f.label||new URL(f.url).hostname}</b><small>{f.url}</small></div><button aria-label={`Remove feed ${f.label||f.url}`} onClick={()=>setList(feeds.filter(x=>x.url!==f.url))}>Remove</button></li>)}</ul>}
    <div className="search-row"><input aria-label="Add news feed URL" type="url" placeholder="https://… RSS or Atom feed" value={url} onChange={e=>setUrl(e.target.value)}/><button disabled={!/^https:\/\/\S+$/.test(url.trim())||feeds.length>=10} onClick={()=>{add({url:url.trim()});setUrl('');}}>Add feed</button></div>
    {missing.length>0&&<p className="muted">Suggested: {missing.map((s,i)=><span key={s.url}>{i?' · ':''}<button className="link-button" onClick={()=>add(s)}>{s.label}</button></span>)}{missing.length>1&&<> · <button className="link-button" onClick={()=>setList([...feeds,...missing].slice(0,10))}>Add all</button></>}</p>}
    <label className="inline-check"><Switch label="KIS market headlines" checked={kis} onChange={v=>{setKis(v);void save({kisNews:v});}}/>KIS market headlines, tagged with stock codes</label>
    <label className="inline-check"><Switch label="U.S. ticker headlines" checked={us} onChange={v=>{setUs(v);void save({usTickerNews:v});}}/>Headlines for U.S. stocks you hold or watch (up to 5)</label>
    {note&&<p className="warning-text">{note}</p>}
  </div>;
}
