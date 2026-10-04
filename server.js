// ============================================================================
// server.js : static file server + room manager (WebSocket).
// The server does NOT run the simulation. It collects each player's stats,
// then broadcasts { seed, seconds, configs } so every browser runs the identical match.
// During a match it is the ONE clock for everybody:
//   - "horizon": the highest tick any client may simulate (sent every 100 ms, with the
//     clock position and speed so every client paces itself the same way)
//   - "tune": a live stat change, stamped with a tick, so all clients apply it at the same moment
//   - "speed": host-only match speed (1x / 2x / 4x), applied to everybody at once
// It also remembers the match (seed, configs, tune log) so a player who closes the tab,
// locks the phone or loses signal can rejoin and fast-forward to the present.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validStats, STATS, MAX_PLAYERS, GAME_SECONDS, MIN_SECONDS, MAX_SECONDS, TPS } from './public/sim.js';   // same rules the UI uses

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
// room   = { code, capacity, seconds, started, players: [], matchId, seed, configs, events, nextId,
//            clock (interval), clk {tick, at, speed}, horizon, maxTicks, emptyTimer }
// player = { slot, name, ws (null = offline), host, stats|null, spawn|null, colony, token }    slot = 1..6 = colour
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';               // no 0/O/1/I confusion

function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join(''); }
  while (rooms.has(code));
  return code;
}
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (room, msg) => { for (const p of room.players) send(p.ws, msg); };
const cleanName = n => String(n ?? '').trim().slice(0, 16) || 'Player';
const validSpawn = s => s && Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0.05 && s.x <= 0.95 && s.y >= 0.05 && s.y <= 0.95;
const cleanSeconds = v => Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(+v) || GAME_SECONDS));   // 1..5 minutes

function pushLobby(room) {                                       // tell everybody the room state ("you" and "token" differ per person)
  const players = room.players.map(p => ({ slot: p.slot, name: p.name, host: p.host, ready: !!p.stats, spawn: p.spawn }));
  for (const p of room.players) send(p.ws, { type: 'lobby', code: room.code, capacity: room.capacity, seconds: room.seconds, you: p.slot, token: p.token, players });
}

// ---------- 3. the shared match clock ----------
// Clients may only simulate up to `horizon`. A tune event is stamped with the last horizon sent,
// so every client applies it at the same tick, before simulating past it.
// clk = "at wall time `at`, the match was at tick `tick`, and time runs at `speed` x".
const LOOKAHEAD = 9, HORIZON_MS = 100;     // 9 ticks (x speed) = 0.3 s of buffer for network jitter
const SPEEDS = [1, 2, 4];
const MAX_EVENTS = 2000;                   // cap on tune events per match (keeps rejoin messages small)
const EMPTY_MS = 120000;                   // a room nobody is connected to is deleted after 2 minutes

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
  let room = null, me = null;                                    // this socket's room and player (closure state)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create' && !room) {
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
      let slot = 1; while (r.players.some(p => p.slot === slot)) slot++;   // lowest free colour
      room = r;
      me = { slot, name: cleanName(m.name), ws, host: false, stats: null, spawn: null, colony: 0, token: randomUUID() };
      room.players.push(me);
      pushLobby(room);
    }
    else if (m.type === 'rejoin' && !room) {                     // came back after closing the tab / losing signal
      const r = rooms.get(String(m.code ?? '').toUpperCase());
      const p = r && r.players.find(q => q.token === m.token);
      if (!p) return send(ws, { type: 'rejoin_failed' });
      const old = p.ws; p.ws = ws;                               // take over the seat
      if (old && old !== ws) old.terminate();                    // a half-dead old socket may still be around
      room = r; me = p; clearTimeout(room.emptyTimer);
      if (room.started) send(ws, startMsg(room, me)); else pushLobby(room);
    }
    else if (m.type === 'config' && room && !room.started) {
      if (!validStats(m.stats)) return send(ws, { type: 'error', msg: 'Stats must add up to exactly 100' });
      me.stats = Object.fromEntries(STATS.map(k => [k, m.stats[k]]));   // copy only the 7 known keys
      me.spawn = validSpawn(m.spawn) ? { x: m.spawn.x, y: m.spawn.y } : null;
      pushLobby(room);
    }
    else if (m.type === 'time' && room && me.host && !room.started) {   // only the host sets the match length
      room.seconds = cleanSeconds(m.seconds);
      pushLobby(room);
    }
    else if (m.type === 'start' && room && me.host && !room.started) {
      const ready = room.players.filter(p => p.stats).sort((a, b) => a.slot - b.slot);
      if (ready.length < 2) return send(ws, { type: 'error', msg: 'Need at least 2 ready players' });
      room.started = true; room.matchId++;
      room.seed = (Math.random() * 2 ** 32) >>> 0;               // fine here: the server is outside the simulation
      room.configs = ready.map(p => ({ name: p.name, slot: p.slot, stats: p.stats, spawn: p.spawn }));
      for (const p of room.players) p.colony = ready.indexOf(p) + 1;   // 0 = spectator
      startClock(room);
      for (const p of room.players) send(p.ws, startMsg(room, p));
      console.log(`room ${room.code}: started with ${ready.length} players (seed ${room.seed}, ${room.seconds}s)`);
    }
    else if (m.type === 'tune' && room && room.started && room.clock && me.colony) {   // live stat change
      if (!validStats(m.stats) || room.events.length >= MAX_EVENTS) return;
      const now = Date.now(); if (now - (me.lastTune || 0) < 150) return; me.lastTune = now;   // simple rate limit
      const ev = { id: room.nextId++, tick: room.horizon, colony: me.colony, stats: Object.fromEntries(STATS.map(k => [k, m.stats[k]])) };
      room.events.push(ev);                                      // kept so a rejoining client can replay it
      broadcast(room, { type: 'tune', ...ev });
    }
    else if (m.type === 'speed' && room && room.started && room.clock && me.host && SPEEDS.includes(+m.speed)) {   // host sets the speed for EVERYONE
      const now = Date.now();
      room.clk = { tick: Math.min(room.maxTicks, clockAt(room, now)), at: now, speed: +m.speed };
      advance(room); broadcast(room, clockMsg(room));            // clients re-pace immediately
    }
    else if (m.type === 'reset' && room && me.host && room.started) {   // rematch
      stopClock(room);
      room.started = false; room.events = [];
      room.players = room.players.filter(p => p.ws);             // seats of players who never came back are freed
      for (const p of room.players) { p.stats = null; p.spawn = null; p.colony = 0; }
      pushLobby(room);
    }
  });

  ws.on('close', () => {
    if (!room || me.ws !== ws) return;                           // not in a room, or this socket was already replaced by a rejoin
    if (room.started) {                                          // match running: keep the seat so the player can come back
      me.ws = null;
      if (me.host) {                                             // hand the host role to someone who is still connected
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
    if (!room.players.length) { stopClock(room); rooms.delete(room.code); return; }   // last one out deletes the room
    if (me.host) room.players[0].host = true;                    // promote the next player
    pushLobby(room);
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
  console.log(`\nCrack is running\n  this computer : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  on your Wi-Fi : http://${i.address}:${PORT}   (open this on your phone)`);
  console.log('');
});