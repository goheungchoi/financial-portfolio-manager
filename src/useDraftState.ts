import {useCallback,useRef,useState,type Dispatch,type SetStateAction} from 'react';
// Session memory only: navigation retains drafts; reload/exit discards them.
const values=new Map<string,unknown>();
const refs=new Map<string,{current:unknown}>();
export function useDraftState<T>(key:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>]{
  const [value,setValue]=useState<T>(()=>values.has(key)?values.get(key) as T:typeof initial==='function'?(initial as ()=>T)():initial);
  const update=useCallback<Dispatch<SetStateAction<T>>>(action=>setValue(current=>{const next=typeof action==='function'?(action as (previous:T)=>T)(current):action;values.set(key,next);return next;}),[key]);
  return [value,update];
}
export function useDraftRef<T>(key:string,initial:T){
  const local=useRef<{current:T}|null>(null);
  if(!local.current){if(!refs.has(key))refs.set(key,{current:initial});local.current=refs.get(key) as {current:T};}
  return local.current;
}
