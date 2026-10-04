// ============================================================================
// main.js : everything the player touches.
//   home -> room (design stats, drop seed, wait) -> game (canvas loop) -> results
// Talks to server.js over WebSocket; runs sim.js locally; draws with render.js.
// ============================================================================
import { createSim, STATS, STAT_MAX, BUDGET, COLORS, MAX_PLAYERS, TPS, W, H } from './sim.js';
import { createRenderer } from './render.js';

const $ = id => document.getElementById(id);
const SCREENS = ['home', 'room', 'game', 'results'];
let screen = 'home';
function show(name) { screen = name; for (const s of SCREENS) $(s).hidden = s !== name; }
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800); }

// ============================ 1. HOME + WEBSOCKET ============================
let ws = null;
const send = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

for (let n = 2; n <= MAX_PLAYERS; n++) $('cap').append(new Option(`Up to ${n} players`, n));
$('cap').value = 4;
try { $('name').value = localStorage.getItem('rw-name') || ''; } catch { /* private mode: ignore */ }
const invited = new URLSearchParams(location.search).get('room');      // invite link: /?room=ABCD
if (invited) $('code').value = invited.toUpperCase().slice(0, 4);

function connect(firstMessage) {
  const name = $('name').value.trim() || 'Player';
  try { localStorage.setItem('rw-name', name); } catch { /* ignore */ }
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => send(firstMessage(name));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onerror = () => toast('Cannot reach the server');
  ws.onclose = () => {
    if (screen === 'game' || screen === 'results') toast('Connection lost (your match keeps running)');   // the sim is local!
    else { toast('Disconnected from server'); show('home'); }
  };
}
$('create').onclick = () => connect(name => ({ type: 'create', name, capacity: +$('cap').value }));
$('join').onclick = () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  connect(name => ({ type: 'join', name, code }));
};

function onMessage(m) {
  if (m.type === 'error') toast(m.msg);
  else if (m.type === 'lobby') onLobby(m);
  else if (m.type === 'start') launch(m);
}

// ============================ 2. ROOM: stats, seed, players ============================
const INFO = {
  atk:   ['Attack',     'Damage you deal. Costs upkeep.'],
  def:   ['Defense',    'Armor, health and lifespan.'],
  spd:   ['Speed',      'Moves faster. Upkeep grows with speed².'],
  intel: ['Intelligence', 'Sees farther, learns faster. Costs upkeep.'],
  repro: ['Breeding',   'Splits at lower energy.'],
  eat:   ['Appetite',   'More energy from each food.'],
  bond:  ['Bonding',    'Less aggressive, makes allies, flocks tight.'],
};
const PRESETS = {
  Balanced: { atk: 14, def: 14, spd: 14, intel: 14, repro: 15, eat: 15, bond: 14 },
  Warrior:  { atk: 35, def: 10, spd: 20, intel: 5,  repro: 10, eat: 10, bond: 10 },
  Turtle:   { atk: 5,  def: 35, spd: 5,  intel: 10, repro: 25, eat: 15, bond: 5 },
  Diplomat: { atk: 5,  def: 15, spd: 10, intel: 10, repro: 10, eat: 15, bond: 35 },
  Breeder:  { atk: 8,  def: 8,  spd: 8,  intel: 8,  repro: 35, eat: 25, bond: 8 },
};
const stats = { ...PRESETS.Balanced };
const spent = () => STATS.reduce((a, k) => a + stats[k], 0);

function updateLeft() {
  const left = BUDGET - spent();
  $('left').textContent = left ? `${left} left` : 'ready ✓';
  $('left').classList.toggle('ok', left === 0);
  $('ready').disabled = left !== 0;                   // must spend exactly 100 points
}
function setStat(k, v) { stats[k] = v; $('s-' + k).value = v; $('v-' + k).textContent = v; }

(function buildStatForm() {
  const box = $('sliders'), pre = $('presets');
  for (const k of STATS) {
    const row = document.createElement('label'); row.className = 'stat';
    const name = document.createElement('span'); name.textContent = INFO[k][0];
    const input = document.createElement('input'); Object.assign(input, { type: 'range', min: 0, max: STAT_MAX, value: stats[k], id: 's-' + k }); input.dataset.k = k;
    const val = document.createElement('b'); val.id = 'v-' + k; val.textContent = stats[k];
    const hint = document.createElement('small'); hint.textContent = INFO[k][1];
    row.append(name, input, val, hint); box.appendChild(row);
  }
  box.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const room = BUDGET - (spent() - stats[k]);       // points still available for this stat
    setStat(k, Math.min(+e.target.value, room));      // the slider cannot go past the budget
    updateLeft();
  });
  for (const [name, preset] of Object.entries(PRESETS)) {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = name;
    b.onclick = () => { for (const k of STATS) setStat(k, preset[k]); updateLeft(); };
    pre.appendChild(b);
  }
  updateLeft();
})();

