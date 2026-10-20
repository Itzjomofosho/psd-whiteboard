# PSD Whiteboard

A whiteboard you can record lessons on, similar to Explain Everything. It's a web app, so it
runs on iPads, iPhones, Android, Chromebooks, Windows and Macs. There are no accounts: boards
and recordings are saved on the device, with optional Google Drive / Classroom integration.

## Features

**Drawing**
- Pen (pressure-sensitive with Apple Pencil), highlighter, object eraser
- Shapes (rectangle, ellipse, triangle, line, arrow) with no fill, light fill or solid fill,
  and solid or dashed outlines
- Text, laser pointer (fades out, shows in recordings)
- **Infinite canvas, zoom and pan:** zoom out to 25% or in to 600% and move in any direction for
  more space. Use the **Zoom tool** (magnifier in the toolbar: drag to move, pinch or scroll to zoom),
  pinch with two fingers in any tool, Ctrl+scroll on a computer, or drag with one finger while using
  an Apple Pencil. The control at the bottom right zooms in/out, returns to the page (the % button)
  and fits everything on the page into view (⛶). Backgrounds repeat forever, and the original page
  shows as a faint dashed outline. Recordings capture whatever is on screen.
- **Ruler and protractor** (Insert menu): drag to move, use the round handle to rotate
  (snaps to 15°). Pen strokes started just above the ruler's top edge draw a straight line
  along it.

**Selecting**
- Tap an item, or drag around several (lasso) with the Select tool
- Move, resize (round handle), recolour, change shape fill/outline, duplicate, bring to front,
  delete. Tap selected text again to edit it.
- **Lock** items in place (selection bar). Locked items can't be selected or erased; unlock
  them from the Pages panel. PDF pages are imported locked.

**Pages:** add, duplicate, reorder and delete pages. Backgrounds: plain, grid, lined,
handwriting lines, dots, coordinate plane, music staff, dark, chalkboard.

**Importing** (Insert menu, home-screen **Open PDF or file**, or drag and drop on a computer)
- Images and photos (camera, Photos, Files)
- **PDFs:** each PDF page becomes a board page you can write on (up to 60 pages)
- **Video clips** that play on the board. Their sound is included in recordings.
- Google Slides, Docs, Sheets, PowerPoint, Word and Excel: through **Open from Google Drive** (below), or save them as PDF
  first (Google: File ▸ Download ▸ PDF; PowerPoint/Word: Export ▸ PDF)

**Presenting and recording**
- **Present**: hides the toolbars, shows a small floating toolbar (which can be moved or
  collapsed), and goes full screen where the browser allows it. Esc or the ⇲ button exits.
- **Camera bubble**: shows your webcam in a circle on the board (and in recordings). Drag to
  move it; tap to change its size.
- **Record** the board, your voice and clip sound, with pause/resume.
  - iPad/iPhone (Safari) record **MP4**. Chromebooks and Windows (Chrome/Edge) record **WebM**,
    which plays in Chrome, Edge, Google Drive, Classroom and YouTube.
  - Recordings are written to the device *while* recording. If the app is closed, crashes or the
    battery dies, the recording up to that point is recovered next time the app opens.
  - Recordings stay under **Recordings on this device** on the home screen until deleted.

**Exporting:** current page as PNG, all pages as PDF (each page includes anything drawn outside the original page area), board project file (`.json`, includes
video clips) for backup or moving to another device, and recordings as video files.

Keyboard (computer): V select, Z zoom tool, P pen, H highlighter, E eraser, S shapes, T text, L laser,
Ctrl+Z / Ctrl+Shift+Z undo/redo, Delete removes the selection, ←/→ or PageUp/PageDown change
pages, + / − / 0 zoom, Esc ends presenting.

## Files

Plain HTML/CSS/JS with no build step. Deploy the folder as-is.

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Page and layout |
| `js/app.js` | UI, tools, pointer handling, pages, presenting, recording, import/export |
| `js/board.js` | Board model, backgrounds, rendering, zoom view, hit-testing |
| `js/store.js` | IndexedDB storage: boards, video clips, recordings |
| `js/recorder.js` | Canvas, microphone and clip-audio recording |
| `js/media.js` | Video clips on the board and the audio mixer |
| `js/camera.js` | Webcam bubble |
| `js/instruments.js` | Ruler and protractor |
| `js/pdfimport.js`, `vendor/pdfjs/` | PDF import using Mozilla PDF.js 3.11 (Apache 2.0, bundled for offline use) |
| `js/pdf.js` | Dependency-free PDF writer for exports |
| `js/drive.js`, `js/config.js` | Optional Google Drive / Classroom integration |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `web.config` | IIS settings (manifest MIME type, no caching of `sw.js`) |

