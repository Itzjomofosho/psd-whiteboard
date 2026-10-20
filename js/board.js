// Board model and rendering. Everything is stored in fixed board coordinates
// (W x H, 16:9). A view { z, x, y } (zoom and top-left corner in board units)
// maps the board onto the W x H canvas, which is CSS-scaled to fit the screen.
export const W = 1920;
export const H = 1080;
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT = 1.25;
export const LASER_MS = 700;
export const FULL_VIEW = Object.freeze({ z: 1, x: 0, y: 0 });

export const BACKGROUNDS = [
  { id: 'white', label: 'Plain' },
  { id: 'grid', label: 'Grid' },
  { id: 'lines', label: 'Lined' },
  { id: 'handwriting', label: 'Handwriting' },
  { id: 'dots', label: 'Dots' },
  { id: 'coord', label: 'Coordinate plane' },
  { id: 'staff', label: 'Music staff' },
  { id: 'black', label: 'Dark' },
  { id: 'chalk', label: 'Chalkboard' },
];
const BG_FILL = { black: '#1d2125', chalk: '#24412f' };
export const isDarkBg = (bg) => bg in BG_FILL;
export const bgFill = (bg) => BG_FILL[bg] || '#ffffff';

let seq = 0;
export const uid = () =>
  Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 7);

export const newPage = (bg = 'white') => ({ id: uid(), bg, objects: [] });

export const newProject = (name) => ({
  id: uid(),
  name,
  created: Date.now(),
  updated: Date.now(),
  pages: [newPage()],
});

// ---------- images and videos ----------

const images = new Map(); // src -> HTMLImageElement
let onImageReady = () => {};
let videoProvider = () => null; // video object -> playable HTMLVideoElement or null
export function setImageReadyHandler(fn) {
  onImageReady = fn;
}
export function setVideoProvider(fn) {
  videoProvider = fn;
}

