// PSD Whiteboard: screens, toolbars, tools and pointer handling.
import {
  W, H, uid, newPage, newProject, BACKGROUNDS, FONT, LINE_HEIGHT, LASER_MS,
  Renderer, renderToCanvas, ensureImages, setImageReadyHandler, setVideoProvider, setView,
  bounds, unionBounds, hitObject, hitTest, pointInPolygon, transformObj, measureText, drawObject, drawLaser,
  isClosedShape,
} from './board.js';
import * as store from './store.js';
import { Recorder } from './recorder.js';
import { jpegPagesToPdf } from './pdf.js';
import { pdfToImages, MAX_PAGES } from './pdfimport.js';
import { CameraBubble } from './camera.js';
import {
  audioMixer, readyPlayer, togglePlay, isPlaying, anyPlaying, pauseAll, probeVideo, setMediaChangeHandler,
} from './media.js';
import {
  newRuler, newProtractor, hitInstrument, snapToEdge, startRotate, rotateTo, drawInstrument,
} from './instruments.js';
import * as drive from './drive.js';
import { icon } from './icons.js';

const COLORS = ['#1f2328', '#1e66f5', '#e03131', '#2f9e44', '#f08c00', '#7048e8', '#fab005', '#ffffff'];
const MINI_COLORS = ['#1f2328', '#1e66f5', '#e03131', '#2f9e44', '#ffffff'];
const SIZES = {
  pen: [3, 6, 12],
  highlighter: [16, 30, 48],
  eraser: [12, 28, 60],
  shape: [3, 6, 12],
  text: [32, 48, 80],
};
const KEYS = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', s: 'shape', t: 'text', l: 'laser' };
const HANDLE = 14; // resize handle radius, CSS px
const MAX_ZOOM = 6;
const MAX_VIDEO_MB = 300;
const FILE_FORMAT = 'psd-whiteboard';
const OBJECT_TYPES = new Set(['stroke', 'shape', 'text', 'image', 'video']);
const isMobile = /iPad|iPhone|iPod|Android/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const paper = $('#paper');
const canvas = $('#canvas');
const overlay = $('#overlay');
const editor = $('#texteditor');
const selbar = $('#selbar');

const renderer = new Renderer(canvas);
overlay.width = W;
overlay.height = H;
const octx = overlay.getContext('2d');
const recorder = new Recorder();
const camera = new CameraBubble();

const state = {
  project: null,
  pageIndex: 0,
  tool: 'pen',
  shape: 'rect',
  fill: 'none',
  dash: false,
  color: COLORS[0],
  sizeIndex: 1,
  selection: [], // selected object ids
};
const undoStacks = new Map(); // page id -> { past, future }
const instruments = { ruler: null, protractor: null };

let view = { z: 1, x: 0, y: 0 }; // zoom and top-left corner, board units
let scale = 1;          // CSS px per canvas px
let dirtyCache = true;  // committed objects need re-rendering
let dirtyFrame = true;  // screen needs re-compositing
let lastRebuild = 0;
let live = [];          // objects being drawn or moved, drawn above the cache
let laser = [];         // laser trail points { x, y, t, brk }
let laserWasOn = false;
let drag = null;        // the active single-pointer gesture
let pinch = null;       // the active two-finger zoom
const touches = new Map(); // touch pointerId -> [clientX, clientY]
let editing = null;     // the open text editor
let penSeen = false;    // once a stylus is used, fingers pan instead of drawing
let recMeta = null;     // the recording in progress
let presentFs = false;  // presentation mode entered browser full screen

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children);
  return e;
}

const iconBtn = (name, title, onclick) =>
  el('button', { class: 'icon', title, 'aria-label': title, html: icon(name), onclick });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function busy(msg) {
  $('#busymsg').textContent = msg;
  if (!$('#busy').open) $('#busy').showModal();
}

function unbusy() {
  if ($('#busy').open) $('#busy').close();
}

const page = () => state.project.pages[state.pageIndex];
const objects = () => page().objects;
const sizeFor = (tool) => (SIZES[tool] || SIZES.pen)[state.sizeIndex];
const selectedObjs = () => {
  const ids = new Set(state.selection);
  return ids.size ? objects().filter((o) => ids.has(o.id)) : [];
};
const replaceMany = (objs, changed) => {
  const m = new Map(changed.map((o) => [o.id, o]));
  return objs.map((o) => m.get(o.id) || o);
};
const round1 = (v) => Math.round(v * 10) / 10;
const pressure = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5);
const k = () => scale * view.z; // CSS px per board unit

const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Whiteboard';
const baseName = (name) => name.replace(/\.[^.]+$/, '');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
};
const extFor = (type) => (type.includes('mp4') ? 'mp4' : 'webm');

function askName(current) {
  const n = prompt('Board name', current);
  return n && n.trim() ? n.trim().slice(0, 80) : null;
}

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const dataURLToBlob = async (url) => (await fetch(url)).blob();
const canvasToBlob = (c, type, quality) => new Promise((resolve) => c.toBlob(resolve, type, quality));

// Share sheet on tablets/phones (Save to Files / Save Video), download elsewhere.
async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (isMobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
}

// ---------- home screen ----------

async function showHome() {
  if (recorder.active) {
    toast('Stop the recording first.');
    return;
  }
  commitTextEditor();
  closeMenus();
  exitPresent();
  pauseAll();
  camera.stop();
  $('#camera').classList.remove('active');
  instruments.ruler = instruments.protractor = null;
  $('#pages').hidden = true;
  await flushSave();
  state.project = null;
  $('#board').hidden = true;
  $('#home').hidden = false;
  await renderHome();
}

async function renderHome() {
  const [list, recs] = await Promise.all([store.listProjects(), store.listRecordings()]);
  $('#projects').replaceChildren(...list.map(projectCard));
  $('#empty').hidden = list.length > 0;
  const done = recs.filter((r) => r.status !== 'recording');
  $('#recordings').replaceChildren(...done.map(recordingRow));
  $('#recordings-section').hidden = !done.length;
}

