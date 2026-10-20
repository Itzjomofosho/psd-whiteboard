// Records the board canvas plus sound with MediaRecorder.
// Safari records MP4. Chrome/Edge record WebM: their MP4 recorder holds all
// data until stop, which would defeat saving chunks as we go (crash safety).
const MP4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
const WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(navigator.userAgent);
const TYPES = isSafari ? [...MP4, ...WEBM] : [...WEBM, ...MP4];

export class Recorder {
  rec = null;
  chunks = [];
  tracks = [];
  startedAt = 0;
  pausedAt = 0;
  pausedTotal = 0;
  duration = 0;
  micSource = null;

  static supported(canvas) {
    return typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function';
  }

  get active() {
    return !!this.rec;
  }

  get paused() {
    return this.rec?.state === 'paused';
  }

  elapsed() {
    if (!this.rec) return this.duration;
    const end = this.paused ? this.pausedAt : performance.now();
    return end - this.startedAt - this.pausedTotal;
  }

  // mixer: { ctx, record } from media.audioMixer(), so clip sound is recorded
  // too; without it the raw microphone track is used.
  // onChunk(blob, seq): called as data arrives (for crash-safe storage).
  // Resolves to { mic: boolean, type }.
  async start(canvas, { mixer = null, onChunk = () => {} } = {}) {
    let mic = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      mic = null;
    }
    let audioTracks = mic ? mic.getAudioTracks() : [];
    if (mixer) {
      try {
        if (mic) {
          this.micSource = mixer.ctx.createMediaStreamSource(mic);
          this.micSource.connect(mixer.record);
        }
        audioTracks = mixer.record.stream.getAudioTracks();
      } catch {
        /* keep the raw mic track */
      }
    }
    const video = canvas.captureStream(30);
    const stream = new MediaStream([...video.getVideoTracks(), ...audioTracks]);
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: 5_000_000,
      audioBitsPerSecond: 128_000,
    });
    this.chunks = [];
    let seq = 0;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.chunks.push(e.data);
      onChunk(e.data, seq++);
    };
    // Stop only our own tracks; the mixer's track is shared and reused.
    this.tracks = [...video.getVideoTracks(), ...(mic ? mic.getTracks() : [])];
    this.mimeType = (mimeType || rec.mimeType || 'video/webm').split(';')[0];
    rec.start(1000);
    this.rec = rec;
    this.startedAt = performance.now();
    this.pausedTotal = 0;
    return { mic: !!mic, type: this.mimeType };
  }

  pause() {
    if (this.rec?.state !== 'recording') return;
    this.rec.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (!this.paused) return;
    this.rec.resume();
    this.pausedTotal += performance.now() - this.pausedAt;
  }

  stop() {
    const rec = this.rec;
    if (!rec) return Promise.resolve(null);
    this.duration = this.elapsed();
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = (rec.mimeType || this.mimeType).split(';')[0] || this.mimeType;
        const blob = new Blob(this.chunks, { type });
        for (const t of this.tracks) t.stop();
        this.micSource?.disconnect();
        this.micSource = null;
        this.rec = null;
        this.chunks = [];
        this.tracks = [];
        resolve(blob);
      };
      rec.stop();
    });
  }
}
