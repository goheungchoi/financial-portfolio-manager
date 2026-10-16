class Notifications {
  constructor(db,provider,getConfig,desktop) {
    this.db=db;this.provider=provider;this.getConfig=getConfig;this.desktop=desktop;this.busy=false;
    db.exec('CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,message TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);');
    this.seen=new Map();this.startedAt=Date.now();
  }
  observe(orders) {
    for(const order of orders) {
      const previous=this.seen.get(order.id);this.seen.set(order.id,order.status);
      if(previous===order.status || previous===undefined&&order.createdAt<this.startedAt || !['Accepted','Partially filled','Filled','Risk stopped','Canceled','Uncertain','Rejected'].includes(order.status))continue;
      const config=this.getConfig();const message=`${order.source==='kis'?order.environment.toUpperCase():'PAPER'} ${order.status}: ${order.side} ${order.symbol}, ${order.filled}/${order.quantity} shares. ${order.reason??(order.source==='kis'?'Broker order update.':'Simulated execution.')}`;
      if(config.desktopAlerts)this.desktop(message);
      if(config.mobileAlerts)this.db.prepare('INSERT OR IGNORE INTO notification_outbox(id,message,nextAt) VALUES(?,?,?)').run(order.id+':'+order.status,message,Date.now());
    }
  }
  async tick() {
    if(this.busy || !this.getConfig().mobileAlerts || this.getConfig().pushConnected===false)return;this.busy=true;
    try {
      const row=this.db.prepare('SELECT * FROM notification_outbox WHERE delivered=0 AND attempts<5 AND nextAt<=? ORDER BY nextAt LIMIT 1').get(Date.now());if(!row)return;
      try{await this.provider.request('push',{message:row.message});if(!this.disposed)this.db.prepare('UPDATE notification_outbox SET delivered=1 WHERE id=?').run(row.id);}
      catch{if(!this.disposed)this.db.prepare('UPDATE notification_outbox SET attempts=attempts+1,nextAt=? WHERE id=?').run(Date.now()+Math.min(3600000,30000*2**row.attempts),row.id);}
    }finally{this.busy=false;}
  }
  status(){return this.db.prepare('SELECT id,message,attempts,delivered FROM notification_outbox ORDER BY rowid DESC LIMIT 30').all();}
}
module.exports={Notifications};
