# Rule Wars: Developer Documentation

Multiplayer colony-war sandbox. Each player spends exactly **100 points** on 7 stats, drops a **seed** on the map, and the colonies fight, breed, ally and paint territory on a shared 2D grid for 3 minutes. The final map is a "territory painting"; the results screen ranks colonies.

- Stack: **Node.js** (server) + **plain browser JavaScript** (no framework, no build step) + **Canvas 2D**.
- One runtime dependency: `ws` (WebSocket library).
- Files: `package.json`, `server.js`, `test.js`, `public/index.html`, `public/main.js`, `public/render.js`, `public/sim.js`.

---

## 1. Install and run

### 1.1 One-time setup
1. Install **Node.js 18.11 or newer** (20 or 22 recommended) from https://nodejs.org (LTS button). Check: `node -v`.
2. Unzip the project and open a terminal inside the `rule-wars` folder.
3. Install the one dependency:
   ```bash
   npm install
   ```

### 1.2 Run
```bash
npm start          # start the server
npm run dev        # same, but restarts when server.js changes
npm test           # headless tests + balance report (no browser needed)
```
The console prints:
```
this computer : http://localhost:3000
on your Wi-Fi : http://192.168.x.x:3000   (open this on your phone)
```

### 1.3 Play
1. Open `http://localhost:3000`, type a name, choose room size, **Create room**.
2. Others open the Wi-Fi address (or the invite link from **Copy invite link**) and enter the 4-letter code.
3. Everyone picks a preset or drags sliders until **ready ✓** shows (all 100 points spent), taps the map to drop their seed, and presses **Ready**.
4. The host presses **Start game** (needs 2+ ready players).

Change the port: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`).

### 1.4 Test on a real phone
- Phone and laptop must be on the **same Wi-Fi**. Open the "on your Wi-Fi" address in the phone browser.
- If it will not load: allow Node through the laptop firewall (Windows asks the first time), and make sure the Wi-Fi does not isolate clients (some college/guest networks do; use a phone hotspot instead).
- `navigator.clipboard` only works on https or localhost, so on `http://192.168...` "Copy invite link" falls back to a copy prompt. That is expected.

### 1.5 Put it online (for the demo)
WebSockets need a real running Node process, so **not** Vercel/Netlify static hosting.
- **Render / Railway / Fly.io**: push the folder to GitHub, create a *Web Service*, build command `npm install`, start command `npm start`. They set `PORT` for you and give you `https://`; the client automatically switches to `wss://`.
- Free tiers sleep when idle: open the site 2-3 minutes before presenting.
- No-deploy alternative: run locally and expose it with a tunnel (`npx localtunnel --port 3000`, or ngrok).

The included `.gitignore` already excludes `node_modules`.

---

## 2. Architecture in one picture

```
 Browser A (host)            Server (server.js)             Browser B
 ┌──────────────┐  create    ┌───────────────────┐  join    ┌──────────────┐
 │ main.js  UI  │──────────▶│ rooms Map          │◀─────────│ main.js  UI  │
 │ sim.js       │  config    │  code, capacity    │  config  │ sim.js       │
 │ render.js    │──────────▶│  players[stats,    │◀─────────│ render.js    │
 └──────┬───────┘  start     │          spawn]    │          └──────┬───────┘
        │                    └─────────┬─────────┘                  │
        │        { seed, configs }  ◀──┴──▶  { seed, configs }      │
        ▼                                                           ▼
   createSim(configs, seed)  ===  identical match  ===  createSim(configs, seed)
```

**The key idea (deterministic lockstep):** the server never simulates and never sends positions. It sends **one message** at game start: a random `seed` and every player's `configs`. Every browser runs `createSim(configs, seed)` locally. Same inputs + deterministic code = the same world on every device, so there is **zero network traffic during the match**. That is why the network cannot make it lag, and why a dropped connection does not stop a running match.

Two consequences you must respect (section 4.12):
1. The sim must never call `Math.random()`, `Date.now()` or anything environment-dependent.
2. Ticks are never skipped. A slow phone runs the match slower but reaches the identical result.

---

## 3. File map

