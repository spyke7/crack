// ============================================================================
// sim.js : the whole game world.
// Pure JavaScript: NO DOM, NO Math.random, NO Date. That keeps it deterministic,
// so every browser given the same (configs, seed) computes the exact same match.
// Used by: public/main.js (browser), server.js (validation), test.js (balance).
// ============================================================================

// ---------- shared constants ----------
export const W = 256, H = 144;              // world grid (cells)
export const TPS = 30;                      // simulation ticks per second
export const GAME_SECONDS = 180;            // default match length
export const MIN_SECONDS = 60, MAX_SECONDS = 300;   // host can pick 1 to 5 minutes
export const MAX_TICKS = TPS * GAME_SECONDS;
export const BUDGET = 100, STAT_MAX = 40;   // every player spends exactly 100 points, max 40 on one stat
export const MAX_PLAYERS = 6;               // hard cap on room capacity
export const STATS = ['atk', 'def', 'spd', 'intel', 'repro', 'eat', 'bond'];
export const COLORS = ['#000000', '#ff4d6d', '#4cc9f0', '#80ed99', '#ffd166', '#c77dff', '#ff9f1c'];

// ---------- tuning knobs (change these while balancing) ----------
const R = {
  maxAgents: 3000, popCap: 650, cell: 8,          // hard array size, per-colony cap, spatial-hash cell size
  startAgents: 14, startEnergy: 70, energyCap: 150, // starting group, starting energy, max energy
  foodEvery: 60, foodRadius: 12, stray: 0.25,       // food rain on a FIXED timer (every 2s); scatter radius; share of pieces landing up to 2x farther
  homeFood: 6, neutralFood: 10, neutralZones: 3,    // pieces per rain: home zones, richer contested zones
  ambient: 3, scouts: 0.2,                          // random food pieces per rain, share of agents that explore
  dmgScale: 0.16, defK: 0.9,                        // global damage multiplier, how much defense cancels attack
  bondAt: 40, trustGain: 0.25, trustLoss: 0.15,     // alliance threshold and trust speed
  reproCooldown: 60, killLoot: 0.15,                 // ticks between splits, share of victim energy looted
  steer: 0.12, body: 1.4, push: 0.25,               // physics: steering inertia, collision diameter (cells), collision push
};

