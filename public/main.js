











import { createSim, STATS, STAT_MAX, BUDGET, COLORS, MAX_PLAYERS, TPS, W, H, MIN_SECONDS, MAX_SECONDS } from './sim.js';
import { createRenderer } from './render.js';

const $ = id => document.getElementById(id);
const SCREENS = ['home', 'room', 'game', 'results'];
let screen = 'home';
function show(name) { screen = name; for (const s of SCREENS) $(s).hidden = s !== name; }
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800); }


let horizon = 0, events = [], seen = new Set(), matchId = 0, isHost = false;
let srvTick = 0, srvLocal = 0, clockSpeed = 1;
let sim = null;


let ws = null;
const send = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };


const getSession = () => { try { return JSON.parse(sessionStorage.getItem('rw-session')); } catch { return null; } };
const saveSession = (code, token) => { try { sessionStorage.setItem('rw-session', JSON.stringify({ code, token })); } catch {   } };
const clearSession = () => { try { sessionStorage.removeItem('rw-session'); } catch {   } };

const capPicker = $('cap-picker'), capTrigger = $('cap-trigger'), capMenu = $('cap-menu'), capLabel = $('cap-label');
const capOptions = []; let selectedCapacity = 4;
for (let n = 2; n <= MAX_PLAYERS; n++) {
  const option = document.createElement('div');
  option.className = 'capacity-option'; option.setAttribute('role', 'option'); option.tabIndex = -1;
  option.dataset.value = n; option.textContent = `Up to ${n} players`;
  option.onclick = () => setCapacity(n);
  capMenu.append(option); capOptions.push(option);
}
function closeCapacityMenu() { capMenu.hidden = true; capTrigger.setAttribute('aria-expanded', 'false'); }
function openCapacityMenu() {
  capMenu.hidden = false; capTrigger.setAttribute('aria-expanded', 'true');
  capOptions.find(option => +option.dataset.value === selectedCapacity)?.focus();
}
function setCapacity(value, returnFocus = true) {
  selectedCapacity = value; capLabel.textContent = `Up to ${value} players`;
  capOptions.forEach(option => option.setAttribute('aria-selected', String(+option.dataset.value === value)));
  closeCapacityMenu(); if (returnFocus) capTrigger.focus();
}
capOptions.forEach(option => option.addEventListener('keydown', e => {
  const index = capOptions.indexOf(e.currentTarget);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); capOptions[(index + (e.key === 'ArrowDown' ? 1 : -1) + capOptions.length) % capOptions.length].focus(); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); capOptions[e.key === 'Home' ? 0 : capOptions.length - 1].focus(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCapacity(+e.currentTarget.dataset.value); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCapacityMenu(); capTrigger.focus(); }
}));
capTrigger.onclick = () => capMenu.hidden ? openCapacityMenu() : closeCapacityMenu();
capTrigger.onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCapacityMenu(); }
  else if (e.key === 'Escape') closeCapacityMenu();
};
document.addEventListener('click', e => { if (!capPicker.contains(e.target)) closeCapacityMenu(); });
setCapacity(4, false);
try { $('name').value = localStorage.getItem('rw-name') || ''; } catch {   }
const invited = new URLSearchParams(location.search).get('room');
if (invited) $('code').value = invited.toUpperCase().slice(0, 4);

function connect(firstMessage) {
  const name = $('name').value.trim() || 'Player';
  try { localStorage.setItem('rw-name', name); } catch {   }
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => send(firstMessage(name));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onerror = () => toast('Cannot reach the server');
  ws.onclose = () => {
    if (screen === 'game' || screen === 'results') {
      toast('Connection lost, reconnecting…');
      setTimeout(() => { if (!ws || ws.readyState > 1) rejoin(); }, 1500);
    } else { toast('Disconnected from server'); show('home'); }
  };
}
function rejoin() {
  const s = getSession(); if (!s) return false;
  connect(() => ({ type: 'rejoin', code: s.code, token: s.token }));
  return true;
}
$('create').onclick = () => connect(name => ({ type: 'create', name, capacity: selectedCapacity }));
$('join').onclick = () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  connect(name => ({ type: 'join', name, code }));
};