function projectCard(m) {
  const open = async () => {
    const p = await store.loadProject(m.id);
    if (p) openProject(p);
  };
  const when = new Date(m.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return el('div', { class: 'card' },
    el('button', { class: 'thumbbtn', 'aria-label': `Open ${m.name}`, onclick: open },
      m.thumb ? el('img', { class: 'thumb', src: m.thumb, alt: '' }) : el('div', { class: 'thumb' })),
    el('div', { class: 'meta' },
      el('div', { class: 'name' }, m.name),
      el('div', { class: 'sub' }, `${m.pages} page${m.pages === 1 ? '' : 's'} · ${when}`)),
    el('div', { class: 'actions' },
      iconBtn('pen', 'Rename', async () => {
        const name = askName(m.name);
        if (!name) return;
        await store.renameProject(m.id, name);
        renderHome();
      }),
      iconBtn('download', 'Download project file', async () => {
        const p = await store.loadProject(m.id);
        if (!p) return;
        busy('Preparing file…');
        try {
          await saveBlob(await projectFileBlob(p), `${safeName(p.name)}.json`);
        } finally {
          unbusy();
        }
      }),
      iconBtn('trash', 'Delete', async () => {
        if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
        await store.deleteProject(m.id);
        renderHome();
      })));
}

function recordingRow(r) {
  const when = new Date(r.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const open = async () => showRecording(r, await store.recordingBlob(r.id, r.type));
  return el('div', { class: 'recrow' },
    el('span', { html: icon('film') }),
    el('div', { class: 'info' },
      el('div', { class: 'name' }, r.name),
      el('div', { class: 'sub' }, `${when} · ${fmtTime(r.duration || 0)} · ${fmtSize(r.size || 0)} `,
        r.status === 'recovered' ? el('span', { class: 'badge' }, '· Recovered') : '')),
    iconBtn('play', 'Play', open),
    iconBtn('download', 'Save video', async () => {
      const blob = await store.recordingBlob(r.id, r.type);
      saveBlob(blob, `${safeName(r.name)}.${extFor(r.type)}`);
    }),
    iconBtn('trash', 'Delete recording', async () => {
      if (!confirm(`Delete the recording "${r.name}"?`)) return;
      await store.deleteRecording(r.id);
      renderHome();
    }));
}

async function createProject(name, pages) {
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const p = newProject(name || `Board ${date}`);
  if (pages?.length) p.pages = pages;
  await store.saveProject(p, thumbnail(p));
  openProject(p);
  return p;
}

// Reads a project file, storing any embedded video clips. Returns the project.
async function parseProjectFile(text) {
  const data = JSON.parse(text);
  const p = data?.format === FILE_FORMAT ? data.project : null;
  if (!p || !Array.isArray(p.pages) || !p.pages.length) throw new Error('Not a whiteboard file');
  const id = uid();
  const mediaIds = new Map();
  for (const [oldId, m] of Object.entries(data.media || {})) {
    const newId = uid();
    await store.putMedia({ id: newId, project: id, blob: await dataURLToBlob(m.data), type: m.type });
    mediaIds.set(oldId, newId);
  }
  return {
    id,
    name: String(p.name || 'Imported board').slice(0, 80),
    created: Date.now(),
    updated: Date.now(),
    pages: p.pages.map((pg) => ({
      id: uid(),
      bg: BACKGROUNDS.some((b) => b.id === pg.bg) ? pg.bg : 'white',
      objects: (Array.isArray(pg.objects) ? pg.objects : [])
        .filter((o) => OBJECT_TYPES.has(o?.type) && (o.type !== 'video' || mediaIds.has(o.mediaId)))
        .map((o) => (o.type === 'video' ? { ...o, mediaId: mediaIds.get(o.mediaId) } : o)),
    })),
  };
}

async function projectFileBlob(p) {
  const media = {};
  for (const pg of p.pages) {
    for (const o of pg.objects) {
      if (o.type !== 'video' || media[o.mediaId]) continue;
      const m = await store.getMedia(o.mediaId);
      if (m) media[o.mediaId] = { type: m.type, data: await blobToDataURL(m.blob) };
    }
  }
  const { driveId, ...project } = p;
  return new Blob([JSON.stringify({ format: FILE_FORMAT, version: 2, project, media })], { type: 'application/json' });
}

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');

// Open file on the home screen: a project file or a PDF (becomes a new board).
async function importFile(file, { driveId = null } = {}) {
  try {
    if (isPdf(file)) {
      const pages = await pdfPages(await file.arrayBuffer());
      if (pages) await createProject(baseName(file.name || 'PDF'), pages);
      return;
    }
    if (file.type.startsWith('image/')) {
      const p = await createProject(baseName(file.name || 'Image'));
      await insertImage(file);
      return p;
    }
    busy('Opening…');
    const p = await parseProjectFile(await file.text());
    if (driveId) p.driveId = driveId;
    await store.saveProject(p, thumbnail(p));
    unbusy();
    openProject(p);
  } catch (err) {
    unbusy();
    toast(err.message === 'Not a whiteboard file' || err instanceof SyntaxError
      ? 'That file is not a PSD Whiteboard project or PDF.'
      : `Could not open that file: ${err.message}`);
  }
}

// ---------- board screen ----------

function openProject(p) {
  state.project = p;
  state.pageIndex = 0;
  state.selection = [];
  undoStacks.clear();
  $('#home').hidden = true;
  $('#board').hidden = false;
  $('#title').textContent = p.name;
  layout();
  pageChanged();
}

function layout() {
  const stage = $('#stage');
  const cs = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (w <= 0 || h <= 0) return;
  scale = Math.min(w / W, h / H);
  paper.style.width = `${Math.floor(W * scale)}px`;
  paper.style.height = `${Math.floor(H * scale)}px`;
  if (editing) styleEditor();
  dirtyFrame = true;
}

function pageChanged() {
  const n = state.project.pages.length;
  state.selection = [];
  view = { z: 1, x: 0, y: 0 };
  updateZoomUi();
  pauseAll();
  dirtyCache = true;
  $('#pagelabel').textContent = `${state.pageIndex + 1} / ${n}`;
  $('#mini-page').textContent = `${state.pageIndex + 1}/${n}`;
  $('#prev').disabled = $('[data-act="prev"]').disabled = state.pageIndex === 0;
  $('#next').disabled = $('[data-act="next"]').disabled = state.pageIndex === n - 1;
  updateUndoButtons();
  renderPagesPanel();
}

function goToPage(i) {
  commitTextEditor();
  state.pageIndex = Math.max(0, Math.min(state.project.pages.length - 1, i));
  pageChanged();
}

// ---------- view (zoom and pan) ----------

function setViewTo(z, x, y) {
  z = Math.min(MAX_ZOOM, Math.max(1, z));
  x = Math.min(Math.max(0, x), W - W / z);
  y = Math.min(Math.max(0, y), H - H / z);
  if (z === view.z && x === view.x && y === view.y) return;
  view = { z, x, y };
  dirtyCache = dirtyFrame = true;
  updateZoomUi();
  if (editing) styleEditor();
}

// Zoom by `factor`, keeping canvas point (cx, cy) fixed.
function zoomAt(factor, cx = W / 2, cy = H / 2) {
  const bx = view.x + cx / view.z, by = view.y + cy / view.z;
  const z = Math.min(MAX_ZOOM, Math.max(1, view.z * factor));
  setViewTo(z, bx - cx / z, by - cy / z);
}

function updateZoomUi() {
  $('#zoom-reset').textContent = `${Math.round(view.z * 100)}%`;
  $('#zoom-out').disabled = view.z <= 1;
  $('#zoom-in').disabled = view.z >= MAX_ZOOM;
}

// Centre of the visible area and the visible size, in board units.
const viewCenter = () => [view.x + W / view.z / 2, view.y + H / view.z / 2];

// ---------- editing, undo, saving ----------

function stack() {
  const id = page().id;
  if (!undoStacks.has(id)) undoStacks.set(id, { past: [], future: [] });
  return undoStacks.get(id);
}

// Objects are treated as immutable, so undo history is just old arrays.
function commit(next) {
  const s = stack();
  s.past.push(objects());
  if (s.past.length > 200) s.past.shift();
  s.future = [];
  page().objects = next;
  afterEdit();
}

function undo() {
  if (drag) return;
  commitTextEditor();
  const s = stack();
  if (!s.past.length) return;
  s.future.push(objects());
  page().objects = s.past.pop();
  afterEdit();
}

function redo() {
  if (drag) return;
  commitTextEditor();
  const s = stack();
  if (!s.future.length) return;
  s.past.push(objects());
  page().objects = s.future.pop();
  afterEdit();
}

function afterEdit() {
  const ids = new Set(objects().map((o) => o.id));
  state.selection = state.selection.filter((id) => ids.has(id));
  dirtyCache = true;
  updateUndoButtons();
  updateUnlockButton();
  markDirty();
}

function updateUndoButtons() {
  const s = stack();
  $('#undo').disabled = $('[data-act="undo"]').disabled = !s.past.length;
  $('#redo').disabled = !s.future.length;
}

let saveTimer = null;
let pendingSave = null;

function markDirty() {
  state.project.updated = Date.now();
  pendingSave = state.project;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

const thumbnail = (p) => renderToCanvas(p.pages[0], 320).toDataURL('image/jpeg', 0.7);

async function flushSave() {
  clearTimeout(saveTimer);
  const p = pendingSave;
  pendingSave = null;
  if (!p) return;
  try {
    await store.saveProject(p, thumbnail(p));
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  }
}

// ---------- rendering ----------

function cacheObjects() {
  let objs = objects();
  const hide = drag?.hide;
  if (hide) objs = objs.filter((o) => !hide.has(o.id));
  if (editing?.existing) objs = objs.filter((o) => o.id !== editing.existing.id);
  return objs;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!state.project) return;
  const playing = anyPlaying();
  if (playing && now - lastRebuild > 33) dirtyCache = true;
  // While zooming, re-render at most ~10x a second; the old image is stretched in between.
  const gesture = pinch || drag?.kind === 'pan';
  if (dirtyCache && (!gesture || now - lastRebuild > 100)) {
    renderer.rebuild(page().bg, cacheObjects(), view);
    lastRebuild = now;
    dirtyCache = false;
    dirtyFrame = true;
  }
  const laserOn = laser.length > 0 && now - laser[laser.length - 1].t < LASER_MS;
  // Recording, the camera and playing clips need every frame.
  if (dirtyFrame || laserOn || laserWasOn || recorder.active || camera.on || playing) {
    renderer.frame(view, (ctx) => {
      for (const o of live) drawObject(ctx, o);
      if (instruments.protractor) drawInstrument(ctx, instruments.protractor);
      if (instruments.ruler) drawInstrument(ctx, instruments.ruler);
      if (laserOn) drawLaser(ctx, laser, now, 1 / view.z);
    }, (ctx) => camera.draw(ctx));
    drawOverlay();
    dirtyFrame = false;
  }
  if (!laserOn && drag?.kind !== 'laser') laser = [];
  laserWasOn = laserOn;
}

const selectionBox = (objs) => {
  const b = unionBounds(objs);
  const pad = 6 / k();
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
};

function onHandle(objs, x, y) {
  const b = selectionBox(objs);
  return Math.hypot(x - (b.x + b.w), y - (b.y + b.h)) <= (HANDLE + 10) / k();
}

function setIcon(button, name) {
  if (button.dataset.state === name) return;
  button.innerHTML = icon(name);
  button.dataset.state = name;
}

// Selection UI lives on its own canvas so it never shows up in recordings.
function drawOverlay() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, W, H);
  setView(octx, view);
  const u = 1 / k(); // board units per CSS px
  octx.lineWidth = 2 * u;
  if (drag?.kind === 'erase' && drag.last) {
    octx.beginPath();
    octx.arc(drag.last[0], drag.last[1], sizeFor('eraser') / 2, 0, Math.PI * 2);
    octx.strokeStyle = 'rgba(0,0,0,.35)';
    octx.stroke();
  }
  if (drag?.kind === 'lasso' && drag.pts.length > 1) {
    octx.beginPath();
    drag.pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.closePath();
    octx.fillStyle = 'rgba(30,102,245,.07)';
    octx.fill();
    octx.setLineDash([6 * u, 5 * u]);
    octx.strokeStyle = '#1e66f5';
    octx.stroke();
    octx.setLineDash([]);
  }
  const moving = drag && (drag.kind === 'move' || drag.kind === 'resize');
  const objs = moving ? drag.results || drag.origs : state.tool === 'select' ? selectedObjs() : [];
  if (!objs.length) {
    selbar.hidden = true;
    return;
  }
  const b = selectionBox(objs);
  octx.strokeStyle = '#1e66f5';
  octx.setLineDash([8 * u, 6 * u]);
  octx.strokeRect(b.x, b.y, b.w, b.h);
  octx.setLineDash([]);
  octx.beginPath();
  octx.arc(b.x + b.w, b.y + b.h, HANDLE * u, 0, Math.PI * 2);
  octx.fillStyle = '#fff';
  octx.fill();
  octx.stroke();

  selbar.hidden = !!drag;
  if (drag) return;
  const single = objs.length === 1 ? objs[0] : null;
  $('#sel-edit').hidden = single?.type !== 'text';
  $('#sel-play').hidden = single?.type !== 'video';
  if (single?.type === 'video') setIcon($('#sel-play'), isPlaying(single) ? 'pause' : 'play');
  const pw = W * scale, ph = H * scale;
  const left = (b.x + b.w / 2 - view.x) * k();
  const top = (b.y - view.y) * k(), bottom = (b.y + b.h - view.y) * k();
  let y, below;
  if (top > 56) [y, below] = [top - 8, false];
  else if (bottom + 56 < ph) [y, below] = [bottom + 8, true];
  else [y, below] = [Math.max(top, 0) + 8, true];
  const half = selbar.offsetWidth / 2 + 4;
  selbar.classList.toggle('below', below);
  selbar.style.left = `${Math.min(Math.max(left, half), pw - half)}px`;
  selbar.style.top = `${y}px`;
}

