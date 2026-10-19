const { DatabaseSync } = require('node:sqlite');
class PortfolioStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  // Plain app settings (not secrets) kept in the settings table.
  getSetting(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null; }
  setSetting(key, value) { if (value == null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key); else this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  getTheme() { return this.db.prepare("SELECT value FROM settings WHERE key='theme'").get()?.value === 'light' ? 'light' : 'dark'; }
  setTheme(theme) {
    if (!['dark', 'light'].includes(theme)) throw new Error('Invalid theme');
    this.db.prepare("INSERT INTO settings VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(theme);
    return theme;
  }
  appendEvent(event) {
    // Only application-generated normalized interactions enter this store. No renderer write API.
    const clean = {};
    for (const key of ['id', 'runId', 'timestamp', 'kind', 'title', 'body']) {
      if (typeof event[key] !== 'string' || event[key].length > 32000) throw new Error('Invalid interaction');
      clean[key] = event[key];
    }
    // Optional: the account the entry belongs to (hashed key and a short label).
    for (const key of ['account', 'accountLabel']) if (typeof event[key] === 'string' && event[key].length <= 200) clean[key] = event[key];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO events(id,payload) VALUES (?,?)').run(clean.id, JSON.stringify(clean));
      this.db.exec('DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 600)');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getEvents() { return this.db.prepare('SELECT payload FROM events ORDER BY seq').all().map(row => JSON.parse(row.payload)); }
  saveSnapshot({timestamp, cash, holdings}) {
    if (!Number.isFinite(cash) || cash < 0 || !Array.isArray(holdings)) throw new Error('Invalid snapshot');
    const rows = holdings.map(h => {
      const clean = {};
      for (const key of ['symbol','name','sector','color']) {
        if (typeof h[key] !== 'string') throw new Error('Invalid holding');
        clean[key] = h[key];
      }
      for (const key of ['quantity','cost','price']) {
        if (!Number.isFinite(h[key]) || h[key] < 0) throw new Error('Invalid holding');
        clean[key] = h[key];
      }
      return clean;
    });
    const payload = JSON.stringify({ environment: 'synthetic', cash, holdings: rows });
    this.db.prepare('INSERT INTO snapshots(timestamp,payload) VALUES (?,?)').run(timestamp,payload);
    this.db.exec('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 100)');
  }
  latestSnapshot() {
    const row = this.db.prepare('SELECT timestamp,payload FROM snapshots ORDER BY id DESC LIMIT 1').get();
    return row ? {timestamp: row.timestamp, ...JSON.parse(row.payload)} : null;
  }
  close() { this.db.close(); }
}
module.exports = { PortfolioStore };
