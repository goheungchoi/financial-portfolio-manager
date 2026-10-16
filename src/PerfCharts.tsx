import {useRef,useState,type ReactNode} from 'react';
// Account history charts sharing one frame: hover shows the day's values; marks stay thin and labels stay in ink colors.
type Frame={W:number;H:number;L:number;R:number;T:number;B:number};
const F:Frame={W:640,H:220,L:64,R:16,T:12,B:26};
// Bars sit in equal slots; lines put points on slot edges.
function useHover(count:number,ref:React.RefObject<SVGSVGElement|null>,bars=false){
  const [hover,setHover]=useState<number|null>(null);const last=count-1;
  const move=(e:React.PointerEvent)=>{const box=ref.current!.getBoundingClientRect();const px=(e.clientX-box.left)*F.W/box.width;const i=bars?Math.floor((px-F.L)/((F.W-F.L-F.R)/Math.max(1,count))):Math.round((px-F.L)/((F.W-F.L-F.R)/Math.max(1,last)));setHover(Math.max(0,Math.min(last,i)));};
  return {hover,move,leave:()=>setHover(null)};
}
function ticks(lo:number,hi:number){const span=hi-lo||1;const raw=span/4;const mag=10**Math.floor(Math.log10(raw));const step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw)!;const out:number[]=[];for(let t=Math.ceil(lo/step)*step;t<=hi+step*1e-9;t+=step)out.push(Math.round(t/step)*step);return out;}
function Shell({label,count,lo,hi,fmt,first,last,children,tip,hover,move,leave,svg,x}:{label:string;count:number;lo:number;hi:number;fmt:(v:number)=>string;first:string;last:string;children:ReactNode;tip:ReactNode;hover:number|null;move:(e:React.PointerEvent)=>void;leave:()=>void;svg:React.RefObject<SVGSVGElement|null>;x:(i:number)=>number}){
  const y=(v:number)=>F.T+(hi-v)*(F.H-F.T-F.B)/(hi-lo||1);
  return <div className="perf-chart"><svg ref={svg} viewBox={`0 0 ${F.W} ${F.H}`} role="img" aria-label={label} onPointerMove={move} onPointerLeave={leave}>
    {ticks(lo,hi).map(t=><g key={t}><line className="perf-grid" x1={F.L} x2={F.W-F.R} y1={y(t)} y2={y(t)}/><text className="perf-axis" x={F.L-6} y={y(t)} textAnchor="end" dominantBaseline="middle">{fmt(t)}</text></g>)}
    <text className="perf-axis" x={F.L} y={F.H-6}>{first}</text><text className="perf-axis" x={F.W-F.R} y={F.H-6} textAnchor="end">{last}</text>
    {children}
    {hover!=null&&<line className="perf-cross" x1={x(hover)} x2={x(hover)} y1={F.T} y2={F.H-F.B}/>}
    <rect x={F.L} y={F.T} width={F.W-F.L-F.R} height={F.H-F.T-F.B} fill="transparent"/>
  </svg>{hover!=null&&count>0&&<div className="perf-tooltip" role="status" style={{left:`${Math.min(80,Math.max(12,x(hover)/F.W*100))}%`}}>{tip}</div>}</div>;
}
const pad=(lo:number,hi:number)=>{if(hi-lo<1e-9){hi+=Math.abs(hi)*0.01||1;lo-=Math.abs(lo)*0.01||1;}const p=(hi-lo)*0.08;return [lo-p,hi+p];};
// Account value with the day's observed high-low range as a band.
export function ValueChart({rows,fmt}:{rows:{day:string;value:number;high:number;low:number}[];fmt:(v:number)=>string}){
  const svg=useRef<SVGSVGElement>(null);const {hover,move,leave}=useHover(rows.length,svg);
  const [lo,hi]=pad(Math.min(...rows.map(r=>r.low)),Math.max(...rows.map(r=>r.high)));const x=(i:number)=>F.L+(rows.length===1?0:i*(F.W-F.L-F.R)/(rows.length-1));const y=(v:number)=>F.T+(hi-v)*(F.H-F.T-F.B)/(hi-lo);
  const band=rows.map((r,i)=>`${x(i)},${y(r.high)}`).join(' ')+' '+[...rows].reverse().map((r,j)=>`${x(rows.length-1-j)},${y(r.low)}`).join(' ');
  const h=hover==null?null:rows[hover];
  return <Shell label={`Account value from ${rows[0].day} to ${rows.at(-1)!.day}`} count={rows.length} lo={lo} hi={hi} fmt={v=>fmt(v)} first={rows[0].day} last={rows.at(-1)!.day} hover={hover} move={move} leave={leave} svg={svg} x={x}
    tip={h&&<><b>{h.day}</b><span>Value {fmt(h.value)}</span><span className="muted">Day range {fmt(h.low)} – {fmt(h.high)}</span></>}>
    <polygon className="perf-band" points={band}/><path className="perf-line portfolio" d={rows.map((r,i)=>(i?'L':'M')+x(i)+','+y(r.value)).join('')}/>
    {h&&<circle className="perf-dot portfolio" cx={x(hover!)} cy={y(h.value)} r="4"/>}
  </Shell>;
}
// Daily P/L bars after deposits and withdrawals, rounded at the data end and anchored to zero.
export function PnlChart({rows,fmt}:{rows:{day:string;pnl:number|null;returnPct:number|null}[];fmt:(v:number)=>string}){
  const svg=useRef<SVGSVGElement>(null);const {hover,move,leave}=useHover(rows.length,svg,true);const vals=rows.map(r=>r.pnl??0);
  const [lo,hi]=pad(Math.min(0,...vals),Math.max(0,...vals));const slot=(F.W-F.L-F.R)/Math.max(1,rows.length);const x=(i:number)=>F.L+slot*(i+0.5);const y=(v:number)=>F.T+(hi-v)*(F.H-F.T-F.B)/(hi-lo);const w=Math.max(2,Math.min(18,slot-2));
  const h=hover==null?null:rows[hover];
  return <Shell label={`Daily profit and loss from ${rows[0].day} to ${rows.at(-1)!.day}`} count={rows.length} lo={lo} hi={hi} fmt={fmt} first={rows[0].day} last={rows.at(-1)!.day} hover={hover} move={move} leave={leave} svg={svg} x={x}
    tip={h&&<><b>{h.day}</b><span>P/L {h.pnl==null?'—':fmt(h.pnl)}</span><span className="muted">{h.returnPct==null?'':`${h.returnPct>0?'+':''}${h.returnPct.toFixed(2)}%`}</span></>}>
    <line className="perf-zero" x1={F.L} x2={F.W-F.R} y1={y(0)} y2={y(0)}/>
    {rows.map((r,i)=>r.pnl==null||r.pnl===0?null:<rect key={r.day} className={r.pnl>0?'perf-bar up':'perf-bar down'} x={x(i)-w/2} width={w} y={Math.min(y(0),y(r.pnl))} height={Math.max(1,Math.abs(y(r.pnl)-y(0)))} rx={Math.min(3,w/2)}/>)}
  </Shell>;
}
// Drawdown of the time-weighted index from its running peak.
export function DrawdownChart({rows}:{rows:{day:string;drawdownPct:number}[]}){
  const svg=useRef<SVGSVGElement>(null);const {hover,move,leave}=useHover(rows.length,svg);
  const [lo,hi]=pad(Math.min(-0.5,...rows.map(r=>r.drawdownPct)),0);const x=(i:number)=>F.L+(rows.length===1?0:i*(F.W-F.L-F.R)/(rows.length-1));const y=(v:number)=>F.T+(Math.min(hi,0.0001)-v)*(F.H-F.T-F.B)/(Math.min(hi,0.0001)-lo);
  const area=`M${x(0)},${y(0)}`+rows.map((r,i)=>`L${x(i)},${y(r.drawdownPct)}`).join('')+`L${x(rows.length-1)},${y(0)}Z`;const h=hover==null?null:rows[hover];
  return <Shell label={`Drawdown from peak, worst ${Math.min(...rows.map(r=>r.drawdownPct)).toFixed(2)}%`} count={rows.length} lo={lo} hi={Math.min(hi,0.0001)} fmt={v=>`${v.toFixed(1)}%`} first={rows[0].day} last={rows.at(-1)!.day} hover={hover} move={move} leave={leave} svg={svg} x={x}
    tip={h&&<><b>{h.day}</b><span>{h.drawdownPct.toFixed(2)}% from peak</span></>}>
    <path className="perf-drawdown" d={area}/><line className="perf-zero" x1={F.L} x2={F.W-F.R} y1={y(0)} y2={y(0)}/>
  </Shell>;
}
