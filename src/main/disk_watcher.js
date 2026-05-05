// ════════════════════════════════════════════════════════════════
// disk_watcher.js — SCAAI Disk Awareness Module
// Upgrade 1: full-disk indexing + fs.watch live change tracking.
//
// Exposes:
//   scan(roots)                    → index all files under given roots
//   startWatching(win, paths)      → live fs.watch on given dirs
//   stopWatching()                 → close all watchers
//   startBackgroundScan(win,roots) → startup routine (load+scan+watch+poll)
//   getIndex()                     → current in-memory index object
//   getCount()                     → number of indexed files
//   shutdown()                     → cleanup before quit
// ════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ──
const DISK_INDEX_FILE  = path.join(os.homedir(), '.scaai', 'disk_index.json');
const SCAN_DEPTH_MAX   = 5;
const MAX_FILES        = 30000;
const RESCAN_INTERVAL  = 3 * 60 * 1000; // 3 min periodic rescan

// Directories to skip entirely during scan — avoids OS noise and huge trees
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', '.nuxt', '.cache', 'cache',
  'tmp', 'temp', 'Temp', '.DS_Store',
  '$Recycle.Bin', 'System Volume Information',
  'Windows', 'ProgramData', 'AppData',
  'Program Files', 'Program Files (x86)',
  '.npm', '.yarn', '.pnpm', 'bower_components',
  'Thumbs.db', '.Trash',
]);

// ── State ──
let _index    = {};     // filePath → { name, ext, size, mtime, dir }
let _watchers = [];     // fs.FSWatcher array
let _scanTimer = null;  // periodic rescan timer
let _win       = null;  // BrowserWindow ref for push events

// ────────────────────────────────────────────
// Persistence helpers
// ────────────────────────────────────────────
function _saveIndex() {
  try {
    const dir = path.dirname(DISK_INDEX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISK_INDEX_FILE, JSON.stringify(_index), 'utf-8');
  } catch (_e) {}
}

function _loadIndex() {
  try {
    if (fs.existsSync(DISK_INDEX_FILE)) {
      _index = JSON.parse(fs.readFileSync(DISK_INDEX_FILE, 'utf-8'));
    }
  } catch (_e) { _index = {}; }
}

// ────────────────────────────────────────────
// Recursive directory walker — populates _index
// ────────────────────────────────────────────
function _walk(dir, depth) {
  if (depth > SCAN_DEPTH_MAX) return;
  if (Object.keys(_index).length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) {
    console.error(`[disk_watcher] _walk failed reading dir ${dir}:`, e.message);
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      _walk(full, depth + 1);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(full);
        _index[full] = {
          name:  e.name,
          ext:   path.extname(e.name).slice(1).toLowerCase(),
          size:  stat.size,
          mtime: stat.mtimeMs,
          dir:   dir,
        };
      } catch (e) {
        console.error(`[disk_watcher] _walk stat failed for ${full}:`, e.message);
      }
    }
  }
}

// ────────────────────────────────────────────
// Full scan of given root paths (async-safe wrapper)
// Returns { ok, count }
// ────────────────────────────────────────────
async function scan(roots) {
  if (!roots || !Array.isArray(roots)) {
    console.error('[disk_watcher] scan() requires an array of root paths');
    return { ok: false, count: 0, error: 'invalid roots array' };
  }
  _index = {};
  const resolved = roots.map(r => r.replace(/^~/, os.homedir()));
  for (const root of resolved) {
    if (fs.existsSync(root)) _walk(root, 0);
  }
  _saveIndex();
  return { ok: true, count: Object.keys(_index).length };
}

// ────────────────────────────────────────────
// Live file-system watchers
// fs.watch with recursive:true works on Windows.
// On macOS / Linux only non-recursive watch is used (shallow dirs).
// ────────────────────────────────────────────
let _pushTimer = null;
let _lastEventType = null;
let _lastEventName = null;

function _pushChange(eventType, filePath) {
  if (!_win) return;
  _lastEventType = eventType;
  _lastEventName = filePath;

  if (_pushTimer) return; // already pending emit

  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    try {
      if (_win && !_win.isDestroyed()) {
        _win.webContents.send('fs:disk-changed', {
          type:  _lastEventType,
          path:  _lastEventName,
          count: Object.keys(_index).length,
        });
      }
    } catch (e) {
      console.error('[disk_watcher] error pushing disk change event:', e.message);
    }
  }, 300); // 300ms debounce
}