function imageFor(src) {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onImageReady();
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

// Resolves once every image (and video poster) on the given pages has loaded.
export async function ensureImages(pages) {
  const waits = [];
  for (const p of pages) {
    for (const o of p.objects) {
      const src = o.type === 'image' ? o.src : o.type === 'video' ? o.poster : null;
      if (!src) continue;
      imageFor(src);
      const img = images.get(src);
      if (!img.complete) waits.push(img.decode().catch(() => {}));
    }
  }
  await Promise.all(waits);
}

// ---------- drawing ----------

function drawBackground(ctx, bg) {
  ctx.fillStyle = bgFill(bg);
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  const hlines = (ys, color, width = 2, dash = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (const y of ys) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const range = (from, to, step) => Array.from({ length: Math.max(0, Math.floor((to - from) / step) + 1) }, (_, i) => from + i * step);

  if (bg === 'grid') {
    ctx.strokeStyle = '#dfe5ec';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const x of range(60, W - 1, 60)) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (const y of range(60, H - 1, 60)) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  } else if (bg === 'lines') {
    hlines(range(120, H - 1, 60), '#cfe0f5');
    ctx.strokeStyle = '#f2b8b8';
    ctx.beginPath();
    ctx.moveTo(160, 0);
    ctx.lineTo(160, H);
    ctx.stroke();
  } else if (bg === 'handwriting') {
    // Primary ruling: solid top line, dashed midline, solid red baseline.
    const rows = range(110, H - 100, 170);
    hlines(rows, '#8fb0dc', 2);
    hlines(rows.map((y) => y + 45), '#8fb0dc', 2, [14, 12]);
    hlines(rows.map((y) => y + 90), '#e48b8b', 3);
  } else if (bg === 'dots') {
    ctx.fillStyle = '#c4ccd6';
    for (const x of range(60, W - 1, 60)) for (const y of range(60, H - 1, 60)) ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
  } else if (bg === 'coord') {
    const u = 40, cx = W / 2, cy = H / 2;
    ctx.strokeStyle = '#e3e8ef';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = cx % u; x < W; x += u) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = cy % u; y < H; y += u) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.strokeStyle = '#475467';
    ctx.fillStyle = '#475467';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, cy); ctx.lineTo(W - 10, cy);
    ctx.moveTo(cx, 10); ctx.lineTo(cx, H - 10);
    ctx.stroke();
    const head = (x, y, dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - dx * 18 - dy * 9, y - dy * 18 - dx * 9);
      ctx.lineTo(x - dx * 18 + dy * 9, y - dy * 18 + dx * 9);
      ctx.fill();
    };
    head(W - 6, cy, 1, 0); head(6, cy, -1, 0); head(cx, 6, 0, -1); head(cx, H - 6, 0, 1);
    ctx.font = `18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = -22; i <= 22; i += 2) if (i) ctx.fillText(String(i), cx + i * u, cy + 8);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = -12; i <= 12; i += 2) if (i) ctx.fillText(String(-i), cx - 8, cy + i * u);
    ctx.font = `italic 24px ${FONT}`;
    ctx.fillText('x', W - 16, cy - 22);
    ctx.textAlign = 'left';
    ctx.fillText('y', cx + 14, 22);
  } else if (bg === 'staff') {
    ctx.strokeStyle = '#7c8797';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const top of range(140, H - 120, 190)) {
      for (let k = 0; k < 5; k++) { ctx.moveTo(80, top + k * 20); ctx.lineTo(W - 80, top + k * 20); }
      ctx.moveTo(80, top); ctx.lineTo(80, top + 80);
      ctx.moveTo(W - 80, top); ctx.lineTo(W - 80, top + 80);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Pen width follows pressure (0.5 = mouse/finger = nominal size).
const penWidth = (o, p) => o.size * (0.3 + p * 1.4);
const strokeReach = (o) => o.size * (o.tool === 'pen' ? 0.85 : 0.5);

function drawStroke(ctx, o) {
  const p = o.points; // flat [x, y, pressure, ...]
  const n = p.length / 3;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = o.color;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (o.tool === 'highlighter') ctx.globalAlpha = 0.35;
  if (n === 1) {
    const r = (o.tool === 'pen' ? penWidth(o, p[2]) : o.size) / 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
  } else if (o.tool === 'highlighter') {
    // One path so overlapping segments don't darken.
    ctx.lineWidth = o.size;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      const last = i === n - 1;
      ctx.quadraticCurveTo(x, y, last ? x : (x + p[i * 3 + 3]) / 2, last ? y : (y + p[i * 3 + 4]) / 2);
    }
    ctx.stroke();
  } else {
    // Segment by segment so each can have its own pressure width.
    let px = p[0], py = p[1];
    for (let i = 1; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      const last = i === n - 1;
      const mx = last ? x : (x + p[i * 3 + 3]) / 2;
      const my = last ? y : (y + p[i * 3 + 4]) / 2;
      ctx.lineWidth = penWidth(o, p[i * 3 + 2]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(x, y, mx, my);
      ctx.stroke();
      px = mx;
      py = my;
    }
  }
  ctx.restore();
}

const arrowHead = (o) => Math.max(18, o.size * 4);
const trianglePoints = (o) => [
  [(o.x1 + o.x2) / 2, Math.min(o.y1, o.y2)],
  [Math.max(o.x1, o.x2), Math.max(o.y1, o.y2)],
  [Math.min(o.x1, o.x2), Math.max(o.y1, o.y2)],
];

function shapePath(ctx, o) {
  const { x1, y1, x2, y2 } = o;
  ctx.beginPath();
  if (o.kind === 'rect') {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (o.kind === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else if (o.kind === 'triangle') {
    const [a, b, c] = trianglePoints(o);
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineTo(...c);
    ctx.closePath();
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
}

export const isClosedShape = (o) => o.type === 'shape' && !(o.kind === 'line' || o.kind === 'arrow');

function drawShape(ctx, o) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = o.color;
  ctx.lineWidth = o.size;
  ctx.lineCap = ctx.lineJoin = 'round';
  shapePath(ctx, o);
  if (isClosedShape(o) && o.fill && o.fill !== 'none') {
    ctx.globalAlpha = o.fill === 'tint' ? 0.25 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (o.dash) ctx.setLineDash([o.size * 3, o.size * 2.2]);
  ctx.stroke();
  if (o.kind === 'arrow') {
    const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
    const len = arrowHead(o);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(o.x2 - len * Math.cos(a - 0.45), o.y2 - len * Math.sin(a - 0.45));
    ctx.lineTo(o.x2, o.y2);
    ctx.lineTo(o.x2 - len * Math.cos(a + 0.45), o.y2 - len * Math.sin(a + 0.45));
    ctx.stroke();
  }
  ctx.restore();
}

function drawText(ctx, o) {
  ctx.save();
  ctx.fillStyle = o.color;
  ctx.font = `${o.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  o.text.split('\n').forEach((line, i) => ctx.fillText(line, o.x, o.y + i * o.size * LINE_HEIGHT));
  ctx.restore();
}

