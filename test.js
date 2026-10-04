// ============================================================================
// test.js : headless checks, no browser needed.   Run:  npm test
//   1. point-budget rule      2. determinism (same seed => same world)
//   3. balance scenarios      4. speed (ms per tick at peak population)
// ============================================================================
import { createSim, validStats, STATS, BUDGET } from './public/sim.js';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };

// build a stats object from a partial spec; the rest of the budget is spread evenly
function stats(spec) {
  const s = Object.fromEntries(STATS.map(k => [k, 0]));
  let left = BUDGET;
  for (const [k, v] of Object.entries(spec)) { s[k] = v; left -= v; }
  const rest = STATS.filter(k => !(k in spec));
  rest.forEach((k, i) => { s[k] = Math.floor(left / rest.length) + (i < left % rest.length ? 1 : 0); });
  return s;
}
const col = (name, spec, x, y) => ({ name, stats: stats(spec), spawn: { x, y } });

function run(configs, seed, maxTicks = Infinity) {
  const sim = createSim(configs, seed);
  let peak = 0, worst = 0, total = 0, ticks = 0;
  while (!sim.done && ticks < maxTicks) {
    const t0 = performance.now();
    sim.step();
    const dt = performance.now() - t0;
    total += dt; ticks++; if (dt > worst) worst = dt;
    if (sim.n > peak) peak = sim.n;
  }
  return { sim, peak, avg: total / ticks, worst, ticks };
}

// ---------- 1. budget ----------
check('valid budget accepted', validStats(stats({})));
check('over budget rejected', !validStats({ ...stats({}), atk: 40, def: 40 }));
check('under budget rejected', !validStats(Object.fromEntries(STATS.map(k => [k, 0]))));
check('stat above cap rejected', !validStats({ ...stats({ atk: 30 }), def: 41, spd: 0, intel: 0, repro: 0, eat: 0, bond: 0 }));

// ---------- 2. determinism ----------
const base = [col('A', { atk: 20 }, .25, .3), col('B', { def: 20 }, .75, .3), col('C', { bond: 25 }, .5, .75)];
const a = run(base, 1234, 1500), b = run(base, 1234, 1500), c = run(base, 999, 1500);
check('same seed => identical world', a.sim.checksum() === b.sim.checksum(), `(${a.sim.checksum()})`);
check('different seed => different world', a.sim.checksum() !== c.sim.checksum());

// ---------- 3. balance scenarios (6 seeds each) ----------
// "Everyone maxes the same stat" and "everyone identical" are the edge cases that must still produce a game.
const four = (spec) => [col('P1', spec, .2, .25), col('P2', spec, .8, .25), col('P3', spec, .2, .75), col('P4', spec, .8, .75)];
const SCENARIOS = {
  'flat (all average)':   four({}),
  'all-in attack':        four({ atk: 40, spd: 20 }),
  'all-in defense':       four({ def: 40, repro: 25 }),
  'all-in bonding':       four({ bond: 40, eat: 25 }),
  'all-in speed':         four({ spd: 40, eat: 30 }),
  'glass cannon vs 2':    [col('Cannon', { atk: 40, spd: 30 }, .2, .5), col('Even1', {}, .8, .25), col('Even2', {}, .8, .75)],
  'turtle vs hunter':     [col('Turtle', { def: 40, repro: 25 }, .25, .5), col('Hunter', { atk: 35, spd: 25 }, .75, .5)],
  'six players (flat)':   [1, 2, 3, 4, 5, 6].map(i => col('S' + i, {}, 0.12 + 0.15 * i, i % 2 ? .3 : .7)),
};
const SEEDS = [1, 2, 3, 4, 5, 6];
console.log('\nscenario              | outcomes (last/peace/divided/extinct) | avg territory % per colony | avg alliances | peak pop | ms/tick');
for (const [name, cfgs] of Object.entries(SCENARIOS)) {
  const kinds = { last: 0, peace: 0, divided: 0, extinct: 0 };
  const terr = cfgs.map(() => 0); let peak = 0, ms = 0, ally = 0;
  for (const seed of SEEDS) {
    const r = run(cfgs, seed), res = r.sim.getResults();
    if (res.outcome.startsWith('Total')) kinds.extinct++;
    else if (res.outcome.includes('last colony')) kinds.last++;
    else if (res.outcome.startsWith('Peaceful')) kinds.peace++;
    else kinds.divided++;
    res.rows.forEach(row => { terr[row.color - 1] += row.territory / SEEDS.length; ally += row.allies / 2 / SEEDS.length; });
    peak = Math.max(peak, r.peak); ms += r.avg / SEEDS.length;
  }
  console.log(`${name.padEnd(21)} | ${Object.values(kinds).join(' / ').padEnd(37)} | ${terr.map(t => t.toFixed(0).padStart(3)).join(' ').padEnd(26)} | ${ally.toFixed(1).padStart(13)} | ${String(peak).padStart(8)} | ${ms.toFixed(2)}`);
}

// ---------- 4. speed ----------
const heavy = run(SCENARIOS['six players (flat)'], 7);
check('avg tick under 6 ms with 6 colonies', heavy.avg < 6, `(avg ${heavy.avg.toFixed(2)} ms, worst ${heavy.worst.toFixed(2)} ms, peak ${heavy.peak} agents)`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