// ---------- pointer input ----------

function canvasPoint(e) {
  const r = paper.getBoundingClientRect();
  return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
}
const toBoard = ([cx, cy]) => [view.x + cx / view.z, view.y + cy / view.z];
const boardPoint = (e) => toBoard(canvasPoint(e));

function instrumentHit(x, y) {
  for (const inst of [instruments.ruler, instruments.protractor]) {
    if (!inst) continue;
    const part = hitInstrument(inst, x, y, 1 / k());
    if (part) return { inst, part };
  }
  return null;
}

function cancelDrag() {
  drag = null;
  live = [];
  dirtyCache = dirtyFrame = true;
}

function startPinch() {
  if (drag?.touch) cancelDrag();
  const ids = [...touches.keys()].slice(0, 2);
  const [a, b] = ids.map((id) => touches.get(id));
  pinch = {
    ids,
    d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
    m0: canvasPoint({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 }),
    v0: { ...view },
  };
}

function updatePinch() {
  const [a, b] = pinch.ids.map((id) => touches.get(id));
  const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const m = canvasPoint({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 });
  const { v0, m0 } = pinch;
  const z = Math.min(MAX_ZOOM, Math.max(1, (v0.z * d) / pinch.d0));
  setViewTo(z, v0.x + m0[0] / v0.z - m[0] / z, v0.y + m0[1] / v0.z - m[1] / z);
}

