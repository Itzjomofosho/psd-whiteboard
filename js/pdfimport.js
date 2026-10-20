// Turns each page of a PDF into an image sized for the board, using the
// bundled copy of Mozilla PDF.js (vendor/pdfjs), loaded only when needed.
import { W, H } from './board.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
const QUALITY = 1.6; // render above board resolution so zooming in stays sharp
export const MAX_PAGES = 60;

let loading;
function loadPdfJs() {
  loading ??= new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement('script');
    s.src = `${BASE}pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the PDF reader.'));
    };
    document.head.append(s);
  });
  return loading;
}

// Resolves to [{ src, w, h }] with w/h in board units (fitted to the board).
export async function pdfToImages(data, onProgress = () => {}) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const count = Math.min(doc.numPages, MAX_PAGES);
  const out = [];
  try {
    for (let i = 1; i <= count; i++) {
      onProgress(i, count);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(W / base.width, H / base.height);
      const vp = page.getViewport({ scale: fit * QUALITY });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push({ src: c.toDataURL('image/jpeg', 0.85), w: base.width * fit, h: base.height * fit });
      page.cleanup();
      c.width = c.height = 0; // release memory early (matters on iPad)
    }
  } finally {
    doc.destroy();
  }
  return { images: out, truncated: doc.numPages > count, total: doc.numPages };
}