function onMessage(m) {
  if (m.type === 'error') toast(m.msg);
  else if (m.type === 'lobby') onLobby(m);
  else if (m.type === 'start') launch(m);
  else if (m.type === 'horizon') { setClock(m); if (sim && document.hidden) pump(50); }
  else if (m.type === 'tune') addEvents([m]);
  else if (m.type === 'host') isHost = true;
  else if (m.type === 'rejoin_failed') { clearSession(); stopGame(); show('home'); toast('That match is no longer available'); }
}


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
  Community:{ atk: 5,  def: 15, spd: 10, intel: 10, repro: 15, eat: 15, bond: 30 },
};
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;


Object.assign($('time'), { min: MIN_SECONDS, max: MAX_SECONDS });
$('time').oninput = () => { $('tval').textContent = mmss(+$('time').value); };
$('time').onchange = () => send({ type: 'time', seconds: +$('time').value });


function createStatEditor(box, pre, onChange) {
  const st = { ...PRESETS.Balanced };
  const sliders = {}, boxes = {}, presetBtns = {};
  const spent = () => STATS.reduce((a, k) => a + st[k], 0);
  function setStat(k, v, keepBox) { st[k] = v; sliders[k].value = v; if (!keepBox) boxes[k].value = v; }
  function refresh() {
    let hit = 'Custom';
    for (const [name, p] of Object.entries(PRESETS)) if (STATS.every(k => st[k] === p[k])) { hit = name; break; }
    for (const [name, b] of Object.entries(presetBtns)) b.classList.toggle('active', name === hit);
    onChange(BUDGET - spent());
  }
  for (const k of STATS) {
    const row = document.createElement('label'); row.className = 'stat';
    const name = document.createElement('span'); name.textContent = INFO[k][0];
    const input = document.createElement('input'); Object.assign(input, { type: 'range', min: 0, max: STAT_MAX, value: st[k] }); input.dataset.k = k;
    const val = document.createElement('input'); Object.assign(val, { type: 'number', min: 0, max: STAT_MAX, step: 1, value: st[k], inputMode: 'numeric' }); val.dataset.k = k;
    const hint = document.createElement('small'); hint.textContent = INFO[k][1];
    sliders[k] = input; boxes[k] = val;
    row.append(name, input, val, hint); box.appendChild(row);
  }

  box.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const raw = e.target.value;
    const room = Math.min(STAT_MAX, BUDGET - (spent() - st[k]));
    const v = Math.max(0, Math.min(Math.round(+raw || 0), room));
    setStat(k, v, e.target.type === 'number' && raw === '');
    refresh();
  });
  box.addEventListener('focusout', e => {
    const k = e.target.dataset.k; if (k) boxes[k].value = st[k];
  });
  for (const [name, preset] of Object.entries(PRESETS)) {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = name;
    b.onclick = () => { for (const k of STATS) setStat(k, preset[k]); refresh(); };
    pre.appendChild(b); presetBtns[name] = b;
  }
  const custom = document.createElement('button'); custom.className = 'ghost'; custom.textContent = 'Custom';
  custom.title = 'Start from zero and spend your 100 points yourself';
  custom.onclick = () => { for (const k of STATS) setStat(k, 0); refresh(); };
  pre.appendChild(custom); presetBtns.Custom = custom;
  refresh();
  return { stats: st, load(s) { for (const k of STATS) setStat(k, s[k]); refresh(); } };
}

const roomEditor = createStatEditor($('sliders'), $('presets'), left => {
  $('left').textContent = left ? `${left} left` : 'ready ✓';
  $('left').classList.toggle('ok', left === 0);
  $('ready').disabled = left !== 0;
});
const stats = roomEditor.stats;


const DEFAULT_SPAWN = [{ x: .15, y: .25 }, { x: .85, y: .25 }, { x: .15, y: .75 }, { x: .85, y: .75 }, { x: .5, y: .15 }, { x: .5, y: .85 }];
const seedCv = $('seedmap'), sctx = seedCv.getContext('2d');
let lobby = null, mySlot = 0, spawn = null;

