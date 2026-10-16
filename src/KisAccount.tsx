// KIS account data types. The account UI now lives in Connections.tsx.
export type KisSnapshot={ source:string; environment:string; timestamp:string; cash:number; reportedTotal:number; holdings:{symbol:string;name:string;quantity:number;cost:number;price:number;marketValue:number;unrealized:number}[] };
export type KisState={ status:string; snapshot:KisSnapshot|null; error:string|null };