## Testing locally

Run `serve.cmd` (needs Python), then open <http://localhost:8080> in Chrome or Edge.
The microphone and camera work on `localhost`. Offline mode is only enabled over HTTPS.

## Hosting

The app **must be served over HTTPS**, because browsers only allow the microphone, camera and
offline mode on secure sites. Any static web host works:

- **District IIS server**: copy the folder into a site or virtual directory with a valid
  certificate. `web.config` is already included.
- Or GitHub Pages, Cloudflare Pages, Netlify, etc.

**Updating:** replace the files, then change `CACHE` in `sw.js` (e.g. `psd-whiteboard-v3`).
Devices pick up the new version the second time the app is opened after the update.

## Deploying to iPads with Jamf Pro

1. **Configuration Profiles → New → Web Clips**
   - Label: `Whiteboard`
   - URL: your HTTPS address (e.g. `https://apps.yourdistrict.org/whiteboard/`)
   - Icon: upload `icons/icon-512.png`
   - Tick **Full Screen**, so it opens as a standalone app without Safari's address bar
   - Removable: your choice
2. Scope it to the device or user groups and save.
3. Microphone and camera: iPadOS asks the first time someone records or turns on the camera;
   tap Allow. A web clip has no MDM setting to pre-approve this.
4. Make sure no restriction or content filter blocks the URL (or Google's sign-in and Drive
   addresses if you enable Drive), and that Safari isn't disabled (full-screen web clips still
   use Safari's engine).

Chromebooks: push the URL as a bookmark or force-installed web app in the Google Admin console.
Windows: Edge/Chrome can install it from the address bar ("Install app"), or push it through
policy (`WebAppInstallForceList`).

## Google Drive and Classroom (optional)

Off by default. When it's turned on, these appear:
- Home screen **Open from Google Drive**: open a board file, PDF, image, Google Slides/Docs or
  PowerPoint/Word file from Drive (Slides, Docs, Sheets and Office files are converted to PDF pages). The picker has My Drive (with folders), Shared with me, Shared drives and Starred tabs. The iPad's own file picker (Open PDF or file) can't convert Google files, so use this button for them.
- Insert ▸ **From Google Drive**: add a PDF, Slides, Docs or image to the current board.
- Export ▸ **Save board to Google Drive**: saves the board file to a "PSD Whiteboard" folder.
  Saving again updates the same file. Opening it from Drive on another device and saving
  keeps updating it. This is how boards move between devices; there's no automatic sync.
- Export ▸ **PDF to Drive & Classroom**, and **Save to Drive** on recordings: uploads, then
  offers **Open in Drive** and **Share to Google Classroom** links.

It only uses the `drive.file` permission, so the app can see just the files it created or that
the user picked, not the rest of their Drive.

Setup (Google Workspace admin, about 15 minutes):
1. In <https://console.cloud.google.com>, create a project (e.g. "PSD Whiteboard").
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **OAuth consent screen**: User type **Internal** (only your district can sign in; no Google
   review needed). Add the scope `.../auth/drive.file`.
4. **Credentials → Create credentials → OAuth client ID**: type **Web application**. Under
   *Authorized JavaScript origins* add the HTTPS origin where the app is hosted
   (e.g. `https://apps.yourdistrict.org`) and `http://localhost:8080` for testing.
5. **Credentials → Create credentials → API key**: restrict it to the Google Picker API and to
   your site's address (HTTP referrer).
6. Put the client ID, API key and the project **number** (from the project's Dashboard) in
   `js/config.js`, then redeploy (and bump `CACHE` in `sw.js`).

If students will view shared files, make sure your Drive sharing settings allow it. Classroom
normally asks to fix sharing when you attach a file students can't open.

## Things to know

- **Storage is per device and per browser.** A board made on one iPad isn't visible on another
  unless it's moved with a project file or Google Drive. Home-screen/web-clip apps keep their
  data, but deleting the web clip deletes its boards and recordings, and so does wiping a
  shared iPad between users.
- Saved videos go wherever the user chooses from the share sheet (Save Video → Photos, or
  Save to Files). On a computer they go to Downloads.
- Recording uses about 37 MB per minute. Recordings and video clips stay on the device until
  deleted, so delete old ones from the home screen to free space. Short recordings (under
  about 15 minutes) are the safe range on older iPads.
- Video clips are limited to 300 MB each. A clip plays on the board where it was added, and is
  included in project files, which makes those files larger.
- Recovered recordings (after a crash) may not show a total length in some players, and may
  not support seeking, but they play normally.