| File | Runs in | Job |
|---|---|---|
| `public/sim.js` | browser + Node | The whole game world: stats, agents, food, combat, alliances, scoring |
| `public/render.js` | browser | Draws a sim fast (pixel buffer + batched squares) |
| `public/main.js` | browser | Screens, WebSocket client, stat form, seed picker, game loop, HUD, results |
| `public/index.html` | browser | Markup + all CSS (4 screens, rotate overlay) |
| `server.js` | Node | Static file server + room manager over WebSocket |
| `test.js` | Node | Rule checks, determinism check, balance report, speed check |
| `package.json` | npm | Scripts + `ws` dependency; `"type": "module"` enables `import` in Node |

Dependency direction: `main.js → sim.js, render.js`; `render.js → sim.js`; `server.js → sim.js`; `test.js → sim.js`. **`sim.js` imports nothing**, which is what lets it run everywhere.

---

## 4. `public/sim.js` (the game)

### 4.1 Constants and the `R` knob object
```js
export const W = 256, H = 144;     // world grid (cells), 16:9
export const TPS = 30;             // ticks per second
export const GAME_SECONDS = 180;
export const MAX_TICKS = TPS * GAME_SECONDS;   // 5400
export const BUDGET = 100, STAT_MAX = 40;
```
These are `export`ed because `main.js`, `server.js` and `test.js` need the same numbers. Change `W/H` and the renderer, seed picker and spatial hash adapt automatically.

`const R = {...}` holds the **balance knobs** (not exported). Section 12 lists what each does.

### 4.2 `mulberry32(seed)`: the seeded random generator
```js
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```
- Returns a **function** (closure) that remembers `a`. Each call advances the state and returns a float in `[0,1)` like `Math.random()`, but the whole sequence is decided by the seed.
- `|0` forces 32-bit integers; `Math.imul` is exact 32-bit multiplication (plain `*` would lose bits); `>>> 0` makes it unsigned; `/ 4294967296` (2^32) maps it into `[0,1)`.
- Integer-only maths, so it is bit-identical in Chrome, Safari, Firefox and Node.

### 4.3 Stats → game numbers
```js
const eff = s => s / (s + 16);
```
**Diminishing returns:** 0 points → 0, 16 points → 0.5, 40 points → 0.71. The 40th point is worth far less than the 4th, so no stat can give unlimited power.

`validStats(s)` is the **point-budget rule**: all 7 stats are integers `0..40` and the total is **exactly 100**. The server uses it to reject cheating, `test.js` tests it, and the UI enforces the same rule with sliders.

`derive(stats)` converts points into what the sim uses:

| Stat | Derived value | Effect |
|---|---|---|
| `atk` | `atk = 3 + 9·eff` | damage before defense; also raises upkeep (`0.16·eff`) and aggression |
| `def` | `def = 1 + 9·eff`, `maxHp = 20 + 40·eff`, `life = 30·(35 + 45·eff)` ticks | armor, health, **lifespan** |
| `spd` | `speed = 0.42 + 0.45·eff` cells/tick | movement; upkeep grows with **speed²** (`0.25·speed²`) |
| `intel` | `look = 4 + round(5·eff)` cells, `learn = 0.004 + 0.03·eff` | vision radius and reinforcement learning rate; upkeep `0.04·eff` |
| `repro` | `reproAt = 105 − 45·eff` | energy needed to split (lower = breeds sooner) |
| `eat` | `eatGain = 30 + 30·eff` | energy per food |
| `bond` | `bondRate = eff` | trust gained per friendly contact, flocking strength |
| atk + bond | `aggr = (a + 0.1) / (a + b + 0.2)` | probability of attacking (vs befriending) on contact |

`drain = 0.035 + 0.25·speed² + 0.16·a + 0.04·i` is the **upkeep**: energy lost every tick. Fast, strong or clever colonies starve faster, which is what makes "maximum everything" a losing idea (section 10).

