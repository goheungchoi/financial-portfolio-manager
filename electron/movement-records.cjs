'use strict';
// The Holdings Movement section's records (movement:records, release gate 1.5.52 G3): the recorded daily positions of
// one account, reduced to what the cards draw. It never throws: a row that cannot be parsed is left out (the cards show
// the day as a gap) and counted; a failed read gives an error reply the section shows with Retry.

/** @param {{day:string,payload:string}[]} rows nav_history rows, oldest first */
function movementDays(rows){
  const days=[];let unreadable=0;
  for(const r of rows){let p;try{p=JSON.parse(r.payload);}catch{unreadable++;continue;}if(!p||typeof p!=='object'){unreadable++;continue;}
    const part=m=>m&&typeof m==='object'?{positions:Array.isArray(m.positions)?m.positions.filter(x=>x&&typeof x==='object').map(({symbol,quantity,value,cost})=>({symbol,quantity,value,cost})):null}:null;
    days.push({day:r.day,fx:p.fx??null,KRW:part(p.KRW),USD:part(p.USD)});}
  return {days,unreadableDays:unreadable};
}

/**
 * @param {{read:()=>{day:string,payload:string}[], orders:()=>any[]}} source
 * @returns {{days:any[],unreadableDays:number,fills:Record<string,{side:string,filled:number,at:number}[]>,error?:string}}
 */
function movementRecords({read,orders}){
  const fills={};try{for(const o of orders())if(o&&o.filled>0&&o.symbol)(fills[o.symbol]??=[]).push({side:o.side,filled:o.filled,at:o.filledObservedAt??o.acceptedAt??o.createdAt});}catch{}
  let rows;try{rows=read();}catch{return {days:[],unreadableDays:0,fills,error:'RECORDS_UNREADABLE'};}
  return {...movementDays(rows),fills};
}
module.exports={movementDays,movementRecords};
