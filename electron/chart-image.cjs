// Draws the phone snapshot chart (Today on top, last 30 days below) as a PNG in a hidden, sandboxed window.
// The page is blank and loads nothing; the drawing code and data are passed in as one script.
function draw(spec){
  const W=800,H=560,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');
  const bg='#15191f',ink='#e6e9ee',muted='#8a94a6',grid='#2a313b',up='#66d9c0',down='#d96c6c';
  g.fillStyle=bg;g.fillRect(0,0,W,H);g.font='600 22px "Segoe UI", sans-serif';
  // Axis labels get more precision as the visible range narrows, so neighbouring labels never read the same.
  const fmt=(v,span)=>spec.amounts?'₩'+(Math.abs(v)>=1e6&&span>=3e4?(v/1e6).toFixed(span>=3e5?2:3)+'M':Math.round(v).toLocaleString('en-US')):(v>0?'+':'')+v.toFixed(span>=3?1:2)+'%';
  const panel=(top,height,title,series,labels,trend)=>{
    g.fillStyle=ink;g.font='600 22px "Segoe UI", sans-serif';g.fillText(title,24,top+26);if(trend){const tw=g.measureText(title).width;g.fillStyle=trend.up?up:down;g.fillText(trend.text,24+tw+14,top+26);}
    const v=series.v.filter(Number.isFinite);const x0=24,x1=W-125,y0=top+44,y1=top+height-34;
    if(v.length<2){g.fillStyle=muted;g.font='18px "Segoe UI", sans-serif';g.fillText('Not enough data yet',x0,(y0+y1)/2);return;}
    let lo=Math.min(...v),hi=Math.max(...v);{const flat=Math.max(Math.abs(hi)*0.001,spec.amounts?1000:0.05);if(hi-lo<flat){const mid=(hi+lo)/2;hi=mid+flat;lo=mid-flat;}}const pad=(hi-lo)*0.08;lo-=pad;hi+=pad;
    const X=i=>x0+(x1-x0)*i/(series.v.length-1),Y=val=>y1-(y1-y0)*(val-lo)/(hi-lo);
    g.strokeStyle=grid;g.lineWidth=1;g.fillStyle=muted;g.font='16px "Segoe UI", sans-serif';
    for(let k=0;k<=3;k++){const val=lo+(hi-lo)*k/3,y=Y(val);g.beginPath();g.moveTo(x0,y);g.lineTo(x1,y);g.stroke();g.fillText(fmt(val,hi-lo),x1+10,y+5);}
    const color=trend?(trend.up?up:down):series.v.at(-1)>=series.v.find(Number.isFinite)?up:down;
    g.beginPath();let started=false;series.v.forEach((val,i)=>{if(!Number.isFinite(val))return;started?g.lineTo(X(i),Y(val)):g.moveTo(X(i),Y(val));started=true;});
    g.strokeStyle=color;g.lineWidth=3;g.lineJoin='round';g.stroke();
    const last=series.v.length-1;g.fillStyle=color;g.beginPath();g.arc(X(last),Y(series.v[last]),5,0,Math.PI*2);g.fill();
    g.fillStyle=muted;g.font='16px "Segoe UI", sans-serif';g.fillText(labels[0],x0,y1+24);const w=g.measureText(labels[1]).width;g.fillText(labels[1],x1-w,y1+24);
  };
  const time=t=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t);
  const t=spec.today.t,d=spec.days.t;
  panel(0,290,'Today',spec.today,t.length?[time(t[0]),time(t.at(-1))+' KST']:['',''],spec.headline?{text:spec.headline,up:spec.up}:null);
  panel(290,270,d.length>1?'Last '+d.length+' days':'Daily history',spec.days,d.length?[d[0].slice(5),d.at(-1).slice(5)]:['','']);
  return c.toDataURL('image/png').split(',')[1];
}
// Returns base64 PNG. One window per drawing, closed afterwards.
async function renderChart(spec){
  const {BrowserWindow}=require('electron');
  const win=new BrowserWindow({show:false,width:800,height:560,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:true,images:false,webgl:false}});
  try{
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
    await win.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3Echart%3C%2Ftitle%3E');
    const png=await win.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(spec)})`);
    if(typeof png!=='string'||png.length>2800000)throw new Error('CHART_FAILED');return png;
  }finally{win.destroy();}
}
module.exports={renderChart,draw};