function onPointerDown(e) {
  if (!state.project || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2 && !pinch) {
      e.preventDefault();
      startPinch();
      return;
    }
    if (touches.size > 2 || pinch) return;
  }
  if (drag) return;
  if (e.pointerType === 'pen') penSeen = true;
  e.preventDefault();
  commitTextEditor();
  closeMenus();
  paper.setPointerCapture(e.pointerId);
  const c = canvasPoint(e);
  const [x, y] = toBoard(c);
  const base = { pointerId: e.pointerId, touch: e.pointerType === 'touch' };

  // The camera bubble and the ruler/protractor can be moved with any tool.
  if (camera.hit(...c)) {
    drag = { ...base, kind: 'camera', dx: camera.x - c[0], dy: camera.y - c[1], c0: c, moved: false };
    return;
  }
  const inst = instrumentHit(x, y);
  if (inst && inst.part !== 'edge') {
    drag = inst.part === 'handle'
      ? { ...base, kind: 'rotate', inst: inst.inst, r: startRotate(inst.inst, x, y) }
      : { ...base, kind: 'instrument', inst: inst.inst, dx: inst.inst.x - x, dy: inst.inst.y - y };
    return;
  }
  // With a stylus in use, a finger pans instead of drawing (palm rejection).
  if (penSeen && e.pointerType === 'touch' && state.tool !== 'select') {
    drag = { ...base, kind: 'pan', c0: c, v0: { ...view } };
    return;
  }

  switch (state.tool) {
    case 'pen':
    case 'highlighter': {
      const snap = inst?.part === 'edge' ? inst.inst : null;
      const [px, py] = snap ? snapToEdge(snap, x, y) : [x, y];
      const o = {
        id: uid(), type: 'stroke', tool: state.tool, color: state.color,
        size: sizeFor(state.tool), points: [round1(px), round1(py), pressure(e)],
      };
      live = [o];
      drag = { ...base, kind: 'stroke', obj: o, snap };
      break;
    }
    case 'eraser':
      drag = { ...base, kind: 'erase', hide: new Set(), last: null };
      eraseTo(x, y);
      break;
    case 'shape': {
      const o = {
        id: uid(), type: 'shape', kind: state.shape, color: state.color, size: sizeFor('shape'),
        x1: x, y1: y, x2: x, y2: y, ...(state.fill !== 'none' && { fill: state.fill }), ...(state.dash && { dash: true }),
      };
      live = [o];
      drag = { ...base, kind: 'shape', obj: o };
      break;
    }
    case 'laser':
      laser.push({ x, y, t: performance.now(), brk: true });
      drag = { ...base, kind: 'laser' };
      break;
    case 'text':
      drag = { ...base, kind: 'text' };
      break;
    case 'select': {
      const sel = selectedObjs();
      if (sel.length && onHandle(sel, x, y)) {
        drag = { ...base, kind: 'resize', origs: sel, box: selectionBox(sel), hide: new Set(state.selection) };
        live = sel;
        dirtyCache = true;
        break;
      }
      const hit = hitTest(objects(), x, y, 12 / k(), (o) => !o.locked);
      if (hit) {
        const wasOnly = state.selection.length === 1 && state.selection[0] === hit.id;
        if (!state.selection.includes(hit.id)) state.selection = [hit.id];
        const origs = selectedObjs();
        drag = {
          ...base, kind: 'move', origs, x0: x, y0: y, moved: false,
          tapTarget: wasOnly ? hit : null, hide: new Set(state.selection),
        };
        live = origs;
        dirtyCache = true;
      } else {
        state.selection = [];
        drag = { ...base, kind: 'lasso', pts: [[x, y]] };
      }
      break;
    }
  }
  dirtyFrame = true;
}

function onPointerMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch) {
    if (pinch.ids.includes(e.pointerId)) updatePinch();
    return;
  }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const coalesced = e.getCoalescedEvents?.() ?? [];
  for (const ev of coalesced.length ? coalesced : [e]) {
    const c = canvasPoint(ev);
    const [x, y] = toBoard(c);
    switch (drag.kind) {
      case 'stroke': {
        const [px, py] = drag.snap ? snapToEdge(drag.snap, x, y) : [x, y];
        const p = drag.obj.points;
        if (Math.hypot(px - p[p.length - 3], py - p[p.length - 2]) < 1.5 / view.z) break;
        p.push(round1(px), round1(py), pressure(ev));
        break;
      }
      case 'shape':
        drag.obj.x2 = x;
        drag.obj.y2 = y;
        break;
      case 'erase':
        eraseTo(x, y);
        break;
      case 'laser':
        laser.push({ x, y, t: performance.now() });
        break;
      case 'move': {
        const dx = x - drag.x0, dy = y - drag.y0;
        if (Math.hypot(dx, dy) * k() > 3) drag.moved = true;
        if (drag.moved) live = drag.results = drag.origs.map((o) => transformObj(o, 0, 0, 1, dx, dy));
        break;
      }
      case 'resize': {
        const b = drag.box;
        const s = Math.max(0.05, (x - b.x + (y - b.y)) / (b.w + b.h));
        live = drag.results = drag.origs.map((o) => transformObj(o, b.x, b.y, s, 0, 0));
        break;
      }
      case 'lasso':
        drag.pts.push([x, y]);
        break;
      case 'pan': {
        const { v0, c0 } = drag;
        setViewTo(v0.z, v0.x - (c[0] - c0[0]) / v0.z, v0.y - (c[1] - c0[1]) / v0.z);
        break;
      }
      case 'camera':
        camera.moveTo(c[0] + drag.dx, c[1] + drag.dy);
        if (Math.hypot(c[0] - drag.c0[0], c[1] - drag.c0[1]) > 8) drag.moved = true;
        break;
      case 'instrument':
        drag.inst.x = x + drag.dx;
        drag.inst.y = y + drag.dy;
        break;
      case 'rotate':
        rotateTo(drag.inst, drag.r, x, y);
        break;
    }
  }
  if (laser.length > 400) laser = laser.slice(-200);
  dirtyFrame = true;
}

function onPointerUp(e) {
  if (e.pointerType === 'touch') touches.delete(e.pointerId);
  if (pinch) {
    if (pinch.ids.includes(e.pointerId)) {
      pinch = null;
      dirtyCache = true;
    }
    return;
  }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  live = [];
  dirtyCache = dirtyFrame = true;
  const objs = objects();
  switch (d.kind) {
    case 'stroke':
      commit([...objs, d.obj]);
      break;
    case 'shape':
      if (Math.hypot(d.obj.x2 - d.obj.x1, d.obj.y2 - d.obj.y1) > 4 / view.z) commit([...objs, d.obj]);
      break;
    case 'erase':
      if (d.hide.size) commit(objs.filter((o) => !d.hide.has(o.id)));
      break;
    case 'move':
      if (d.moved && d.results) commit(replaceMany(objs, d.results));
      else if (d.tapTarget?.type === 'text') openTextEditor(d.tapTarget);
      else if (d.tapTarget?.type === 'video') togglePlay(d.tapTarget);
      break;
    case 'resize':
      if (d.results) commit(replaceMany(objs, d.results));
      break;
    case 'lasso':
      finishLasso(d.pts);
      break;
    case 'text': {
      const [x, y] = boardPoint(e);
      openTextEditor(hitTest(objs, x, y, 12 / k(), (o) => o.type === 'text' && !o.locked), x, y);
      break;
    }
    case 'camera':
      if (!d.moved) camera.cycleSize();
      break;
  }
}

function onPointerCancel(e) {
  if (e.pointerType === 'touch') touches.delete(e.pointerId);
  if (pinch?.ids.includes(e.pointerId)) {
    pinch = null;
    dirtyCache = true;
  }
  if (drag && e.pointerId === drag.pointerId) cancelDrag();
}

function finishLasso(pts) {
  const b = unionBounds(pts.map(([x, y]) => ({ x, y, w: 0, h: 0 })));
  if (pts.length < 3 || (b.w + b.h) * k() < 12) {
    state.selection = [];
    return;
  }
  state.selection = objects()
    .filter((o) => {
      if (o.locked) return false;
      const ob = bounds(o);
      return pointInPolygon(ob.x + ob.w / 2, ob.y + ob.h / 2, pts);
    })
    .map((o) => o.id);
}

// Erases along the path since the last point so fast swipes don't skip.
// Images, videos and locked items are skipped (use the select tool for those).
function eraseTo(x, y) {
  const r = Math.max(sizeFor('eraser') / 2, 4);
  const pts = [];
  if (drag.last) {
    const [lx, ly] = drag.last;
    const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (r / 2)));
    for (let i = 1; i <= n; i++) pts.push([lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n]);
  } else {
    pts.push([x, y]);
  }
  drag.last = [x, y];
  for (const o of objects()) {
    if (o.type === 'image' || o.type === 'video' || o.locked || drag.hide.has(o.id)) continue;
    if (pts.some(([px, py]) => hitObject(o, px, py, r, true))) {
      drag.hide.add(o.id);
      dirtyCache = true;
    }
  }
}