// seed picker: a small map where you tap to drop your colony
const DEFAULT_SPAWN = [{ x: .15, y: .25 }, { x: .85, y: .25 }, { x: .15, y: .75 }, { x: .85, y: .75 }, { x: .5, y: .15 }, { x: .5, y: .85 }];
const seedCv = $('seedmap'), sctx = seedCv.getContext('2d');
let lobby = null, mySlot = 0, spawn = null;

function drawSeedMap() {
  const k = seedCv.width / W;                         // canvas is drawn at 2x the world grid
  sctx.fillStyle = '#0a0c12'; sctx.fillRect(0, 0, seedCv.width, seedCv.height);
  sctx.strokeStyle = '#1a2133'; sctx.lineWidth = 1; sctx.beginPath();
  for (let x = 0; x <= W; x += 32) { sctx.moveTo(x * k + .5, 0); sctx.lineTo(x * k + .5, seedCv.height); }
  for (let y = 0; y <= H; y += 36) { sctx.moveTo(0, y * k + .5); sctx.lineTo(seedCv.width, y * k + .5); }
  sctx.stroke();
  for (const p of lobby ? lobby.players : []) {
    const s = p.slot === mySlot ? spawn : p.spawn;    // my own pick is local until I press Ready
    if (!s) continue;
    sctx.fillStyle = COLORS[p.slot]; sctx.beginPath(); sctx.arc(s.x * seedCv.width, s.y * seedCv.height, p.slot === mySlot ? 11 : 8, 0, 6.2832); sctx.fill();
    if (p.slot === mySlot) { sctx.strokeStyle = '#fff'; sctx.lineWidth = 2; sctx.stroke(); }
  }
}
function pickSpawn(e) {
  const r = seedCv.getBoundingClientRect(), c = v => Math.min(.95, Math.max(.05, v));
  spawn = { x: c((e.clientX - r.left) / r.width), y: c((e.clientY - r.top) / r.height) };
  drawSeedMap();
}
seedCv.addEventListener('pointerdown', e => { seedCv.setPointerCapture(e.pointerId); pickSpawn(e); });
seedCv.addEventListener('pointermove', e => { if (e.buttons) pickSpawn(e); });

