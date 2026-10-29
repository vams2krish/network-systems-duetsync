import http from 'node:http';
import process from 'node:process';
import {readFile} from 'node:fs/promises';
import {randomBytes, createHmac} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {configuredStore} from './store.js';
import {createHub} from './hub.js';

const assets = {'/': ['index.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'], '/demo.wav': ['demo.wav','audio/wav'], '/favicon.svg': ['favicon.svg','image/svg+xml']};
export function createApp({store = configuredStore(), lead = 1200, pollMs = 400, allowedOrigins, edge = false, socketPaths = ['/api/socket']} = {}) {
  const secret = store.key || process.env.SUPABASE_SERVICE_ROLE_KEY || randomBytes(32).toString('hex');
  const addressKey = req => createHmac('sha256', secret).update(edge ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress) : process.env.VERCEL ? String(req.headers['x-vercel-forwarded-for'] || req.socket.remoteAddress) : req.socket.remoteAddress || 'local').digest('hex');
  const sameOrigin = req => {
    const origin = req.headers.origin;
    if (!origin) return !process.env.VERCEL && !edge;
    const allowed = allowedOrigins || (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null);
    return allowed ? allowed.includes(origin) : origin === `${process.env.VERCEL ? 'https' : 'http'}://${req.headers.host}`;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (process.env.VERCEL || edge) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405, {Allow:'GET, HEAD'}); return res.end(); }
      if (path === '/healthz' || path.endsWith('/duet-sync/healthz')) {
        await store.health();
        res.setHeader('Cache-Control','no-store');
        res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify({ok:true, storage:store.constructor.name === 'DatabaseStore' ? 'durable' : 'development-memory', version:'2.0.0'}));
      }
      const asset = assets[path];
      if (!asset) { res.writeHead(404); return res.end('Not found'); }
      const body = await readFile(new URL('../public/' + asset[0], import.meta.url));
      res.setHeader('Content-Type',asset[1]);
      res.setHeader('Cache-Control',path === '/demo.wav' ? 'public, max-age=86400' : 'no-cache');
      res.setHeader('Content-Length',body.length);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(503); res.end('Temporarily unavailable');
    }
  });
  const wss = new WebSocketServer({noServer:true, maxPayload:4096, perMessageDeflate:false});
  const hub=createHub({store,lead,pollMs});
  const {rooms,log}=hub;
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (!socketPaths.includes(new URL(req.url,'http://localhost').pathname) || !sameOrigin(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      if (wss.clients.size >= 200 || !await store.limit(`upgrade:${addressKey(req)}`,60,600000)) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(req,socket,head,ws => wss.emit('connection',ws,req));
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); log('upgrade_storage_error'); }
  });
  wss.on('connection',(ws,req)=>hub.accept(ws,addressKey(req)));
  async function close(){hub.stop();await new Promise(r=>server.close(r));}
  return {server,wss,store,rooms,close};
}
