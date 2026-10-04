





import { W, H } from './sim.js';

const BG = [10, 12, 18], FOOD = [235, 240, 255];
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;


export function createRenderer(canvas, sim, palette) {
  const ctx = canvas.getContext('2d', { alpha: false });


  const low = document.createElement('canvas'); low.width = W; low.height = H;
  const lctx = low.getContext('2d');
  const img = lctx.createImageData(W, H);
  const buf = new Uint32Array(img.data.buffer);

  const agentCss = palette.map(h => { const [r, g, b] = rgb(h); return `rgb(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)})`; });
  const FOOD_PX = pack(...FOOD);


  const bg = new Uint32Array(W * H), gr = sim.foodRadius + 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = 0;
    for (const z of sim.zones) { const d = Math.hypot(x - z[0], y - z[1]); if (d < gr) t = Math.max(t, 1 - d / gr); }
    bg[y * W + x] = pack(BG[0] + 14 * t, BG[1] + 22 * t, BG[2] + 30 * t);
  }


  let cw = 0, ch = 0, scale = 1, ox = 0, oy = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, Math.round(canvas.clientWidth * dpr)); ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = cw; canvas.height = ch;
    scale = Math.min(cw / W, ch / H);
    ox = (cw - W * scale) / 2; oy = (ch - H * scale) / 2;
    ctx.imageSmoothingEnabled = false;
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();


  function draw(alpha, showFood = true) {
    const { food, x, y, px, py, col } = sim, n = sim.n;



    for (let i = 0; i < W * H; i++) buf[i] = showFood && food[i] ? FOOD_PX : bg[i];
    lctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(low, ox, oy, W * scale, H * scale);


    const rad = Math.max(2, scale * 0.7);
    for (let c = 1; c < palette.length; c++) {
      ctx.fillStyle = agentCss[c];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (col[i] !== c) continue;
        const ix = px[i] + (x[i] - px[i]) * alpha, iy = py[i] + (y[i] - py[i]) * alpha;
        const cx = ox + ix * scale, cy = oy + iy * scale;
        ctx.moveTo(cx + rad, cy); ctx.arc(cx, cy, rad, 0, 6.2832);
      }
      ctx.fill();
    }
  }



  function paintingURL() {
    draw(1, false);
    const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').drawImage(canvas, ox, oy, W * scale, H * scale, 0, 0, w, h);
    return out.toDataURL('image/png');
  }

  return { draw, paintingURL, destroy: () => ro.disconnect() };
}
