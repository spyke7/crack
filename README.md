# Crack

Crack is a browser-based multiplayer colony strategy sandbox. Players spend exactly 100 points across seven stats, place a colony seed, and watch their colonies explore, eat, reproduce, fight, form alliances, and paint territory across a shared map.

Matches run for up to three minutes. The results screen compares territory, population, kills, food collected, births, deaths, and alliances.

## Features

- Multiplayer rooms for 2–6 players
- Create or join rooms with a short code or invite link
- Seven configurable colony stats with a strict 100-point budget
- Presets for quickly testing different strategies
- Deterministic simulations that produce the same result on every client
- Local simulation during matches, so network traffic does not cause gameplay lag
- Canvas rendering with smooth interpolation and pixel-art territory trails
- Desktop and mobile-landscape support
- Rematches without creating a new room
- Headless tests and a balance/performance report

## Requirements

- Node.js 18.11 or newer
- A modern browser with JavaScript and WebSocket support

Node.js 20 or 22 LTS is recommended.

## Quick start

Install the dependency:

```bash
npm install
```

Start the server:

```bash
npm start
```

Open the printed local address, normally:

```text
http://localhost:3000
```

For development, use the watch mode:

```bash
npm run dev
```

Run the automated checks with:

```bash
npm test
```

## How to play

1. Open the app and enter a player name.
2. Choose a room size and select **Create room**.
3. Share the invite link or four-letter room code with the other players.
4. Choose a preset or distribute 100 points across the colony stats.
5. Tap the map to place your colony seed.
6. Select **Ready** once all 100 points have been assigned.
7. The host selects **Start game** when at least two players are ready.
8. Watch the simulation, adjust the local game speed if needed, and compare the results when the match ends.

Players who are not ready when the host starts become spectators for that match.

## Colony stats

Every colony has the same total budget, but different distributions create different strategies:

- **Attack**: increases damage and aggression, but also increases upkeep.
- **Defense**: improves armor, health, and lifespan.
- **Speed**: improves movement, but faster colonies consume more energy.
- **Intelligence**: increases vision and the speed of simple reinforcement learning.
- **Reproduction**: lets colonies split at a lower energy threshold.
- **Eating**: increases the energy gained from food.
- **Bonding**: improves flocking and makes peaceful alliances more likely.

Stats use diminishing returns and are capped individually. A build is valid only when every stat is an integer from 0 to 40 and the total is exactly 100.

## Game simulation

The game uses a deterministic lockstep design:

1. The server creates one random seed and sends it with every player's configuration.
2. Each browser runs the same simulation locally from those inputs.
3. No positions are streamed during the match.

Because the same seed, configuration, and deterministic rules are used everywhere, clients can reach the same result without constant network updates. This also makes matches replayable from their seed and configurations.

The simulation includes:

- Food zones and periodic food drops
- Territory painting and fading movement trails
- Exploration and colony memory
- Combat, damage, energy, and loot
- Reproduction and population caps
- Pairwise trust and permanent alliances
- Territory, population, kills, bonding, and alliance-based scoring

See [DOCS.md](DOCS.md) for the full simulation model, balance knobs, determinism rules, and performance notes.

## Npm scripts

```bash
npm start       # start the production server
npm run dev     # restart the server when files change
npm test        # run headless checks and print a balance report
```

The server listens on port `3000` by default. To use another port:

```powershell
$env:PORT=8080; npm start
```

On macOS or Linux:

```bash
PORT=8080 npm start
```

## Playing on a phone

To test on a phone, connect the phone and computer to the same Wi-Fi network and open the `on your Wi-Fi` address printed by the server.

If the address does not load:

- Allow Node.js through the computer's firewall.
- Confirm both devices are on the same network.
- Avoid networks that isolate connected devices, such as some guest or college networks.
- Try a phone hotspot if the network blocks device-to-device connections.

The app asks mobile users to rotate to landscape mode. Clipboard access on a non-secure local Wi-Fi address may fall back to a copy prompt; this is expected.

## Deployment

Crack needs a running Node.js process and WebSocket support, so it should be deployed as a web service rather than a static site.

Typical deployment settings on services such as Render, Railway, or Fly.io are:

```text
Build command: npm install
Start command: npm start
```

The server uses the `PORT` supplied by the hosting platform. Once deployed over HTTPS, the browser automatically uses secure WebSockets.

For a quick local demo, a tunnel can expose the local server:

```bash
npx localtunnel --port 3000
```

Free hosting plans may sleep while idle, so start or visit the service a few minutes before a presentation.

## Development notes

When changing `public/sim.js`, preserve determinism:

- Use the seeded random generator instead of `Math.random()`.
- Do not use time, DOM, browser, or network state inside the simulation.
- Keep iteration order stable.
- Do not skip simulation ticks to catch up.
- Run `npm test` after changing simulation or balance code.

The tests check the stat budget, determinism, different-seed behaviour, match balance, and simulation speed. If two clients ever disagree, compare their simulation checksums to find the first divergent tick.

For a deeper explanation of the spatial hash, typed-array data layout, fixed timestep loop, WebSocket protocol, tuning knobs, and known balance notes, read [DOCS.md](DOCS.md).

## Troubleshooting

**`Cannot find package 'ws'`**  
Run `npm install` from the project directory.

**The phone cannot open the Wi-Fi address**  
Check the network, firewall, and printed IP address. A phone hotspot is a useful fallback.

**The app says it cannot reach the server**  
Make sure `npm start` is running and open the app through the server address, not directly from a `file://` URL.

**The app works locally but not after deployment**  
Use a host that supports long-running Node.js services and WebSockets. Static-only hosting is not sufficient.

**Two players see different results**  
Check for non-deterministic code in `public/sim.js`, especially calls to `Math.random()`, time APIs, or environment-dependent state.

**The simulation stutters on an older phone**  
Run the headless performance test first, then inspect whether simulation or rendering is the bottleneck. The detailed tuning and performance guide is in [DOCS.md](DOCS.md).

## License

No license has been specified for this project yet.