// ---------- small helpers ----------
export function mulberry32(a) {                     // seeded PRNG: same seed -> same sequence
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const eff = s => s / (s + 16);                      // diminishing returns: 0->0, 16->.5, 40->.71
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function validStats(s) {                     // the point-budget rule (used by server AND ui)
  if (!s) return false;
  let sum = 0;
  for (const k of STATS) {
    const v = s[k];
    if (!Number.isInteger(v) || v < 0 || v > STAT_MAX) return false;
    sum += v;
  }
  return sum === BUDGET;
}

// Turn the 7 raw stats into the numbers the simulation actually uses.
export function derive(s) {
  const a = eff(s.atk), d = eff(s.def), v = eff(s.spd), i = eff(s.intel),
        r = eff(s.repro), e = eff(s.eat), b = eff(s.bond);
  const speed = 0.42 + 0.45 * v;                    // cells per tick
  return {
    atk: 3 + 9 * a, def: 1 + 9 * d, maxHp: 20 + 40 * d,
    speed, look: 4 + Math.round(5 * i), learn: 0.004 + 0.03 * i,
    reproAt: 105 - 45 * r, eatGain: 30 + 30 * e,
    bondRate: b, aggr: (a + 0.1) / (a + b + 0.2),   // chance to attack (vs. befriend) on contact
    drain: 0.035 + 0.25 * speed * speed + 0.16 * a + 0.04 * i,  // upkeep: fast/strong/clever = hungry
    life: TPS * (35 + 45 * d),                      // lifespan in ticks
  };
}

// ============================================================================
export function createSim(configs, seed, seconds = GAME_SECONDS) {
  const rnd = mulberry32(seed);
  const maxTicks = TPS * clamp(Math.round(seconds) || GAME_SECONDS, MIN_SECONDS, MAX_SECONDS);
  const N = configs.length, S = N + 1;              // colonies are 1..N, 0 = nobody
  const popCap = Math.min(R.popCap, Math.floor(R.maxAgents / N));
  const GX = Math.ceil(W / R.cell), GY = Math.ceil(H / R.cell);

  // ----- agents: struct-of-arrays (typed arrays = no garbage, cache friendly) -----
  const M = R.maxAgents;
  const x = new Float32Array(M), y = new Float32Array(M);       // position
  const px = new Float32Array(M), py = new Float32Array(M);     // previous position (for smooth drawing)
  const vx = new Float32Array(M), vy = new Float32Array(M);     // velocity
  const en = new Float32Array(M), hp = new Float32Array(M);     // energy, health
  const dieAt = new Uint32Array(M), cd = new Uint16Array(M);    // death tick, reproduction cooldown
  const col = new Uint8Array(M);                                // which colony
  const role = new Uint8Array(M);                               // 1 = scout (explores), 0 = settler (stays with the group)
  const tx = new Float32Array(M), ty = new Float32Array(M);     // desired heading (unit vector) chosen by think()
  let n = 0;                                                    // live agents (indices 0..n-1)
  let tick = 0;                                                 // current simulation tick

  // ----- world layers (one byte per cell) -----
  const owner = new Uint8Array(W * H);    // who painted this cell last = territory painting
  const food = new Uint8Array(W * H);     // 1 = food here

  // ----- colony level data -----
  const P = [null], mem = [null];
  const pop = new Int32Array(S), peak = new Int32Array(S), terr = new Int32Array(S);
  const eaten = new Int32Array(S), kills = new Int32Array(S), born = new Int32Array(S), dead = new Int32Array(S);
  const trust = new Float32Array(S * S);  // trust[a*S+b] = how much colony a trusts colony b
  const allied = new Uint8Array(S * S);   // 1 = allies (never fight, move together)
  terr[0] = W * H;
  configs.forEach((cfg, k) => {
    const p = derive(cfg.stats);
    p.w = { food: 1, hunt: 0.6, flee: 0.6 };                    // learned preferences (reinforcement)
    P.push(p);
    const sx = (cfg.spawn ? cfg.spawn.x : 0.2 + 0.6 * (k % 3) / 2) * W;
    const sy = (cfg.spawn ? cfg.spawn.y : 0.3 + 0.4 * Math.floor(k / 3)) * H;
    mem.push({ x: sx, y: sy });                                 // where this colony last found food
  });

  function spawn(c, sx, sy, energy) {
    if (n >= M || pop[c] >= popCap) return false;
    const i = n++, p = P[c];
    x[i] = px[i] = clamp(sx, 0, W - 1.01); y[i] = py[i] = clamp(sy, 0, H - 1.01);
    vx[i] = (rnd() - 0.5) * p.speed; vy[i] = (rnd() - 0.5) * p.speed;
    en[i] = energy; hp[i] = p.maxHp; cd[i] = R.reproCooldown; col[i] = c; role[i] = rnd() < R.scouts ? 1 : 0;
    tx[i] = vx[i] / p.speed; ty[i] = vy[i] / p.speed;
    dieAt[i] = tick + Math.round(p.life * (0.9 + 0.2 * rnd()));
    pop[c]++; born[c]++; if (pop[c] > peak[c]) peak[c] = pop[c];
    return true;
  }
  function removeAt(i) {                            // swap-remove keeps arrays dense
    pop[col[i]]--;
    const l = --n;
    if (i !== l) {
      x[i] = x[l]; y[i] = y[l]; px[i] = px[l]; py[i] = py[l]; vx[i] = vx[l]; vy[i] = vy[l];
      en[i] = en[l]; hp[i] = hp[l]; dieAt[i] = dieAt[l]; cd[i] = cd[l]; col[i] = col[l]; role[i] = role[l];
      tx[i] = tx[l]; ty[i] = ty[l];
    }
  }

  // ----- fertile zones: fixed spots where food rains. One small "home" zone per colony, plus
  //       a few richer neutral zones in the middle that everybody fights over. -----
  const zones = [];
  for (let c = 1; c <= N; c++) zones.push([clamp(mem[c].x + (rnd() - 0.5) * 12, 6, W - 6), clamp(mem[c].y + (rnd() - 0.5) * 12, 6, H - 6), R.homeFood]);
  for (let k = 0; k < R.neutralZones; k++) zones.push([W * (0.2 + 0.6 * rnd()), H * (0.2 + 0.6 * rnd()), R.neutralFood]);
  function dropFood() {                             // called on a fixed timer; every zone rains every time
    for (const z of zones) {
      for (let k = 0; k < z[2]; k++) {
        let ox, oy;
        do { ox = rnd() * 2 - 1; oy = rnd() * 2 - 1; } while (ox * ox + oy * oy > 1);   // random point in a disc (seeded rnd = same on every device)
        const reach = R.foodRadius * (rnd() < R.stray ? 2 : 1);                          // some pieces land farther out = scattered
        const fx = Math.floor(z[0] + ox * reach), fy = Math.floor(z[1] + oy * reach);
        if (fx >= 0 && fx < W && fy >= 0 && fy < H) food[fy * W + fx] = 1;               // off the map: skip (no piling up on the border)
      }
    }
    for (let k = 0; k < R.ambient; k++) food[((rnd() * H) | 0) * W + ((rnd() * W) | 0)] = 1;   // sparse food everywhere
  }

  // ----- spatial hash: bucket agents by grid cell so neighbour queries are O(1) -----
  const cellStart = new Int32Array(GX * GY + 1), cursor = new Int32Array(GX * GY);
  const cellOf = new Int32Array(M), items = new Int32Array(M);
  function buildHash() {                            // counting sort, zero allocation
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const c = ((y[i] / R.cell) | 0) * GX + ((x[i] / R.cell) | 0);
      cellOf[i] = c; cellStart[c + 1]++;
    }
    for (let c = 0; c < GX * GY; c++) cellStart[c + 1] += cellStart[c];
    cursor.set(cellStart.subarray(0, GX * GY));
    for (let i = 0; i < n; i++) items[cursor[cellOf[i]]++] = i;
  }

  // ----- reinforcement: nudge a colony's preference after a success / failure -----
  function reward(c, key, amt) {
    const p = P[c];
    p.w[key] = clamp(p.w[key] + p.learn * amt, 0.2, 3);
  }

  // ----- decision making (runs for 1/4 of the agents every tick) -----
  function think(i, c, p) {
    const cx = x[i] | 0, cy = y[i] | 0;
    // 1) nearest food inside the vision box (bigger box = higher intelligence)
    let fx = 0, fy = 0, fd = 1e9;
    const x0 = Math.max(0, cx - p.look), x1 = Math.min(W - 1, cx + p.look);
    const y1 = Math.min(H - 1, cy + p.look);
    for (let yy = Math.max(0, cy - p.look); yy <= y1; yy++) {
      for (let xx = x0, row = yy * W; xx <= x1; xx++) {
        if (food[row + xx]) {
          const d = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy);
          if (d < fd) { fd = d; fx = xx + 0.5; fy = yy + 0.5; }
        }
      }
    }
    // 2) neighbours from the spatial hash
    let ex = 0, ey = 0, ed = 1e9, eo = 0;           // nearest foe
    let sx = 0, sy = 0, cnt = 0, rx = 0, ry = 0;    // friends: centroid + separation push
    const g = cellOf[i], gx = g % GX, gy = (g / GX) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = gy + oy; if (yy < 0 || yy >= GY) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox; if (xx < 0 || xx >= GX) continue;
        const cell = yy * GX + xx;
        for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
          const j = items[k]; if (j === i) continue;
          const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy, o = col[j];
          if (o === c || allied[c * S + o]) {       // friend (own colony or ally)
            sx += dx; sy += dy; cnt++;
            if (d2 < 2.25) { rx -= dx; ry -= dy; }
          } else if (d2 < ed) { ed = d2; ex = dx; ey = dy; eo = o; }
        }
      }
    }
    // 3) score the options: eat / hunt / flee
    const hunger = Math.max(0.1, 1 - en[i] / 120);
    const sFood = fd < 1e9 ? p.w.food * hunger / (1 + 0.15 * Math.sqrt(fd)) : 0;
    let sHunt = 0, sFlee = 0;
    if (eo) {
      const po = P[eo], dist = 1 + 0.15 * Math.sqrt(ed);
      const edge = p.atk - po.def * R.defK, danger = po.atk - p.def * R.defK;   // damage I deal vs. damage I take
      sHunt = p.w.hunt * p.aggr * Math.max(0, edge) / 10 / dist;
      sFlee = p.w.flee * Math.max(0, danger - edge) / 10 / dist;
    }
    // 4) build a steering direction
    let dx = 0, dy = 0, m, has = true;
    if (sFlee > sFood && sFlee > sHunt) { dx = -ex; dy = -ey; }
    else if (sHunt > sFood && sHunt > 0) { dx = ex; dy = ey; }
    else if (sFood > 0) { dx = fx - x[i]; dy = fy - y[i]; }
    else has = false;
    if (has) { m = Math.sqrt(dx * dx + dy * dy) || 1; dx /= m; dy /= m; }
    else if (role[i]) {                             // scout, nothing in sight: keep going straight
      m = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) || 1; dx = vx[i] / m; dy = vy[i] / m;
    } else {                                        // settler, nothing in sight: drift toward the remembered food area
      const mm = mem[c], k = 0.2 + 0.05 * p.look;
      dx = mm.x - x[i]; dy = mm.y - y[i]; m = Math.sqrt(dx * dx + dy * dy) || 1; dx = (dx / m) * k; dy = (dy / m) * k;
    }
    if (cnt && !role[i]) {                          // settlers flock: cohesion pulls toward friends
      const cm = Math.sqrt(sx * sx + sy * sy) || 1, k = 0.15 + 0.5 * p.bondRate;
      dx += (sx / cm) * k; dy += (sy / cm) * k;
    }
    if (rx || ry) { const rm = Math.sqrt(rx * rx + ry * ry); dx += (rx / rm) * 0.6; dy += (ry / rm) * 0.6; }
    dx += (rnd() - 0.5) * 0.5; dy += (rnd() - 0.5) * 0.5;   // wander noise
    m = Math.sqrt(dx * dx + dy * dy) || 1;
    tx[i] = dx / m; ty[i] = dy / m;                 // think only picks a heading; physics does the moving
  }

  // ----- fight or befriend every foreign agent within 2 cells -----
  function contacts(i, c, p) {
    const g = cellOf[i], gx = g % GX, gy = (g / GX) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = gy + oy; if (yy < 0 || yy >= GY) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox; if (xx < 0 || xx >= GX) continue;
        const cell = yy * GX + xx;
        for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
          const j = items[k], o = col[j];
          if (o === c || hp[j] <= 0 || allied[c * S + o]) continue;
          const dx = x[j] - x[i], dy = y[j] - y[i];
          if (dx * dx + dy * dy > 4) continue;
          if (rnd() < p.aggr) {                                       // ATTACK
            const dmg = (p.atk - P[o].def * R.defK) * (0.8 + 0.4 * rnd()) * R.dmgScale;
            if (dmg > 0) {
              hp[j] -= dmg;
              const t = o * S + c; trust[t] = Math.max(0, trust[t] - R.trustLoss);   // victim trusts attacker less
              reward(o, 'flee', 1);
              if (hp[j] <= 0) {                                       // kill: loot energy, learn to hunt
                en[i] = Math.min(R.energyCap, en[i] + R.killLoot * en[j]);
                kills[c]++; reward(c, 'hunt', 3);
              }
            }
          } else {                                                    // BEFRIEND
            const a = c * S + o;
            trust[a] = Math.min(R.bondAt * 1.5, trust[a] + p.bondRate * R.trustGain);
            if (trust[a] >= R.bondAt && trust[o * S + c] >= R.bondAt) allied[a] = allied[o * S + c] = 1;   // both sides trust -> alliance
          }
        }
      }
    }
  }

  // ----- initial colonies -----
  configs.forEach((cfg, k) => {
    const c = k + 1, m = mem[c];
    for (let q = 0; q < R.startAgents; q++) spawn(c, m.x + (rnd() - 0.5) * 8, m.y + (rnd() - 0.5) * 8, R.startEnergy);
  });

  // ============================ one simulation tick ============================
  const sim = {
    done: false, reason: '', W, H, N, owner, food, foodRadius: R.foodRadius, x, y, px, py, col,
    pop, terr, allied, zones, configs,
    get n() { return n; },
    get tick() { return tick; },
    get timeLeft() { return Math.max(0, (maxTicks - tick) / TPS); },

    step() {
      if (sim.done) return;
      const t = ++tick;
      px.set(x.subarray(0, n)); py.set(y.subarray(0, n));          // remember last positions for interpolation
      if (t % R.foodEvery === 0) dropFood();
      buildHash();
      const n0 = n;                                                 // newborns wait until next tick (not in the hash yet)

      // ---- physics: smooth steering (inertia) + soft-body collisions between ALL agents ----
      const bodyD2 = R.body * R.body;
      for (let i = 0; i < n0; i++) {
        const sp = P[col[i]].speed;
        vx[i] += (tx[i] * sp - vx[i]) * R.steer;    // accelerate toward the heading instead of snapping
        vy[i] += (ty[i] * sp - vy[i]) * R.steer;
        const g = cellOf[i], gx = g % GX, gy = (g / GX) | 0;
        for (let oy = -1; oy <= 1; oy++) {
          const yy = gy + oy; if (yy < 0 || yy >= GY) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = gx + ox; if (xx < 0 || xx >= GX) continue;
            const cell = yy * GX + xx;
            for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
              const j = items[k]; if (j === i) continue;
              const dx = x[i] - x[j], dy = y[i] - y[j], d2 = dx * dx + dy * dy;
              if (d2 >= bodyD2) continue;
              if (d2 < 1e-6) { vx[i] += (i & 1 ? 0.1 : -0.1); continue; }   // exactly overlapping: deterministic nudge
              const d = Math.sqrt(d2), f = (1 - d / R.body) * R.push / d;
              vx[i] += dx * f; vy[i] += dy * f;     // spring-like push apart (each agent pushes itself, so it's symmetric)
            }
          }
        }
        const v2 = vx[i] * vx[i] + vy[i] * vy[i], vm = sp * 1.8;
        if (v2 > vm * vm) { const s = vm / Math.sqrt(v2); vx[i] *= s; vy[i] *= s; }   // speed limit keeps it stable
      }

      for (let i = 0; i < n0; i++) {
        if (hp[i] <= 0) continue;                                   // killed earlier this tick
        const c = col[i], p = P[c];
        if (((t + i) & 3) === 0) think(i, c, p);                    // staggered thinking

        x[i] += vx[i]; y[i] += vy[i];                               // move + bounce off the walls
        if (x[i] < 0) { x[i] = 0; vx[i] = -vx[i]; tx[i] = -tx[i]; } else if (x[i] > W - 1.01) { x[i] = W - 1.01; vx[i] = -vx[i]; tx[i] = -tx[i]; }
        if (y[i] < 0) { y[i] = 0; vy[i] = -vy[i]; ty[i] = -ty[i]; } else if (y[i] > H - 1.01) { y[i] = H - 1.01; vy[i] = -vy[i]; ty[i] = -ty[i]; }

        const cell = (y[i] | 0) * W + (x[i] | 0);                   // paint the territory
        const prev = owner[cell];
        if (prev !== c) { terr[prev]--; terr[c]++; owner[cell] = c; }

        en[i] -= p.drain;                                           // metabolism
        if (hp[i] < p.maxHp) hp[i] += 0.02;                         // slow healing
        if (cd[i]) cd[i]--;

        if (food[cell]) {                                           // eat
          food[cell] = 0; en[i] = Math.min(R.energyCap, en[i] + p.eatGain); eaten[c]++;
          reward(c, 'food', 1);
          const m = mem[c]; m.x += (x[i] - m.x) * 0.05; m.y += (y[i] - m.y) * 0.05;   // running average of food spots
        }

        contacts(i, c, p);                                          // fight or befriend

        if (en[i] > p.reproAt && cd[i] === 0 && hp[i] > 0) {        // reproduce
          en[i] *= 0.5; cd[i] = R.reproCooldown;
          spawn(c, x[i] + (rnd() - 0.5) * 2, y[i] + (rnd() - 0.5) * 2, en[i]);
        }
      }

      for (let i = n - 1; i >= 0; i--) {                            // cull: starved, wounded, or old age
        if (hp[i] <= 0 || en[i] <= 0 || t >= dieAt[i]) { dead[col[i]]++; removeAt(i); }
      }

      if (t % TPS === 0) for (let c = 1; c <= N; c++) {             // preferences slowly drift back to neutral
        const w = P[c].w; w.food += (1 - w.food) * 0.02; w.hunt += (0.6 - w.hunt) * 0.02; w.flee += (0.6 - w.flee) * 0.02;
      }

      if (t >= maxTicks) { sim.done = true; sim.reason = 'time'; }
      else if (t > TPS * 3) {
        let alive = 0; for (let c = 1; c <= N; c++) if (pop[c] > 0) alive++;
        if (alive <= 1) { sim.done = true; sim.reason = alive ? 'last' : 'extinct'; }
      }
    },

    // cheap fingerprint of the world: equal fingerprints = no desync
    checksum() {
      let h = n | 0;
      for (let i = 0; i < n; i++) h = (Math.imul(h, 31) + ((x[i] * 64) | 0) + ((y[i] * 64) | 0) + (en[i] | 0)) | 0;
      return h >>> 0;
    },

    // live stat change: swap in new derived numbers, keep the colony's learned preferences.
    // Existing agents pick it up next tick; their lifespan stays as spawned, newborns use the new one.
    retune(c, stats) {
      if (c < 1 || c > N || !validStats(stats)) return;
      const p = derive(stats);
      p.w = P[c].w;
      P[c] = p;
    },

    getResults() {
      const rows = configs.map((cfg, k) => {
        const c = k + 1;
        let allies = 0, bsum = 0;
        for (let o = 1; o <= N; o++) {
          if (o === c) continue;
          if (allied[c * S + o]) allies++;
          bsum += Math.min(1, (trust[c * S + o] + trust[o * S + c]) / (2 * R.bondAt));
        }
        const bonding = N > 1 ? (bsum / (N - 1)) * 100 : 0;
        const territory = (terr[c] / (W * H)) * 100;
        return {
          name: cfg.name, color: c, territory, population: pop[c], peak: peak[c], kills: kills[c],
          eaten: eaten[c], born: born[c], died: dead[c], allies, bonding,
          score: territory + pop[c] * 0.05 + kills[c] * 0.2 + allies * 3 + bonding * 0.05,
        };
      }).sort((a, b) => b.score - a.score);

      const alive = rows.filter(r => r.population > 0);
      let outcome;
      if (alive.length === 0) outcome = 'Total extinction: nobody survived';
      else if (alive.length === 1) outcome = `${alive[0].name} is the last colony standing`;
      else if (alive.every(a => alive.every(b => a === b || allied[a.color * S + b.color]))) outcome = 'Peaceful coexistence: all survivors are allies';
      else outcome = `${alive.length} colonies survive in a divided world`;
      return { outcome, rows, reason: sim.reason, ticks: tick };
    },
  };
  return sim;
}