// ---------- text ----------

function openTextEditor(existing, x = 0, y = 0) {
  commitTextEditor();
  const size = existing?.size ?? sizeFor('text');
  editing = {
    existing,
    size,
    color: existing?.color ?? state.color,
    x: existing ? existing.x : x,
    y: existing ? existing.y : Math.max(0, y - size * 0.6),
  };
  editor.value = existing?.text ?? '';
  editor.hidden = false;
  styleEditor();
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(editor.value.length, editor.value.length);
  dirtyCache = true;
}

function styleEditor() {
  const e = editing;
  editor.style.left = `${(e.x - view.x) * k()}px`;
  editor.style.top = `${(e.y - view.y) * k()}px`;
  editor.style.fontSize = `${e.size * k()}px`;
  editor.style.lineHeight = String(LINE_HEIGHT);
  editor.style.fontFamily = FONT;
  editor.style.color = e.color;
  autosizeEditor();
}

function autosizeEditor() {
  if (!editing) return;
  const m = measureText(editor.value || 'M', editing.size);
  editor.style.width = `${(m.w + editing.size) * k()}px`;
  editor.style.height = `${m.h * k() + 2}px`;
}

function commitTextEditor(cancel = false) {
  if (!editing || !state.project) return;
  const e = editing;
  editing = null;
  const text = editor.value.replace(/\s+$/, '');
  editor.hidden = true;
  editor.blur();
  dirtyCache = true;
  if (cancel) return;
  const objs = objects();
  if (e.existing) {
    if (!text) commit(objs.filter((o) => o.id !== e.existing.id));
    else if (text !== e.existing.text || e.color !== e.existing.color || e.size !== e.existing.size) {
      const m = measureText(text, e.size);
      commit(replaceMany(objs, [{ ...e.existing, text, color: e.color, size: e.size, w: m.w, h: m.h }]));
    }
  } else if (text) {
    const m = measureText(text, e.size);
    commit([...objs, { id: uid(), type: 'text', x: e.x, y: e.y, text, size: e.size, color: e.color, w: m.w, h: m.h }]);
  }
}

// ---------- toolbars ----------