function drawImage(ctx, o) {
  const img = imageFor(o.src);
  if (img) {
    ctx.drawImage(img, o.x, o.y, o.w, o.h);
  } else {
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }
}

function drawVideo(ctx, o) {
  const v = videoProvider(o);
  const poster = o.poster && imageFor(o.poster);
  ctx.save();
  if (v && v.readyState >= 2 && (v.currentTime > 0 || !poster)) ctx.drawImage(v, o.x, o.y, o.w, o.h);
  else if (poster) ctx.drawImage(poster, o.x, o.y, o.w, o.h);
  else {
    ctx.fillStyle = '#20242a';
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }
  if (!v || v.paused) {
    // Play badge
    const r = Math.min(o.w, o.h) * 0.12;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.35, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.55, cy);
    ctx.lineTo(cx - r * 0.35, cy + r * 0.5);
    ctx.fill();
  }
  ctx.restore();
}

export function drawObject(ctx, o) {
  if (o.type === 'stroke') drawStroke(ctx, o);
  else if (o.type === 'shape') drawShape(ctx, o);
  else if (o.type === 'text') drawText(ctx, o);
  else if (o.type === 'image') drawImage(ctx, o);
  else if (o.type === 'video') drawVideo(ctx, o);
}

export function drawPage(ctx, bg, objects) {
  drawBackground(ctx, bg);
  for (const o of objects) drawObject(ctx, o);
}

