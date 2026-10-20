// Google Drive integration (optional, see config.js). Uses the drive.file
// scope, so the app can only see files it created or that the user picks.
import { GOOGLE } from './config.js';

export const driveEnabled = () => !!GOOGLE.clientId;
export const canPick = () => !!GOOGLE.apiKey;

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'PSD Whiteboard';
const GOOGLE_TYPES = {
  'application/vnd.google-apps.presentation': true,
  'application/vnd.google-apps.document': true,
  'application/vnd.google-apps.drawing': true,
  'application/vnd.google-apps.spreadsheet': true,
};
// Office files are converted by copying them as Google files, then exporting.
const CONVERT = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
  'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
  'application/msword': 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.ms-excel': 'application/vnd.google-apps.spreadsheet',
};
export const PICKABLE = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/json',
  ...Object.keys(GOOGLE_TYPES), ...Object.keys(CONVERT),
];

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error('Could not reach Google. Check the internet connection.'));
      };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

// Load Google's scripts ahead of time: the sign-in popup must open directly
// from a tap, with no waiting in between, or browsers block it.
export function preloadDrive() {
  if (!driveEnabled()) return;
  loadScript('https://accounts.google.com/gsi/client').catch(() => {});
  loadScript('https://apis.google.com/js/api.js')
    .then(() => new Promise((r) => window.gapi.load('picker', r)))
    .catch(() => {});
}

let token = null;
let tokenExpiry = 0;
let tokenClient = null;

function getToken() {
  if (token && Date.now() < tokenExpiry - 60_000) return Promise.resolve(token);
  if (!window.google?.accounts?.oauth2) {
    preloadDrive();
    return Promise.reject(new Error('Google sign-in is still loading. Try again in a moment.'));
  }
  return new Promise((resolve, reject) => {
    tokenClient ??= window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE.clientId,
      scope: SCOPE,
      callback: () => {},
    });
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      token = resp.access_token;
      tokenExpiry = Date.now() + resp.expires_in * 1000;
      resolve(token);
    };
    tokenClient.error_callback = (err) =>
      reject(new Error(err.type === 'popup_closed' ? 'Google sign-in was closed.' : err.message || 'Google sign-in failed.'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// Call directly from a tap handler, before any other awaiting, so the Google
// sign-in popup isn't blocked. Later Drive calls reuse the token.
export const signIn = () => getToken();

async function api(path, opts = {}) {
  const t = await getToken();
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, ...opts.headers },
  });
  if (res.status === 401) token = null;
  if (!res.ok) {
    let msg = `Google Drive error ${res.status}`;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  return res;
}

async function folderId() {
  const cached = localStorage.getItem('driveFolder');
  if (cached) {
    try {
      const f = await (await api(`/drive/v3/files/${cached}?fields=id,trashed`)).json();
      if (!f.trashed) return f.id;
    } catch {}
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await (await api(`/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await api('/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = (await created.json()).id;
  }
  try {
    localStorage.setItem('driveFolder', id);
  } catch {}
  return id;
}

// Uploads (or, with fileId, replaces) a file in the "PSD Whiteboard" folder.
// Resolves to { id, webViewLink }.
export async function upload(blob, name, { fileId = null } = {}) {
  const meta = fileId ? { name } : { name, parents: [await folderId()] };
  const path = `/upload/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=resumable&fields=id,webViewLink`;
  const init = await api(path, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
    },
    body: JSON.stringify(meta),
  });
  const session = init.headers.get('Location');
  if (!session) throw new Error('Google Drive did not accept the upload.');
  const res = await fetch(session, { method: 'PUT', body: blob });
  if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
  return res.json();
}

// Opens the Google Picker. Resolves to { id, name, mimeType } or null.
export async function pick() {
  if (!GOOGLE.apiKey) throw new Error('Browsing Google Drive needs the API key in js/config.js (see README).');
  const t = await getToken();
  if (!window.google?.picker) throw new Error('Google Picker is still loading. Try again in a moment.');
  const P = window.google.picker;
  // Tabs laid out like Drive itself: browsable folders rather than one flat list.
  const view = (label) => {
    const v = new P.DocsView(P.ViewId.DOCS)
      .setMimeTypes(PICKABLE.join(','))
      .setMode(P.DocsViewMode.LIST)
      .setSelectFolderEnabled(false);
    v.setLabel?.(label);
    return v;
  };
  const views = [
    view('My Drive').setIncludeFolders(true).setParent('root'),
    view('Shared with me').setIncludeFolders(true).setOwnedByMe(false),
    view('Shared drives').setIncludeFolders(true).setEnableDrives(true),
    view('Starred').setStarred(true),
  ];
  return new Promise((resolve) => {
    const builder = new P.PickerBuilder()
      .setAppId(GOOGLE.appId)
      .setOAuthToken(t)
      .setDeveloperKey(GOOGLE.apiKey)
      .setTitle('Choose a file for your whiteboard');
    if (P.Feature?.SUPPORT_DRIVES) builder.enableFeature(P.Feature.SUPPORT_DRIVES);
    for (const v of views) builder.addView(v);
    builder
      .setCallback((d) => {
        if (d.action === P.Action.PICKED) resolve(d.docs[0]);
        else if (d.action === P.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}

// Downloads a picked file. Google Slides/Docs and Office files come back as PDF.
export async function download(file) {
  if (GOOGLE_TYPES[file.mimeType]) {
    return (await api(`/drive/v3/files/${file.id}/export?mimeType=application/pdf`)).blob();
  }
  if (CONVERT[file.mimeType]) {
    const copy = await (await api(`/drive/v3/files/${file.id}/copy?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${file.name} (converting)`, mimeType: CONVERT[file.mimeType] }),
    })).json();
    try {
      return await (await api(`/drive/v3/files/${copy.id}/export?mimeType=application/pdf`)).blob();
    } finally {
      api(`/drive/v3/files/${copy.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  return (await api(`/drive/v3/files/${file.id}?alt=media`)).blob();
}

export const classroomShareUrl = (link, title) =>
  `https://classroom.google.com/share?url=${encodeURIComponent(link)}&title=${encodeURIComponent(title)}`;