function setTool(tool) {
  commitTextEditor();
  state.tool = tool;
  if (tool !== 'select') state.selection = [];
  for (const b of $$('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
  paper.dataset.tool = tool;
  updateSizes();
  dirtyFrame = true;
}

function updateShapeMenu() {
  $('#shapebtn').innerHTML = icon(state.shape);
  for (const b of $$('[data-shape]')) b.classList.toggle('active', b.dataset.shape === state.shape);
  for (const b of $$('[data-fill]')) b.classList.toggle('active', b.dataset.fill === state.fill);
  $('#dashbtn').classList.toggle('active', state.dash);
}

// Applies a change to the selected objects that accept it.
function restyleSelection(accepts, change) {
  if (state.tool !== 'select') return;
  const changed = selectedObjs().filter(accepts).map((o) => ({ ...o, ...change }));
  if (changed.length) commit(replaceMany(objects(), changed));
}

function pickColor(c) {
  state.color = c;
  updatePalette();
  if (editing) {
    editing.color = c;
    editor.style.color = c;
    return;
  }
  restyleSelection((o) => o.type !== 'image' && o.type !== 'video' && o.color !== c, { color: c });
}

function buildPalette(container, colors, withCustom) {
  for (const c of colors) {
    container.append(el('button', {
      class: 'swatch', style: `--c:${c}`, 'data-color': c, title: c, 'aria-label': `Colour ${c}`,
      onclick: () => pickColor(c),
    }));
  }
  if (withCustom) {
    container.append(el('label', { class: 'swatch custom', title: 'Custom colour' },
      el('input', { type: 'color', value: '#000000', 'aria-label': 'Custom colour', onchange: (e) => pickColor(e.target.value) })));
  }
}

function updatePalette() {
  for (const b of $$('.swatch[data-color]')) b.classList.toggle('active', b.dataset.color === state.color);
  $('.swatch.custom').classList.toggle('active', !COLORS.includes(state.color));
}

function updateSizes() {
  $('#sizes').classList.toggle('disabled', !SIZES[state.tool]);
  for (const b of $$('#sizes .size')) b.classList.toggle('active', +b.dataset.size === state.sizeIndex);
}

function closeMenus() {
  for (const m of $$('.menu')) m.hidden = true;
}

function toggleMenu(menu, anchor) {
  const wasOpen = !menu.hidden;
  closeMenus();
  if (wasOpen) return;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - m.width / 2), innerWidth - m.width - 8);
  let top = r.bottom + 6;
  if (top + m.height > innerHeight - 8) top = r.top - m.height - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

// Size that fits within `frac` of the visible area, centred in it.
function placeInView(w, h, frac = 0.6) {
  const vw = W / view.z, vh = H / view.z;
  const f = Math.min((vw * frac) / w, (vh * frac) / h, 1 / view.z);
  const [cx, cy] = viewCenter();
  return { x: cx - (w * f) / 2, y: cy - (h * f) / 2, w: w * f, h: h * f };
}

async function insertImage(file) {
  if (!file || !state.project) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Downscale big photos so boards stay small.
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const src = /png|gif|webp|svg/.test(file.type) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    const o = { id: uid(), type: 'image', src, ...placeInView(c.width, c.height) };
    commit([...objects(), o]);
    setTool('select');
    state.selection = [o.id];
  } catch {
    toast("Couldn't open that image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// PDF -> board pages, each with the PDF page as a locked image. Null if it failed.
async function pdfPages(data) {
  busy('Opening PDF…');
  try {
    const { images, truncated, total } = await pdfToImages(data, (i, n) => busy(`Importing page ${i} of ${n}…`));
    if (truncated) toast(`Only the first ${MAX_PAGES} of ${total} pages were imported.`);
    return images.map((im) => ({
      id: uid(),
      bg: 'white',
      objects: [{ id: uid(), type: 'image', src: im.src, x: (W - im.w) / 2, y: (H - im.h) / 2, w: im.w, h: im.h, locked: true }],
    }));
  } catch (err) {
    toast(err.name === 'PasswordException' ? 'That PDF is password-protected.' : `Couldn't read that PDF. ${err.message || ''}`);
    return null;
  } finally {
    unbusy();
  }
}

// Inserts PDF pages after the current page (replacing it if it's empty).
async function insertPdf(data) {
  const pages = await pdfPages(data);
  if (!pages?.length) return;
  const all = state.project.pages;
  const replace = !objects().length;
  all.splice(state.pageIndex + (replace ? 0 : 1), replace ? 1 : 0, ...pages);
  markDirty();
  goToPage(state.pageIndex + (replace ? 0 : 1));
  toast(`Added ${pages.length} page${pages.length === 1 ? '' : 's'}. PDF pages are locked; unlock them from the Pages panel.`);
}

async function insertVideo(file) {
  if (!file || !state.project) return;
  if (file.size > MAX_VIDEO_MB * 1048576) {
    toast(`That video is over ${MAX_VIDEO_MB} MB. Trim it or use a shorter clip.`);
    return;
  }
  busy('Adding video…');
  try {
    const info = await probeVideo(file);
    const mediaId = uid();
    await store.putMedia({ id: mediaId, project: state.project.id, blob: file, type: file.type });
    const o = { id: uid(), type: 'video', mediaId, poster: info.poster, ...placeInView(info.width, info.height) };
    commit([...objects(), o]);
    setTool('select');
    state.selection = [o.id];
    toast('Tap the video to play it. Its sound is included in recordings.');
  } catch (err) {
    toast(err.message || "Couldn't add that video.");
  } finally {
    unbusy();
  }
}

function toggleInstrument(kind) {
  if (instruments[kind]) {
    instruments[kind] = null;
  } else {
    const [cx, cy] = viewCenter();
    const inst = kind === 'ruler' ? newRuler() : newProtractor();
    inst.x = kind === 'ruler' ? cx - 600 : cx;
    inst.y = kind === 'ruler' ? cy + 60 : cy + 160;
    instruments[kind] = inst;
  }
  for (const b of $$('[data-insert="ruler"], [data-insert="protractor"]')) {
    b.classList.toggle('on', !!instruments[b.dataset.insert]);
  }
  dirtyFrame = true;
}

// ---------- selection actions ----------

function deleteSelected() {
  const ids = new Set(state.selection);
  if (!ids.size) return;
  state.selection = [];
  commit(objects().filter((o) => !ids.has(o.id)));
}

function duplicateSelected() {
  const copies = selectedObjs().map((o) => transformObj({ ...o, id: uid() }, 0, 0, 1, 30, 30));
  if (!copies.length) return;
  commit([...objects(), ...copies]);
  state.selection = copies.map((o) => o.id);
}

function bringToFront() {
  const ids = new Set(state.selection);
  if (!ids.size) return;
  commit([...objects().filter((o) => !ids.has(o.id)), ...objects().filter((o) => ids.has(o.id))]);
}

function lockSelected() {
  const changed = selectedObjs().map((o) => ({ ...o, locked: true }));
  if (!changed.length) return;
  state.selection = [];
  commit(replaceMany(objects(), changed));
  toast('Locked. Unlock from the Pages panel.');
}

function unlockAll() {
  const changed = objects().filter((o) => o.locked).map(({ locked, ...o }) => o);
  if (changed.length) commit(replaceMany(objects(), changed));
}

function updateUnlockButton() {
  const n = state.project ? objects().filter((o) => o.locked).length : 0;
  const b = $('#unlock-all');
  b.hidden = !n;
  b.querySelector('.label').textContent = `Unlock ${n} locked item${n === 1 ? '' : 's'}`;
}

// ---------- pages ----------

function addPage() {
  commitTextEditor();
  state.project.pages.splice(state.pageIndex + 1, 0, newPage(page().bg));
  markDirty();
  goToPage(state.pageIndex + 1);
}

function duplicatePage(i) {
  const src = state.project.pages[i];
  const copy = { id: uid(), bg: src.bg, objects: src.objects.map((o) => ({ ...o, id: uid() })) };
  state.project.pages.splice(i + 1, 0, copy);
  markDirty();
  goToPage(i + 1);
}

function deletePage(i) {
  const pages = state.project.pages;
  if (pages.length === 1) {
    if (pages[0].objects.length && confirm('Clear everything on this page?')) commit([]);
    return;
  }
  if (pages[i].objects.length && !confirm(`Delete page ${i + 1}?`)) return;
  undoStacks.delete(pages[i].id);
  pages.splice(i, 1);
  markDirty();
  goToPage(state.pageIndex > i || state.pageIndex >= pages.length ? state.pageIndex - 1 : state.pageIndex);
}

function movePage(i, delta) {
  const pages = state.project.pages;
  const j = i + delta;
  if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  if (state.pageIndex === i) state.pageIndex = j;
  else if (state.pageIndex === j) state.pageIndex = i;
  markDirty();
  pageChanged();
}

function setBackground(bg) {
  page().bg = bg;
  dirtyCache = true;
  markDirty();
  renderPagesPanel();
}

function renderPagesPanel() {
  updateUnlockButton();
  if ($('#pages').hidden || !state.project) return;
  $('#bgchoices').replaceChildren(...BACKGROUNDS.map((b) =>
    el('button', { class: b.id === page().bg ? 'active' : '', onclick: () => setBackground(b.id) }, b.label)));
  const pages = state.project.pages;
  $('#pagelist').replaceChildren(...pages.map((p, i) =>
    el('div', { class: `pagecard${i === state.pageIndex ? ' current' : ''}` },
      el('button', { class: 'go', 'aria-label': `Go to page ${i + 1}`, onclick: () => goToPage(i) },
        el('span', { class: 'num' }, String(i + 1)), renderToCanvas(p, 380)),
      el('div', { class: 'ops' },
        iconBtn('up', 'Move up', () => movePage(i, -1)),
        iconBtn('down', 'Move down', () => movePage(i, 1)),
        iconBtn('copy', 'Duplicate page', () => duplicatePage(i)),
        iconBtn('trash', 'Delete page', () => deletePage(i))))));
  $('#pagelist .current')?.scrollIntoView({ block: 'nearest' });
}

// ---------- presentation mode ----------

function enterPresent() {
  commitTextEditor();
  closeMenus();
  $('#pages').hidden = true;
  document.body.classList.add('presenting');
  // On iPad the full-screen Web Clip already hides Safari; elsewhere use the Fullscreen API.
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (request && !isStandalone()) {
    try {
      request.call(root)?.catch?.(() => {});
    } catch {}
  }
}

function exitPresent() {
  if (!document.body.classList.contains('presenting')) return;
  document.body.classList.remove('presenting');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {});
  }
}

function onFullscreenChange() {
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  // Leaving full screen with Esc or the browser's own control ends the presentation.
  if (!fs && presentFs) document.body.classList.remove('presenting');
  presentFs = fs;
}

// ---------- camera ----------

async function toggleCamera() {
  if (camera.on) {
    camera.stop();
  } else if (!CameraBubble.supported()) {
    toast('The camera is not available in this browser.');
  } else {
    try {
      await camera.start();
      toast('Drag the camera bubble to move it; tap it to change its size.');
    } catch {
      toast('Camera not available, or permission was denied.');
    }
  }
  $('#camera').classList.toggle('active', camera.on);
  dirtyFrame = true;
}

// ---------- recording ----------

let recTimer = null;
let chunkWarned = false;

function updateRecUi() {
  const on = recorder.active;
  for (const b of $$('[data-rec="start"]')) b.hidden = on;
  for (const t of $$('[data-rec="time"]')) {
    t.hidden = !on;
    t.textContent = fmtTime(recorder.elapsed());
  }
  for (const b of $$('[data-rec="pause"]')) {
    b.hidden = !on;
    setIcon(b, recorder.paused ? 'play' : 'pause');
    b.title = recorder.paused ? 'Resume recording' : 'Pause recording';
  }
  for (const b of $$('[data-rec="stop"]')) b.hidden = !on;
  document.body.classList.toggle('rec-paused', recorder.paused);
}

async function startRecording() {
  if (recorder.active) return;
  if (!Recorder.supported(canvas)) {
    toast('Recording is not supported in this browser.');
    return;
  }
  commitTextEditor();
  const mixer = audioMixer(); // created during the tap, as Safari requires
  const id = uid();
  const meta = {
    id, name: `${state.project.name} ${stamp()}`, project: state.project.id,
    created: Date.now(), status: 'recording', duration: 0, size: 0, type: '',
  };
  chunkWarned = false;
  try {
    const { mic, type } = await recorder.start(canvas, {
      mixer,
      onChunk: (blob, seq) => {
        meta.size += blob.size;
        store.putChunk(id, seq, blob).catch(() => {
          if (!chunkWarned) toast('Storage is full: this recording is only kept in memory until you save it.');
          chunkWarned = true;
        });
        meta.duration = recorder.elapsed();
        store.putRecording({ ...meta }).catch(() => {});
      },
    });
    meta.type = type;
    recMeta = meta;
    store.putRecording({ ...meta }).catch(() => {});
    if (!mic) toast('No microphone access. Recording without your voice.');
  } catch (err) {
    toast(`Could not start recording: ${err.message}`);
    return;
  }
  dirtyFrame = true;
  updateRecUi();
  recTimer = setInterval(updateRecUi, 250);
}

function togglePause() {
  if (recorder.paused) recorder.resume();
  else recorder.pause();
  updateRecUi();
}

async function stopRecording() {
  clearInterval(recTimer);
  const blob = await recorder.stop();
  updateRecUi();
  if (!blob || !recMeta) return;
  const meta = { ...recMeta, status: 'done', duration: recorder.duration, size: blob.size, type: blob.type || recMeta.type };
  recMeta = null;
  await store.putRecording(meta).catch(() => {});
  showRecording(meta, blob);
}

function showRecording(meta, blob) {
  const dlg = $('#recdialog');
  const video = $('#recvideo');
  const url = URL.createObjectURL(blob);
  const ext = extFor(blob.type || meta.type);
  const filename = `${safeName(meta.name)}.${ext}`;
  $('#rectitle').textContent = meta.name;
  video.src = url;
  $('#recinfo').textContent = [
    fmtTime(meta.duration || 0), fmtSize(blob.size), ext.toUpperCase(),
    meta.status === 'recovered' ? 'recovered after an interruption' : 'kept on this device until you delete it',
  ].join(' · ');
  $('#recdrive').hidden = true;
  $('#recsave').onclick = () => saveBlob(blob, filename);
  $('#recdrivebtn').onclick = () => uploadToDrive(blob, filename, (res) => showDriveLinks($('#recdrive'), res, meta.name));
  $('#recdelete').onclick = async () => {
    if (!confirm('Delete this recording from this device?')) return;
    await store.deleteRecording(meta.id).catch(() => {});
    dlg.close();
  };
  $('#recdone').onclick = () => dlg.close();
  dlg.onclose = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    if (!state.project) renderHome();
  };
  dlg.showModal();
}

