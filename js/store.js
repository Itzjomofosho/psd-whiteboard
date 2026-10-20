// Storage in IndexedDB. Everything stays on the device.
//   projects   full boards
//   meta       the small records the home screen lists
//   media      video clip files placed on boards
//   recordings recording info; chunks holds the video data, written while
//              recording so a crash or closed tab doesn't lose the lesson
const DB_NAME = 'psd-whiteboard';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'id' });
      }
      if (e.oldVersion < 2) {
        d.createObjectStore('media', { keyPath: 'id' }).createIndex('project', 'project');
        d.createObjectStore('recordings', { keyPath: 'id' });
        d.createObjectStore('chunks', { keyPath: 'key' }).createIndex('rec', 'rec');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

async function get(storeName, key) {
  const d = await db();
  return result(d.transaction(storeName).objectStore(storeName).get(key));
}

async function put(storeName, value) {
  const d = await db();
  const tx = d.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  return done(tx);
}

// ---------- boards ----------

export async function listProjects() {
  const d = await db();
  const all = await result(d.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export const loadProject = (id) => get('projects', id);

export async function saveProject(project, thumb) {
  const d = await db();
  const tx = d.transaction(['projects', 'meta'], 'readwrite');
  tx.objectStore('projects').put(project);
  tx.objectStore('meta').put({
    id: project.id,
    name: project.name,
    updated: project.updated,
    pages: project.pages.length,
    thumb,
  });
  return done(tx);
}

export async function renameProject(id, name) {
  const d = await db();
  const tx = d.transaction(['projects', 'meta'], 'readwrite');
  const projects = tx.objectStore('projects');
  const meta = tx.objectStore('meta');
  const [project, info] = await Promise.all([result(projects.get(id)), result(meta.get(id))]);
  if (project) projects.put({ ...project, name });
  if (info) meta.put({ ...info, name });
  return done(tx);
}

export async function deleteProject(id) {
  const d = await db();
  const tx = d.transaction(['projects', 'meta', 'media'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('meta').delete(id);
  tx.objectStore('media').index('project').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    tx.objectStore('media').delete(cursor.primaryKey);
    cursor.continue();
  };
  return done(tx);
}

// ---------- video clips ----------

export const putMedia = (m) => put('media', m); // { id, project, blob, type }
export const getMedia = (id) => get('media', id);

// ---------- recordings ----------

export const putRecording = (r) => put('recordings', r);
export const getRecording = (id) => get('recordings', id);

export async function listRecordings() {
  const d = await db();
  const all = await result(d.transaction('recordings').objectStore('recordings').getAll());
  return all.sort((a, b) => b.created - a.created);
}

export const putChunk = (rec, seq, blob) =>
  put('chunks', { key: `${rec}:${String(seq).padStart(7, '0')}`, rec, blob });

export async function recordingBlob(id, type) {
  const d = await db();
  const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
  const chunks = await result(d.transaction('chunks').objectStore('chunks').getAll(range));
  return new Blob(chunks.map((c) => c.blob), { type });
}

export async function deleteRecording(id) {
  const d = await db();
  const tx = d.transaction(['recordings', 'chunks'], 'readwrite');
  tx.objectStore('recordings').delete(id);
  tx.objectStore('chunks').delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
  return done(tx);
}