function onLobby(m) {
  if (screen === 'game' || screen === 'results') stopGame();   // host pressed "Rematch"
  lobby = m; mySlot = m.you;
  if (!spawn) spawn = DEFAULT_SPAWN[m.you - 1];
  if (screen !== 'room') show('room');

  const me = m.players.find(p => p.slot === m.you);
  $('rcode').textContent = m.code;
  const ul = $('players'); ul.replaceChildren();
  for (const p of m.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = COLORS[p.slot];
    const nm = document.createElement('span'); nm.textContent = p.name + (p.slot === m.you ? ' (you)' : '') + (p.host ? ' 👑' : '');
    const st = document.createElement('span'); st.className = 'r'; st.textContent = p.ready ? '✓ ready' : '…';
    li.append(dot, nm, st); ul.appendChild(li);
  }
  const ready = m.players.filter(p => p.ready).length;
  $('waiting').textContent = `${m.players.length}/${m.capacity} joined · ${ready} ready` + (me.host ? '' : ' · host starts the game');
  $('start').hidden = !me.host; $('start').disabled = ready < 2;
  $('ready').textContent = me.ready ? 'Update ✓' : 'Ready';
  drawSeedMap();
}
$('ready').onclick = () => send({ type: 'config', stats: { ...stats }, spawn });
$('start').onclick = () => send({ type: 'start' });
$('copy').onclick = async () => {
  const link = `${location.origin}/?room=${lobby.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch { prompt('Copy this invite link:', link); }     // clipboard needs https; fall back to a prompt on plain http
};

// ============================ 3. GAME LOOP ============================
const TICK_MS = 1000 / TPS, MAX_STEPS = 4;            // never run more than 4 ticks in one frame
let sim = null, renderer = null, palette = [], myColony = 0;
let frameId = 0, acc = 0, last = 0, lastHud = 0, speed = 1, finished = false, chips = [];
let paused = false;                                   // true while the phone is in portrait

const portrait = matchMedia('(orientation: portrait) and (max-width: 900px)');
const syncPause = () => { paused = portrait.matches; };
portrait.addEventListener('change', syncPause); syncPause();

function launch({ seed, configs, you }) {
  stopGame();
  myColony = you;
  palette = ['', ...configs.map(c => COLORS[c.slot])];    // colony id (1..N) -> css colour
  sim = createSim(configs, seed);                         // identical on every device
  show('game');                                           // show first, so the canvas has a real size
  renderer = createRenderer($('cv'), sim, palette);

  const box = $('chips'); box.replaceChildren(); chips = [];
  configs.forEach((cfg, k) => {
    const el = document.createElement('div'); el.className = 'chip' + (k + 1 === you ? ' me' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = palette[k + 1];
    const label = document.createElement('span');
    el.append(dot, label); box.appendChild(el); chips.push({ label, name: cfg.name });
  });
  speed = 1; $('speed').textContent = '1×'; $('banner').textContent = '';
  acc = 0; last = performance.now(); lastHud = 0; finished = false;
  frameId = requestAnimationFrame(frame);
}

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (paused) { last = now; return; }                     // phone in portrait: freeze
  acc += Math.min(now - last, 100) * speed; last = now;   // clamp: a long tab sleep must not cause a huge catch-up
  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_STEPS && !sim.done) { sim.step(); acc -= TICK_MS; steps++; }
  if (steps === MAX_STEPS) acc = 0;                       // too slow: run slower, never spiral. (Ticks are never skipped, so results stay identical.)
  renderer.draw(Math.min(1, acc / TICK_MS));              // acc/TICK_MS = how far we are between two ticks
  if (now - lastHud > 250) { lastHud = now; updateHud(); }
  if (sim.done && !finished) { finished = true; $('banner').textContent = { time: "Time's up!", last: 'Last colony standing!', extinct: 'Extinction!' }[sim.reason] || 'Game over'; setTimeout(showResults, 1600); }
}

function updateHud() {
  const t = Math.ceil(sim.timeLeft);
  $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  chips.forEach((chip, k) => {
    const c = k + 1; let allies = 0;
    for (let o = 1; o <= sim.N; o++) if (sim.allied[c * (sim.N + 1) + o]) allies++;
    chip.label.textContent = `${chip.name} ${sim.pop[c]} · ${(sim.terr[c] / (W * H) * 100).toFixed(0)}%` + (allies ? ` 🤝${allies}` : '') + (sim.pop[c] ? '' : ' ☠');
  });
}
$('speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('speed').textContent = speed + '×'; };

function stopGame() {
  cancelAnimationFrame(frameId);
  if (renderer) renderer.destroy();
  sim = null; renderer = null;
}

// ============================ 4. RESULTS ============================
const COLUMNS = [
  ['#', (r, i) => i + 1], ['Colony', r => r.name], ['Territory', r => r.territory.toFixed(1) + '%'], ['Pop', r => r.population],
  ['Peak', r => r.peak], ['Kills', r => r.kills], ['Eaten', r => r.eaten], ['Born', r => r.born], ['Died', r => r.died],
  ['Allies', r => r.allies], ['Bonding', r => r.bonding.toFixed(0) + '%'], ['Score', r => r.score.toFixed(1)],
];
function showResults() {
  if (screen !== 'game' || !sim) return;                  // player already left or rematch started
  cancelAnimationFrame(frameId);
  const res = sim.getResults();
  $('outcome').textContent = res.outcome;

  const table = $('rtable'); table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const [title] of COLUMNS) head.appendChild(Object.assign(document.createElement('th'), { textContent: title }));
  const body = table.createTBody();
  res.rows.forEach((row, i) => {
    const tr = body.insertRow(); if (i === 0) tr.className = 'win';
    COLUMNS.forEach(([title, fn]) => {
      const td = tr.insertCell(); td.textContent = fn(row, i);
      if (title === 'Colony') { const dot = document.createElement('span'); dot.className = 'dot'; dot.style.cssText = `display:inline-block;margin-right:6px;background:${palette[row.color]}`; td.prepend(dot); }
    });
  });

  const url = renderer.paintingURL();
  $('painting').src = url; $('dl').href = url;
  const me = lobby && lobby.players.find(p => p.slot === mySlot);
  $('rematch').hidden = !(me && me.host);
  show('results');
}
$('rematch').onclick = () => send({ type: 'reset' });
$('leave').onclick = () => { location.href = location.pathname; };