export function drawLaser(ctx, trail, now, unit = 1) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = ctx.fillStyle = '#ff2d2d';
  ctx.shadowColor = '#ff2d2d';
  ctx.shadowBlur = 16;
  ctx.lineWidth = 10 * unit;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const age = now - b.t;
    if (b.brk || age > LASER_MS) continue;
    ctx.globalAlpha = Math.min(1, 1 - age / LASER_MS);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const head = trail[trail.length - 1];
  const age = now - head.t;
  if (age < LASER_MS) {
    ctx.globalAlpha = Math.min(1, 1 - age / LASER_MS);
    ctx.beginPath();
    ctx.arc(head.x, head.y, 9 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export const setView = (ctx, v) => ctx.setTransform(v.z, 0, 0, v.z, -v.x * v.z, -v.y * v.z);

// Draws committed objects into an offscreen cache for a given view, then each
// frame composites the cache (re-projected if the view has since changed)
// plus whatever the caller draws on top.
export class Renderer {
  constructor(canvas) {
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d');
    this.cache = document.createElement('canvas');
    this.cache.width = W;
    this.cache.height = H;
    this.cctx = this.cache.getContext('2d');
    this.cacheView = FULL_VIEW;
    this.bg = 'white';
  }

  rebuild(bg, objects, view) {
    this.bg = bg;
    this.cacheView = { ...view };
    setView(this.cctx, view);
    drawPage(this.cctx, bg, objects);
  }

  // drawWorld(ctx) draws in board coordinates; drawScreen(ctx) in canvas pixels.
  frame(view, drawWorld, drawScreen) {
    const { ctx, cacheView: cv } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cv.z !== view.z || cv.x !== view.x || cv.y !== view.y) {
      ctx.fillStyle = bgFill(this.bg);
      ctx.fillRect(0, 0, W, H);
      const s = view.z / cv.z;
      ctx.setTransform(s, 0, 0, s, (cv.x - view.x) * view.z, (cv.y - view.y) * view.z);
    }
    ctx.drawImage(this.cache, 0, 0);
    setView(ctx, view);
    drawWorld(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawScreen(ctx);
  }
}

export function renderToCanvas(page, width) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((width * H) / W);
  const ctx = c.getContext('2d');
  ctx.scale(width / W, width / W);
  drawPage(ctx, page.bg, page.objects);
  return c;
}

// ---------- geometry ----------

const measureCtx = document.createElement('canvas').getContext('2d');
export function measureText(text, size) {
  measureCtx.font = `${size}px ${FONT}`;
  const lines = text.split('\n');
  const w = Math.max(1, ...lines.map((l) => measureCtx.measureText(l).width));
  return { w, h: lines.length * size * LINE_HEIGHT };
}

export function bounds(o) {
  if (o.type === 'stroke') {
    const p = o.points;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    const pad = strokeReach(o);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }
  if (o.type === 'shape') {
    const pad = o.size / 2 + (o.kind === 'arrow' ? arrowHead(o) / 2 : 0);
    const x = Math.min(o.x1, o.x2), y = Math.min(o.y1, o.y2);
    return { x: x - pad, y: y - pad, w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2 };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

export function unionBounds(objs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs) {
    const b = bounds(o);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const inBox = (b, x, y, r) => x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;

// edgeOnly: closed shapes only count their outline (used by the eraser).
export function hitObject(o, x, y, r, edgeOnly = false) {
  if (!inBox(bounds(o), x, y, r)) return false;
  if (o.type === 'stroke') {
    const p = o.points;
    const reach = r + strokeReach(o);
    if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) <= reach;
    for (let i = 3; i < p.length; i += 3) {
      if (distToSeg(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach) return true;
    }
    return false;
  }
  if (o.type === 'shape') {
    const reach = r + o.size / 2;
    if (o.kind === 'line' || o.kind === 'arrow') return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= reach;
    if (!edgeOnly) return true;
    const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
    const rx = Math.abs(o.x2 - o.x1) / 2, ry = Math.abs(o.y2 - o.y1) / 2;
    if (o.kind === 'ellipse') {
      if (!rx || !ry) return true;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= reach;
    }
    if (o.kind === 'triangle') {
      const [a, b, c] = trianglePoints(o);
      return [[a, b], [b, c], [c, a]].some(([p, q]) => distToSeg(x, y, p[0], p[1], q[0], q[1]) <= reach);
    }
    return !(Math.abs(x - cx) < rx - reach && Math.abs(y - cy) < ry - reach);
  }
  return true;
}

// Topmost object under the point, optionally filtered.
export function hitTest(objects, x, y, r, filter = () => true) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (filter(o) && hitObject(o, x, y, r)) return o;
  }
  return null;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Scale about (ox, oy) by s, then translate by (dx, dy). Returns a new object.
export function transformObj(o, ox, oy, s, dx, dy) {
  const mx = (x) => ox + (x - ox) * s + dx;
  const my = (y) => oy + (y - oy) * s + dy;
  switch (o.type) {
    case 'stroke': {
      const p = o.points.slice();
      for (let i = 0; i < p.length; i += 3) {
        p[i] = mx(p[i]);
        p[i + 1] = my(p[i + 1]);
      }
      return { ...o, points: p, size: o.size * s };
    }
    case 'shape':
      return { ...o, x1: mx(o.x1), y1: my(o.y1), x2: mx(o.x2), y2: my(o.y2), size: o.size * s };
    case 'text':
      return { ...o, x: mx(o.x), y: my(o.y), size: o.size * s, w: o.w * s, h: o.h * s };
    default:
      return { ...o, x: mx(o.x), y: my(o.y), w: o.w * s, h: o.h * s };
  }
}