// Recordings still marked "recording" were cut off (closed tab, crash, battery).
async function recoverRecordings() {
  let recovered = 0;
  for (const r of await store.listRecordings()) {
    if (r.status !== 'recording') continue;
    const blob = await store.recordingBlob(r.id, r.type);
    if (!blob.size) {
      await store.deleteRecording(r.id);
      continue;
    }
    await store.putRecording({ ...r, status: 'recovered', size: blob.size });
    recovered++;
  }
  if (recovered) toast('A recording that was interrupted has been recovered. It is listed under Recordings.');
}

// ---------- export ----------

async function pdfBlob() {
  const p = state.project;
  await ensureImages(p.pages);
  const images = [];
  for (const pg of p.pages) {
    const blob = await canvasToBlob(renderToCanvas(pg, W), 'image/jpeg', 0.9);
    images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H });
  }
  return jpegPagesToPdf(images);
}

async function runExport(kind) {
  closeMenus();
  commitTextEditor();
  const p = state.project;
  const name = safeName(p.name);
  if (kind === 'drive-board' || kind === 'drive-pdf') {
    const blobPromise = kind === 'drive-board' ? projectFileBlob(p) : pdfBlob();
    if (kind === 'drive-board') {
      uploadToDrive(blobPromise, `${name}.json`, (res) => {
        p.driveId = res.id;
        markDirty();
        toast('Board saved to Google Drive (PSD Whiteboard folder).');
      }, { fileId: p.driveId });
    } else {
      uploadToDrive(blobPromise, `${name}.pdf`, (res) => showShareDialog(res, p.name));
    }
    return;
  }
  busy('Preparing…');
  try {
    if (kind === 'png') {
      await ensureImages([page()]);
      const blob = await canvasToBlob(renderToCanvas(page(), W), 'image/png');
      unbusy();
      await saveBlob(blob, `${name} - page ${state.pageIndex + 1}.png`);
    } else if (kind === 'pdf') {
      const blob = await pdfBlob();
      unbusy();
      await saveBlob(blob, `${name}.pdf`);
    } else if (kind === 'file') {
      const blob = await projectFileBlob(p);
      unbusy();
      await saveBlob(blob, `${name}.json`);
    }
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  } finally {
    unbusy();
  }
}

// ---------- Google Drive ----------

// Signs in first (straight from the tap, so the popup isn't blocked), then uploads.
async function uploadToDrive(blobOrPromise, filename, onDone, { fileId = null } = {}) {
  const auth = drive.signIn();
  busy('Saving to Google Drive…');
  try {
    await auth;
    const blob = await blobOrPromise;
    let res;
    try {
      res = await drive.upload(blob, filename, { fileId });
    } catch (err) {
      if (!fileId) throw err;
      res = await drive.upload(blob, filename); // the old Drive copy is gone; make a new one
    }
    unbusy();
    onDone(res);
  } catch (err) {
    toast(err.message);
  } finally {
    unbusy();
  }
}

function showDriveLinks(container, res, title) {
  container.replaceChildren(
    el('span', {}, 'Saved to Google Drive.'),
    el('a', { href: res.webViewLink, target: '_blank', rel: 'noopener' }, 'Open in Drive'),
    el('a', { href: drive.classroomShareUrl(res.webViewLink, title), target: '_blank', rel: 'noopener' }, 'Share to Google Classroom'));
  container.hidden = false;
}

