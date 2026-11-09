'use strict';
// Servidor de "Dibuja la frase". Sin dependencias: solo Node 18+.
// Estado en memoria; las salas se borran tras 12 h sin actividad.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_BODY = 300 * 1024;
const MAX_PARTICIPANTS = 80;
const MAX_ROOMS = 500;
const ROOM_TTL = 12 * 3600 * 1000;

const rooms = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
  } while (rooms.has(c));
  return c;
}

function safeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function publicId(pid) {
  return crypto.createHash('sha256').update(pid).digest('hex').slice(0, 10);
}

// Lo que ve cada cliente. Los dibujos de los demás solo se envían al revelar.
function view(room, cl, full) {
  const cur = [...room.drawings.values()].filter(d => d.round === room.round);
  const online = new Set([...room.clients].filter(c => !c.isHost && c.pid).map(c => c.pid)).size;
  const v = {
    phrase: room.phrase, phase: room.phase, round: room.round,
    showNames: room.showNames, count: cur.length, online, host: cl.isHost
  };
  if (room.phase === 'reveal') {
    v.drawings = cur.sort((a, b) => a.t - b.t).map(d => ({
      id: d.id,
      name: room.showNames ? d.name : '',
      caption: d.caption,
      strokes: d.strokes,
      mine: d.pid === cl.pid
    }));
  } else if (full && cl.pid) {
    const m = room.drawings.get(cl.pid);
    if (m && m.round === room.round) v.mine = { strokes: m.strokes, caption: m.caption };
  }
  return v;
}

function send(cl, v) {
  try { cl.res.write('event: state\ndata: ' + JSON.stringify(v) + '\n\n'); } catch (e) {}
}
function broadcast(room, except) {
  room.touched = Date.now();
  for (const cl of room.clients) if (cl !== except) send(cl, view(room, cl, false));
}

function cleanStrokes(s) {
  if (!Array.isArray(s) || s.length > 600) return null;
  const out = [];
  let pts = 0;
  for (const x of s) {
    if (!x || typeof x.c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x.c)) return null;
    if (typeof x.w !== 'number' || !Array.isArray(x.p)) return null;
    if (x.p.length % 2 || x.p.length > 8000) return null;
    pts += x.p.length;
    if (pts > 40000) return null;
    const p = x.p.map((n, i) => {
      const max = i % 2 ? 600 : 800;
      return Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
    });
    out.push({ c: x.c, w: Math.max(1, Math.min(60, x.w)), p });
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      fs.readFile(INDEX, (err, data) => {
        if (err) return json(res, 500, { error: 'no index' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        res.end(data);
      });
      return;
    }
    if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'POST' && p === '/api/rooms') {
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Servidor lleno, inténtalo más tarde.' });
      const code = newCode();
      const hostKey = crypto.randomBytes(16).toString('hex');
      rooms.set(code, {
        code, hostKey, phrase: '', phase: 'idle', round: 0, showNames: true,
        drawings: new Map(), clients: new Set(), touched: Date.now()
      });
      return json(res, 201, { code, hostKey });
    }

    const m = p.match(/^\/api\/rooms\/([A-Z]{4})(?:\/([a-z]+))?$/);
    if (!m) return json(res, 404, { error: 'not found' });
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Sesión no encontrada' });
    const action = m[2];

    if (req.method === 'GET' && !action) return json(res, 200, { ok: true, code: room.code });

    if (req.method === 'GET' && action === 'events') {
      const pid = String(u.searchParams.get('pid') || '');
      const cl = {
        res,
        pid: /^[\w-]{8,64}$/.test(pid) ? pid : null,
        isHost: safeEq(u.searchParams.get('k'), room.hostKey)
      };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      room.clients.add(cl);
      send(cl, view(room, cl, true));
      broadcast(room, cl); // actualiza el contador de conectados a los demás
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(ka); room.clients.delete(cl); broadcast(room); });
      return;
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    const isHost = safeEq(body.k, room.hostKey);
    room.touched = Date.now();

    if (action === 'phrase') {
      if (!isHost) return json(res, 403, { error: 'Solo el facilitador' });
      const phrase = String(body.phrase || '').trim().slice(0, 200);
      if (!phrase) return json(res, 400, { error: 'Falta la frase' });
      room.phrase = phrase;
      room.phase = 'draw';
      room.round += 1;
      if (typeof body.showNames === 'boolean') room.showNames = body.showNames;
      broadcast(room);
      // Cada cliente arranca la ronda con su propio dibujo (ninguno en una ronda nueva).
      return json(res, 200, { ok: true });
    }
    if (action === 'phase') {
      if (!isHost) return json(res, 403, { error: 'Solo el facilitador' });
      if (room.phase === 'idle') return json(res, 400, { error: 'Aún no hay frase' });
      if (body.phase !== 'draw' && body.phase !== 'reveal') return json(res, 400, { error: 'Fase no válida' });
      room.phase = body.phase;
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (action === 'names') {
      if (!isHost) return json(res, 403, { error: 'Solo el facilitador' });
      room.showNames = !!body.showNames;
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (action === 'remove') {
      if (!isHost) return json(res, 403, { error: 'Solo el facilitador' });
      for (const [pid, d] of room.drawings) if (d.id === body.id) room.drawings.delete(pid);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (action === 'drawing') {
      if (room.phase !== 'draw') return json(res, 409, { error: 'Ahora no se pueden enviar dibujos.' });
      const pid = String(body.pid || '');
      if (!/^[\w-]{8,64}$/.test(pid)) return json(res, 400, { error: 'Identificador no válido' });
      if (!room.drawings.has(pid) && room.drawings.size >= MAX_PARTICIPANTS)
        return json(res, 429, { error: 'La sesión está llena.' });
      const strokes = cleanStrokes(body.strokes);
      if (!strokes || !strokes.length) return json(res, 400, { error: 'Dibujo no válido' });
      room.drawings.set(pid, {
        pid, id: publicId(pid), round: room.round, strokes,
        name: String(body.name || 'Anónimo').trim().slice(0, 30) || 'Anónimo',
        caption: String(body.caption || '').trim().slice(0, 100),
        t: Date.now()
      });
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'error' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.touched > ROOM_TTL && r.clients.size === 0) rooms.delete(code);
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Dibuja la frase en http://localhost:' + PORT));
}
module.exports = server;
