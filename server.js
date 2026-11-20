import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.txt':'text/plain; charset=utf-8' };
const stores = new Set(['products','customers','sales','invoiceItems','settings','loyalty']);
const numericStores = new Set(['products','customers','sales','invoiceItems','loyalty']);
let mongo, db;

// Load a local .env without adding a dependency; production hosts should set environment variables.
if (existsSync(path.join(root, '.env'))) {
  for (const line of (await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
if (process.env.MONGODB_URI) {
  const { MongoClient } = await import('mongodb');
  mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
    db = mongo.db(process.env.MONGODB_DB || 'pradeep_sales_pos');
    await Promise.all([...stores].map(s => db.collection(s).createIndex({ id: 1 }, { unique: true, sparse: true })));
    await db.collection('sales').createIndex({ invoiceNo: 1 });
    console.log(`Connected to MongoDB database ${db.databaseName}`);
  } catch (err) {
    console.error(`MongoDB connection failed (${err.code || err.name}). Check the Atlas URI hostname, database user/password, and Network Access allowlist.`);
    await mongo.close().catch(() => {});
    mongo = null;
  }
} else console.warn('MONGODB_URI is unset. API reads will return empty data; configure .env to use Atlas.');

function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
const password = process.env.APP_PASSWORD || '';
const sign = value => createHmac('sha256', password).update(value).digest('base64url');
function validSession(req) {
  if (!password) return process.env.NODE_ENV !== 'production';
  const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('pos_session='));
  if (!cookie) return false;
  const token = decodeURIComponent(cookie.slice('pos_session='.length)), [expiry, sig] = token.split('.');
  if (!expiry || !sig || Number(expiry) < Date.now()) return false;
  const expected = Buffer.from(sign(expiry)), actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error('Request too large'); }
  return raw ? JSON.parse(raw) : {};
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') return send(res, db ? 200 : 503, { ok: !!db, database: !!db });
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/auth/session' && req.method === 'GET') return send(res, validSession(req) ? 200 : 401, { authenticated: validSession(req) });
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        if (!password) return send(res, 503, { error: 'APP_PASSWORD is not configured on the server.' });
        const input = await body(req), a = Buffer.from(String(input.password || '')), b = Buffer.from(password);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 401, { error: 'Incorrect password' });
        const expiry = String(Date.now() + 7 * 86400000), secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `pos_session=${encodeURIComponent(`${expiry}.${sign(expiry)}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
        return send(res, 200, { authenticated: true });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', 'pos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res, 200, { authenticated: false });
      }
      if (!db) return send(res, 503, { error: 'MongoDB is not connected.' });
      if (!validSession(req)) return send(res, 401, { error: 'Authentication required' });
      if (url.pathname === '/api/sync/snapshot' && req.method === 'GET') {
        const snapshot = {};
        const names = url.searchParams.get('cacheOnly') === '1' ? ['products','customers','settings','loyalty'] : [...stores];
        for (const name of names) snapshot[name] = await db.collection(name).find({}, { projection: { _id: 0 } }).toArray();
        return send(res, 200, snapshot);
      }
      if (url.pathname === '/api/sync/batch' && req.method === 'POST') {
        const changes = await body(req);
        if (!Array.isArray(changes) || changes.length > 1000) return send(res, 400, { error: 'Invalid sync batch' });
        const results = [];
        for (const change of changes) {
          if (!stores.has(change.store) || !['put','delete'].includes(change.op)) return send(res, 400, { error: 'Invalid sync operation' });
          const col = db.collection(change.store);
          const filter = change.store === 'settings' ? { key: change.key } : { id: change.key };
          if (change.op === 'delete') await col.deleteOne(filter);
          else {
            const doc = change.value;
            if (!doc || (change.store === 'settings' ? doc.key == null : doc.id == null)) return send(res, 400, { error: 'Invalid sync record' });
            await col.updateOne(filter, { $set: doc }, { upsert: true });
          }
          results.push(change.qid);
        }
        return send(res, 200, { applied: results });
      }
      if (url.pathname === '/api/sync/id-range' && req.method === 'POST') {
        const input = await body(req), name = input.store;
        if (!numericStores.has(name)) return send(res, 400, { error: 'Invalid id range request' });
        const counters = db.collection('_counters');
        const latest = await db.collection(name).find({}, { projection: { id: 1, _id: 0 } }).sort({ id: -1 }).limit(1).next();
        if (latest?.id) await counters.updateOne({ _id: name }, { $max: { next: latest.id } }, { upsert: true });
        const row = await counters.findOneAndUpdate({ _id: name }, { $inc: { next: 1000000 } }, { upsert: true, returnDocument: 'after', includeResultMetadata: false });
        return send(res, 200, { start: row.next - 999999, end: row.next });
      }
      if (url.pathname === '/api/sync/invoice-range' && req.method === 'POST') {
        const { prefix = 'PS' } = await body(req);
        if (!/^[A-Z0-9]{1,6}$/.test(prefix)) return send(res, 400, { error: 'Invalid invoice prefix' });
        const counters = db.collection('_counters'), key = `invoice:${prefix}`;
        const existing = await db.collection('sales').find({ invoiceNo: { $regex: `^${prefix}-(\\d+)$` } }, { projection: { invoiceNo: 1, _id: 0 } }).toArray();
        const highest = existing.reduce((max, x) => Math.max(max, +(x.invoiceNo.split('-').pop()) || 0), 0);
        await counters.updateOne({ _id: key }, { $max: { next: highest } }, { upsert: true });
        const row = await counters.findOneAndUpdate({ _id: key }, { $inc: { next: 1000 } }, { upsert: true, returnDocument: 'after', includeResultMetadata: false });
        return send(res, 200, { start: row.next - 999, end: row.next });
      }
      const [, , store, key] = url.pathname.split('/');
      if (!stores.has(store)) return send(res, 404, { error: 'Unknown data collection' });
      const col = db.collection(store);
      if (req.method === 'GET' && !key) return send(res, 200, await col.find({}, { projection: { _id: 0 } }).toArray());
      if (req.method === 'GET' && key) {
        const doc = await col.findOne({ id: Number.isNaN(Number(key)) ? key : Number(key) }, { projection: { _id: 0 } });
        return doc ? send(res, 200, doc) : send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'PUT') {
        const doc = await body(req);
        if (store === 'settings') {
          if (!doc || typeof doc.key !== 'string') return send(res, 400, { error: 'Setting key is required' });
          await col.updateOne({ key: doc.key }, { $set: doc }, { upsert: true });
        } else {
          if (!doc || doc.id == null) return send(res, 400, { error: 'Record id is required' });
          await col.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
        }
        return send(res, 200, doc);
      }
      if (req.method === 'DELETE' && key) {
        const id = Number.isNaN(Number(key)) ? key : Number(key);
        await col.deleteOne(store === 'settings' ? { key: id } : { id });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(root, `.${pathname}`);
    if (!target.startsWith(root + path.sep) || !existsSync(target)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(target).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: e.message || 'Server error' }); }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`POS server listening on port ${process.env.PORT || 3000}`));
