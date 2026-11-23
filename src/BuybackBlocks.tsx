// The buy-back block (found in live use; the user's rule): stocks sold outside the app whose app buys are refused for 30
// days. Activity lists them with Remove; the order ticket shows a plain line for a blocked stock (your own ticket is
// never blocked). Both refresh with the app's state, and a Remove that fails says so.
import {useEffect,useRef,useState} from 'react';import {subscribeRuntime} from './runtimeFeed';
type Block={market:'KR'|'US';symbol:string;soldOn:string;blockedUntil:string};
type Api={getBuyback?():Promise<{blocks:Block[]}>;removeBuyback?(market:string,symbol:string):Promise<{blocks:Block[]}>};
const api=()=>(window.portfolio as unknown as Api|undefined);
export function useBuybackBlocks(){const [blocks,setBlocks]=useState<Block[]>([]);const [error,setError]=useState('');const last=useRef(0);
  useEffect(()=>{let live=true;const read=()=>{last.current=Date.now();void api()?.getBuyback?.().then(r=>{if(live&&Array.isArray(r?.blocks))setBlocks(r.blocks);}).catch(()=>{});};read();
    const stop=subscribeRuntime(()=>{if(Date.now()-last.current>=10000)read();});return ()=>{live=false;stop();};},[]);
  const remove=async(b:Block)=>{setError('');try{const r=await api()?.removeBuyback?.(b.market,b.symbol);if(Array.isArray(r?.blocks))setBlocks(r.blocks);else setError(`Could not remove ${b.symbol}.`);}catch{setError(`Could not remove ${b.symbol}.`);}};
  return {blocks,remove,error};}
export function BuybackSection(){const {blocks,remove,error}=useBuybackBlocks();if(!blocks.length&&!error)return null;
  return <section className="buyback-blocks" aria-label="Buy-back blocked"><div className="section-head"><h2>Buy-back blocked</h2><small className="muted">Sold outside the app · app buys refused for 30 days</small></div>
    <ul className="compact-rows">{blocks.map(b=><li key={b.market+b.symbol}><span className="row-text">{b.symbol}</span><span className="muted">sold {b.soldOn} · blocked until {b.blockedUntil}</span>
      <button className="link-button" aria-label={`Remove the buy-back block for ${b.symbol}`} onClick={()=>void remove(b)}>Remove</button></li>)}</ul>
    {error&&<p className="negative small-line" role="alert">{error}</p>}</section>;}
export function BuybackTicketLine({market,symbol,side}:{market:'KR'|'US';symbol:string;side:string}){const {blocks}=useBuybackBlocks();const b=side==='Buy'?blocks.find(x=>x.market===market&&x.symbol===symbol):null;
  return b?<p className="muted small-line" role="note" aria-label="Buy-back block">You sold this outside the app on {b.soldOn}; the app's own buys of it are blocked until {b.blockedUntil}.</p>:null;}
