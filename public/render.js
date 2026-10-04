// ============================================================================
// render.js : turns a simulation into pixels, fast.
//   world (territory, trails, food)  -> one small pixel buffer  -> ONE putImageData
//   agents                           -> ONE path + ONE fill per colony
// The cost per frame is almost independent of how many agents exist.
// ============================================================================
import { W, H } from './sim.js';

const BG = [10, 12, 18], FOOD = [235, 240, 255];
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
// Pack to 0xAABBGGRR. Every phone/laptop CPU is little-endian, so this matches ImageData's R,G,B,A byte order.
const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

// palette[c] = css colour of colony c (index 0 unused)
export function createRenderer(canvas, sim, palette) {
  const ctx = canvas.getContext('2d', { alpha: false });

  // --- low-res layer: 1 cell = 1 pixel, scaled up by the GPU when drawn ---
  const low = document.createElement('canvas'); low.width = W; low.height = H;
  const lctx = low.getContext('2d');
  const img = lctx.createImageData(W, H);
  const buf = new Uint32Array(img.data.buffer);             // same memory as img.data, viewed as 32-bit pixels

  // --- lookup table: lut[(colony << 8) | glow] = final pixel. No colour maths inside the draw loop. ---
  const lut = new Uint32Array(256 * palette.length);
  const agentCss = palette.map(h => { const [r, g, b] = rgb(h); return `rgb(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)})`; });
  for (let c = 1; c < palette.length; c++) {
    const [r, g, b] = rgb(palette[c]);
    for (let glow = 0; glow < 256; glow++) {
      const k = 0.3 + 0.7 * (glow / 255);                   // painted ground = 30% bright, fresh trail = 100%
      lut[(c << 8) | glow] = pack(BG[0] + (r - BG[0]) * k, BG[1] + (g - BG[1]) * k, BG[2] + (b - BG[2]) * k);
    }
  }
  const FOOD_PX = pack(...FOOD);

  // --- static background: dark with a soft glow around each fertile zone (computed once) ---
  const bg = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = 0;
    for (const z of sim.zones) { const d = Math.hypot(x - z[0], y - z[1]); if (d < 11) t = Math.max(t, 1 - d / 11); }
    bg[y * W + x] = pack(BG[0] + 14 * t, BG[1] + 22 * t, BG[2] + 30 * t);
  }

  // --- sizing: keep the world's 16:9 shape (letterbox), cap pixel ratio at 2 ---
  let cw = 0, ch = 0, scale = 1, ox = 0, oy = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, Math.round(canvas.clientWidth * dpr)); ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = cw; canvas.height = ch;                  // (this resets the context, so re-apply settings below)
    scale = Math.min(cw / W, ch / H);
    ox = (cw - W * scale) / 2; oy = (ch - H * scale) / 2;
    ctx.imageSmoothingEnabled = false;                      // crisp pixels when scaling up
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  // alpha = 0..1 progress between the last two ticks, so motion looks smooth at any frame rate
  function draw(alpha) {
    const { owner, glow, food, x, y, px, py, col } = sim, n = sim.n;

    // 1) world layer
    for (let i = 0; i < W * H; i++) {
      const o = owner[i];
      buf[i] = food[i] ? FOOD_PX : o ? lut[(o << 8) | glow[i]] : bg[i];
    }
    lctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(low, ox, oy, W * scale, H * scale);

    // 2) agents, batched: one beginPath/fill per colony, integer coords, plain squares
    const s = Math.max(2, Math.round(scale * 0.9));
    for (let c = 1; c < palette.length; c++) {
      ctx.fillStyle = agentCss[c];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (col[i] !== c) continue;
        const ix = px[i] + (x[i] - px[i]) * alpha, iy = py[i] + (y[i] - py[i]) * alpha;
        ctx.rect((ox + ix * scale) | 0, (oy + iy * scale) | 0, s, s);
      }
      ctx.fill();
    }
  }

  // final "territory painting" as a PNG data URL (bigger, no agents, trails shown at steady brightness)
  function paintingURL(zoom = 4) {
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const im = new ImageData(W, H), b = new Uint32Array(im.data.buffer), { owner } = sim;
    for (let i = 0; i < W * H; i++) b[i] = owner[i] ? lut[(owner[i] << 8) | 170] : bg[i];
    tmp.getContext('2d').putImageData(im, 0, 0);
    const out = document.createElement('canvas'); out.width = W * zoom; out.height = H * zoom;
    const g = out.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(tmp, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  return { draw, paintingURL, destroy: () => ro.disconnect() };
}
