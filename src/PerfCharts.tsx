import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
// Account history charts. They draw at the container's real width so text and marks keep their size,
// share one frame (date ticks, round value ticks, crosshair readout) and label only the points that matter.
const T=18,B=30,L=68,R=76;
type Scale={w:number;h:number;x:(i:number)=>number;y:(v:number)=>number;lo:number;hi:number;ticks:number[]};
function useWidth(){const ref=useRef<HTMLDivElement>(null);const [w,setW]=useState(720);
  useEffect(()=>{const el=ref.current;if(!el)return;const update=()=>setW(Math.max(320,Math.round(el.clientWidth)));update();const ro=new ResizeObserver(update);ro.observe(el);return()=>ro.disconnect();},[]);
  return [ref,w] as const;}
export function niceTicks(lo:number,hi:number,count=5){const span=hi-lo||Math.abs(hi)||1;const raw=span/count;const mag=10**Math.floor(Math.log10(raw));const step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw)!;const out:number[]=[];for(let t=Math.ceil(lo/step-1e-9)*step;t<=hi+step*1e-9;t+=step)out.push(Math.round(t/step)*step);return {ticks:out,step};}
// Pads the data range to whole ticks so lines never touch the frame; a flat series still gets a readable range.
function scale(w:number,count:number,values:number[],{bars=false,includeZero=false,h:H=260}:{bars?:boolean;includeZero?:boolean;h?:number}={}):Scale{
  let lo=Math.min(...values,...(includeZero?[0]:[])),hi=Math.max(...values,...(includeZero?[0]:[]));
  if(hi-lo<Math.abs(hi)*0.002||hi===lo){const pad=Math.max(Math.abs(hi)*0.004,1e-6);lo-=pad;hi+=pad;}
  const {ticks,step}=niceTicks(lo,hi);const tlo=Math.min(ticks[0],lo),thi=Math.max(ticks.at(-1)!,hi);const extra=(thi-tlo)*0.04;
  const top=includeZero&&thi<=0?0:thi+(ticks.at(-1)!>=hi?0:extra),bottom=includeZero&&tlo>=0?0:tlo-(ticks[0]<=lo?0:extra);
  const slot=(w-L-R)/Math.max(1,count);const x=bars?(i:number)=>L+slot*(i+0.5):(i:number)=>L+(count<=1?0:i*(w-L-R)/(count-1));
  const y=(v:number)=>T+(top-v)*(H-T-B)/((top-bottom)||1);
  return {w,h:H,x,y,lo:bottom,hi:top,ticks:ticks.filter(t=>t>=bottom-step*1e-6&&t<=top+step*1e-6)};
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const shortDay=(day:string,withYear=false)=>`${MONTHS[Number(day.slice(5,7))-1]} ${Number(day.slice(8,10))}${withYear?`, ${day.slice(0,4)}`:''}`;
// Up to six evenly spaced date labels; the year is shown when the range crosses one.
function dateTicks(days:string[],w:number){const n=days.length;if(!n)return [];const room=Math.max(2,Math.min(6,Math.floor((w-L-R)/90)));const idx=n<=room?days.map((_,i)=>i):Array.from({length:room},(_,k)=>Math.round(k*(n-1)/(room-1)));const years=days[0].slice(0,4)!==days.at(-1)!.slice(0,4);return [...new Set(idx)].map(i=>({i,label:shortDay(days[i],years&&(i===0||days[i].slice(0,4)!==days[Math.max(0,i-1)].slice(0,4)))}));}
// Compact axis money: enough decimals that neighbouring ticks differ.
export function axisMoney(v:number,step:number,currency:string){const sym=currency==='USD'?'$':'₩';const a=Math.abs(v),sign=v<0?'-':'';
  if(currency!=='USD'&&a>=1e6){const whole=(n:number)=>Math.abs(step/n-Math.round(step/n))<1e-6;const d=step>=1e6&&whole(1e6)?0:whole(1e5)?1:whole(1e4)?2:3;return `${sign}${sym}${(a/1e6).toFixed(d)}M`;}
  if(currency==='USD'&&a>=1e4){const d=step>=1e4?0:1;return `${sign}${sym}${(a/1e3).toFixed(d)}K`;}
  return `${sign}${sym}${a.toLocaleString('en-US',{maximumFractionDigits:currency==='USD'&&step<1?2:0})}`;}
const pctLabel=(v:number,step:number)=>`${v>0?'+':''}${v.toFixed(step>=1?0:step>=0.1?1:2)}%`;
function useHover(count:number,s:Scale,bars:boolean){const [hover,setHover]=useState<number|null>(null);
  const move=(e:React.PointerEvent<SVGSVGElement>)=>{const box=e.currentTarget.getBoundingClientRect();const px=(e.clientX-box.left)*s.w/box.width;const span=s.w-L-R;const i=bars?Math.floor((px-L)/(span/Math.max(1,count))):Math.round((px-L)/(span/Math.max(1,count-1)));setHover(Math.max(0,Math.min(count-1,i)));};
  return {hover,move,leave:()=>setHover(null)};}
// Frame: grid, value ticks, date ticks, crosshair and the readout card next to the hovered point.
function Frame({label,days,s,fmt,hover,move,leave,tip,children,legend,boxRef}:{label:string;days:string[];s:Scale;fmt:(v:number)=>string;hover:number|null;move:(e:React.PointerEvent<SVGSVGElement>)=>void;leave:()=>void;tip:ReactNode;children:ReactNode;legend?:ReactNode;boxRef:React.RefObject<HTMLDivElement|null>}){
  const H=s.h;const hx=hover==null?0:s.x(hover);const flip=hx>s.w*0.62;
  return <div className="perf-chart" ref={boxRef}><svg width={s.w} height={H} viewBox={`0 0 ${s.w} ${H}`} role="img" aria-label={label} onPointerMove={move} onPointerLeave={leave}>
    {s.ticks.map(t=><g key={t}><line className="perf-grid" x1={L} x2={s.w-R} y1={s.y(t)} y2={s.y(t)}/><text className="perf-axis" x={L-10} y={s.y(t)} textAnchor="end" dominantBaseline="middle">{fmt(t)}</text></g>)}
    {dateTicks(days,s.w).map(({i,label})=><text key={i} className="perf-axis" x={s.x(i)} y={H-8} textAnchor={i===0?'start':i===days.length-1?'end':'middle'}>{label}</text>)}
    {children}
    {hover!=null&&<line className="perf-cross" x1={hx} x2={hx} y1={T} y2={H-B}/>}
    <rect x={L} y={T} width={Math.max(0,s.w-L-R)} height={H-T-B} fill="transparent"/>
  </svg>{hover!=null&&<div className="perf-tooltip" role="status" style={flip?{right:s.w-hx+12,left:'auto',transform:'none'}:{left:hx+12,transform:'none'}}>{tip}</div>}{legend}</div>;
}
const End=({x,y,text,className=''}:{x:number;y:number;text:string;className?:string})=><text className={`perf-label ${className}`} x={x+8} y={y} dominantBaseline="middle">{text}</text>;
// A labelled point (period high or low); the label sits above or below so it stays clear of the line.
const Mark=({x,y,text,below,w,tone=''}:{x:number;y:number;text:string;below?:boolean;w:number;tone?:string})=><g className={`perf-mark ${tone}`}><circle cx={x} cy={y} r="3.5"/><text x={Math.min(Math.max(x,L+40),w-R-40)} y={below?y+16:y-10} textAnchor="middle">{text}</text></g>;
const signedMoney=(v:number,fmt:(v:number)=>string)=>(v>0?'+':v<0?'−':'')+fmt(Math.abs(v));
// Account value: a line with a soft area, the day's high-low band, the start level, and the period high and low.
export function ValueChart({rows,fmt,currency='KRW',height=260,marks=true}:{rows:{day:string;value:number;high:number;low:number}[];fmt:(v:number)=>string;currency?:string;height?:number;marks?:boolean}){
  const [ref,w]=useWidth();const grad=useId();const s=scale(w,rows.length,rows.flatMap(r=>[r.low,r.high,r.value]),{h:height});const H=s.h;const {hover,move,leave}=useHover(rows.length,s,false);
  const step=s.ticks.length>1?s.ticks[1]-s.ticks[0]:Math.abs(s.hi-s.lo);const start=rows[0].value,last=rows.at(-1)!;
  const line=rows.map((r,i)=>(i?'L':'M')+s.x(i).toFixed(1)+','+s.y(r.value).toFixed(1)).join('');
  const band=rows.some(r=>r.high>r.low)?rows.map((r,i)=>`${s.x(i)},${s.y(r.high)}`).join(' ')+' '+[...rows].reverse().map((r,j)=>`${s.x(rows.length-1-j)},${s.y(r.low)}`).join(' '):null;
  const hiI=rows.reduce((b,r,i)=>r.value>rows[b].value?i:b,0),loI=rows.reduce((b,r,i)=>r.value<rows[b].value?i:b,0);const up=last.value>=start;
  const h=hover==null?null:rows[hover];
  return <Frame boxRef={ref} label={`Account value from ${rows[0].day} to ${last.day}: ${fmt(start)} to ${fmt(last.value)}`} days={rows.map(r=>r.day)} s={s} fmt={v=>axisMoney(v,step,currency)} hover={hover} move={move} leave={leave}
    tip={h&&<><b>{shortDay(h.day,true)}</b><span>{fmt(h.value)}</span><span className={h.value>=start?'positive':'negative'}>{signedMoney(h.value-start,fmt)} ({((h.value/start-1)*100).toFixed(2)}%) since {shortDay(rows[0].day)}</span>{h.high>h.low&&<span className="muted">Day range {fmt(h.low)} – {fmt(h.high)}</span>}</>}>
    <defs><linearGradient id={grad} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--perf-portfolio)" stopOpacity=".22"/><stop offset="100%" stopColor="var(--perf-portfolio)" stopOpacity="0"/></linearGradient></defs>
    <path d={`${line}L${s.x(rows.length-1)},${H-B}L${s.x(0)},${H-B}Z`} fill={`url(#${grad})`}/>
    {band&&<polygon className="perf-band" points={band}/>}
    <line className="perf-ref" x1={L} x2={s.w-R} y1={s.y(start)} y2={s.y(start)}/>
    <path className="perf-line portfolio" d={line}/>
    {marks&&hiI!==rows.length-1&&hiI!==0&&<Mark w={s.w} x={s.x(hiI)} y={s.y(rows[hiI].value)} text={`High ${axisMoney(rows[hiI].value,step/10,currency)}`}/>}
    {marks&&loI!==rows.length-1&&loI!==0&&<Mark w={s.w} below x={s.x(loI)} y={s.y(rows[loI].value)} text={`Low ${axisMoney(rows[loI].value,step/10,currency)}`}/>}
    <circle className="perf-dot portfolio" cx={s.x(rows.length-1)} cy={s.y(last.value)} r="4"/><End x={s.x(rows.length-1)} y={s.y(last.value)} text={axisMoney(last.value,step/10,currency)} className={up?'positive':'negative'}/>
    {h&&<circle className="perf-dot portfolio" cx={s.x(hover!)} cy={s.y(h.value)} r="4.5"/>}
  </Frame>;
}
// Cumulative time-weighted return against the benchmark, both rebased to the first day of the window.
export function ReturnChart({rows,benchmark}:{rows:{day:string;portfolio:number;benchmark:number|null}[];benchmark:string}){
  const [ref,w]=useWidth();const pv=rows.map(r=>r.portfolio*100),bv=rows.map(r=>r.benchmark==null?null:r.benchmark*100);
  const s=scale(w,rows.length,[...pv,...bv.filter((v):v is number=>v!=null)],{includeZero:true});const {hover,move,leave}=useHover(rows.length,s,false);const step=s.ticks.length>1?s.ticks[1]-s.ticks[0]:1;
  const path=(vals:(number|null)[])=>vals.map((v,i)=>v==null?null:`${s.x(i).toFixed(1)},${s.y(v).toFixed(1)}`).filter(Boolean).map((p,i)=>(i?'L':'M')+p).join('');
  const last=rows.length-1,pe=pv[last],be=bv[last];const gap=be!=null&&Math.abs(s.y(pe)-s.y(be))<14?(pe>=be!?-8:8):0;const h=hover==null?null:hover;
  const fmt=(v:number|null)=>v==null?'—':`${v>0?'+':''}${v.toFixed(2)}%`;
  return <Frame boxRef={ref} label={`Cumulative return since ${rows[0].day}: portfolio ${fmt(pe)}, ${benchmark} ${fmt(be)}`} days={rows.map(r=>r.day)} s={s} fmt={v=>pctLabel(v,step)} hover={hover} move={move} leave={leave}
    legend={<div className="perf-legend"><span><i className="swatch portfolio"/>Portfolio (time-weighted)</span>{bv.some(v=>v!=null)&&<span><i className="swatch benchmark"/>{benchmark}</span>}</div>}
    tip={h!=null&&<><b>{shortDay(rows[h].day,true)}</b><span><i className="swatch portfolio"/>Portfolio {fmt(pv[h])}</span><span><i className="swatch benchmark"/>{benchmark} {fmt(bv[h])}</span>{bv[h]!=null&&<span className={pv[h]>=bv[h]!?'positive':'negative'}>{pv[h]>=bv[h]!?'Ahead':'Behind'} by {Math.abs(pv[h]-bv[h]!).toFixed(2)} pts</span>}</>}>
    <line className="perf-zero" x1={L} x2={s.w-R} y1={s.y(0)} y2={s.y(0)}/>
    {bv.some(v=>v!=null)&&<path className="perf-line benchmark" d={path(bv)}/>}<path className="perf-line portfolio" d={path(pv)}/>
    {be!=null&&<><circle className="perf-dot benchmark" cx={s.x(last)} cy={s.y(be)} r="3.5"/><End x={s.x(last)} y={s.y(be)-gap} text={fmt(be)}/></>}
    <circle className="perf-dot portfolio" cx={s.x(last)} cy={s.y(pe)} r="4"/><End x={s.x(last)} y={s.y(pe)+gap} text={fmt(pe)}/>
    {h!=null&&<><circle className="perf-dot portfolio" cx={s.x(h)} cy={s.y(pv[h])} r="4.5"/>{bv[h]!=null&&<circle className="perf-dot benchmark" cx={s.x(h)} cy={s.y(bv[h]!)} r="4"/>}</>}
  </Frame>;
}
// Daily P/L after deposits and withdrawals: bars from zero, rounded at the data end; the best and worst days are labelled.
export function PnlChart({rows,fmt,currency='KRW'}:{rows:{day:string;pnl:number|null;returnPct:number|null}[];fmt:(v:number)=>string;currency?:string}){
  const [ref,w]=useWidth();const vals=rows.map(r=>r.pnl??0);const span=Math.max(...vals,0)-Math.min(...vals,0);const s=scale(w,rows.length,[...vals,Math.max(...vals,0)+span*0.1,Math.min(...vals,0)-span*0.1],{bars:true,includeZero:true});const {hover,move,leave}=useHover(rows.length,s,true);
  const step=s.ticks.length>1?s.ticks[1]-s.ticks[0]:1;const slot=(s.w-L-R)/Math.max(1,rows.length);const bw=Math.max(2,Math.min(16,slot*0.7));
  const best=vals.indexOf(Math.max(...vals)),worst=vals.indexOf(Math.min(...vals));const h=hover==null?null:rows[hover];
  const up=vals.filter(v=>v>0).length,down=vals.filter(v=>v<0).length,total=vals.reduce((a,b)=>a+b,0);
  const bar=(v:number,i:number)=>{const y0=s.y(0),y1=s.y(v),r=Math.min(3,bw/2),x0=s.x(i)-bw/2,hgt=Math.abs(y1-y0);if(hgt<1)return null;
    // Only the end away from zero is rounded.
    const d=v>0?`M${x0},${y0}V${y1+r}Q${x0},${y1} ${x0+r},${y1}H${x0+bw-r}Q${x0+bw},${y1} ${x0+bw},${y1+r}V${y0}Z`:`M${x0},${y0}V${y1-r}Q${x0},${y1} ${x0+r},${y1}H${x0+bw-r}Q${x0+bw},${y1} ${x0+bw},${y1-r}V${y0}Z`;
    return <path key={i} className={`perf-bar ${v>0?'up':'down'} ${hover!=null&&hover!==i?'dim':''}`} d={d}/>;};
  return <Frame boxRef={ref} label={`Daily profit and loss from ${rows[0].day} to ${rows.at(-1)!.day}: ${up} up days, ${down} down days`} days={rows.map(r=>r.day)} s={s} fmt={v=>axisMoney(v,step,currency)} hover={hover} move={move} leave={leave}
    legend={<div className="perf-legend"><span><i className="swatch up"/>{up} up days</span><span><i className="swatch down"/>{down} down days</span><span className="muted">Net {signedMoney(total,fmt)}</span></div>}
    tip={h&&<><b>{shortDay(h.day,true)}</b><span className={(h.pnl??0)>=0?'positive':'negative'}>{h.pnl==null?'—':signedMoney(h.pnl,fmt)}</span>{h.returnPct!=null&&<span className="muted">{h.returnPct>0?'+':''}{h.returnPct.toFixed(2)}% on the day</span>}</>}>
    {vals.map(bar)}<line className="perf-zero" x1={L} x2={s.w-R} y1={s.y(0)} y2={s.y(0)}/>
    {vals[best]>0&&<text className="perf-mark-text" x={Math.min(Math.max(s.x(best),L+30),s.w-R-30)} y={s.y(vals[best])-8} textAnchor="middle">{axisMoney(vals[best],step/10,currency)}</text>}
    {vals[worst]<0&&<text className="perf-mark-text" x={Math.min(Math.max(s.x(worst),L+30),s.w-R-30)} y={s.y(vals[worst])+16} textAnchor="middle">{axisMoney(vals[worst],step/10,currency)}</text>}
  </Frame>;
}
// Drawdown of the time-weighted index from its running peak, with the worst point labelled.
export function DrawdownChart({rows}:{rows:{day:string;drawdownPct:number}[]}){
  const [ref,w]=useWidth();const vals=rows.map(r=>Math.min(0,r.drawdownPct));const s=scale(w,rows.length,[...vals,Math.min(-0.5,...vals)*1.14],{includeZero:true});const {hover,move,leave}=useHover(rows.length,s,false);
  const step=s.ticks.length>1?s.ticks[1]-s.ticks[0]:1;const line=vals.map((v,i)=>(i?'L':'M')+s.x(i).toFixed(1)+','+s.y(v).toFixed(1)).join('');
  const worst=vals.indexOf(Math.min(...vals));const h=hover==null?null:rows[hover];const now=vals.at(-1)!;
  return <Frame boxRef={ref} label={`Drawdown from peak, worst ${vals[worst].toFixed(2)}% on ${rows[worst].day}, now ${now.toFixed(2)}%`} days={rows.map(r=>r.day)} s={s} fmt={v=>pctLabel(v,step)} hover={hover} move={move} leave={leave}
    tip={h&&<><b>{shortDay(h.day,true)}</b><span>{h.drawdownPct<-0.005?`${h.drawdownPct.toFixed(2)}% below the peak`:'At a new peak'}</span></>}>
    <path className="perf-drawdown" d={`M${s.x(0)},${s.y(0)}${line.replace(/^M/,'L')}L${s.x(rows.length-1)},${s.y(0)}Z`}/><path className="perf-drawdown-line" d={line}/>
    <line className="perf-zero" x1={L} x2={s.w-R} y1={s.y(0)} y2={s.y(0)}/>
    {vals[worst]<0&&<Mark w={s.w} tone="down" below x={s.x(worst)} y={s.y(vals[worst])} text={`Worst ${vals[worst].toFixed(2)}% · ${shortDay(rows[worst].day)}`}/>}
    <End x={s.x(rows.length-1)} y={s.y(now)} text={now<-0.005?`${now.toFixed(2)}%`:'Peak'}/>
    {h&&<circle className="perf-dot drawdown" cx={s.x(hover!)} cy={s.y(Math.min(0,h.drawdownPct))} r="4.5"/>}
  </Frame>;
}