function showShareDialog(res, title) {
  const links = el('p', { class: 'drive-result' });
  const dlg = el('dialog', {},
    el('h2', {}, title),
    links,
    el('div', { class: 'dlg-actions' }, el('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Done')));
  showDriveLinks(links, res, title);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// Picks a file from Drive. For a board, `onBoard` decides where it goes.
async function pickFromDrive({ intoBoard }) {
  const auth = drive.signIn();
  let file;
  try {
    await auth;
    file = await drive.pick();
  } catch (err) {
    toast(err.message);
    return;
  }
  if (!file) return;
  busy(`Downloading ${file.name}…`);
  let blob;
  try {
    blob = await drive.download(file);
  } catch (err) {
    unbusy();
    toast(err.message);
    return;
  }
  unbusy();
  const asFile = new File([blob], file.name, { type: blob.type || file.mimeType });
  if (!intoBoard) {
    importFile(asFile, { driveId: file.mimeType === 'application/json' ? file.id : null });
  } else if (isPdf(asFile)) {
    insertPdf(await blob.arrayBuffer());
  } else if (asFile.type.startsWith('image/')) {
    insertImage(asFile);
  } else {
    toast('To open a board file, use Google Drive on the home screen.');
  }
}

// ---------- wiring ----------

function wire() {
  for (const node of $$('[data-icon]')) node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon));
  document.body.classList.toggle('drive-off', !drive.driveEnabled());

  $('#new').onclick = () => createProject();
  $('#import').onclick = () => $('#importFile').click();
  $('#home-drive').onclick = () => pickFromDrive({ intoBoard: false });
  $('#importFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  };

  $('#home-btn').onclick = showHome;
  $('#title').onclick = () => {
    const name = askName(state.project.name);
    if (!name) return;
    state.project.name = name;
    $('#title').textContent = name;
    markDirty();
  };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#prev').onclick = () => goToPage(state.pageIndex - 1);
  $('#next').onclick = () => goToPage(state.pageIndex + 1);
  $('#addpage').onclick = addPage;
  $('#pagelabel').onclick = () => {
    $('#pages').hidden = !$('#pages').hidden;
    renderPagesPanel();
  };
  $('#pages-close').onclick = () => { $('#pages').hidden = true; };
  $('#pages-add').onclick = addPage;
  $('#unlock-all').onclick = unlockAll;
  $('#camera').onclick = toggleCamera;
  $('#present').onclick = enterPresent;

  for (const b of $$('[data-rec="start"]')) b.onclick = startRecording;
  for (const b of $$('[data-rec="pause"]')) b.onclick = togglePause;
  for (const b of $$('[data-rec="stop"]')) b.onclick = stopRecording;
  $('#export').onclick = (e) => toggleMenu($('#exportmenu'), e.currentTarget);
  for (const b of $$('[data-export]')) b.onclick = () => runExport(b.dataset.export);

  for (const b of $$('.tool:not(#shapebtn)')) b.onclick = () => setTool(b.dataset.tool);
  $('#shapebtn').onclick = (e) => {
    // With shapes selected, the menu restyles them instead of switching tools.
    if (!(state.tool === 'select' && selectedObjs().some(isClosedShape))) setTool('shape');
    toggleMenu($('#shapemenu'), e.currentTarget);
  };
  for (const b of $$('[data-shape]')) {
    b.onclick = () => {
      state.shape = b.dataset.shape;
      setTool('shape');
      updateShapeMenu();
      closeMenus();
    };
  }
  for (const b of $$('[data-fill]')) {
    b.onclick = () => {
      state.fill = b.dataset.fill;
      updateShapeMenu();
      restyleSelection(isClosedShape, { fill: state.fill });
    };
  }
  $('#dashbtn').onclick = () => {
    state.dash = !state.dash;
    updateShapeMenu();
    restyleSelection((o) => o.type === 'shape', { dash: state.dash });
  };

  $('#insertbtn').onclick = (e) => toggleMenu($('#insertmenu'), e.currentTarget);
  for (const b of $$('[data-insert]')) {
    b.onclick = () => {
      closeMenus();
      const kind = b.dataset.insert;
      if (kind === 'image') $('#imageFile').click();
      else if (kind === 'pdf') $('#pdfFile').click();
      else if (kind === 'video') $('#videoFile').click();
      else if (kind === 'drive') pickFromDrive({ intoBoard: true });
      else toggleInstrument(kind);
    };
  }
  const onFile = (input, fn) => {
    input.onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) fn(f);
    };
  };
  onFile($('#imageFile'), insertImage);
  onFile($('#pdfFile'), async (f) => insertPdf(await f.arrayBuffer()));
  onFile($('#videoFile'), insertVideo);

  for (const b of $$('#sizes .size')) {
    b.onclick = () => {
      state.sizeIndex = +b.dataset.size;
      updateSizes();
      if (editing) {
        editing.size = sizeFor('text');
        styleEditor();
      }
    };
  }

  $('#zoom-in').onclick = () => zoomAt(1.25);
  $('#zoom-out').onclick = () => zoomAt(0.8);
  $('#zoom-reset').onclick = () => setViewTo(1, 0, 0);

  $('#sel-edit').onclick = () => {
    const [o] = selectedObjs();
    if (o?.type === 'text') openTextEditor(o);
  };
  $('#sel-play').onclick = () => {
    const [o] = selectedObjs();
    if (o?.type === 'video') togglePlay(o);
  };
  $('#sel-copy').onclick = duplicateSelected;
  $('#sel-front').onclick = bringToFront;
  $('#sel-lock').onclick = lockSelected;
  $('#sel-delete').onclick = deleteSelected;

  // Presentation toolbar
  $('#mini-exit').onclick = exitPresent;
  $('[data-act="undo"]').onclick = undo;
  $('[data-act="prev"]').onclick = () => goToPage(state.pageIndex - 1);
  $('[data-act="next"]').onclick = () => goToPage(state.pageIndex + 1);
  $('#mini-collapse').onclick = () => $('#mini').classList.toggle('collapsed');
  $('#mini-move').onclick = () => {
    const top = $('#mini').classList.toggle('top');
    setIcon($('#mini-move'), top ? 'tobottom' : 'totop');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  paper.addEventListener('pointerdown', onPointerDown);
  paper.addEventListener('pointermove', onPointerMove);
  paper.addEventListener('pointerup', onPointerUp);
  paper.addEventListener('pointercancel', onPointerCancel);
  paper.addEventListener('contextmenu', (e) => e.preventDefault());
  paper.addEventListener('wheel', (e) => {
    if (!state.project) return;
    e.preventDefault();
    const c = canvasPoint(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-e.deltaY * 0.01), c[0], c[1]);
    } else if (view.z > 1) {
      const f = W / paper.getBoundingClientRect().width / view.z;
      setViewTo(view.z, view.x + e.deltaX * f, view.y + e.deltaY * f);
    }
  }, { passive: false });
  // Keep taps on the selection bar and text editor from starting a gesture on the board.
  selbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  editor.addEventListener('pointerdown', (e) => e.stopPropagation());

  editor.addEventListener('input', autosizeEditor);
  editor.addEventListener('blur', () => commitTextEditor());
  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') commitTextEditor(true);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitTextEditor();
  });

  $('#busy').addEventListener('cancel', (e) => e.preventDefault());
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu, [data-menu]')) closeMenus();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!state.project || e.target.matches('input, textarea') || $('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if ((key === 'delete' || key === 'backspace') && state.selection.length) {
      e.preventDefault();
      deleteSelected();
    } else if (key === 'escape') {
      if (document.body.classList.contains('presenting')) exitPresent();
      state.selection = [];
      dirtyFrame = true;
    } else if (key === 'pagedown' || (key === 'arrowright' && !state.selection.length)) goToPage(state.pageIndex + 1);
    else if (key === 'pageup' || (key === 'arrowleft' && !state.selection.length)) goToPage(state.pageIndex - 1);
    else if (!mod && (key === '+' || key === '=')) zoomAt(1.25);
    else if (!mod && key === '-') zoomAt(0.8);
    else if (!mod && key === '0') setViewTo(1, 0, 0);
    else if (!mod && !e.altKey && KEYS[key]) setTool(KEYS[key]);
  });

  document.addEventListener('paste', (e) => {
    if (!state.project || e.target.matches?.('input, textarea')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) insertImage(item.getAsFile());
  });
  $('#stage').addEventListener('dragover', (e) => e.preventDefault());
  $('#stage').addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (isPdf(f)) insertPdf(await f.arrayBuffer());
    else if (f.type.startsWith('video/')) insertVideo(f);
    else if (f.type.startsWith('image/')) insertImage(f);
  });

  new ResizeObserver(layout).observe($('#stage'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave();
  });
  window.addEventListener('beforeunload', (e) => {
    flushSave();
    if (recorder.active) e.preventDefault();
  });
}

wire();
buildPalette($('#palette'), COLORS, true);
buildPalette($('#mini-palette'), MINI_COLORS, false);
updatePalette();
updateShapeMenu();
setTool('pen');
setImageReadyHandler(() => { dirtyCache = true; });
setVideoProvider(readyPlayer);
setMediaChangeHandler(() => { dirtyCache = dirtyFrame = true; });
drive.preloadDrive();
recoverRecordings()
  .catch(() => {})
  .then(renderHome)
  .catch((err) => toast(`Storage unavailable: ${err.message}`));
requestAnimationFrame(frame);
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
