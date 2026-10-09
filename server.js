











import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validStats, STATS, MAX_PLAYERS, GAME_SECONDS, MIN_SECONDS, MAX_SECONDS, TPS } from './public/sim.js';

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const envInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const MAX_ROOMS = envInt(process.env.MAX_ROOMS, 1000, 1, 10000);
const MAX_MESSAGES_PER_WINDOW = 120;
const MESSAGE_WINDOW_MS = 10000;
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
let supabaseOrigin = '';
try { supabaseOrigin = new URL(process.env.SUPABASE_URL).origin; } catch { /* Supabase is configured after setup. */ }
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'self'; connect-src 'self' ws: wss: ${supabaseOrigin}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
};


const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); }
  catch { res.writeHead(400, SECURITY_HEADERS); return res.end('Bad request'); }
  if (rel.includes('\0')) { res.writeHead(400, SECURITY_HEADERS); return res.end('Bad request'); }
  if (rel === '/health') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  if (rel === '/api/config') {
    const body = JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, `.${rel}`);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, SECURITY_HEADERS);
      return res.end(status === 404 ? 'Not found' : 'Internal server error');
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': data.byteLength });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;





const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  verifyClient: ({ origin }, done) => done(!origin || !allowedOrigins.size || allowedOrigins.has(origin), 403, 'Forbidden origin'),
});
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join(''); }
  while (rooms.has(code));
  return code;
}
const send = (ws, msg) => {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch { ws.terminate(); }
};
const broadcast = (room, msg) => { for (const p of room.players) send(p.ws, msg); };
const cleanName = n => String(n ?? '').trim().slice(0, 16) || 'Player';
const validSpawn = s => s && Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0.05 && s.x <= 0.95 && s.y >= 0.05 && s.y <= 0.95;
const cleanSeconds = v => Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(+v) || GAME_SECONDS));
function allowMessage(ws) {
  const now = Date.now();
  if (!ws.messageWindow || now - ws.messageWindow.started >= MESSAGE_WINDOW_MS) ws.messageWindow = { started: now, count: 0 };
  ws.messageWindow.count++;
  if (ws.messageWindow.count <= MAX_MESSAGES_PER_WINDOW) return true;
  ws.close(1008, 'Too many messages');
  return false;
}

function pushLobby(room) {
  const players = room.players.map(p => ({ slot: p.slot, name: p.name, host: p.host, ready: !!p.stats, spawn: p.spawn }));
  for (const p of room.players) send(p.ws, { type: 'lobby', code: room.code, capacity: room.capacity, seconds: room.seconds, you: p.slot, token: p.token, players });
}





const LOOKAHEAD = 9, HORIZON_MS = 100;
const SPEEDS = [1, 2, 4];
const MAX_EVENTS = 2000;
const EMPTY_MS = 120000;

const clockAt = (room, now = Date.now()) => room.clk.tick + (now - room.clk.at) * TPS * room.clk.speed / 1000;
const clockMsg = room => ({ type: 'horizon', tick: room.horizon, at: Math.min(room.maxTicks, clockAt(room)), speed: room.clk.speed });
const startMsg = (room, p) => ({ ...clockMsg(room), type: 'start', matchId: room.matchId, seed: room.seed, seconds: room.seconds,
  configs: room.configs, you: p.colony, host: p.host, events: room.events });

function stopClock(room) { if (room.clock) clearInterval(room.clock); room.clock = null; }
function advance(room) {
  const h = Math.min(room.maxTicks, Math.floor(clockAt(room)) + LOOKAHEAD * room.clk.speed);
  if (h > room.horizon) {
    room.horizon = h; broadcast(room, clockMsg(room));
    if (h >= room.maxTicks) stopClock(room);
  }
}
function startClock(room) {
  stopClock(room);
  room.maxTicks = room.seconds * TPS;
  room.clk = { tick: 0, at: Date.now(), speed: 1 };
  room.horizon = LOOKAHEAD;
  room.events = []; room.nextId = 1;
  room.clock = setInterval(() => advance(room), HORIZON_MS);
}

