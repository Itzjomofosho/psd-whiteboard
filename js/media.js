// Video clips placed on boards, plus the audio mixer used while recording.
// Clip files live in IndexedDB ("media" store); <video> elements are made on demand.
import * as store from './store.js';

const players = new Map(); // mediaId -> HTMLVideoElement
let onChange = () => {};
let mixer = null;

export function setMediaChangeHandler(fn) {
  onChange = fn;
}

// Shared AudioContext. Video sound goes to the speakers and to `record`;
// the microphone goes only to `record` (so it doesn't echo).
// Must first be called from a user gesture (Safari).
export function audioMixer() {
  if (!mixer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    mixer = { ctx, record: ctx.createMediaStreamDestination() };
  }
  if (mixer.ctx.state === 'suspended') mixer.ctx.resume().catch(() => {});
  return mixer;
}

export function playerFor(o) {
  let v = players.get(o.mediaId);
  if (v) return v;
  v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.onloadeddata = v.onplay = v.onpause = v.onended = v.onseeked = () => onChange();
  players.set(o.mediaId, v);
  store.getMedia(o.mediaId).then((m) => {
    if (m) v.src = URL.createObjectURL(m.blob);
  });
  return v;
}

// Board renderer hook: an element ready to draw, or null.
export const readyPlayer = (o) => {
  const v = players.get(o.mediaId);
  return v && v.readyState >= 2 ? v : null;
};

export async function togglePlay(o) {
  const v = playerFor(o);
  if (!v.paused) {
    v.pause();
    return;
  }
  const mix = audioMixer();
  if (mix && !v.routed) {
    try {
      const src = mix.ctx.createMediaElementSource(v);
      src.connect(mix.ctx.destination);
      src.connect(mix.record);
      v.routed = true;
    } catch {
      // Falls back to normal playback; the mic still picks up the sound.
    }
  }
  if (v.ended) v.currentTime = 0;
  try {
    await v.play();
  } catch {
    /* blocked or not loaded yet */
  }
}

export function isPlaying(o) {
  const v = players.get(o.mediaId);
  return !!v && !v.paused && !v.ended;
}

export const anyPlaying =() => [...players.values()].some((v) => !v.paused && !v.ended);

export function pauseAll() {
  for (const v of players.values()) v.pause();
}

// Reads size and a poster frame from a video file. Some files (e.g. phone or
// browser recordings) report no size or duration up front, so this waits for
// real frame data and falls back to 16:9 without a poster if none arrives.
export function probeVideo(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (withPoster) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const width = v.videoWidth || 1280;
      const height = v.videoHeight || 720;
      let poster = null;
      if (withPoster && v.videoWidth) {
        const k = Math.min(1, 640 / Math.max(width, height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(width * k));
        c.height = Math.max(1, Math.round(height * k));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        poster = c.toDataURL('image/jpeg', 0.8);
      }
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      resolve({ width, height, poster });
    };
    const timer = setTimeout(() => finish(false), 8000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('This video format is not supported on this device.'));
    };
    v.onloadeddata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      if (d > 0.2) v.currentTime = Math.min(0.5, d / 4);
      else finish(true);
    };
    v.onseeked = () => finish(true);
    v.src = url;
    v.load();
  });
}
