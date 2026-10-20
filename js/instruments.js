// Ruler and protractor. They live in board coordinates, are drawn on the board
// canvas (so they show in recordings) but are not saved with the board.
// Pen strokes started just above the ruler's top edge snap to that edge.
import { FONT } from './board.js';

export const CM = 40; // board units per "centimetre"
const RULER = { L: 30 * CM, H: 100 };
const PROT_R = 320;
const SNAP_ZONE = 40;
const HANDLE_R = 24;

export function newRuler() {
  return { kind: 'ruler', x: 360, y: 640, a: 0 };
}

export function newProtractor() {
  return { kind: 'protractor', x: 960, y: 760, a: 0 };
}

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

export function toLocal(inst, x, y) {
  return rot(x - inst.x, y - inst.y, -inst.a);
}

export function toWorld(inst, lx, ly) {
  const [dx, dy] = rot(lx, ly, inst.a);
  return [inst.x + dx, inst.y + dy];
}

// Local coordinates of the pivot used when rotating, and of the rotate handle.
const pivot = (inst) => (inst.kind === 'ruler' ? [RULER.L / 2, RULER.H / 2] : [0, 0]);
// Handles sit just outside the scale so they never cover any numbers.
const handle = (inst) => (inst.kind === 'ruler' ? [RULER.L + 38, RULER.H / 2] : [PROT_R + 38, 0]);

// 'handle' | 'body' | 'edge' (ruler snap zone) | null
export function hitInstrument(inst, x, y, unit = 1) {
  const [lx, ly] = toLocal(inst, x, y);
  const [hx, hy] = handle(inst);
  if (Math.hypot(lx - hx, ly - hy) <= HANDLE_R + 10 * unit) return 'handle';
  if (inst.kind === 'ruler') {
    if (lx >= 0 && lx <= RULER.L && ly >= 0 && ly <= RULER.H) return 'body';
    if (lx >= 0 && lx <= RULER.L && ly < 0 && ly >= -SNAP_ZONE) return 'edge';
    return null;
  }
  const r = Math.hypot(lx, ly);
  if ((ly <= 0 && r <= PROT_R) || (ly > 0 && ly <= 26 && Math.abs(lx) <= PROT_R)) return 'body';
  return null;
}

// Projects a point onto the ruler's measuring edge (local y = 0).
export function snapToEdge(inst, x, y) {
  const [lx] = toLocal(inst, x, y);
  return toWorld(inst, Math.max(0, Math.min(RULER.L, lx)), 0);
}

export function startRotate(inst, x, y) {
  const c = toWorld(inst, ...pivot(inst));
  return { c, a0: inst.a, p0: Math.atan2(y - c[1], x - c[0]) };
}

// Rotates about the pivot, snapping to 15° steps when close.
export function rotateTo(inst, r, x, y) {
  let a = r.a0 + Math.atan2(y - r.c[1], x - r.c[0]) - r.p0;
  const step = Math.PI / 12;
  const near = Math.round(a / step) * step;
  if (Math.abs(a - near) < (2.5 * Math.PI) / 180) a = near;
  inst.a = a;
  const [px, py] = pivot(inst);
  const [dx, dy] = rot(px, py, a);
  inst.x = r.c[0] - dx;
  inst.y = r.c[1] - dy;
}

// Signed angle from horizontal, -179..180 (screen y points down, so negate).
const degrees = (a) => {
  const d = Math.round((-a * 180) / Math.PI) % 360;
  return ((d + 540) % 360) - 180 || 0;
};

function drawHandle(ctx, inst) {
  const [hx, hy] = handle(inst);
  ctx.beginPath();
  ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#475467';
  ctx.stroke();
  // circular arrow
  ctx.beginPath();
  ctx.arc(hx, hy, 11, -Math.PI * 0.2, Math.PI * 1.3);
  ctx.stroke();
  const ex = hx + 11 * Math.cos(-Math.PI * 0.2), ey = hy + 11 * Math.sin(-Math.PI * 0.2);
  ctx.beginPath();
  ctx.moveTo(ex - 7, ey - 3);
  ctx.lineTo(ex + 1, ey + 1);
  ctx.lineTo(ex + 3, ey - 8);
  ctx.stroke();
}

function drawRuler(ctx, inst) {
  const { L, H: RH } = RULER;
  ctx.fillStyle = 'rgba(255, 233, 150, 0.82)';
  ctx.strokeStyle = '#8a6d1b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(0, 0, L, RH);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i <= 300; i++) {
    const x = (i * CM) / 10;
    const len = i % 10 === 0 ? 30 : i % 5 === 0 ? 20 : 11;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, len);
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#5c4810';
  ctx.stroke();
  ctx.fillStyle = '#5c4810';
  ctx.font = `600 17px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 30; i++) ctx.fillText(String(i), Math.min(Math.max(i * CM, 8), L - 8), 34);
  ctx.font = `14px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`cm   ${degrees(inst.a)}°`, 14, RH - 26);
  drawHandle(ctx, inst);
}

function drawProtractor(ctx, inst) {
  const R = PROT_R;
  ctx.fillStyle = 'rgba(190, 222, 255, 0.78)';
  ctx.strokeStyle = '#1d4f91';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, R, Math.PI, 0);
  ctx.lineTo(R, 26);
  ctx.lineTo(-R, 26);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  for (let d = 0; d <= 180; d++) {
    const a = Math.PI + (d * Math.PI) / 180;
    const len = d % 10 === 0 ? 30 : d % 5 === 0 ? 20 : 10;
    ctx.moveTo(R * Math.cos(a), R * Math.sin(a));
    ctx.lineTo((R - len) * Math.cos(a), (R - len) * Math.sin(a));
  }
  ctx.moveTo(-R, 0);
  ctx.lineTo(R, 0);
  ctx.moveTo(0, -14);
  ctx.lineTo(0, 14);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#123a6b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d <= 180; d += 10) {
    const a = Math.PI + (d * Math.PI) / 180;
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(String(180 - d), (R - 48) * Math.cos(a), (R - 48) * Math.sin(a));
    ctx.font = `13px ${FONT}`;
    ctx.fillText(String(d), (R - 74) * Math.cos(a), (R - 74) * Math.sin(a));
  }
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  drawHandle(ctx, inst);
}

export function drawInstrument(ctx, inst) {
  ctx.save();
  ctx.translate(inst.x, inst.y);
  ctx.rotate(inst.a);
  if (inst.kind === 'ruler') drawRuler(ctx, inst);
  else drawProtractor(ctx, inst);
  ctx.restore();
}