wss.on('connection', ws => {
  let room = null, me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => ws.terminate());

  ws.on('message', raw => {
    if (!allowMessage(ws)) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create' && !room) {
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', msg: 'Server is at capacity' });
      const capacity = Math.min(Math.max(parseInt(m.capacity) || 4, 2), MAX_PLAYERS);
      room = { code: newCode(), capacity, seconds: GAME_SECONDS, started: false, players: [], matchId: 0,
               clock: null, clk: null, horizon: 0, maxTicks: 0, events: [], nextId: 1, emptyTimer: null };
      rooms.set(room.code, room);
      me = { slot: 1, name: cleanName(m.name), ws, host: true, stats: null, spawn: null, colony: 0, token: randomUUID() };
      room.players.push(me);
      pushLobby(room);
    }
    else if (m.type === 'join' && !room) {
      const r = rooms.get(String(m.code ?? '').toUpperCase());
      if (!r) return send(ws, { type: 'error', msg: 'No room with that code' });
      if (r.started) return send(ws, { type: 'error', msg: 'That game already started' });
      if (r.players.length >= r.capacity) return send(ws, { type: 'error', msg: 'Room is full' });
      let slot = 1; while (r.players.some(p => p.slot === slot)) slot++;
      room = r;
      me = { slot, name: cleanName(m.name), ws, host: false, stats: null, spawn: null, colony: 0, token: randomUUID() };
      room.players.push(me);
      pushLobby(room);
    }
    else if (m.type === 'rejoin' && !room) {
      const r = rooms.get(String(m.code ?? '').toUpperCase());
      const p = r && r.players.find(q => q.token === m.token);
      if (!p) return send(ws, { type: 'rejoin_failed' });
      const old = p.ws; p.ws = ws;
      if (old && old !== ws) old.terminate();
      room = r; me = p; clearTimeout(room.emptyTimer);
      if (room.started) send(ws, startMsg(room, me)); else pushLobby(room);
    }
    else if (m.type === 'config' && room && !room.started) {
      if (!validStats(m.stats)) return send(ws, { type: 'error', msg: 'Stats must add up to exactly 100' });
      me.stats = Object.fromEntries(STATS.map(k => [k, m.stats[k]]));
      me.spawn = validSpawn(m.spawn) ? { x: m.spawn.x, y: m.spawn.y } : null;
      pushLobby(room);
    }
    else if (m.type === 'time' && room && me.host && !room.started) {
      room.seconds = cleanSeconds(m.seconds);
      pushLobby(room);
    }
    else if (m.type === 'start' && room && me.host && !room.started) {
      const ready = room.players.filter(p => p.stats).sort((a, b) => a.slot - b.slot);
      if (ready.length < 2) return send(ws, { type: 'error', msg: 'Need at least 2 ready players' });
      room.started = true; room.matchId++;
      room.seed = (Math.random() * 2 ** 32) >>> 0;
      room.configs = ready.map(p => ({ name: p.name, slot: p.slot, stats: p.stats, spawn: p.spawn }));
      for (const p of room.players) p.colony = ready.indexOf(p) + 1;
      startClock(room);
      for (const p of room.players) send(p.ws, startMsg(room, p));
      console.log(`room ${room.code}: started with ${ready.length} players (seed ${room.seed}, ${room.seconds}s)`);
    }
    else if (m.type === 'tune' && room && room.started && room.clock && me.colony) {
      if (!validStats(m.stats) || room.events.length >= MAX_EVENTS) return;
      const now = Date.now(); if (now - (me.lastTune || 0) < 150) return; me.lastTune = now;
      const ev = { id: room.nextId++, tick: room.horizon, colony: me.colony, stats: Object.fromEntries(STATS.map(k => [k, m.stats[k]])) };
      room.events.push(ev);
      broadcast(room, { type: 'tune', ...ev });
    }
    else if (m.type === 'speed' && room && room.started && room.clock && me.host && SPEEDS.includes(+m.speed)) {
      const now = Date.now();
      room.clk = { tick: Math.min(room.maxTicks, clockAt(room, now)), at: now, speed: +m.speed };
      advance(room); broadcast(room, clockMsg(room));
    }
    else if (m.type === 'reset' && room && me.host && room.started) {
      stopClock(room);
      room.started = false; room.events = [];
      room.players = room.players.filter(p => p.ws);
      for (const p of room.players) { p.stats = null; p.spawn = null; p.colony = 0; }
      pushLobby(room);
    }
  });

  ws.on('close', () => {
    if (!room || me.ws !== ws) return;
    if (room.started) {
      me.ws = null;
      if (me.host) {
        const next = room.players.find(p => p !== me && p.ws);
        if (next) { me.host = false; next.host = true; send(next.ws, { type: 'host' }); }
      }
      if (!room.players.some(p => p.ws)) {
        clearTimeout(room.emptyTimer);
        room.emptyTimer = setTimeout(() => { stopClock(room); rooms.delete(room.code); }, EMPTY_MS);
      }
      return;
    }
    room.players = room.players.filter(p => p !== me);
    if (!room.players.length) { stopClock(room); rooms.delete(room.code); return; }
    if (me.host) room.players[0].host = true;
    pushLobby(room);
  });
});


setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

export default server;

if (!process.env.VERCEL) server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCrack is running\n  this computer : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  on your Wi-Fi : http://${i.address}:${PORT}   (open this on your phone)`);
  console.log('');
});