function drawSeedMap() {
  const k = seedCv.width / W;
  sctx.fillStyle = '#0a0c12'; sctx.fillRect(0, 0, seedCv.width, seedCv.height);
  sctx.strokeStyle = '#1a2133'; sctx.lineWidth = 1; sctx.beginPath();
  for (let x = 0; x <= W; x += 32) { sctx.moveTo(x * k + .5, 0); sctx.lineTo(x * k + .5, seedCv.height); }
  for (let y = 0; y <= H; y += 36) { sctx.moveTo(0, y * k + .5); sctx.lineTo(seedCv.width, y * k + .5); }
  sctx.stroke();
  for (const p of lobby ? lobby.players : []) {
    const s = p.slot === mySlot ? spawn : p.spawn;
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
  if (screen === 'game' || screen === 'results') stopGame();
  lobby = m; mySlot = m.you;
  if (m.token) saveSession(m.code, m.token);
  if (!spawn) spawn = DEFAULT_SPAWN[m.you - 1];
  if (screen !== 'room') show('room');

  const me = m.players.find(p => p.slot === m.you);
  isHost = me.host;
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
  if (document.activeElement !== $('time')) $('time').value = m.seconds;
  $('tval').textContent = mmss(+$('time').value);
  $('time').disabled = !me.host;
  $('thint').textContent = me.host ? 'You are the host: 1 to 5 minutes' : 'Set by the host';
  drawSeedMap();
}
$('ready').onclick = () => send({ type: 'config', stats: { ...stats }, spawn });
$('start').onclick = () => send({ type: 'start' });
$('copy').onclick = async () => {
  const link = `${location.origin}/?room=${lobby.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch { prompt('Copy this invite link:', link); }
};


let renderer = null, palette = [], myColony = 0;
let frameId = 0, lastHud = 0, finished = false, chips = [];
let paused = false;


function setClock(m) {
  srvTick = m.at; srvLocal = performance.now(); clockSpeed = m.speed;
  horizon = Math.max(horizon, m.tick);
}
const wantTick = now => Math.min(horizon, srvTick + (now - srvLocal) * TPS * clockSpeed / 1000);

function addEvents(list) {
  let added = false;
  for (const e of list) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); added = true; }
  if (added) events.sort((a, b) => a.tick - b.tick || a.id - b.id);
}


function pump(budgetMs) {
  if (!sim) return;
  if (!sim.done) {
    const t0 = performance.now(), want = Math.floor(wantTick(t0));
    while (sim.tick < want && !sim.done) {

      while (events.length && events[0].tick <= sim.tick) { const e = events.shift(); sim.retune(e.colony, e.stats); }
      sim.step();
      if (performance.now() - t0 > budgetMs) break;
    }
  }
  checkEnd();
}
function checkEnd() {
  if (!sim || !sim.done || finished) return;
  finished = true;
  $('banner').textContent = { time: "Time's up!", last: 'Last colony standing!', extinct: 'Extinction!' }[sim.reason] || 'Game over';
  setTimeout(showResults, 1600);
}


let lastSent = '', tuneTimer = 0;
const tuner = createStatEditor($('tsliders'), $('tpresets'), left => {
  $('tleft').textContent = left ? `${left} left` : 'live ✓';
  $('tleft').classList.toggle('ok', left === 0);
  clearTimeout(tuneTimer);
  if (left === 0 && sim) tuneTimer = setTimeout(sendTune, 150);
});
function sendTune() {
  const s = JSON.stringify(tuner.stats);
  if (s === lastSent) return;
  lastSent = s; send({ type: 'tune', stats: { ...tuner.stats } });
}
$('tunebtn').onclick = () => { $('tune').hidden = !$('tune').hidden; };
$('speed').onclick = () => {
  if (!isHost) return toast('Only the host can change the speed');
  send({ type: 'speed', speed: clockSpeed === 1 ? 2 : clockSpeed === 2 ? 4 : 1 });
};

const portrait = matchMedia('(orientation: portrait) and (max-width: 900px)');
const syncPause = () => { paused = portrait.matches; };
portrait.addEventListener('change', syncPause); syncPause();

function launch(m) {
  isHost = !!m.host;
  if (sim && m.matchId === matchId) {
    setClock(m); addEvents(m.events || []);
    return;
  }
  stopGame();
  matchId = m.matchId; myColony = m.you;
  horizon = 0; events = []; seen = new Set();
  addEvents(m.events || []); setClock(m);
  palette = ['', ...m.configs.map(c => COLORS[c.slot])];
  sim = createSim(m.configs, m.seed, m.seconds);
  show('game');
  renderer = createRenderer($('cv'), sim, palette);


  $('tune').hidden = true; $('tunebtn').hidden = !m.you;
  if (m.you) {
    let mine = m.configs[m.you - 1].stats;
    for (const e of m.events || []) if (e.colony === m.you) mine = e.stats;
    lastSent = JSON.stringify(mine); tuner.load(mine);
  }

  const box = $('chips'); box.replaceChildren(); chips = [];
  m.configs.forEach((cfg, k) => {
    const el = document.createElement('div'); el.className = 'chip' + (k + 1 === m.you ? ' me' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = palette[k + 1];
    const label = document.createElement('span');
    el.append(dot, label); box.appendChild(el); chips.push({ label, name: cfg.name });
  });
  $('banner').textContent = '';
  lastHud = 0; finished = false;
  frameId = requestAnimationFrame(frame);
}

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (!sim) return;
  pump(wantTick(now) - sim.tick > TPS * 2 ? 40 : 12);
  if (!paused) {
    const w = wantTick(now), fl = Math.floor(w);
    renderer.draw(sim.tick < fl || w >= horizon ? 1 : w - fl);
  }
  if (now - lastHud > 250) { lastHud = now; updateHud(now); }
}

function updateHud(now) {
  const t = Math.ceil(sim.timeLeft);
  $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const lag = sim.done ? 0 : (wantTick(now) - sim.tick) / (TPS * clockSpeed);
  $('lag').hidden = lag < 1.5; $('lag').textContent = `⏩ catching up ${Math.ceil(lag)}s`;
  $('speed').textContent = clockSpeed + '×';
  chips.forEach((chip, k) => {
    const c = k + 1; let allies = 0;
    for (let o = 1; o <= sim.N; o++) if (sim.allied[c * (sim.N + 1) + o]) allies++;
    chip.label.textContent = `${chip.name} ${sim.pop[c]} · ${(sim.terr[c] / (W * H) * 100).toFixed(0)}%` + (allies ? ` 🤝${allies}` : '') + (sim.pop[c] ? '' : ' ☠');
  });
}


setInterval(() => { if (sim && document.hidden) pump(200); }, 500);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  lastHud = 0;
  if ((screen === 'game' || screen === 'results') && (!ws || ws.readyState > 1)) rejoin();
});

function stopGame() {
  cancelAnimationFrame(frameId);
  clearTimeout(tuneTimer); $('tune').hidden = true;
  if (renderer) renderer.destroy();
  sim = null; renderer = null; matchId = 0;
}


const COLUMNS = [
  ['#', (r, i) => i + 1], ['Colony', r => r.name], ['Territory', r => r.territory.toFixed(1) + '%'], ['Pop', r => r.population],
  ['Peak', r => r.peak], ['Kills', r => r.kills], ['Eaten', r => r.eaten], ['Born', r => r.born], ['Died', r => r.died],
  ['Allies', r => r.allies], ['Bonding', r => r.bonding.toFixed(0) + '%'], ['Score', r => r.score.toFixed(1)],
];
function showResults() {
  if (screen !== 'game' || !sim) return;
  cancelAnimationFrame(frameId);
  $('tune').hidden = true;
  const res = sim.getResults();
  const winner = res.reason === 'extinct' ? null : res.rows[0];
  $('outcome').textContent = winner && winner.color === myColony ? "Congrats! You're CRACKED" : res.outcome;

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
  $('rematch').hidden = !isHost;
  show('results');
}
$('rematch').onclick = () => send({ type: 'reset' });
$('leave').onclick = () => { clearSession(); location.href = location.pathname; };


if (!invited) rejoin();
