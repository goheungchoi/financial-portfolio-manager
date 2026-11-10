import type {RuntimeState} from './RuntimeSettings';
// One shared 2-second runtime poller (lag fix L2, artifacts/reviews/2026-11-10-lag): the status header, Home, the
// dashboard and the shell used to poll getRuntime each on its own timer, so the main process built the state several
// times every two seconds. Subscribers now share one request per tick; the first subscriber starts the timer and the
// last one stops it. A failed request is passed on as an error with the last good state.
type Listener=(state:RuntimeState|null,failed:boolean)=>void;
const listeners=new Set<Listener>();let timer:number|null=null;let pending=false;let last:RuntimeState|null=null;
async function tick(){
  if(pending)return;pending=true;
  try{const state=await window.portfolio?.getRuntime();if(state){last=state;for(const listen of [...listeners])listen(state,false);}}
  catch{for(const listen of [...listeners])listen(last,true);}
  finally{pending=false;}
}
export function subscribeRuntime(listen:Listener):()=>void{
  listeners.add(listen);if(last)listen(last,false);
  if(timer==null){void tick();timer=window.setInterval(()=>void tick(),2000);}
  return()=>{listeners.delete(listen);if(!listeners.size&&timer!=null){window.clearInterval(timer);timer=null;}};
}
// After an action changed the state, ask for it now instead of waiting for the next tick.
export function refreshRuntime(){void tick();}
// Journal and News (lag fix L2b): fetch the 1.6 MB history when the page has none yet, when the state's historyVersion
// differs from the one it was fetched at, or when the version is unknown (null), in which case every refresh fetches.
export const needsHistory=(seen:string|null|undefined,version:string|null|undefined,has:boolean)=>!has||version==null||seen!==version;