function startWatching(win, paths) {
  if (!Array.isArray(paths)) {
    console.warn('[disk_watcher] startWatching() requires an array of paths, falling back to empty.');
    paths = [];
  }
  _win = win || _win;
  stopWatching(); // clear previous watchers
  const useRecursive = (process.platform === 'win32');
  for (const p of paths) {
    const resolved = p.replace(/^~/, os.homedir());
    if (!fs.existsSync(resolved)) continue;
    try {
      const watcher = fs.watch(resolved, { recursive: useRecursive }, (eventType, filename) => {
        if (!filename) return;
        const full = path.join(resolved, filename);
        // Update or remove entry
        try {
          const stat = fs.statSync(full);
          _index[full] = {
            name:  path.basename(full),
            ext:   path.extname(full).slice(1).toLowerCase(),
            size:  stat.size,
            mtime: stat.mtimeMs,
            dir:   path.dirname(full),
          };
        } catch (_e) {
          delete _index[full]; // file deleted/moved
        }
        _pushChange(eventType, full);
      });
      watcher.on('error', (e) => {
        console.error('[disk_watcher] watcher error on', resolved, e.message);
      });
      _watchers.push(watcher);
    } catch (e) {
      console.error('[disk_watcher] failed to start watcher for', resolved, e.message);
    }
  }
}

function stopWatching() {
  for (const w of _watchers) { try { w.close(); } catch (_e) {} }
  _watchers = [];
}

// ────────────────────────────────────────────
// Startup routine — called once after window ready
// 1. Load persisted index for instant availability
// 2. Background fresh scan
// 3. Start live watchers on home dir
// 4. Schedule periodic rescan
// ────────────────────────────────────────────
function startBackgroundScan(win, defaultRoots) {
  _win = win;

  // Step 1: load persisted index immediately (fast — no disk walk needed)
  _loadIndex();

  // Notify renderer that stale index is available
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('fs:disk-ready', {
        count:  Object.keys(_index).length,
        stale:  true,
        source: 'persisted',
      });
    } catch (_e) {}
  }

  const roots = (defaultRoots || [os.homedir()]).map(r => r.replace(/^~/, os.homedir()));

  // Step 2: background fresh scan (runs async, does not block window)
  scan(roots).then(() => {
    startWatching(win, roots);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('fs:disk-ready', {
          count:  Object.keys(_index).length,
          stale:  false,
          source: 'scan',
        });
      } catch (_e) {}
    }
  }).catch(() => {});

  // Step 3: periodic rescan to catch anything the watcher misses
  if (_scanTimer) clearInterval(_scanTimer);
  _scanTimer = setInterval(() => {
    scan(roots).then(() => {
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('fs:disk-ready', {
            count:  Object.keys(_index).length,
            stale:  false,
            source: 'periodic',
          });
        } catch (_e) {}
      }
    }).catch(() => {});
  }, RESCAN_INTERVAL);
}

// ── Cleanup before app quit ──
function shutdown() {
  stopWatching();
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
}

function getIndex() { return _index; }
function getCount() { return Object.keys(_index).length; }

// ────────────────────────────────────────────
// NEW: Query functions for Upgrade 3
// ────────────────────────────────────────────
function getExtSummary() {
  const summary = {};
  for (const path in _index) {
    const file = _index[path];
    if (file.ext) {
      if (!summary[file.ext]) {
        summary[file.ext] = { count: 0, size: 0 };
      }
      summary[file.ext].count++;
      summary[file.ext].size += file.size;
    }
  }
  // Sort by count descending
  return Object.entries(summary)
    .sort(([, a], [, b]) => b.count - a.count)
    .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
}

function findByExt(ext) {
  const extension = (ext || '').toLowerCase().replace(/^\./, '');
  const results = [];
  for (const path in _index) {
    const file = _index[path];
    if (file.ext === extension) {
      results.push({ path, ...file });
    }
  }
  return { count: results.length, results };
}

module.exports = {
  scan,
  startWatching,
  stopWatching,
  startBackgroundScan,
  getIndex,
  getCount,
  shutdown,
  getExtSummary,
  findByExt,
};
