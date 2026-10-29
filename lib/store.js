import process from 'node:process';
// Room documents use optimistic concurrency; the database owns compare-and-swap.
export class MemoryStore {
  rooms = new Map();
  rates = new Map();
  async load(key) {
    const row = this.rooms.get(key);
    if (!row || row.expires < Date.now()) { this.rooms.delete(key); return null; }
    return structuredClone(row);
  }
  async save(key, version, data, expires) {
    const current = this.rooms.get(key);
    const actual = current && current.expires >= Date.now() ? current.version : 0;
    if (actual !== version) return false;
    this.rooms.set(key, {version: version + 1, data: structuredClone(data), expires});
    return true;
  }
  async limit(key, max, window) {
    const bucket = `${key}:${Math.floor(Date.now() / window)}`;
    const count = (this.rates.get(bucket) || 0) + 1;
    this.rates.set(bucket, count);
    if (this.rates.size > 10000) this.rates.clear();
    return count <= max;
  }
  async health() { return true; }
}

export class DatabaseStore {
  constructor({url, key}) { this.url = url; this.key = key; }
  async rpc(action, payload = {}) {
    const response = await fetch(`${this.url}/rest/v1/rpc/duet_store`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', apikey: this.key, Authorization: `Bearer ${this.key}`},
      body: JSON.stringify({p_secret: '', p_action: action, p_payload: payload}),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`Storage unavailable (${response.status})`);
    return response.json();
  }
  load(key) { return this.rpc('load', {key}); }
  save(key, version, data, expires) { return this.rpc('save', {key, version, data, expires}); }
  limit(key, max, window) { return this.rpc('limit', {key, max, window}); }
  health() { return this.rpc('health'); }
}

export function configuredStore() {
  const {SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key} = process.env;
  if (url && key) return new DatabaseStore({url, key});
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('Production requires durable storage configuration');
  return new MemoryStore();
}
