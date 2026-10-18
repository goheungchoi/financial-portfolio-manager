class Notifications {
  constructor(db,provider,getConfig,desktop) {
    this.db=db;this.provider=provider;this.getConfig=getConfig;this.desktop=desktop;this.busy=false;
    db.exec('CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,message TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);');
    try{db.exec('ALTER TABLE notification_outbox ADD COLUMN payload TEXT');}catch{}
    this.seen=new Map();this.startedAt=Date.now();this.render=null;
  }
  observe(orders) {
    for(const order of orders) {
      const previous=this.seen.get(order.id);this.seen.set(order.id,order.status);
      if(previous===order.status || previous===undefined&&order.createdAt<this.startedAt || !['Accepted','Partially filled','Filled','Risk stopped','Canceled','Uncertain','Rejected'].includes(order.status))continue;
      const config=this.getConfig();const message=`${order.source==='kis'?order.environment.toUpperCase():'PAPER'} ${order.status}: ${order.side} ${order.symbol}, ${order.filled}/${order.quantity} shares. ${order.reason??(order.source==='kis'?'Broker order update.':'Simulated execution.')}`;
      if(config.desktopAlerts)this.desktop(message);
      // A completed fill becomes a phone snapshot instead of a one-line alert when snapshots are on; partial fills stay one-line alerts.
      if(config.mobileAlerts&&order.status==='Filled'){let posted=false;try{posted=this.onFill?.(order)===true;}catch{}if(posted)continue;}
      if(config.mobileAlerts)this.db.prepare('INSERT OR IGNORE INTO notification_outbox(id,message,nextAt) VALUES(?,?,?)').run(order.id+':'+order.status,message,Date.now());
    }
  }
  // Engine-originated alerts (guardrails, digests) use the same desktop and webhook preferences as order alerts.
  notify(id,message) {
    const config=this.getConfig();
    if(config.desktopAlerts)this.desktop(message);
    if(config.mobileAlerts)this.db.prepare('INSERT OR IGNORE INTO notification_outbox(id,message,nextAt) VALUES(?,?,?)').run(id,message,Date.now());
  }
  // Phone snapshots go only to the webhook, never to desktop alerts; the chart is drawn when the post is sent.
  post(snapshot) {
    if(!this.getConfig().mobileAlerts)return false;
    this.db.prepare('INSERT OR IGNORE INTO notification_outbox(id,message,nextAt,payload) VALUES(?,?,?,?)').run(snapshot.id,snapshot.text,Date.now(),JSON.stringify(snapshot));return true;
  }
  async tick() {
    if(this.busy || !this.getConfig().mobileAlerts || this.getConfig().pushConnected===false)return;this.busy=true;
    try {
      const row=this.db.prepare('SELECT * FROM notification_outbox WHERE delivered=0 AND attempts<5 AND nextAt<=? ORDER BY nextAt LIMIT 1').get(Date.now());if(!row)return;
      // Snapshots older than 30 minutes are sent as text only; the chart would no longer be current.
      const snapshot=row.payload?JSON.parse(row.payload):null;let image=null;
      if(snapshot?.chart&&this.render&&Date.now()-snapshot.now<1800000)try{image=await this.render(snapshot.chart);}catch{}
      const request=snapshot?{message:row.message,embed:require('./phone-snapshot.cjs').discordEmbed(snapshot),...(image?{image}:{})}:{message:row.message};
      try{await this.provider.request('push',request);if(!this.disposed)this.db.prepare('UPDATE notification_outbox SET delivered=1 WHERE id=?').run(row.id);}
      catch{if(!this.disposed)this.db.prepare('UPDATE notification_outbox SET attempts=attempts+1,nextAt=? WHERE id=?').run(Date.now()+Math.min(3600000,30000*2**row.attempts),row.id);}
    }finally{this.busy=false;}
  }
  status(){return this.db.prepare('SELECT id,message,attempts,delivered FROM notification_outbox ORDER BY rowid DESC LIMIT 30').all();}
}
module.exports={Notifications};
