// Webcam bubble drawn onto the board canvas so it appears in recordings.
// Positions are in canvas pixels (unaffected by zoom).
import { W, H } from './board.js';

const SIZES = [110, 160, 230];

export class CameraBubble {
  stream = null;
  video = null;
  sizeIndex = 1;
  x = W - 200;
  y = H - 200;

  get on() {
    return !!this.stream;
  }

  get r() {
    return SIZES[this.sizeIndex];
  }

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    this.video = v;
  }

  stop() {
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.video = null;
  }

  cycleSize() {
    this.sizeIndex = (this.sizeIndex + 1) % SIZES.length;
    this.clamp();
  }

  hit(cx, cy) {
    return this.on && Math.hypot(cx - this.x, cy - this.y) <= this.r;
  }

  moveTo(cx, cy) {
    this.x = cx;
    this.y = cy;
    this.clamp();
  }

  clamp() {
    const r = this.r + 6;
    this.x = Math.max(r, Math.min(W - r, this.x));
    this.y = Math.max(r, Math.min(H - r, this.y));
  }

  draw(ctx) {
    const v = this.video;
    if (!v || v.readyState < 2) return;
    const { x, y, r } = this;
    // Cover-fit the camera frame into the circle, mirrored like a selfie view.
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = (2 * r) / Math.min(vw, vh);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    ctx.drawImage(v, (-vw * s) / 2, (-vh * s) / 2, vw * s, vh * s);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();
  }
}
