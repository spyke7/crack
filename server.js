// ============================================================================
// server.js : static file server + room manager (WebSocket).
// The server does NOT run the simulation. It only collects each player's stats,
// then broadcasts { seed, configs } so every browser runs the identical match.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validStats, STATS, MAX_PLAYERS } from './public/sim.js';   // same budget rule the UI uses

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ---------- 1. static files (public/) ----------
const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel === '/health') return res.end('ok');                    // for hosting platforms
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }   // block ../ tricks
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- 2. rooms ----------
// room   = { code, capacity, started, players: [] }
// player = { slot, name, ws, host, stats|null, spawn|null }    slot = 1..6 = colour in the palette
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';               // no 0/O/1/I confusion

function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join(''); }
  while (rooms.has(code));
  return code;
}
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const cleanName = n => String(n ?? '').trim().slice(0, 16) || 'Player';
const validSpawn = s => s && Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0.05 && s.x <= 0.95 && s.y >= 0.05 && s.y <= 0.95;

function pushLobby(room) {                                       // tell everybody the room state ("you" differs per person)
  const players = room.players.map(p => ({ slot: p.slot, name: p.name, host: p.host, ready: !!p.stats, spawn: p.spawn }));
  for (const p of room.players) send(p.ws, { type: 'lobby', code: room.code, capacity: room.capacity, you: p.slot, players });
}

wss.on('connection', ws => {
  let room = null, me = null;                                    // this socket's room and player (closure state)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create' && !room) {
      const capacity = Math.min(Math.max(parseInt(m.capacity) || 4, 2), MAX_PLAYERS);
      room = { code: newCode(), capacity, started: false, players: [] };
      rooms.set(room.code, room);
      me = { slot: 1, name: cleanName(m.name), ws, host: true, stats: null, spawn: null };
      room.players.push(me);
      pushLobby(room);
    }
    else if (m.type === 'join' && !room) {
      const r = rooms.get(String(m.code ?? '').toUpperCase());
      if (!r) return send(ws, { type: 'error', msg: 'No room with that code' });
      if (r.started) return send(ws, { type: 'error', msg: 'That game already started' });
      if (r.players.length >= r.capacity) return send(ws, { type: 'error', msg: 'Room is full' });
      let slot = 1; while (r.players.some(p => p.slot === slot)) slot++;   // lowest free colour
      room = r;
      me = { slot, name: cleanName(m.name), ws, host: false, stats: null, spawn: null };
      room.players.push(me);
      pushLobby(room);
    }
    else if (m.type === 'config' && room && !room.started) {
      if (!validStats(m.stats)) return send(ws, { type: 'error', msg: 'Stats must add up to exactly 100' });
      me.stats = Object.fromEntries(STATS.map(k => [k, m.stats[k]]));   // copy only the 7 known keys
      me.spawn = validSpawn(m.spawn) ? { x: m.spawn.x, y: m.spawn.y } : null;
      pushLobby(room);
    }
    else if (m.type === 'start' && room && me.host && !room.started) {
      const ready = room.players.filter(p => p.stats).sort((a, b) => a.slot - b.slot);
      if (ready.length < 2) return send(ws, { type: 'error', msg: 'Need at least 2 ready players' });
      room.started = true;
      const seed = (Math.random() * 2 ** 32) >>> 0;              // fine here: the server is outside the simulation
      const configs = ready.map(p => ({ name: p.name, slot: p.slot, stats: p.stats, spawn: p.spawn }));
      for (const p of room.players) {                            // "you" = your colony number (0 = spectator)
        send(p.ws, { type: 'start', seed, configs, you: ready.indexOf(p) + 1 });
      }
      console.log(`room ${room.code}: started with ${ready.length} players (seed ${seed})`);
    }
    else if (m.type === 'reset' && room && me.host && room.started) {   // rematch
      room.started = false;
      for (const p of room.players) { p.stats = null; p.spawn = null; }
      pushLobby(room);
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.players = room.players.filter(p => p !== me);
    if (!room.players.length) { rooms.delete(room.code); return; }   // last one out deletes the room
    if (me.host) room.players[0].host = true;                        // promote the next player
    if (!room.started) pushLobby(room);                              // running matches are local; nothing to tell them
  });
});

// drop dead connections (phones that lost signal) every 30 s
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nRule Wars is running\n  this computer : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  on your Wi-Fi : http://${i.address}:${PORT}   (open this on your phone)`);
  console.log('');
});