### 4.4 Data layout: struct-of-arrays
```js
const x = new Float32Array(M), y = new Float32Array(M);   // position
const en = new Float32Array(M), hp = new Float32Array(M); // energy, health
const col = new Uint8Array(M);                            // colony id (1..N)
let n = 0;                                                // live agents are indices 0..n-1
```
Instead of an array of `{x, y, energy}` objects there is **one typed array per property**, indexed by agent number `i`.
- No object allocation → no garbage-collector pauses (the #1 cause of random stutter).
- Contiguous memory → the CPU cache works well → thousands of agents cost microseconds.
- `px, py` hold the **previous tick's position** for smooth drawing (section 5).
- `role[i]`: `1` = scout (explores in straight lines), `0` = settler (flocks, returns to remembered food).

`spawn(c, x, y, energy)` appends at index `n++`. It returns early if the global array (`M = 3000`) or the colony cap (`popCap`, `R.popCap` divided by the number of colonies) is full. It uses `rnd()` for the starting velocity, the scout role, and a ±10% lifespan variation so deaths are staggered.

`removeAt(i)` is a **swap-remove**: copy the last agent into slot `i`, then `n--`. O(1), keeps arrays dense. The cull loop runs from `n-1` **down to 0**: the element moved into `i` came from above `i`, where we already looked, so nothing is skipped.

### 4.5 World layers
```js
const owner = new Uint8Array(W * H);  // colony that last stepped here
const glow  = new Uint8Array(W * H);  // 255 when freshly walked, fades to 0
const food  = new Uint8Array(W * H);  // 1 = food on this cell
```
Cell index = `y * W + x`. `owner` **is** the territory painting; `glow` is the bright fading trail. The territory counter is kept incrementally so the HUD is O(1):
```js
const prev = owner[cell];
if (prev !== c) { terr[prev]--; terr[c]++; owner[cell] = c; }
```
`terr[0]` starts at `W*H` (everything unowned).

### 4.6 Food: fertile zones
- One small **home zone** per colony near its seed (`R.homeFood` pieces per rain) and `R.neutralZones` richer **neutral zones** in the middle (`R.neutralFood`). Positions are fixed and derived from the seed.
- Every `R.foodEvery` ticks (45 = 1.5 s) each zone rains with probability `R.rainChance`, plus `R.ambient` random pieces anywhere.
- Fixed zones make the map **learnable** (that is what the colony memory exploits) and create permanent battlegrounds, which produces the repeating patterns.

Random point in a disc:
```js
do { ox = rnd() * 2 - 1; oy = rnd() * 2 - 1; } while (ox * ox + oy * oy > 1);
```
Pick a point in the square `[-1,1]²` and retry until it lands inside the unit circle (rejection sampling). This avoids `Math.sin/cos`, which can differ in the last bit between browsers and would break determinism.

### 4.7 Spatial hash (what makes it fast)
Without it, "who is near me?" checks every agent against every agent: 1000 agents = 1,000,000 checks per tick. With it, each agent only looks at the 3×3 buckets around it.
```js
function buildHash() {
  cellStart.fill(0);
  for (let i = 0; i < n; i++) {
    const c = ((y[i] / R.cell) | 0) * GX + ((x[i] / R.cell) | 0);  // which 8x8 bucket
    cellOf[i] = c; cellStart[c + 1]++;                                // count agents per bucket
  }
  for (let c = 0; c < GX * GY; c++) cellStart[c + 1] += cellStart[c]; // prefix sum -> start offsets
  cursor.set(cellStart.subarray(0, GX * GY));
  for (let i = 0; i < n; i++) items[cursor[cellOf[i]]++] = i;         // drop agent ids into place
}
```
This is a **counting sort**: pass 1 counts agents per bucket; the prefix sum turns counts into "bucket b starts at offset `cellStart[b]`"; pass 3 writes agent ids so `items[cellStart[b] .. cellStart[b+1]-1]` are exactly the agents in bucket `b`. No allocation, three linear passes. To visit a bucket: `for (k = cellStart[cell]; k < cellStart[cell+1]; k++) j = items[k]`.

It is built **once at the start of the tick**, so positions in it are one move old (fine). Newborns (index ≥ `n0`) are not in it, so the main loop runs `i < n0` and newborns start acting next tick.

### 4.8 `think(i, c, p)`: how an agent decides
Runs for 1/4 of agents each tick: `if (((t + i) & 3) === 0)`. `(t+i)&3` is `(t+i) mod 4`, so every agent thinks every 4th tick, on different ticks than its neighbours. This **staggering** cuts AI cost 4× with no visible change because velocity persists between decisions.

1. **Nearest food** in a `(2·look+1)²` box. Bigger `look` (intelligence) sees farther. Squared distances only (no `sqrt`), since we just compare.
2. **Neighbours** from the hash (3×3 buckets). Each is a *friend* (`o === c || allied[c*S+o]`) or a *foe*. Friends feed `sx,sy` (sum of offsets → direction to the group) and `rx,ry` (push away from friends closer than 1.5 cells). The nearest foe is remembered.
3. **Score the options:**
   ```
   hunger = max(0.1, 1 - energy/120)
   sFood  = w.food * hunger / (1 + 0.15*dist_to_food)
   edge   = my.atk - their.def*defK        // damage I would deal
   danger = their.atk - my.def*defK        // damage I would take
   sHunt  = w.hunt * aggr * max(0, edge)  / 10 / (1 + 0.15*dist)
   sFlee  = w.flee * max(0, danger - edge) / 10 / (1 + 0.15*dist)
   ```
   Scores fall with distance. Hungry agents want food; strong, aggressive ones hunt; agents that would lose a fight flee. `w.*` are the **learned weights**. The highest score wins.
4. **Steering:** the winner becomes a unit vector. With nothing in sight a *scout* keeps its heading and a *settler* drifts toward `mem[c]` (remembered food area). Then cohesion (`(sx/|s|) · (0.15 + 0.5·bondRate)`), separation (normalised `rx,ry` × 0.6) and wander noise `±0.25` are added, and:
   ```js
   vx[i] = vx[i] * 0.4 + (dx / m) * p.speed * 0.6;
   ```
   40% old velocity + 60% new direction = inertia, so agents turn smoothly instead of jittering.

**The "intelligence" (no ML):**
- *Reinforcement:* `reward(c, key, amt)` does `w[key] += learn·amt` (clamped `0.2..3`). Eating → `food +1`, killing → `hunt +3`, being hurt → `flee +1`. Every second the weights drift 2% back toward neutral so the colony keeps adapting. Higher `intel` → larger `learn`.
- *Running average (line-fitting-style memory):* on every meal `mem.x += (x - mem.x) * 0.05`, an exponential moving average of where food was eaten.

### 4.9 `contacts(i, c, p)`: fight or befriend
For every foreign, living, non-allied agent within 2 cells (`dx*dx+dy*dy > 4` is skipped):
```js
if (rnd() < p.aggr) {                // ATTACK
  dmg = (p.atk - P[o].def * defK) * (0.8 + 0.4*rnd()) * dmgScale;
  if (dmg > 0) { hp[j] -= dmg; trust[o*S+c] -= trustLoss; ... }   // victim trusts attacker less
} else {                             // BEFRIEND
  trust[c*S+o] += p.bondRate * trustGain;
  if (trust[c*S+o] >= bondAt && trust[o*S+c] >= bondAt) allied both ways;
}
```
- **Damage uses a difference**, `atk − def·defK`, randomised ±20%. If defense beats attack, `dmg ≤ 0`: nothing happens and no trust is lost. That is why a **stalemate leads to peace**.
- `trust[a*S+b]` = how much colony `a` trusts `b` (flat `Float32Array`, `S = N+1`). Befriending raises *your* trust in them; being damaged lowers *your* trust in the attacker. **An alliance needs both directions ≥ `bondAt`** (40). Allies never fight and count as friends for flocking, which mixes colours in the painting.
- A kill (`hp ≤ 0`) loots `killLoot` of the victim's energy and rewards `hunt`. Dead agents stay in the arrays until the cull pass; `hp[j] <= 0` targets are skipped so each kill is counted once.

### 4.10 `sim.step()`: order of one tick
1. `tick++`; copy `x,y` → `px,py`.
2. Every `foodEvery` ticks: `dropFood()`.
3. `buildHash()`.
4. For each agent `i < n0`: skip if dead → `think` (staggered) → move and bounce off walls → paint `owner/glow` → pay upkeep, heal +0.02, cooldown → eat → `contacts` → reproduce if `energy > reproAt && cooldown == 0` (energy halves; the child gets the other half).
5. Cull (descending): remove `hp ≤ 0`, `energy ≤ 0`, or `tick ≥ dieAt[i]` (old age).
6. Every 6 ticks fade `glow` by 4 (a trail lasts ≈ 13 s); every second drift the learned weights toward neutral.
7. End checks: `tick ≥ MAX_TICKS` → `'time'`; after 3 s, if ≤ 1 colony has population → `'last'` or `'extinct'`.

Bounce uses `W - 1.01` (not `W`) so `(x|0)` can never equal `W`, which would index outside the array.

### 4.11 Results, score, checksum
`getResults()` returns `{ outcome, rows, reason, ticks }`; per colony: territory %, population, peak, kills, eaten, born, died, allies, bonding.
- **Bonding %** = average over other colonies of `min(1, (trust_ab + trust_ba) / (2·bondAt))`.
- **Score** = `territory% + 0.05·population + 0.2·kills + 3·allies + 0.05·bonding`. Change the formula in this one place to change what "winning" means.
- **Outcome text:** nobody alive = extinction; one alive = last standing; all survivors mutually allied = peaceful coexistence; otherwise a divided world.

`checksum()` hashes all positions/energies into one number. Two clients with different checksums at the same tick have **desynced**. `test.js` uses it to prove determinism.

### 4.12 Determinism rules (do not break these)
- Only `rnd()` for randomness, never `Math.random()`.
- No `Date`, `performance.now()`, `window`, DOM or network inside `sim.js`.
- Iterate in index order; call `rnd()` in the same order on every client.
- Avoid `Math.sin/cos/exp/pow/hypot` in the sim (not guaranteed bit-identical across engines). `+ - * /`, `Math.sqrt`, `floor/round/min/max` are safe. (`render.js` uses `Math.hypot`; that is fine because rendering never feeds back into the sim.)
- Never skip ticks to catch up (the game loop only slows down).
- If you add a feature and clients disagree, log `sim.checksum()` every 100 ticks on both to find the first tick where they diverge.

---

## 5. `public/render.js` (the lag-free part)

Goal: per-frame cost almost independent of agent count.

**1. The world is one tiny bitmap.**
```js
const img = lctx.createImageData(W, H);
const buf = new Uint32Array(img.data.buffer);   // same memory, 1 number = 1 pixel
```
`img.data` is RGBA bytes (4 per pixel). A `Uint32Array` over the same buffer lets us write a pixel with **one store** instead of four. The 256×144 bitmap goes up with a single `putImageData`, then one `drawImage` scales it to the screen on the GPU (`imageSmoothingEnabled = false` keeps pixels crisp).

**2. Lookup table instead of colour maths.**
```js
lut[(c << 8) | glow] = pack(...)    // built once
buf[i] = food[i] ? FOOD_PX : o ? lut[(o << 8) | glow[i]] : bg[i];
```
`(o << 8) | glow` combines colony (high bits) and trail brightness (0-255) into one index: one read, one write per pixel. `pack(r,g,b)` returns `0xAABBGGRR`, which a little-endian `Uint32` stores as bytes `R,G,B,A` (all current devices are little-endian).

**3. Batch the agents.** One `beginPath()`, many `rect()` with integer coordinates, one `fill()` per colony. Style changes are expensive, shapes are cheap. No `arc()`, no `shadowBlur`, no per-agent `save/restore`.

**4. Interpolation.** The sim ticks 30×/s but screens refresh 60-120×/s.
```js
const ix = px[i] + (x[i] - px[i]) * alpha;
```
`alpha` (0..1) is how far we are between the last two ticks, so motion is smooth at any refresh rate without simulating more.

**5. Sizing.** `devicePixelRatio` is capped at 2. `ResizeObserver` re-fits on window/orientation change; the world is letterboxed to keep 16:9 via `scale = Math.min(cw / W, ch / H)`. Setting `canvas.width` resets the context, so `imageSmoothingEnabled` is re-applied inside `resize()`.

`bg` is a one-time background with a soft glow around each fertile zone. `paintingURL()` builds a 4× PNG from `owner` only (no agents, steady trail brightness) for the results screen and the download button.

---

## 6. `public/main.js` (UI + loop)

### 6.1 Screens
`show(name)` toggles the `hidden` attribute on `#home`, `#room`, `#game`, `#results`; the variable `screen` is read by the WebSocket close handler and `showResults`.

### 6.2 WebSocket client
`connect(firstMessage)` opens `ws(s)://<same host>` and on `open` sends the first message (`create` or `join`). Protocol: section 7.2. `onclose` depends on the screen: during a match it only shows a toast (the sim is local so the match continues); otherwise it returns to home.

### 6.3 Stat form with a hard budget
```js
const room = BUDGET - (spent() - stats[k]);   // points available if THIS stat were 0
setStat(k, Math.min(+e.target.value, room));  // slider cannot exceed what is left
```
`spent()` sums all stats; subtracting the current stat gives what the others use. The slider you drag simply stops when the budget runs out. **Ready** is disabled unless the total is exactly 100. Presets overwrite all seven values.

### 6.4 Seed picker
A 512×288 canvas drawn at 2× the world grid (`k = canvas.width / W`). Pointer events cover mouse and touch; CSS `touch-action: none` stops the page scrolling while you drag. Coordinates are stored **normalised** (`0.05..0.95`), so they are resolution independent; the sim multiplies by `W`/`H`. Your own pick is local until you press Ready; other players' picks arrive in the lobby message.

### 6.5 Game loop (fixed timestep + accumulator)
```js
acc += Math.min(now - last, 100) * speed; last = now;
while (acc >= TICK_MS && steps < MAX_STEPS && !sim.done) { sim.step(); acc -= TICK_MS; steps++; }
if (steps === MAX_STEPS) acc = 0;
renderer.draw(Math.min(1, acc / TICK_MS));
```
- `requestAnimationFrame` calls `frame` at the display rate. `acc` banks elapsed milliseconds; each `TICK_MS` (33.3 ms) buys one `sim.step()`. This **decouples simulation rate from frame rate**: a 120 Hz phone and a 30 FPS laptop both run exactly 30 ticks per real second.
- `Math.min(now - last, 100)`: after a 10 s tab sleep we do not try to simulate 300 ticks at once.
- `MAX_STEPS = 4`: if a device cannot keep up it runs slower instead of freezing in a catch-up spiral (`acc = 0` drops the backlog). Ticks are not skipped, so the result is unchanged.
- The leftover `acc / TICK_MS` is the interpolation `alpha` for the renderer.
- `speed` (1×/2×/4×) multiplies banked time. Local only; results unaffected.
- `paused` freezes the loop while a phone is in portrait.

### 6.6 HUD and results
`updateHud()` runs every 250 ms (DOM writes are slow; never per frame). When `sim.done`, a banner shows for 1.6 s, then `showResults()` builds the table with `textContent` (never `innerHTML`, so a player named `<script>` is harmless), shows the painting, and shows **Rematch** only to the host.

---

## 7. `server.js`

### 7.1 Structure
1. **Static server:** `http.createServer` serves `public/`. `path.normalize` plus the `startsWith(PUBLIC + path.sep)` check blocks `../` path traversal. `/health` returns `ok` for hosting platforms. `Cache-Control: no-cache` so edits show immediately.
2. **WebSocket** on the *same* HTTP server (`new WebSocketServer({ server })`): one port for both. `maxPayload: 4096` rejects huge messages.
3. **Rooms:** `rooms` is a `Map<code, room>`; `room = { code, capacity, started, players[] }`; `player = { slot, name, ws, host, stats, spawn }`. `slot` (1-6) is the colour; a joiner gets the lowest free slot.
4. **Per-connection state** lives in the closure variables `room` and `me` inside `wss.on('connection')`, so each socket knows who it is without a lookup.
5. **Heartbeat:** every 30 s the server pings; a socket that has not answered since the last round is `terminate()`d (phones that lost signal).

The server **validates everything:** room size is clamped to `2..MAX_PLAYERS`, stats must pass `validStats`, spawn must be inside `0.05..0.95`, names are trimmed to 16 characters, and only the 7 known stat keys are copied.

### 7.2 Message protocol (JSON text frames)
| Direction | `type` | Fields | Meaning |
|---|---|---|---|
| client → server | `create` | `name, capacity` | new room; sender becomes host (slot 1) |
| client → server | `join` | `name, code` | enter a room (fails if full/started/unknown) |
| client → server | `config` | `stats, spawn` | set/update my colony; marks me ready |
| client → server | `start` | none | host only; needs ≥ 2 ready |
| client → server | `reset` | none | host only; rematch → back to lobby |
| server → client | `lobby` | `code, capacity, you, players[{slot,name,host,ready,spawn}]` | full room state, sent on every change |
| server → client | `start` | `seed, configs[{name,slot,stats,spawn}], you` | begin the match; `you` = your colony id (0 = spectator) |
| server → client | `error` | `msg` | shown as a toast |

`configs` are sorted by slot; **index in `configs` + 1 = colony id** inside the sim, while `slot` only chooses the colour (`palette[k+1] = COLORS[configs[k].slot]`). Players who are not ready at `start` are excluded and watch as spectators. The server uses `Math.random()` only to make the seed, which is fine because it is outside the sim. If the host leaves, `room.players[0].host = true` promotes the next player; an empty room is deleted.

---

## 8. `public/index.html`

- One page, four screen blocks toggled by `hidden`. `[hidden]{display:none!important}` is required because `display:flex/grid` on a class would otherwise override the attribute.
- **Rotate overlay:** `@media (orientation: portrait) and (max-width: 900px) { #rotate { display:flex } }` covers everything with a "rotate your phone" message; `main.js` pauses the loop using the same query via `matchMedia(...).addEventListener('change')`. The width limit stops tall desktop windows from triggering it. (Locking orientation from JS is unreliable on iOS, so we ask the user.)
- **Safe areas:** `viewport-fit=cover` + `env(safe-area-inset-*)` keeps the HUD out from under notches.
- `100dvh` avoids the mobile address-bar jump that `100vh` causes.
- `@media (max-height: 500px)` compacts the room screen for short landscape phones.

---

## 9. `test.js`

`npm test` needs no browser or server (it imports `sim.js` directly).
1. **Budget rule:** valid accepted; over-budget, under-budget and over-cap rejected.
2. **Determinism:** same configs + seed → identical `checksum()` after 1500 ticks; a different seed → different.
3. **Balance report** (6 seeds per scenario): how many matches end last-standing / peace / divided / extinct, mean territory per colony, mean alliances, peak population, ms per tick.
4. **Speed:** a 6-colony match must average under 6 ms per tick.
The exit code is non-zero on failure (usable in CI).

---

## 10. Your original doubt: "what if everybody maxes (or mins) everything?"

It cannot happen, by design, and every extreme still produces a game:

1. **Fixed budget.** Exactly 100 points over 7 stats, max 40 each. All-max is impossible, and spending less than 100 is rejected, so all-minimum is impossible too. Everyone has equal total power; only the *spread* differs.
2. **Upkeep.** Speed, attack and intelligence raise energy drain every tick; extremes burn out.
3. **Relative combat.** Damage is `atk − def·0.9`, a *difference*. If everyone is aggressive they hurt each other equally (mutual destruction, maybe one survivor). If everyone is defensive, attacks do ~0 damage, nobody loses trust, and they **ally** (stalemate → coexistence).
4. **Diminishing returns** (`s/(s+16)`).
5. **Thresholds** create behaviour: split at `reproAt`, attack with probability `aggr`, ally when trust ≥ 40 on both sides.

What `npm test` shows for 4 identical colonies: all-in attack → war (divided world, occasionally one winner); all-in defense and all-in bonding → peaceful coexistence; all-in speed → scattered divided world; identical balanced builds → war with random winners. Time limit + lifespans + food pacing always end the match.

---

## 11. Performance cheat sheet

| Technique | Where | Saves |
|---|---|---|
| Typed arrays (struct-of-arrays), no allocation in loops | `sim.js` | GC stutter |
| Spatial hash (counting sort) | `buildHash` | O(n²) → O(n) |
| Staggered AI (1/4 of agents per tick) | `step` | 75% of decision cost |
| Population caps | `R.popCap`, `R.maxAgents` | bounded worst case |
| Fixed timestep + accumulator + `MAX_STEPS` | `frame` | frame-rate independence, no spiral |
| One `putImageData` for the whole world | `render.js` | thousands of draw calls |
| Colour lookup table | `lut` | per-pixel maths |
| Batched `rect` + one `fill` per colony | `draw` | state changes |
| Interpolation | `draw(alpha)` | smooth at 60-120 Hz with 30 ticks |
| DPR cap at 2 | `resize` | fill rate on phones |
| HUD every 250 ms via `textContent` | `updateHud` | layout thrash |
| No network during the match | lockstep | latency |

Measured in headless Node: roughly 0.2-0.5 ms per tick on average with 4-6 colonies and 450-800 agents; the budget is 33 ms per tick.

**If it lags on a device:** (1) Chrome DevTools → Performance → record 5 s and see whether `step` or `draw` is the wide bar. (2) `step` slow: lower `R.popCap` / `R.maxAgents`, or make `think` run every 8th tick. (3) `draw` slow: shrink `W,H` (e.g. 192×108) or cap DPR at 1.5. (4) Last resort: move `sim` into a Web Worker and post typed arrays back as transferables.

---

## 12. Tuning guide (all in `sim.js`)

| Knob | Where | Raise it and... |
|---|---|---|
| `R.homeFood`, `R.neutralFood`, `R.rainChance`, `R.ambient` | `R` | more food → bigger populations, less conflict |
| `R.foodEvery` | `R` | food rain interval (ticks) |
| `R.popCap`, `R.maxAgents` | `R` | more agents (and CPU) |
| `R.scouts` | `R` | more explorers → web-like trails, faster contact |
| `R.dmgScale`, `R.defK` | `R` | more lethal / defense cancels more attack |
| `R.bondAt`, `R.trustGain`, `R.trustLoss` | `R` | harder/easier alliances |
| `R.killLoot` | `R` | snowballing for winners |
| formulas in `derive()` | top | shape of each stat's benefit and cost |
| `GAME_SECONDS`, `TPS` | top | match length / sim resolution |
| score formula | `getResults` | what "winning" means |

Workflow: edit a number, run `npm test`, read the balance table, repeat. It takes seconds and needs no browser.

**Known balance note:** in a 5-player free-for-all of the five UI presets, *Warrior* tends to dominate and *Turtle / Breeder / Diplomat* tend to be squeezed out (fast scouts paint more cells and reach the neutral zones first). In 2-4 player matches and in the `npm test` scenario table the game is far more even. This is the first thing to tune in your balancing slot: try a larger `speed²` upkeep, a lower `R.scouts`, or a healing/lifespan bonus for defense.

---

## 13. What was and was not tested

Tested here:
- `npm test` on the final code: all checks pass (budget rule, determinism, speed under 6 ms/tick).
- A real server plus **two real headless Chrome clients** (one desktop 1280×720, one phone-landscape 844×390): create room → join by code → presets → ready → host start → run at 4× → both reach the results screen with **identical result tables** → host rematch returns both to the lobby → resizing to portrait shows the rotate overlay.
- No JavaScript errors in the console during that run. (This browser run happened just before the last balance tweaks, which only changed numbers in `sim.js`; re-run a quick two-device match after you tune.)

**Not** tested: a physical phone or iOS Safari, more than 2 browsers at once, hosting on Render/Railway, long idle reconnects. Do a quick real-phone run early (section 1.4).

---

## 14. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find package 'ws'` | run `npm install` in the project folder |
| `Cannot use import statement` | `package.json` must have `"type": "module"` (it does) and Node ≥ 18 |
| Phone cannot open the Wi-Fi address | same Wi-Fi? firewall? try a phone hotspot; check the printed IP |
| "Cannot reach the server" toast | server not running, or page opened from `file://` (it must be served by `npm start`) |
| Works locally, not online | the host must support WebSockets (Render/Railway/Fly, not static hosts) |
| Rotate message stays on desktop | window is narrower than 900 px **and** taller than wide; widen it |
| Two players see different results | something non-deterministic entered `sim.js` (section 4.12); compare `checksum()` |
| Stutter on an old phone | see section 11 "if it lags" |

---

## 15. Limits and ideas

- Alliances are permanent and pairwise (no betrayal, no chains). Easy extension: let `trust` decay each second and break `allied` below a lower threshold.
- No reconnect: a player who refreshes in the lobby gets a new slot; mid-match nothing is lost until they reload the page.
- Spectators (not ready at start) cannot join later. No chat, no sound.
- Ideas: terrain obstacles (a `wall` layer checked in the move step), mutations (jitter `derive()` output per child), a live territory minimap, match replay (store `seed` + `configs`; the match is perfectly replayable because it is deterministic).
