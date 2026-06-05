const DDG = require('duck-duck-scrape');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { exec, execFile, spawn } = require('child_process');
// ── Upgrade 1: Disk Awareness Module ──
const diskWatcher = require('./disk_watcher');
// ── Upgrade 2: Skill Plugin System + Multi-Agent Registry ──
const skillRunner = require('./skill_runner');
const agentsMgr = require('./agents');

// ══════════════════════════════════════════════════════════════════
// ── WSL2 INTEGRATION LAYER ──
// All shell command execution routes through WSL2 when available.
// This mirrors OpenClaw's architecture: Electron stays on Windows
// for native APIs (file dialogs, window chrome, tray) while the
// POSIX shell environment (bash, find, ls, apt, git, python…) runs
// inside the default WSL2 distro.
//
// Path translation:
//   Windows → WSL : C:\Users\foo\bar  →  /mnt/c/Users/foo/bar
//   WSL → Windows : /mnt/c/Users/foo  →  C:\Users\foo
//   WSL home (~)  : ~/... is left for bash to expand inside WSL
//
// Opening files/apps on the desktop:
//   wslview (wslu)  — opens with default Windows app via WSL
//   explorer.exe    — fallback for any path
//   powershell -Command "Start-Process '...'"  — last resort
// ══════════════════════════════════════════════════════════════════

let _wslAvailable = false;   // true once confirmed
let _wslDistro = '';      // e.g. "Ubuntu", "Debian"
let _wslChecked = false;   // detection ran at least once
let _wslVersion = '';      // WSL version string for UI

/** Translate a Windows absolute path to its WSL2 /mnt/… equivalent */
function winToWslPath(p) {
  if (!p || typeof p !== 'string') return p || '';
  // Already a WSL/Unix path — pass through
  if (p.startsWith('/') || p.startsWith('~')) return p;
  // C:\Users\foo → /mnt/c/Users/foo
  return p
    .replace(/^([A-Za-z]):[\\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

/** Translate a WSL /mnt/… path back to a Windows absolute path */
function wslToWinPath(p) {
  if (!p || typeof p !== 'string') return p || '';
  if (!p.startsWith('/mnt/')) return p;
  return p
    .replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, '\\');
}

/**
 * Detect WSL2 availability once. Caches the result in _wslAvailable.
 * Uses `wsl --list --verbose` so we also grab the default distro name.
 */
async function detectWsl2() {
  if (_wslChecked) return _wslAvailable;
  _wslChecked = true;
  return new Promise(resolve => {
    // wsl.exe outputs UTF-16LE — Node exec() receives it as UTF-8 which turns
    // every character into <char>\0.  Strip NULs AND the BOM (\uFEFF / \uFFFE)
    // BEFORE splitting into lines so the * marker and distro names are clean.
    exec('wsl --list --verbose', { timeout: 12000, shell: true, encoding: 'buffer' }, (err, stdoutBuf, stderrBuf) => {
      // Decode buffer as UTF-16LE (the real encoding wsl.exe uses)
      let raw = '';
      try {
        raw = stdoutBuf.toString('utf16le');
      } catch (_) {
        // Older Node without buffer utf16le — fall back to stripping NULs from ascii
        raw = (stdoutBuf.toString('binary') + (stderrBuf ? stderrBuf.toString('binary') : '')).replace(/\0/g, '');
      }
      // Strip BOM and carriage returns for clean line splitting
      raw = raw.replace(/\uFEFF|\uFFFE/g, '').replace(/\r/g, '');

      const rawLc = raw.toLowerCase();
      if (!err || rawLc.includes('name') || rawLc.includes('running') || rawLc.includes('stopped')) {
        _wslAvailable = true;
        const lines = raw.split('\n');

        // --- Robust default-distro detection ---
        // The table format is:  "* Ubuntu-20.04    Stopped    2"
        // After UTF-16→string the leading `*` may have surrounding whitespace.
        for (const line of lines) {
          const trimmed = line.trim();
          // Match lines that start with '*' (possibly with surrounding spaces)
          if (/^\*/.test(trimmed)) {
            const withoutStar = trimmed.replace(/^\*\s*/, '').trim();
            const parts = withoutStar.split(/\s+/);
            if (parts[0] && parts[0].length > 1 && /^[A-Za-z]/.test(parts[0])) {
              _wslDistro = parts[0];
              break;
            }
          }
        }

        if (!_wslDistro) {
          // Fallback: find any line that looks like a distro name (skip header)
          for (const line of lines) {
            const t = line.trim().replace(/^\*\s*/, '');
            if (t && !t.startsWith('NAME') && t.length > 2 && /^[A-Za-z]/.test(t)) {
              _wslDistro = t.split(/\s+/)[0];
              break;
            }
          }
        }

        if (!_wslDistro) _wslDistro = 'Ubuntu';
        _wslVersion = raw.slice(0, 200).replace(/\n+/g, ' ').trim();
        console.log('[WSL2] Available — default distro:', _wslDistro);

        // Warm-up: confirm /mnt/c is mounted before signalling ready
        const distroArgs2 = _wslDistro ? ['-d', _wslDistro] : [];
        const warmup = require('child_process').spawn(
          'wsl', [...distroArgs2, '--', 'bash', '-c', 'ls /mnt/c > /dev/null 2>&1 && echo mounted'],
          { windowsHide: true }
        );
        const warmupTimer = setTimeout(() => {
          try { warmup.kill(); } catch { }
          console.log('[WSL2] Mount check timed out — proceeding anyway');
          resolve(true);
        }, 20000);
        warmup.on('close', () => { clearTimeout(warmupTimer); console.log('[WSL2] /mnt/c mounted, ready'); resolve(true); });
        warmup.on('error', () => { clearTimeout(warmupTimer); resolve(true); });
        return;
      } else {
        _wslAvailable = false;
        console.log('[WSL2] Not detected — falling back to native Windows shell');
      }
      resolve(_wslAvailable);
    });
  });
}

/**
 * Run a bash command inside WSL2.
 * Retries without -d flag if spawn crashes (null exit / ENOENT).
 * Timeout extended to 30s — distro may need to start from Stopped state.
 */
function wslExec(command, options = {}) {
  const cwd = options.cwd || os.homedir();
  const timeout = options.timeout || 60000;
  const wslCwd = winToWslPath(cwd);
  const fullCmd = `cd "${wslCwd.replace(/"/g, '\\"')}" 2>/dev/null; ${command}`;

  function _spawnWsl(args) {
    return new Promise(resolve => {
      let stdout = '', stderr = '', done = false;
      const proc = require('child_process').spawn('wsl', args, {
        windowsHide: true, env: { ...process.env },
      });
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { proc.kill(); } catch { }
        resolve({ ok: false, stdout, stderr, code: -1, error: 'WSL timed out after ' + timeout + 'ms' });
      }, timeout);
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', e => {
        if (done) return; done = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr, code: -1, error: e.message, spawnError: true });
      });
      proc.on('close', code => {
        if (done) return; done = true;
        clearTimeout(timer);
        const ok = code === 0;
        resolve({
          ok, stdout, stderr,
          code: code !== null ? code : -1,
          error: !ok ? (stderr || (code !== null ? 'exit ' + code : 'null exit')) : null,
          nullExit: code === null,
        });
      });
    });
  }

  return (async () => {
    // Attempt 1: explicit distro name
    const args1 = _wslDistro
      ? ['-d', _wslDistro, '--', 'bash', '-c', fullCmd]
      : ['--', 'bash', '-c', fullCmd];
    const r1 = await _spawnWsl(args1);
    if (!r1.spawnError && !r1.nullExit) return r1;
    // Attempt 2: no -d flag (use WSL default distro)
    console.warn('[WSL2] Retrying without -d flag:', r1.error);
    return _spawnWsl(['--', 'bash', '-c', fullCmd]);
  })();
}
/**
 * Open a file or folder using WSL2 or Windows mechanisms.
 * Priority:
 *   1. wslview (wslu package — most reliable WSL→Windows open)
 *   2. explorer.exe <winpath>
 *   3. Electron shell.openPath as last resort
 */
async function wslOpenPath(p) {
  const winHome = os.homedir();
  let resolved = p.replace(/^~/, winHome);
  if (resolved.startsWith('/mnt/')) resolved = wslToWinPath(resolved);

  // 1. Try wslview via spawn (most reliable: opens with associated Windows app)
  const wslPath = winToWslPath(resolved);
  const distroArg = _wslDistro ? ['-d', _wslDistro] : [];
  return new Promise(resolveP => {
    const tryWslview = () => new Promise(r => {
      const p2 = require('child_process').spawn('wsl', [...distroArg, '--', 'bash', '-c',
      `command -v wslview >/dev/null 2>&1 && wslview "${wslPath.replace(/"/g, '\\"')}" || exit 1`
      ], { windowsHide: true });
      p2.on('close', code => r(code === 0));
      p2.on('error', () => r(false));
    });

    const tryExplorer = () => new Promise(r => {
      const p3 = require('child_process').spawn('explorer.exe', [resolved], { windowsHide: true });
      p3.on('close', code => r(code === 0 || code === 1)); // explorer returns 1 on success
      p3.on('error', () => r(false));
    });

    const tryPowershell = () => new Promise(r => {
      exec(`powershell -NoProfile -Command "Start-Process '${resolved.replace(/'/g, "''")}'"`
        , { timeout: 6000, shell: true }, err => r(!err));
    });

    tryWslview()
      .then(ok => ok ? null : tryExplorer())
      .then(ok => ok == null ? null : (ok ? null : tryPowershell()))
      .then(ok => {
        if (ok == null || ok) { resolveP({ ok: true }); return; }
        shell.openPath(resolved)
          .then(() => resolveP({ ok: true }))
          .catch(e => resolveP({ ok: false, error: e.message }));
      });
  });
}
// ── Data paths ──
const DATA_DIR = path.join(os.homedir(), '.scaai');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const PERSONA_FILE = path.join(DATA_DIR, 'persona.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FILES_INDEX = path.join(DATA_DIR, 'files_index.json');
const BRIDGE_FILE = path.join(DATA_DIR, 'semantic_bridge.py');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
const TOOLS_FILE = path.join(DATA_DIR, 'tools.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const API_LOG_FILE = path.join(DATA_DIR, 'api_logs.json');

// ── API Interaction Logger ──
// Persists request/response metadata to disk for debugging provider anomalies.
// Capped at 200 entries to prevent unbounded growth.
function logApiInteraction(provider, model, status, error, meta = {}) {
  try {
    ensureDataDir();
    const logs = readJSON(API_LOG_FILE, []);
    logs.push({
      ts: Date.now(),
      iso: new Date().toISOString(),
      provider,
      model,
      status, // 'ok' | 'error' | 'failover'
      error: error || null,
      ...meta,
    });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    writeJSON(API_LOG_FILE, logs);
  } catch (_) { /* logging must never break the app */ }
}

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } }
function writeJSON(file, data) {
  ensureDataDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}
// Serialised write queue: prevents race conditions when multiple IPC handlers
// call writeJSON on the same file concurrently.
const _writeQueue = Promise.resolve();
function enqueueWrite(file, data) {
  return _writeQueue = _writeQueue.then(() => writeJSON(file, data));
}

// ── Window ──
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#0d0d11',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js'), webSecurity: false, webviewTag: true },
  });
  win.loadFile(path.join(__dirname, '../../index.html'));
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:;"] } });
  });

  // ── Navigation guards: prevent any link from hijacking the main app window ──
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url.startsWith('http')) {
      win.webContents.executeJavaScript(
        `if(typeof openMiniBrowser==='function') openMiniBrowser(${JSON.stringify(url)});`
      ).catch(() => { });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith('file://') || url === 'about:blank';
    if (!isLocal) {
      event.preventDefault();
      if (url.startsWith('http')) {
        win.webContents.executeJavaScript(
          `if(typeof openMiniBrowser==='function') openMiniBrowser(${JSON.stringify(url)});`
        ).catch(() => { });
      }
    }
  });
}
app.whenReady().then(async () => {
  ensureBridge();
  // ── Detect WSL2 BEFORE creating the window so _wslAvailable is set
  //    before any IPC handler can be invoked by the renderer ──
  await detectWsl2().catch(() => { _wslAvailable = false; });
  createWindow();
  // ── Upgrade 1: start background disk scan after renderer is ready ──
  win.webContents.once('did-finish-load', () => {
    diskWatcher.startBackgroundScan(win, [os.homedir()]);
    // ── Upgrade 2: seed built-in skills + agent registry ──
    skillRunner.installBuiltinSkills();
    agentsMgr.loadAgents();
    // ── Notify renderer of WSL2 status once we know it ──
    setTimeout(() => {
      if (_wslAvailable && win && !win.isDestroyed()) {
        win.webContents.send('wsl2:ready', { distro: _wslDistro, version: _wslVersion });
        console.log('[WSL2] Notified renderer — distro:', _wslDistro);
      }
    }, 1500); // give detectWsl2() time to finish
  });
});
app.on('before-quit', () => diskWatcher.shutdown());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Window controls ──
ipcMain.on('win-minimize', () => win.minimize());
ipcMain.on('win-maximize', () => { win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close', () => win.close());

// ── Persistence IPC ──
// Short-term memory (MEM) removed — all persistence via semantic memory (ChromaDB)
ipcMain.handle('memory:load', () => []);
ipcMain.handle('memory:save', (_, d) => true);
ipcMain.handle('memory:clear', () => true);
ipcMain.handle('persona:load', () => readJSON(PERSONA_FILE, { confidence: .55, curiosity: .70, attention: .55 }));
ipcMain.handle('persona:save', (_, d) => { writeJSON(PERSONA_FILE, d); return true; });
let _config = { useWsl2: true };
try {
  const saved = readJSON(CONFIG_FILE, null);
  if (saved) _config = saved;
} catch (e) { }

ipcMain.handle('config:load', () => readJSON(CONFIG_FILE, {
  provider: 'groq',
  groqKey: '',
  customApiUrl: '', customApiKey: '', customModel: '', customFmt: '',
  customAuthHeader: 'Authorization', customAuthPrefix: 'Bearer ',
  model: 'llama-3.3-70b',
  useWsl2: true,
}));
ipcMain.handle('config:save', (_, d) => {
  _config = d;
  writeJSON(CONFIG_FILE, d);
  return true;
});
ipcMain.handle('files:load-index', () => readJSON(FILES_INDEX, {}));
ipcMain.handle('files:save-index', (_, d) => { writeJSON(FILES_INDEX, d); return true; });

// ── System info ──
ipcMain.handle('sys:info', () => ({
  platform: process.platform,
  home: os.homedir(),
  desktop: path.join(os.homedir(), 'Desktop'),
  documents: path.join(os.homedir(), 'Documents'),
  downloads: path.join(os.homedir(), 'Downloads'),
  hostname: os.hostname(),
  username: os.userInfo().username,
  // WSL2 flags — renderer uses these to select Linux vs Windows commands
  wsl2: _wslAvailable,
  wslDistro: _wslDistro || '',
}));

// ── WSL2 status query (IPC) ──
ipcMain.handle('wsl2:status', () => ({
  available: _wslAvailable,
  distro: _wslDistro,
  version: _wslVersion,
}));

// ── ALFRED AWARENESS: Self Architecture Digest ──
ipcMain.handle('sys:self-map', async () => {
  try {
    const cwd = process.cwd();
    const pkgPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) return { ok: false, error: 'package.json not found' };

    // 1. Ensure it's SCAAI
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (!pkg.name || !pkg.name.toLowerCase().includes('scaai')) {
      return { ok: false, error: 'Not the SCAAI repository' };
    }

    // 2. Read package.json scripts
    let digest = `## Build & Run Scripts (from package.json)\n`;
    digest += JSON.stringify(pkg.scripts || {}, null, 2) + `\n\n`;

    // 3. Structural Map
    digest += `## Architecture Map (src/)\n`;
    const srcPath = path.join(cwd, 'src');
    if (fs.existsSync(srcPath)) {
      const items = fs.readdirSync(srcPath, { withFileTypes: true });
      for (const item of items) {
        digest += `- ${item.name}${item.isDirectory() ? '/' : ''}\n`;
        if (item.isDirectory()) {
          const subItems = fs.readdirSync(path.join(srcPath, item.name), { withFileTypes: true });
          for (const sub of subItems) {
            if (!['node_modules', '.git'].includes(sub.name)) {
              digest += `  - ${sub.name}\n`;
            }
          }
        }
      }
    } else {
      digest += `(src/ directory not found)\n`;
    }

    // 4. Read Documentation
    const clPath = path.join(cwd, 'CHANGELOG.md');
    if (fs.existsSync(clPath)) {
      digest += `\n## Recent Documentation (CHANGELOG.md - top 30 lines)\n`;
      const clLines = fs.readFileSync(clPath, 'utf-8').split('\n');
      digest += clLines.slice(0, 30).join('\n') + `\n`;
    }

    return { ok: true, digest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Path translation helpers exposed to renderer ──
ipcMain.handle('wsl2:win-to-wsl', (_, p) => winToWslPath(p));
ipcMain.handle('wsl2:wsl-to-win', (_, p) => wslToWinPath(p));

// ── Execute shell command ──
// When WSL2 is available: all commands run inside the WSL2 bash environment.
// The cwd is auto-translated from Windows to /mnt/… format.
// When WSL2 is not available: falls back to native Windows CMD.
ipcMain.handle('sys:exec', async (_, command, options = {}) => {
  const timeout = options.timeout || 45000; // Increased to 45s for reliability
  const cwd = options.cwd || os.homedir();

  // Check if WSL2 is available AND enabled in settings
  const useWsl = _wslAvailable && (_config.useWsl2 !== false);

  if (useWsl) {
    return wslExec(command, { cwd, timeout });
  }

  // Native Windows fallback
  return new Promise(resolve => {
    exec(command, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      shell: true,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error || error.code === 0,
        stdout: stdout || '',
        stderr: stderr || '',
        code: error ? error.code : 0,
        error: error ? error.message : null,
      });
    });
  });
});

// ── List directory ──
// Uses WSL2 `ls -la` when available for full POSIX path support.
// Falls back to Node.js fs.readdirSync on Windows-only installs.
ipcMain.handle('sys:list-dir', async (_, dirPath) => {
  const resolved = dirPath.replace(/^~/, os.homedir());

  if (_wslAvailable) {
    // Determine the WSL path to list — handle both Windows and WSL-style input
    const wslPath = resolved.startsWith('/mnt/') ? resolved : winToWslPath(resolved);
    const r = await wslExec(`ls -la "${wslPath.replace(/"/g, '\\"')}" 2>&1`, { timeout: 35000 });
    if (r.ok && r.stdout) {
      const entries = [];
      const lines = r.stdout.split('\n').slice(1);
      for (const line of lines) {
        if (!line.trim() || line.startsWith('total')) continue;
        const parts = line.trim().split(/\s+/);
        const name = parts.slice(8).join(' ');
        if (!name || name === '.' || name === '..') continue;
        const isDir = line.startsWith('d');
        const fullWsl = `${wslPath.replace(/\/$/, '')}/${name}`;
        const winFull = wslToWinPath(fullWsl);
        entries.push({ name, type: isDir ? 'dir' : 'file', fullPath: winFull || fullWsl });
      }
      return { ok: true, path: resolved, entries };
    }
    // Fallback to Node fs with correct Windows path
    try {
      const winPath = resolved.startsWith('/mnt/') ? wslToWinPath(resolved) : resolved;
      if (!winPath || !require('fs').existsSync(winPath)) throw new Error('Path not found: ' + winPath);
      const e = fs.readdirSync(winPath, { withFileTypes: true });
      return { ok: true, path: resolved, entries: e.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', fullPath: path.join(winPath, e.name) })) };
    } catch (e2) { return { ok: false, error: (r && r.error) || e2.message }; }
  }

  // Native Windows
  try {
    const e = fs.readdirSync(resolved, { withFileTypes: true });
    return { ok: true, path: resolved, entries: e.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', fullPath: path.join(resolved, e.name) })) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Find files ──
// Uses WSL2 `find` when available — far more powerful than the Node.js walk.
ipcMain.handle('sys:find', async (_, searchRoot, pattern) => {
  const resolved = searchRoot.replace(/^~/, os.homedir());

  if (_wslAvailable) {
    const wslRoot = resolved.startsWith('/mnt/') ? resolved : winToWslPath(resolved);
    const safePattern = pattern.replace(/"/g, '\\"');
    const r = await wslExec(`find "${wslRoot.replace(/"/g, '\\"')}" -maxdepth 8 -name "${safePattern}" 2>/dev/null | head -60`, { timeout: 35000 });
    const lines = (r.stdout || '').split('\n').filter(Boolean);
    const results = lines.map(l => {
      const winPath = wslToWinPath(l.trim());
      return { name: path.basename(winPath || l), path: winPath || l, type: 'file' };
    });
    return { ok: true, results };
  }

  // Native Node.js walk fallback
  const results = [], pLow = pattern.toLowerCase();
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    const skip = new Set(['node_modules', '.git', '$Recycle.Bin', 'System Volume Information', 'Windows', 'AppData']);
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(pLow)) results.push({ name: e.name, path: full, type: e.isDirectory() ? 'dir' : 'file' });
        if (e.isDirectory() && results.length < 50) walk(full, depth + 1);
        if (results.length >= 50) return;
      }
    } catch { }
  }
  walk(resolved);
  return { ok: true, results };
});

ipcMain.handle('sys:open-url', (_, url) => { shell.openExternal(url); return { ok: true }; });

// ── Open file / folder / application ──
// WSL2 mode: uses wslview (wslu) → explorer.exe → PowerShell Start-Process.
// This is how OpenClaw opens Windows desktop apps from WSL context.
// Native mode: Electron shell.openPath.
ipcMain.handle('sys:open-path', async (_, p) => {
  if (_wslAvailable) return wslOpenPath(p);
  await shell.openPath(p.replace(/^~/, os.homedir()));
  return { ok: true };
});

// ── UI Automation via Python/pyautogui ──
// In WSL2 mode: script is written to a Windows temp path then run via WSL python3.
// pyautogui still controls the Windows desktop because WSL2 shares the display.
ipcMain.handle('sys:ui', async (_, script, options = {}) => new Promise(resolve => {
  const tmpFile = path.join(os.tmpdir(), 'scaai_ui_' + Date.now() + '.py');
  try { fs.writeFileSync(tmpFile, script, 'utf-8'); }
  catch (e) { return resolve({ ok: false, error: 'Could not write temp script: ' + e.message }); }

  const wslTmp = winToWslPath(tmpFile);
  const cmd = _wslAvailable
    ? `wsl bash -c 'python3 "${wslTmp.replace(/"/g, '\\"')}" 2>&1'`
    : `python "${tmpFile}"`;

  exec(cmd, {
    cwd: options.cwd || os.homedir(),
    timeout: options.timeout || 20000,
    env: { ...process.env },
    shell: true,
  }, (error, stdout, stderr) => {
    try { fs.unlinkSync(tmpFile); } catch { }
    resolve({
      ok: !error || error.code === 0,
      stdout: stdout || '',
      stderr: stderr || '',
      error: error ? error.message : null,
    });
  });
}));

// ── FS ──
ipcMain.handle('fs:open-files', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('fs:open-folder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('fs:stat', async (_, fp) => {
  try {
    const stats = fs.statSync(fp.replace(/^~/, os.homedir()));
    return { ok: true, isDirectory: stats.isDirectory(), isFile: stats.isFile(), size: stats.size };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:read-file', async (_, fp) => {
  try {
    fp = fp.replace(/^~/, os.homedir());
    const stat = fs.statSync(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const name = path.basename(fp);

    // ── Image files ──
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext))
      return { ok: true, content: `[Image: ${name}, ${Math.round(stat.size / 1024)}KB]`, size: stat.size };

    // ── Excel / binary Office formats ──
    if (['xlsx', 'xls'].includes(ext))
      return { ok: true, content: `[Excel: ${name} — open in Office or convert to CSV for AI analysis]`, size: stat.size };

    // ── Word documents ──
    if (['docx', 'doc'].includes(ext))
      return { ok: true, content: `[Word: ${name} — convert to .txt or .md for AI analysis]`, size: stat.size };

    // ── PDF: 3-tier text extraction ──
    if (ext === 'pdf') {
      // Tier 1: WSL pdftotext (most accurate, preserves layout)
      if (_wslAvailable) {
        const wslPath = winToWslPath(fp);
        const r = await wslExec(
          `pdftotext "${wslPath.replace(/"/g, '\\"')}" - 2>/dev/null`,
          { timeout: 20000 }
        );
        if (r.ok && r.stdout && r.stdout.trim().length > 30) {
          return { ok: true, content: r.stdout.trim(), size: stat.size, source: 'pdftotext' };
        }
        // pdftotext not installed — fall through to Tier 2
      }

      // Tier 2: pdf-parse (pure Node.js, no WSL needed)
      try {
        const pdfParse = require('pdf-parse');
        const buf = fs.readFileSync(fp);
        const data = await pdfParse(buf);
        const text = (data.text || '').trim();
        if (text.length > 10) {
          return {
            ok: true, content: text, size: stat.size,
            source: 'pdf-parse', pages: data.numpages,
            info: `${data.numpages} page(s)`,
          };
        }
        // Scanned / image-only PDF — no embedded text
        return {
          ok: true,
          content: `[PDF: ${name} — ${data.numpages} page(s), scanned/image-only PDF, no embedded text. Use OCR to extract content.]`,
          size: stat.size,
        };
      } catch (pdfErr) {
        console.error('[fs:read-file] pdf-parse failed:', pdfErr.message);
      }

      // Tier 3: actionable error with install hint
      return {
        ok: true,
        content: [
          `[PDF: ${name} — text extraction unavailable]`,
          ``,
          `To enable PDF reading, install poppler-utils in WSL:`,
          `  wsl sudo apt install -y poppler-utils`,
          ``,
          `Then reload the file.`,
        ].join('\n'),
        size: stat.size,
      };
    }

    // ── All other files: binary guard then UTF-8 read ──
    const buf = fs.readFileSync(fp);
    let bin = false;
    for (let i = 0; i < Math.min(512, buf.length); i++) { if (buf[i] === 0) { bin = true; break; } }
    if (bin) return { ok: true, content: `[Binary: ${name}, ${Math.round(stat.size / 1024)}KB]`, size: stat.size };
    return { ok: true, content: fs.readFileSync(fp, 'utf-8'), size: stat.size };

  } catch (e) { return { ok: false, error: e.message }; }
});

function walkDir(dir, max = 5, d = 0) { if (d > max) return []; const skip = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', 'dist', 'build', '.venv', 'venv', '.next']); let r = []; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (skip.has(e.name)) continue; const f = path.join(dir, e.name); if (e.isDirectory()) r.push(...walkDir(f, max, d + 1)); else r.push(f); } } catch { } return r; }
ipcMain.handle('fs:list-folder', (_, p) => walkDir(p));

ipcMain.handle('fs:write-file', async (_, fp, c) => {
  try {
    fp = fp.replace(/^~/, os.homedir());
    if (fs.existsSync(fp)) fs.copyFileSync(fp, fp + '.scaai.bak');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, c, 'utf-8');
    const stat = fs.statSync(fp);
    return { ok: true, content: c, size: stat.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:create-file', async (_, fp, c) => { try { fp = fp.replace(/^~/, os.homedir()); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, c || '', 'utf-8'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

ipcMain.handle('fs:delete-file', async (_, fp) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1,
    message: `Permanently delete this file from disk?\n\n${fp}`, detail: 'This cannot be undone.',
  });
  if (r.response === 0) {
    try { fs.unlinkSync(fp.replace(/^~/, os.homedir())); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Cancelled' };
});

ipcMain.handle('fs:refresh-file', async (_, fp) => {
  try {
    fp = fp.replace(/^~/, os.homedir());
    if (!fs.existsSync(fp)) return { ok: false, gone: true, error: 'File no longer exists on disk' };
    const stat = fs.statSync(fp), ext = path.extname(fp).slice(1).toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return { ok: true, content: `[Image: ${path.basename(fp)}, ${Math.round(stat.size / 1024)}KB]`, size: stat.size };
    const buf = fs.readFileSync(fp); let bin = false; for (let i = 0; i < Math.min(512, buf.length); i++) { if (buf[i] === 0) { bin = true; break; } }
    if (bin) return { ok: true, content: `[Binary: ${path.basename(fp)}, ${Math.round(stat.size / 1024)}KB]`, size: stat.size };
    return { ok: true, content: fs.readFileSync(fp, 'utf-8'), size: stat.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:refresh-folder', async (_, folderRoot) => {
  try { folderRoot = folderRoot.replace(/^~/, os.homedir()); const paths = walkDir(folderRoot); return { ok: true, paths }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:save-dialog', async (_, n) => { const r = await dialog.showSaveDialog(win, { defaultPath: n || 'untitled.txt' }); return r.canceled ? null : r.filePath; });
ipcMain.handle('fs:open-external', (_, p) => { shell.openPath(p); return true; });

// ── Feedback store ──
ipcMain.handle('feedback:save', async (_, entry) => {
  try {
    ensureDataDir();
    const existing = readJSON(FEEDBACK_FILE, []);
    existing.push(entry);
    writeJSON(FEEDBACK_FILE, existing);
    return { ok: true, count: existing.length };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('feedback:load', () => readJSON(FEEDBACK_FILE, []));

// ── Notes store (saved text snippets) ──
ipcMain.handle('threads:save', async (_, entry) => {
  try {
    ensureDataDir();
    const existing = readJSON(THREADS_FILE, []);
    existing.push(entry);
    writeJSON(THREADS_FILE, existing);
    return { ok: true, count: existing.length };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('threads:load', () => readJSON(THREADS_FILE, []));
ipcMain.handle('threads:delete', async (_, id) => {
  try {
    const existing = readJSON(THREADS_FILE, []);
    const updated = existing.filter(t => t.id !== id);
    writeJSON(THREADS_FILE, updated);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── User Profile store (persistent across sessions, works offline) ──
ipcMain.handle('profile:load', () => readJSON(PROFILE_FILE, {
  name: '', projects: [], preferences: [], workingStyle: '', recentTopics: [], lastUpdated: null
}));
ipcMain.handle('profile:save', async (_, data) => {
  try {
    ensureDataDir();
    const existing = readJSON(PROFILE_FILE, {});
    const merged = { ...existing, ...data, lastUpdated: Date.now() };
    writeJSON(PROFILE_FILE, merged);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('profile:update-field', async (_, key, value) => {
  try {
    ensureDataDir();
    const existing = readJSON(PROFILE_FILE, {});
    // Arrays: merge+dedupe; strings: replace
    if (Array.isArray(value) && Array.isArray(existing[key])) {
      existing[key] = [...new Set([...existing[key], ...value])].slice(-30);
    } else {
      existing[key] = value;
    }
    existing.lastUpdated = Date.now();
    writeJSON(PROFILE_FILE, existing);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Tools config store ──
ipcMain.handle('tools:load', () => readJSON(TOOLS_FILE, {
  systemInstructions: '',
  webSearch: { engine: 'tavily', tavilyKey: '', braveKey: '', googleKey: '', googleCx: '' },
  obsidian: { configured: false, vaultPath: '', templatePath: '', folderStructure: { researchFolder: 'Research', conceptsFolder: 'Concepts', meetingsFolder: 'Meetings', projectsFolder: 'Projects' } },
}));
ipcMain.handle('tools:save', async (_, data) => {
  try { ensureDataDir(); writeJSON(TOOLS_FILE, data); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Projects store ──
ipcMain.handle('projects:load', () => readJSON(PROJECTS_FILE, []));
ipcMain.handle('projects:create', async (_, proj) => {
  try {
    ensureDataDir();
    const list = readJSON(PROJECTS_FILE, []);
    const entry = {
      id: 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: proj.name || 'Untitled Project',
      description: proj.description || '',
      phase: 'planning',
      systemPrompt: '',
      context: '',
      color: proj.color || '#6c63ff',
      chatIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.push(entry);
    writeJSON(PROJECTS_FILE, list);
    return { ok: true, project: entry };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('projects:update', async (_, id, data) => {
  try {
    ensureDataDir();
    const list = readJSON(PROJECTS_FILE, []);
    const idx = list.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: 'Project not found' };
    list[idx] = { ...list[idx], ...data, id, updatedAt: Date.now() };
    writeJSON(PROJECTS_FILE, list);
    return { ok: true, project: list[idx] };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('projects:delete', async (_, id) => {
  try {
    ensureDataDir();
    const list = readJSON(PROJECTS_FILE, []);
    const updated = list.filter(p => p.id !== id);
    writeJSON(PROJECTS_FILE, updated);
    // also remove all chats belonging to this project
    const chats = readJSON(CHATS_FILE, []);
    const updChats = chats.filter(c => c.projectId !== id);
    writeJSON(CHATS_FILE, updChats);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('projects:rename', async (_, id, name) => {
  try {
    ensureDataDir();
    const list = readJSON(PROJECTS_FILE, []);
    const idx = list.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: 'Project not found' };
    list[idx].name = name; list[idx].updatedAt = Date.now();
    writeJSON(PROJECTS_FILE, list);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Chats (session history) store ──
ipcMain.handle('chats:load', () => readJSON(CHATS_FILE, []));
ipcMain.handle('chats:save', async (_, chat) => {
  try {
    ensureDataDir();
    const list = readJSON(CHATS_FILE, []);
    const idx = list.findIndex(c => c.id === chat.id);
    if (idx !== -1) { list[idx] = { ...list[idx], ...chat, updatedAt: Date.now() }; }
    else { list.push({ ...chat, createdAt: chat.createdAt || Date.now(), updatedAt: Date.now() }); }
    // Trim before write: keep last 200 chats total
    if (list.length > 200) { list.splice(0, list.length - 200); }
    await enqueueWrite(CHATS_FILE, list);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('chats:delete', async (_, id) => {
  try {
    ensureDataDir();
    const list = readJSON(CHATS_FILE, []);
    writeJSON(CHATS_FILE, list.filter(c => c.id !== id));
    // Clean up attachment files for this chat
    const chatDir = path.join(ATTACHMENTS_DIR, id);
    if (fs.existsSync(chatDir)) {
      fs.rmSync(chatDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('chats:rename', async (_, id, newTitle) => {
  try {
    ensureDataDir();
    const list = readJSON(CHATS_FILE, []);
    const idx = list.findIndex(c => c.id === id);
    if (idx === -1) return { ok: false, error: 'Chat not found' };
    list[idx] = { ...list[idx], title: newTitle, updatedAt: Date.now() };
    writeJSON(CHATS_FILE, list);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('chats:load-by-project', async (_, projectId) => {
  try {
    const list = readJSON(CHATS_FILE, []);
    return { ok: true, chats: list.filter(c => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt) };
  } catch (e) { return { ok: false, chats: [], error: e.message }; }
});

// ══════════════════════════════════════════
// ── Semantic Memory IPC ──
// ══════════════════════════════════════════

// Ensure the bridge script exists in ~/.scaai/
// ── Bridge source embedded at build time (v019ade53) ──
// Always written to disk on launch so users never need to manually copy the file
const BRIDGE_SOURCE = `#!/usr/bin/env python3
"""
SCAAI Semantic Memory Bridge v3
- Uses chromadb.utils.embedding_functions.ONNXMiniLM_L6_V2 (fast, no internet needed)
  Falls back to hash-based embeddings if ONNX not available
- Args: python semantic_bridge.py <command>
        python semantic_bridge.py <command> '{"key":"val"}'
        python semantic_bridge.py <command> --file /path/to/args.json
Commands: init, search, store, stats, recall, learn, forget, delete, list_all, ingest
"""
import sys, json, os, hashlib, time, warnings

# Suppress ALL warnings and chromadb telemetry noise before any imports
warnings.filterwarnings("ignore")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
os.environ.setdefault("CHROMA_TELEMETRY", "False")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

# Silence chromadb startup noise  -  capture both stdout and stderr during import
import io as _io
_real_stdout = sys.stdout
_real_stderr = sys.stderr
sys.stdout = _io.StringIO()
sys.stderr = _io.StringIO()
try:
    import chromadb as _chroma_preload
except Exception:
    pass
finally:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr

CHROMA_PATH = os.path.expanduser("~/.scaai/chroma_db")

def parse_args():
    argv = sys.argv[1:]
    if not argv:
        return None, {}
    cmd = argv[0]
    args = {}
    if len(argv) >= 3 and argv[1] == '--file':
        try:
            with open(argv[2], 'r', encoding='utf-8') as f:
                args = json.load(f)
        except Exception:
            args = {}
    elif len(argv) >= 2:
        try:
            args = json.loads(argv[1])
        except Exception:
            args = {}
    return cmd, args

def get_embedding_fn():
    """
    Return the fastest available embedding function.
    Handles chromadb 0.x, 1.x, and 1.5.x import path changes.
    All import attempts suppress stdout/stderr so no noise leaks into
    the SCAAI_JSON output stream.
    """
    # chromadb 1.5.x moved ONNX to a sub-module; try both known paths silently
    for _mod_path in [
        "chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2",
        "chromadb.utils.embedding_functions",
    ]:
        try:
            import importlib as _imp
            _mod = _imp.import_module(_mod_path)
            _cls = getattr(_mod, "ONNXMiniLM_L6_V2", None)
            if _cls:
                _so, _se = sys.stdout, sys.stderr
                sys.stdout = _io.StringIO(); sys.stderr = _io.StringIO()
                try:
                    fn = _cls()
                    fn(["warmup"])   # trigger model load now — avoids delay on first query
                    return fn
                except Exception:
                    pass
                finally:
                    sys.stdout = _so; sys.stderr = _se
        except Exception:
            pass

    # sentence-transformers DefaultEmbeddingFunction (chromadb 0.x / older 1.x)
    try:
        _so, _se = sys.stdout, sys.stderr
        sys.stdout = _io.StringIO(); sys.stderr = _io.StringIO()
        try:
            from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
            fn = DefaultEmbeddingFunction()
            fn(["test"])
            return fn
        except Exception:
            pass
        finally:
            sys.stdout = _so; sys.stderr = _se
    except Exception:
        pass

    # Hash fallback — deterministic, no downloads, always works offline.
    # Uses 384 dims to match MiniLM-L6 so cosine similarity is consistent.
    class HashEmbeddings:
        def __call__(self, texts):
            results = []
            for text in texts:
                vec = [0.0] * 384
                for i, ch in enumerate(text[:2048]):
                    idx = (ord(ch) * 31 + i * 7) % 384
                    vec[idx] += 1.0
                norm = (sum(v*v for v in vec) ** 0.5) or 1.0
                results.append([v/norm for v in vec])
            return results
    return HashEmbeddings()

_embedding_fn = None
def get_ef():
    global _embedding_fn
    if _embedding_fn is None:
        _embedding_fn = get_embedding_fn()
    return _embedding_fn

def get_client():
    import chromadb
    # chromadb 1.x removed Settings and the settings= kwarg from PersistentClient.
    # Telemetry is suppressed via env vars set at the top of this file.
    # Suppress any stdout/stderr chromadb emits during client init.
    _so, _se = sys.stdout, sys.stderr
    sys.stdout = _io.StringIO()
    sys.stderr = _io.StringIO()
    try:
        # Try 1.x API first (no settings kwarg)
        try:
            client = chromadb.PersistentClient(path=CHROMA_PATH)
        except TypeError:
            # Fallback for older chromadb that accepted settings=
            try:
                from chromadb.config import Settings as _S
                client = chromadb.PersistentClient(
                    path=CHROMA_PATH,
                    settings=_S(anonymized_telemetry=False)
                )
            except Exception:
                client = chromadb.PersistentClient(path=CHROMA_PATH)
    finally:
        sys.stdout = _so
        sys.stderr = _se
    return client

def get_collection(client):
    # chromadb 1.5.x breaking change: list_collections() return type changed;
    # accessing .name on it raises AttributeError.
    # Safe fix: always try get_collection() first — it uses the persisted
    # embedding function and avoids the "different embedding function" conflict.
    # Only create if the collection genuinely doesn't exist yet.
    try:
        return client.get_collection(name="scaai_memory")
    except Exception:
        pass
    try:
        return client.create_collection(
            name="scaai_memory",
            embedding_function=get_ef(),
            metadata={"hnsw:space": "cosine"}
        )
    except Exception:
        # Last resort — get_or_create with no explicit fn
        return client.get_or_create_collection(name="scaai_memory")


def out(data):
    # Write directly to fd 1 — bypasses ALL Python IO buffering and
    # sys.stdout redirection. chromadb suppression blocks sys.stdout into
    # a StringIO buffer; os.write(1,...) goes straight to the pipe Node reads.
    # chr(10) used instead of backslash-n so JS template literal does not
    # expand it into a real newline when writing this file to disk.
    line = "SCAAI_JSON:" + json.dumps(data) + chr(10)
    try:
        os.write(1, line.encode("utf-8"))
    except Exception:
        try:
            _real_stdout.write(line)
            _real_stdout.flush()
        except Exception:
            pass

def _emergency_out(err_msg):
    """Guaranteed output even if out() itself fails — used in top-level except."""
    line = 'SCAAI_JSON:{"ok":false,"error":' + json.dumps(str(err_msg)) + '}' + chr(10)
    try:
        os.write(1, line.encode("utf-8"))
    except Exception:
        pass

def cmd_init():
    try:
        client = get_client()
        col = get_collection(client)
        count = col.count()
        out({"ok": True, "count": count, "path": CHROMA_PATH})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_search(args):
    try:
        query = args.get("query", "")
        n = args.get("n", 5)
        filter_type = args.get("type", None)
        if not query:
            out({"ok": False, "error": "empty query"})
            return
        client = get_client()
        col = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "results": []})
            return
        where = {"type": filter_type} if filter_type else None
        kwargs = {"query_texts": [query], "n_results": min(n, col.count())}
        if where:
            kwargs["where"] = where
        results = col.query(**kwargs)
        res_out = []
        for i, doc in enumerate(results["documents"][0]):
            meta = results["metadatas"][0][i] if results.get("metadatas") else {}
            dist = results["distances"][0][i] if results.get("distances") else 1.0
            res_out.append({
                "content": doc, "meta": meta,
                "score": round(1 - dist, 4),
                "id": results["ids"][0][i] if results.get("ids") else ""
            })
        out({"ok": True, "results": res_out})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_store(args):
    try:
        content = args.get("content", "")
        meta    = args.get("meta", {})
        doc_id  = args.get("id", None)
        if not content:
            out({"ok": False, "error": "empty content"})
            return
        if not doc_id:
            doc_id = "doc_" + hashlib.md5((content[:200] + str(time.time())).encode()).hexdigest()[:12]
        meta["ts"] = meta.get("ts", str(int(time.time())))
        client = get_client()
        col = get_collection(client)
        col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
        out({"ok": True, "id": doc_id, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_stats():
    try:
        client = get_client()
        col = get_collection(client)
        count = col.count()
        peek = col.peek(limit=5) if count > 0 else {}
        recent = []
        if peek and peek.get("documents"):
            for i, doc in enumerate(peek["documents"]):
                meta = peek["metadatas"][i] if peek.get("metadatas") else {}
                recent.append({"content": doc[:120], "meta": meta})
        out({"ok": True, "count": count, "path": CHROMA_PATH, "recent": recent})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_recall(args):
    args["n"] = args.get("n", 8)
    cmd_search(args)

def cmd_learn(args):
    try:
        content = args.get("content", "")
        label   = args.get("label", "")
        tags    = args.get("tags", [])
        if not content:
            out({"ok": False, "error": "empty content"})
            return
        meta = {
            "type":   "learned",
            "label":  label,
            "tags":   ",".join(tags) if tags else "",
            "ts":     str(int(time.time())),
            "source": args.get("source", "user"),
        }
        if label:
            doc_id = "learn_" + hashlib.md5(label.lower().encode()).hexdigest()[:12]
        else:
            doc_id = "learn_" + hashlib.md5((content[:200] + str(time.time())).encode()).hexdigest()[:12]
        client = get_client()
        col = get_collection(client)
        col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
        out({"ok": True, "id": doc_id, "label": label, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_forget(args):
    try:
        doc_id  = args.get("id", None)
        label   = args.get("label", None)
        keyword = args.get("keyword", None)
        client  = get_client()
        col     = get_collection(client)
        deleted_ids = []
        if doc_id:
            col.delete(ids=[doc_id])
            deleted_ids.append(doc_id)
        elif label:
            guessed = "learn_" + hashlib.md5(label.lower().encode()).hexdigest()[:12]
            try:
                col.delete(ids=[guessed])
                deleted_ids.append(guessed)
            except Exception:
                pass
            try:
                res = col.get(where={"label": label})
                if res and res.get("ids"):
                    col.delete(ids=res["ids"])
                    deleted_ids.extend(res["ids"])
            except Exception:
                pass
        elif keyword:
            if col.count() > 0:
                res = col.query(query_texts=[keyword], n_results=min(5, col.count()))
                if res and res.get("ids") and res["ids"][0]:
                    col.delete(ids=res["ids"][0])
                    deleted_ids.extend(res["ids"][0])
        out({"ok": True, "deleted": deleted_ids, "remaining": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_list_all(args):
    try:
        limit  = args.get("limit", 20)
        offset = args.get("offset", 0)
        client = get_client()
        col    = get_collection(client)
        count  = col.count()
        if count == 0:
            out({"ok": True, "entries": [], "total": 0})
            return
        res = col.get(limit=min(limit, count), offset=offset,
                      include=["documents", "metadatas"])
        entries = []
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta = res["metadatas"][i] if res.get("metadatas") else {}
                entries.append({
                    "id":      res["ids"][i] if res.get("ids") else "",
                    "content": doc[:200], "meta": meta,
                })
        out({"ok": True, "entries": entries, "total": count, "offset": offset})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_ingest(args):
    """
    Batch-ingest chunks from one or more files into ChromaDB as type:knowledge.
    args = {
      "chunks": [
        {"content": "...", "source": "filename.md", "chunk_id": 0},
        ...
      ]
    }
    Uses deterministic IDs (kb_<hash of source+chunk_id>) so re-ingesting
    the same file is idempotent  -  existing chunks are upserted, not duplicated.
    """
    try:
        chunks = args.get("chunks", [])
        if not chunks:
            out({"ok": False, "error": "no chunks provided"})
            return
        client = get_client()
        col    = get_collection(client)
        stored = 0
        ids, docs, metas = [], [], []
        for c in chunks:
            content_text = c.get("content", "").strip()
            if not content_text or len(content_text) < 20:
                continue
            source   = c.get("source", "unknown")
            chunk_id = c.get("chunk_id", 0)
            # Deterministic ID  -  same source+chunk_id always maps to same vector slot
            raw_id   = f"kb_{source}_{chunk_id}"
            doc_id   = "kb_" + hashlib.md5(raw_id.encode()).hexdigest()[:16]
            meta = {
                "type":     "knowledge",
                "source":   source,
                "chunk_id": str(chunk_id),
                "ts":       str(int(time.time())),
                "label":    f"{source}_{chunk_id}",
            }
            ids.append(doc_id)
            docs.append(content_text)
            metas.append(meta)
            stored += 1
        if not ids:
            out({"ok": False, "error": "all chunks were empty or too short"})
            return
        # Upsert in one batch  -  efficient for large files
        col.upsert(documents=docs, metadatas=metas, ids=ids)
        out({"ok": True, "stored": stored, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_context(args):
    """
    Tiered multi-query context fetch for the cognitive pipeline.
    TIER 1: Always fetch ALL learned/identity/preference/project facts first.
    TIER 2: Fill remaining slots with semantic search across exchange+synthesis.
    This prevents high-value profile facts from being crowded out by exchange volume.
    """
    import time
    try:
        queries   = args.get("queries", [])
        n         = args.get("n", 5)
        min_score = args.get("min_score", 0.08)
        if not queries:
            out({"ok": False, "error": "no queries provided"})
            return
        client = get_client()
        col    = get_collection(client)
        total  = col.count()
        if total == 0:
            out({"ok": True, "results": [], "total_db": 0})
            return

        seen_ids = set()
        merged   = []

        # TIER 1: Always include ALL structured facts (never crowded out by exchange volume)
        for type_filter in ["learned", "identity", "preference", "project"]:
            try:
                res = col.get(
                    where={"type": type_filter},
                    limit=50,
                    include=["documents", "metadatas", "ids"]
                )
                if not res or not res.get("documents"):
                    continue
                for i, doc in enumerate(res["documents"]):
                    rid  = res["ids"][i] if res.get("ids") else ""
                    meta = res["metadatas"][i] if res.get("metadatas") else {}
                    if rid in seen_ids:
                        continue
                    seen_ids.add(rid)
                    merged.append({
                        "content": doc, "meta": meta, "score": 1.0,
                        "id": rid, "matched_query": "__profile__", "tier": 1
                    })
            except Exception:
                continue

        # TIER 2: Semantic search for exchange + synthesis entries
        for q in queries[:4]:
            if not q or not q.strip():
                continue
            try:
                res = col.query(
                    query_texts=[q],
                    n_results=min(n, total),
                    include=["documents", "metadatas", "distances", "ids"]
                )
                for i, doc in enumerate(res["documents"][0]):
                    rid   = res["ids"][0][i] if res.get("ids") else ""
                    dist  = res["distances"][0][i] if res.get("distances") else 1.0
                    score = round(1 - dist, 4)
                    meta  = res["metadatas"][0][i] if res.get("metadatas") else {}
                    mtype = meta.get("type", "")
                    if mtype in ("learned", "identity", "preference", "project"):
                        continue  # already in tier 1
                    if score < min_score:
                        continue
                    if rid in seen_ids:
                        for m in merged:
                            if m["id"] == rid and score > m["score"]:
                                m["score"] = score
                        continue
                    seen_ids.add(rid)
                    merged.append({
                        "content": doc, "meta": meta, "score": score,
                        "id": rid, "matched_query": q[:60], "tier": 2
                    })
            except Exception:
                continue

        merged.sort(key=lambda x: (x.get("tier", 2), -x["score"]))
        out({"ok": True, "results": merged[:n*3], "total_db": total})
    except Exception as e:
        out({"ok": False, "error": str(e)})
def cmd_profile(args):
    try:
        client = get_client()
        col    = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "facts": [], "total": 0})
            return
        facts = []
        for type_filter in ["learned", "identity", "preference", "project"]:
            try:
                res = col.get(where={"type": type_filter}, limit=50,
                              include=["documents","metadatas"])
                if res and res.get("documents"):
                    for i, doc in enumerate(res["documents"]):
                        meta = res["metadatas"][i] if res.get("metadatas") else {}
                        facts.append({"content":doc,"type":type_filter,
                                      "label":meta.get("label",""),"ts":meta.get("ts",""),
                                      "id":res["ids"][i] if res.get("ids") else ""})
            except Exception:
                continue
        seen = set()
        unique = []
        for f in facts:
            if f["id"] not in seen:
                seen.add(f["id"])
                unique.append(f)
        unique.sort(key=lambda x: x.get("ts",""), reverse=True)
        out({"ok": True, "facts": unique, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_recall_by_date(args):
    try:
        ts_from = int(args.get("ts_from", 0))
        ts_to   = int(args.get("ts_to", 9999999999))
        n       = int(args.get("n", 20))
        client  = get_client()
        col     = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "results": [], "window": {"from": ts_from, "to": ts_to}})
            return
        res = col.get(limit=min(col.count(), 2000), include=["documents","metadatas"])
        entries = []
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta = res["metadatas"][i] if res.get("metadatas") else {}
                try:
                    ts_val = int(meta.get("ts","0"))
                except (ValueError, TypeError):
                    continue
                if ts_from <= ts_val <= ts_to:
                    entries.append({"content":doc,"meta":meta,"ts":ts_val,
                                    "id":res["ids"][i] if res.get("ids") else ""})
        entries.sort(key=lambda x: x["ts"])
        entries = entries[:n]
        out({"ok": True, "results": entries, "total_in_window": len(entries),
             "window": {"from": ts_from, "to": ts_to}})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_embedding_check():
    """
    Detect which embedding function is actually active.
    Returns: {ok, engine, dim, semantic} where semantic=True means real embeddings.
    Used by the UI to warn the user if they are running hash-based fallback.
    """
    try:
        # Test ONNX first
        try:
            from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
            ef = ONNXMiniLM_L6_V2()
            test = ef(["test semantic embedding quality"])
            dim = len(test[0]) if test else 0
            out({"ok": True, "engine": "ONNXMiniLM_L6_V2", "dim": dim, "semantic": True,
                 "note": "Real semantic embeddings active. Retrieval quality: excellent."})
            return
        except Exception:
            pass
        # Test sentence-transformers default
        try:
            from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
            ef = DefaultEmbeddingFunction()
            test = ef(["test"])
            dim = len(test[0]) if test else 0
            out({"ok": True, "engine": "DefaultEmbeddingFunction", "dim": dim, "semantic": True,
                 "note": "sentence-transformers embeddings active. Retrieval quality: good."})
            return
        except Exception:
            pass
        # Hash fallback is active — this is the problem
        out({"ok": True, "engine": "HashEmbeddings_fallback", "dim": 256, "semantic": False,
             "note": "WARNING: Hash-based embeddings active. Retrieval quality: poor. "
                     "Install ONNX embeddings: pip install 'chromadb[onnx]' or pip install onnxruntime"})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_health(args):
    """
    Returns memory health stats: entry count by type, timestamp distribution,
    most common topic tags. Used by the memory health dashboard (U12).
    """
    try:
        client = get_client()
        col    = get_collection(client)
        total  = col.count()
        if total == 0:
            out({"ok": True, "total": 0, "by_type": {}, "by_source": {}, "topics": [], "oldest_ts": None, "newest_ts": None})
            return

        type_counts   = {}
        source_counts = {}
        topic_freq    = {}
        oldest_ts     = None
        newest_ts     = None
        batch_size    = 200
        offset        = 0

        while offset < total:
            res = col.get(limit=batch_size, offset=offset, include=["metadatas"])
            if not res or not res.get("metadatas"):
                break
            for meta in res["metadatas"]:
                mtype  = meta.get("type", "unknown")
                msrc   = meta.get("source", "")
                mtopic = meta.get("topic", "")
                mts    = meta.get("ts", "")
                type_counts[mtype]   = type_counts.get(mtype, 0) + 1
                if msrc:
                    source_counts[msrc] = source_counts.get(msrc, 0) + 1
                if mtopic:
                    for tag in mtopic.split(","):
                        t = tag.strip()
                        if t and len(t) > 3:
                            topic_freq[t] = topic_freq.get(t, 0) + 1
                try:
                    ts_int = int(mts)
                    if oldest_ts is None or ts_int < oldest_ts:
                        oldest_ts = ts_int
                    if newest_ts is None or ts_int > newest_ts:
                        newest_ts = ts_int
                except (ValueError, TypeError):
                    pass
            offset += batch_size

        sorted_topics = sorted(topic_freq.items(), key=lambda x: x[1], reverse=True)[:15]
        out({"ok": True, "total": total, "by_type": type_counts, "by_source": source_counts,
             "topics": sorted_topics, "oldest_ts": oldest_ts, "newest_ts": newest_ts})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_prune_old(args):
    """
    Remove low-value exchange entries older than N days.
    Structured facts (learned/identity/preference/project/synthesis) are NEVER pruned.
    """
    import time as _time
    try:
        days       = int(args.get("days", 60))
        min_len    = int(args.get("min_content_len", 120))
        dry_run    = args.get("dry_run", False)
        cutoff_ts  = int(_time.time()) - (days * 86400)
        client     = get_client()
        col        = get_collection(client)
        total      = col.count()
        SAFE_TYPES = {"learned", "identity", "preference", "project", "synthesis",
                      "session_summary", "retrospective", "codebase", "codebase_deep", "knowledge"}
        to_delete  = []
        batch_size = 200
        offset     = 0

        while offset < total:
            res = col.get(limit=batch_size, offset=offset,
                          include=["documents", "metadatas", "ids"])
            if not res or not res.get("documents"):
                break
            for i, doc in enumerate(res["documents"]):
                meta  = res["metadatas"][i] if res.get("metadatas") else {}
                rid   = res["ids"][i] if res.get("ids") else ""
                mtype = meta.get("type", "exchange")
                try:
                    mts = int(meta.get("ts", "0"))
                except (ValueError, TypeError):
                    mts = 0
                if mtype in SAFE_TYPES:
                    continue
                if mts > cutoff_ts:
                    continue
                if len(doc) >= min_len:
                    continue
                to_delete.append(rid)
            offset += batch_size

        if not dry_run and to_delete:
            for i in range(0, len(to_delete), 50):
                try:
                    col.delete(ids=to_delete[i:i+50])
                except Exception:
                    pass

        out({"ok": True, "pruned": len(to_delete), "dry_run": dry_run,
             "remaining": col.count(), "cutoff_days": days})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_import_conversations(args):
    """
    Bulk-import conversation history: [{role, content, ts}]
    """
    import hashlib, time as _time
    try:
        entries  = args.get("entries", [])
        if not entries:
            out({"ok": False, "error": "no entries provided"})
            return
        client   = get_client()
        col      = get_collection(client)
        imported = 0
        skipped  = 0

        for entry in entries:
            content = (entry.get("content") or "").strip()
            role    = entry.get("role", "user")
            ts      = entry.get("ts", int(_time.time()))
            if len(content) < 30:
                skipped += 1
                continue
            doc_id  = "import_" + hashlib.md5(content[:200].encode()).hexdigest()[:12]
            meta    = {"type": "exchange", "role": role, "ts": str(int(ts)), "source": "import"}
            try:
                col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
                imported += 1
            except Exception:
                skipped += 1

        out({"ok": True, "imported": imported, "skipped": skipped, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})



def cmd_topics(args):
    """
    Returns all stored topic_checkpoint labels — the actual verified topics
    SCAAI has explicit memory of from past sessions. Honest memory list only.
    """
    try:
        client = get_client()
        col    = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "topics": [], "total": 0})
            return
        res = col.get(limit=500, include=["documents", "metadatas", "ids"])
        topics = []
        seen_labels = set()
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta   = res["metadatas"][i] if res.get("metadatas") else {}
                source = meta.get("source", "")
                tags   = str(meta.get("tags", ""))
                if source != "topic_continuity" and "topic_checkpoint" not in tags:
                    continue
                label = ""
                for line in doc.strip().split("\\n")[:3]:
                    if line.startswith("[TOPIC_CHECKPOINT:"):
                        label = line[len("[TOPIC_CHECKPOINT:"):].rstrip("]").strip()
                        break
                if not label:
                    label = meta.get("label", "").replace("topic_chk_", "").replace("_", " ").strip()
                if not label or label in seen_labels:
                    continue
                seen_labels.add(label)
                status  = "unknown"
                summary = ""
                for line in doc.strip().split("\\n"):
                    if line.startswith("Status:"):
                        status = line[7:].strip()
                    if line.startswith("What we discussed:") and not summary:
                        summary = line[len("What we discussed:"):].strip()[:120]
                    elif line.startswith("Where we left off:") and not summary:
                        summary = line[len("Where we left off:"):].strip()[:120]
                topics.append({"label": label, "status": status,
                                "ts": meta.get("ts", "0"), "summary": summary})
        topics.sort(key=lambda x: x.get("ts", "0"), reverse=True)
        out({"ok": True, "topics": topics, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_score_relevance(args):
    """
    Vector-based relevance scoring for prompt compression.
    Embeds query + candidate texts in ONE batch, returns cosine similarity scores.
    No ChromaDB collection needed — pure embedding math.
    """
    try:
        query = (args.get("query") or "").strip()
        texts = args.get("texts") or []
        if not query:
            out({"ok": False, "error": "query is required"})
            return
        if not texts:
            out({"ok": True, "scores": [], "count": 0})
            return
        texts = [str(t)[:800] for t in texts[:200]]
        ef = get_ef()
        all_embeddings = ef([query] + texts)
        q_vec  = all_embeddings[0]
        q_norm = (sum(v * v for v in q_vec) ** 0.5) or 1.0
        q_unit = [v / q_norm for v in q_vec]
        scores = []
        for emb in all_embeddings[1:]:
            t_norm = (sum(v * v for v in emb) ** 0.5) or 1.0
            t_unit = [v / t_norm for v in emb]
            cos = sum(a * b for a, b in zip(q_unit, t_unit))
            scores.append(round(max(0.0, min(1.0, cos)), 4))
        out({"ok": True, "scores": scores, "count": len(scores)})
    except Exception as e:
        out({"ok": False, "error": str(e)})


if __name__ == "__main__":
    try:
        cmd, args = parse_args()
        if not cmd:
            out({"ok": False, "error": "no command given"})
            import sys as _sys; _sys.exit(1)
        dispatch = {
            "init":                  cmd_init,
            "search":                lambda: cmd_search(args),
            "store":                 lambda: cmd_store(args),
            "stats":                 cmd_stats,
            "recall":                lambda: cmd_recall(args),
            "learn":                 lambda: cmd_learn(args),
            "forget":                lambda: cmd_forget(args),
            "delete":                lambda: cmd_forget(args),
            "list_all":              lambda: cmd_list_all(args),
            "ingest":                lambda: cmd_ingest(args),
            "context":               lambda: cmd_context(args),
            "profile":               lambda: cmd_profile(args),
            "recall_by_date":        lambda: cmd_recall_by_date(args),
            "embedding_check":       cmd_embedding_check,
            "health":                cmd_health,
            "prune_old":             lambda: cmd_prune_old(args),
            "import_conversations":  lambda: cmd_import_conversations(args),
            "topics":                lambda: cmd_topics(args),
            "score_relevance":       lambda: cmd_score_relevance(args),
        }
        fn = dispatch.get(cmd)
        if fn:
            fn()
        else:
            out({"ok": False, "error": "unknown command: " + cmd})
    except Exception as _top_err:
        _emergency_out("fatal bridge error: " + str(_top_err))
`;

const BRIDGE_VERSION = 'e004-analyzer-purge';

function ensureBridge() {
  ensureDataDir();
  // U8: Only rewrite bridge when version changes — eliminates file I/O on every mem op.
  // Check .ver file first; if it matches BRIDGE_VERSION, skip the expensive rewrite.
  const verFile = BRIDGE_FILE + '.ver';
  try {
    const storedVer = fs.readFileSync(verFile, 'utf-8').trim();
    if (storedVer === BRIDGE_VERSION && fs.existsSync(BRIDGE_FILE)) {
      return true; // already current — skip rewrite
    }
  } catch (e) { /* ver file missing or unreadable — proceed with rewrite */ }
  // Version mismatch or first run — write bridge + update ver file
  try {
    fs.writeFileSync(BRIDGE_FILE, BRIDGE_SOURCE, 'utf-8');
    fs.writeFileSync(verFile, BRIDGE_VERSION, 'utf-8');
    console.log('[BRIDGE] Written version', BRIDGE_VERSION);
  } catch (e) {
    console.error('[BRIDGE] Could not write bridge:', e.message);
    return false;
  }
  return true;
}

// Timeout per command type — ChromaDB loads sentence-transformer models on first call
// First store/learn can take 30-60s on slow machines (model download + load)
// Subsequent calls are fast (<2s) once the model is cached in memory
const BRIDGE_TIMEOUTS = {
  init: 15000, stats: 15000,         // metadata ops — allow extra for first connect
  search: 20000, recall: 20000,       // vector search
  store: 90000, learn: 90000,         // first call: model load + embed (can be slow)
  forget: 20000, delete: 20000,
  list_all: 20000,
  ingest: 120000,
  embedding_check: 20000,            // test which embedding engine is active
  health: 30000,                     // full collection scan for health stats
  prune_old: 60000,                  // collection scan + batch delete
  import_conversations: 120000,       // bulk upsert — can be large
  score_relevance: 15000,            // embedding batch — fast after first model load
};

function runBridge(cmd, args = {}) {
  const timeoutMs = BRIDGE_TIMEOUTS[cmd] || 20000;
  return new Promise(resolve => {
    // U8: Bridge written once at startup — no per-call rewrite needed
    if (!fs.existsSync(BRIDGE_FILE)) {
      ensureBridge(); // emergency fallback if file was deleted
    }
    if (!fs.existsSync(BRIDGE_FILE)) {
      return resolve({ ok: false, error: 'semantic_bridge.py not found.' });
    }
    // Write args to temp JSON file — avoids all shell path-escaping on Windows
    const tmpArgs = path.join(os.tmpdir(), 'scaai_bridge_' + Date.now() + '.json');
    try { fs.writeFileSync(tmpArgs, JSON.stringify(args), 'utf-8'); }
    catch (e) { return resolve({ ok: false, error: 'Cannot write temp args: ' + e.message }); }

    // spawn — no shell, args as array, zero escaping issues
    function trySpawn(pyBin, callback) {
      let stdout = '', stderr = '', timedOut = false;
      let proc;
      try {
        proc = spawn(pyBin, [BRIDGE_FILE, cmd, '--file', tmpArgs], {
          env: { ...process.env },
          windowsHide: true,
        });
      } catch (e) { callback(e, null, null); return; }
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch { }
        callback(new Error('bridge timeout (' + timeoutMs + 'ms) — ChromaDB may be loading, try again'), stdout, stderr);
      }, timeoutMs);
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        try { fs.unlinkSync(tmpArgs); } catch { }
        if (timedOut) return;
        callback(code !== 0 && !stdout ? new Error('exit ' + code + ': ' + stderr.slice(0, 120)) : '', stdout, stderr);
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        try { fs.unlinkSync(tmpArgs); } catch { }
        callback(e, stdout, stderr);
      });
    }

    function parseOut(out) {
      // 1. Sentinel -- SCAAI_JSON: prefix is our guaranteed output line
      const si = out.indexOf('SCAAI_JSON:');
      if (si !== -1) {
        const jsonStr = out.slice(si + 11).split('\n')[0].trim();
        try { return JSON.parse(jsonStr); } catch (e) { }
      }
      // 2. Whole output
      const trimmed = out.trim();
      try { return JSON.parse(trimmed); } catch (e) { }
      // 3. Last line starting with { or [
      const lines = trimmed.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if ((l.startsWith('{') || l.startsWith('[')) && l.length > 2) {
          try { return JSON.parse(l); } catch (e2) { }
        }
      }
      // 4. Any {...} blob
      const m = trimmed.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e3) { } }
      return { ok: false, error: 'Bridge parse error: ' + trimmed.slice(0, 300) };
    }

    trySpawn('python', (error, stdout, stderr) => {
      const notFound = error && (
        error.code === 'ENOENT' ||
        /not found|not recognized|no such file|cannot find/i.test((error.message || '') + (stderr || ''))
      );
      if (notFound) {
        // python not in PATH — try python3
        trySpawn('python3', (err2, out2, serr2) => {
          if (err2 && !out2) {
            return resolve({ ok: false, error: 'Python not found in PATH. Install Python 3.8+ or check PATH.', stderr: serr2 || '' });
          }
          resolve(parseOut(out2));
        });
        return;
      }
      // Python ran but bridge crashed — include full stderr for diagnosis
      if (error && !stdout) {
        return resolve({
          ok: false,
          error: String(error.message || error),
          stderr: stderr || '',
          detail: stderr ? stderr.slice(0, 500) : ''
        });
      }
      if (!stdout.trim()) {
        return resolve({ ok: false, error: 'Bridge produced no output', stderr: stderr || '' });
      }
      resolve(parseOut(stdout));
    });
  });
}

// Diagnostic command — runs bridge with verbose output for troubleshooting
ipcMain.handle('sem:diagnose', async () => new Promise(resolve => {
  ensureBridge();
  // Use exec+shell=true so stderr is merged — catches Python import errors
  // that produce output on stderr only (before any print() runs)
  const { exec: ex } = require('child_process');
  const results = {};
  const q = s => `"${s.replace(/"/g, '\"')}"`;  // quote for shell

  function run(label, cmd, cb) {
    ex(cmd, { timeout: 15000, env: { ...process.env }, shell: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      results[label] = {
        code: err ? err.code : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        combined: ((stdout || '') + (stderr || '')).trim(),
        error: err ? err.message : null
      };
      cb();
    });
  }

  // Step 1: python version
  run('python_version', 'python --version 2>&1', () => {
    const pyOk = results.python_version.code === 0 || results.python_version.combined.includes('Python');
    const pyBin = pyOk ? 'python' : 'python3';

    // Step 2: python3 fallback if needed
    run('python3_version', 'python3 --version 2>&1', () => {

      // Step 3: chromadb import
      run('chromadb_import', `${pyBin} -c "import chromadb; print('chromadb:', chromadb.__version__)" 2>&1`, () => {

        // Step 4: run the actual bridge with shell so stderr is captured
        const tmpArgs = path.join(os.tmpdir(), 'scaai_diag_' + Date.now() + '.json');
        fs.writeFileSync(tmpArgs, '{}', 'utf-8');
        run('bridge_raw', `${pyBin} ${q(BRIDGE_FILE)} init --file ${q(tmpArgs)} 2>&1`, () => {
          try { fs.unlinkSync(tmpArgs); } catch { }

          // Step 5: check if bridge output is valid JSON
          const raw = results.bridge_raw.combined;
          function _extractJSON(s) {
            const si = s.indexOf('SCAAI_JSON:');
            if (si !== -1) { try { return JSON.parse(s.slice(si + 11).split('\n')[0].trim()); } catch (e) { } }
            try { return JSON.parse(s.trim()); } catch (e) { }
            const ls = s.trim().split('\n');
            for (let i = ls.length - 1; i >= 0; i--) {
              const l = ls[i].trim();
              if ((l.startsWith('{') || l.startsWith('[')) && l.length > 2) { try { return JSON.parse(l); } catch (e2) { } }
            }
            const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e3) { } }
            return null;
          }
          const _p = _extractJSON(raw);
          results.bridge_parsed = _p || { ok: false, error: 'Not valid JSON: ' + raw.slice(0, 400) };
          resolve({ ok: results.bridge_parsed && results.bridge_parsed.ok, results });
        });
      });
    });
  });
}));

ipcMain.handle('sem:init', async () => runBridge('init'));
ipcMain.handle('sem:search', async (_, args) => runBridge('search', args));
ipcMain.handle('sem:store', async (_, args) => runBridge('store', args));
ipcMain.handle('sem:stats', async () => runBridge('stats'));
// New semantic commands per SEMANTIC_MEMORY_SETUP.md
ipcMain.handle('sem:recall', async (_, args) => runBridge('recall', args));
ipcMain.handle('sem:learn', async (_, args) => runBridge('learn', args));
ipcMain.handle('sem:forget', async (_, args) => runBridge('forget', args));
ipcMain.handle('sem:list_all', async (_, args) => runBridge('list_all', args || {}));
ipcMain.handle('sem:ingest', async (_, args) => runBridge('ingest', args || {}));
// ── Cognitive Pipeline: batch context fetch + profile retrieval ──
ipcMain.handle('sem:context', async (_, args) => runBridge('context', args || {}));
ipcMain.handle('sem:profile', async () => runBridge('profile', {}));
ipcMain.handle('sem:recall_by_date', async (_, args) => runBridge('recall_by_date', args || {}));
ipcMain.handle('sem:embedding_check', async () => runBridge('embedding_check'));
ipcMain.handle('sem:health', async () => runBridge('health'));
ipcMain.handle('sem:prune', async (_, args) => runBridge('prune_old', args || {}));
ipcMain.handle('sem:import_conversations', async (_, args) => runBridge('import_conversations', args || {}));
ipcMain.handle('sem:topics', async (_, args) => runBridge('topics', args || {}));
// ── Vector relevance scoring for prompt compression ──
ipcMain.handle('sem:score', async (_, args) => runBridge('score_relevance', args || {}));

// ── Knowledge Graph ──
ipcMain.handle('sem:graph_store', async (_, args) => runBridge('graph_store', args || {}));
ipcMain.handle('sem:graph_query', async (_, args) => runBridge('graph_query', args || {}));
ipcMain.handle('sem:graph_all', async () => runBridge('graph_all', {}));
// ── Algorithmic Graph Intelligence ──
ipcMain.handle('sem:graph_centrality', async (_, args) => runBridge('graph_centrality', args || {}));
ipcMain.handle('sem:graph_cluster', async (_, args) => runBridge('graph_cluster', args || {}));
ipcMain.handle('sem:graph_decay', async (_, args) => runBridge('graph_decay', args || {}));
ipcMain.handle('sem:graph_boost', async (_, args) => runBridge('graph_boost', args || {}));
ipcMain.handle('sem:graph_traverse', async (_, args) => runBridge('graph_traverse', args || {}));

// Install chromadb if missing
ipcMain.handle('sem:install', async () => new Promise(resolve => {
  // Try python -m pip first (most reliable on Windows — uses exact Python in PATH)
  // Fall back to pip3, then pip
  const cmds = [
    'python -m pip install chromadb --quiet',
    'python3 -m pip install chromadb --quiet',
    'pip install chromadb --quiet',
    'pip3 install chromadb --quiet',
  ];
  let idx = 0;
  function tryNext() {
    if (idx >= cmds.length) return resolve({ ok: false, error: 'All pip methods failed. Install manually: python -m pip install chromadb' });
    const cmd = cmds[idx++];
    exec(cmd, { timeout: 180000, env: { ...process.env }, shell: true }, (error, stdout, stderr) => {
      if (!error) { resolve({ ok: true, stdout, stderr, cmd }); return; }
      // If it's a "not found" error, try next method; otherwise report the error
      const notFound = error.code === 'ENOENT' || /not found|not recognized|no such file/i.test((error.message || '') + (stderr || ''));
      if (notFound) { tryNext(); }
      else {
        // Non-ENOENT error — might still have worked partially, try verifying
        resolve({ ok: false, stdout, stderr, error: error.message, cmd });
      }
    });
  }
  tryNext();
}));

// ══════════════════════════════════════════
// ── API layer ──
// ══════════════════════════════════════════
function httpsPost(hostname, urlPath, headers, body) {
  return new Promise(resolve => {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    const mergedHeaders = {
      'User-Agent': 'SCAAI/1.0 (Desktop)',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(s),
      ...headers
    };
    const req = https.request({ hostname, path: urlPath, method: 'POST', headers: mergedHeaders }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'Request timed out after 30 seconds' });
    });
    req.write(s); req.end();
  });
}

// Anthropic
async function callAnthropic({ apiKey, model, system, messages, maxTokens }) {
  const modelId = model || 'claude-sonnet-4-20250514';
  const body = { model: modelId, max_tokens: maxTokens || 4096, system, messages };
  const res = await httpsPost('api.anthropic.com', '/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body);
  try {
    const j = JSON.parse(res.body);
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true };
    if (j.error) return { ok: false, error: j.error.message };
    const text = j.content?.map(c => c.text || '').join('') || '';
    return { ok: text.length > 0, text };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Gemini — updated with 2.0 Flash and Flash-Lite support
async function callGemini({ apiKey, model, system, messages, maxTokens }) {
  const modelMap = {
    'gemini-2.5-flash': 'gemini-2.5-flash',
    'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite-preview-06-17',
    'gemini-2.0-flash': 'gemini-2.0-flash',
    'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite',
  };
  const apiModel = modelMap[model] || model;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: maxTokens || 4096, temperature: 0.7 },
  };
  const res = await httpsPost('generativelanguage.googleapis.com', `/v1beta/models/${apiModel}:generateContent?key=${apiKey}`, {}, body);
  try {
    const j = JSON.parse(res.body);
    if (res.status === 400) return { ok: false, error: j.error?.message || 'Bad request' };
    if (res.status === 403 || res.status === 401) return { ok: false, authError: true };
    if (res.status === 429) return { ok: false, error: 'Rate limit hit. Wait a moment and retry.' };
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) return { ok: false, error: j.error?.message || j.candidates?.[0]?.finishReason || 'No response from Gemini' };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Groq
async function callGroq({ apiKey, model, system, messages, maxTokens, tools }) {
  const modelMap = {
    'llama-3.3-70b': 'llama-3.3-70b-versatile',
    'llama-4-scout': 'meta-llama/llama-4-scout-17b-16e-instruct',
  };
  const apiModel = modelMap[model] || model;
  const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
  const body = {
    model: apiModel,
    messages: msgs,
    max_tokens: maxTokens || 4096,
    temperature: 0.1,
    ...(tools ? { tools, tool_choice: 'auto' } : {})
  };
  const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', { 'Authorization': `Bearer ${apiKey}` }, body);
  if (res.status === 403) {
    logApiInteraction('groq', model, 'error', 'HTTP 403 — firewall/VPN block', { httpStatus: 403 });
    return { ok: false, groqBlocked: true, error: 'Groq firewall blocked your IP (HTTP 403). Groq actively blocks commercial VPNs. Switching to backup provider…' };
  }
  try {
    const j = JSON.parse(res.body);
    if (res.status !== 200) {
      fs.appendFileSync(path.join(os.homedir(), '.scaai', 'groq_debug.log'), `[${new Date().toISOString()}] ${res.status} ${res.body}\n`);
    }
    if (res.status === 401) {
      logApiInteraction('groq', model, 'error', 'HTTP 401 — auth failed', { httpStatus: 401 });
      return { ok: false, authError: true, groqBlocked: true };
    }
    if (j.error) {
      const errMsg = j.error.message || JSON.stringify(j.error);
      const isRestricted = /restricted|suspended|disabled|blocked|forbidden/i.test(errMsg);
      logApiInteraction('groq', model, 'error', errMsg, { httpStatus: res.status, restricted: isRestricted });
      return { ok: false, error: errMsg, groqRestricted: isRestricted, groqBlocked: isRestricted };
    }
    const msg = j.choices?.[0]?.message;
    const text = msg?.content || '';
    const tool_calls = msg?.tool_calls;
    logApiInteraction('groq', model, (text || tool_calls) ? 'ok' : 'error', (text || tool_calls) ? null : 'Empty response');
    return { ok: !!(text || tool_calls), text, tool_calls };
  } catch (e) {
    logApiInteraction('groq', model, 'error', e.message);
    return { ok: false, error: e.message };
  }
}


// ── SCAAI TOOL REGISTRY ──
const SCAAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_context",
      description: "Returns technical context about the current environment (OS, Home Dir, WSL status, User).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_drives",
      description: "Lists all available disk drives/partitions on the system.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Lists files and subdirectories in a given local path. Handles Windows paths and WSL /mnt/ paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path to list (can use ~ for home)." },
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads content from a file. Large files are safely truncated. Use read_file_chunked for very large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The absolute path of the file to read." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file_chunked",
      description: "Reads a specific chunk/segment of a file using offset and length. Best for very large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The absolute path of the file to read." },
          offset: { type: "number", description: "Byte offset to start reading from (default 0)." },
          length: { type: "number", description: "Number of bytes to read (max 30,000)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Creates or overwrites a file with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The absolute path of the file to write." },
          content: { type: "string", description: "The text content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Searches for files matching a pattern in a specific directory subtree.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The root path to start search." },
          pattern: { type: "string", description: "Filename pattern (e.g. *.js or name part)." }
        },
        required: ["path", "pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_path",
      description: "Opens a file, folder, or URL using the operating system's default application (like double-clicking).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path or URL to open." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Executes a shell command on the local machine. Runs in WSL2 bash if available.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          cwd: { type: ["string", "null"], description: "The working directory. Pass null or omit to use the user's home directory." }
        },
        required: ["command"]
      }
    }
  }
];
/** Truncates text to a safe limit with a clear summary for the LLM. */
function _safeOutput(text, limit = 12000, context = 'output') {
  if (!text || text.length <= limit) return text;
  const lines = text.split('\n');
  return `${text.slice(0, limit)}\n\n[... TRUNCATED ... ${text.length - limit} characters omitted. This ${context} is very long. Request specific parts if needed. Total lines: ${lines.length}]`;
}

/** Detects common binary file patterns/extensions. */
function _isBinary(filename, buf) {
  const ext = path.extname(filename).toLowerCase();
  const binaryExts = ['.exe', '.dll', '.bin', '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.zip', '.rar', '.7z', '.tar', '.gz', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.iso', '.dat', '.db', '.sqlite', '.pyc', '.node', '.woff', '.woff2', '.ttf', '.eot'];
  if (binaryExts.includes(ext)) return true;
  if (buf && buf.length > 0) {
    // Check first 2KB for NUL bytes or high density of non-text chars
    const chunk = buf.slice(0, 2048);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) return true;
    }
  }
  return false;
}

/** Executes the actual logic for a tool call requested by the LLM. */
async function handleScaaiTool(call) {
  const { name, arguments: argsJson } = call.function;
  let args;
  try { args = JSON.parse(argsJson); } catch (e) { return `Error parsing arguments: ${e.message}`; }

  console.log(`[SCAAI TOOLS] Executing ${name}...`, args);

  switch (name) {
    case 'get_context':
      return JSON.stringify({
        platform: os.platform(),
        username: os.userInfo().username,
        homeDir: os.homedir(),
        wslAvailable: _wslAvailable,
        wslDistro: _wslDistro,
        cwd: process.cwd()
      }, null, 2);

    case 'list_drives':
      try {
        if (os.platform() === 'win32') {
          return new Promise(resolve => {
            exec('powershell "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N=\'UsedGB\';E={[math]::Round($_.Used/1GB,2)}}, @{N=\'FreeGB\';E={[math]::Round($_.Free/1GB,2)}} | ConvertTo-Json"', (err, stdout) => {
              resolve(stdout || 'Error: Could not retrieve drive list.');
            });
          });
        } else {
          const r = await wslExec('df -h', { timeout: 10000 });
          return r.stdout || r.stderr || 'No drives found.';
        }
      } catch (e) { return `Error: ${e.message}`; }

    case 'list_directory':
      try {
        let rawPath = args.path.replace(/^~/, os.homedir());
        if (_wslAvailable) {
          const wslPath = rawPath.startsWith('/') ? rawPath : winToWslPath(rawPath);
          const r = await wslExec(`ls -laF "${wslPath.replace(/"/g, '\\"')}"`, { timeout: 15000 });
          return r.ok ? r.stdout : `Error: ${r.stderr || r.error || 'Unknown WSL error'}`;
        } else {
          if (!fs.existsSync(rawPath)) return `Error: Path does not exist: ${rawPath}`;
          const files = fs.readdirSync(rawPath, { withFileTypes: true });
          const out = files.map(f => `${f.isDirectory() ? '[D]' : '[F]'} ${f.name}`).join('\n') || '(empty)';
          return _safeOutput(out, 15000, 'directory listing');
        }
      } catch (e) { return `Error: ${e.message}`; }

    case 'read_file':
      try {
        let rawPath = args.path.replace(/^~/, os.homedir());
        const winPath = rawPath.startsWith('/mnt/') ? wslToWinPath(rawPath) : rawPath;
        if (!fs.existsSync(winPath)) return `Error: File does not exist: ${winPath}`;

        // Binary check (read first 2KB)
        const fd = fs.openSync(winPath, 'r');
        const buffer = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buffer, 0, 2048, 0);

        if (_isBinary(winPath, buffer.slice(0, bytesRead))) {
          fs.closeSync(fd);
          return `Error: Cannot read binary file content as text. Path: ${winPath}`;
        }

        // Optimized read: only read the first 50KB to avoid process-killing memory spikes on huge files
        const maxRead = 50000;
        const readBuffer = Buffer.alloc(maxRead);
        const contentBytes = fs.readSync(fd, readBuffer, 0, maxRead, 0);
        fs.closeSync(fd);

        const content = readBuffer.slice(0, contentBytes).toString('utf-8');
        const truncatedNote = contentBytes >= maxRead ? "\n\n[NOTE: File is large and has been truncated. Use read_file_chunked to read further segments.]" : "";
        return _safeOutput(content + truncatedNote, 20000, 'file content');
      } catch (e) { return `Error: ${e.message}`; }

    case 'read_file_chunked':
      try {
        let rawPath = args.path.replace(/^~/, os.homedir());
        const winPath = rawPath.startsWith('/mnt/') ? wslToWinPath(rawPath) : rawPath;
        const offset = args.offset || 0;
        const length = Math.min(args.length || 20000, 30000);

        if (!fs.existsSync(winPath)) return `Error: File does not exist: ${winPath}`;

        const fd = fs.openSync(winPath, 'r');
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        fs.closeSync(fd);

        if (bytesRead === 0) return "[EOF: No more content at this offset]";

        const content = buffer.slice(0, bytesRead).toString('utf-8');
        return `[Chunk @ ${offset}, ${bytesRead} bytes]\n${content}`;
      } catch (e) { return `Error: ${e.message}`; }

    case 'write_file':
      try {
        let rawPath = args.path.replace(/^~/, os.homedir());
        const winPath = rawPath.startsWith('/mnt/') ? wslToWinPath(rawPath) : rawPath;
        const parent = path.dirname(winPath);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(winPath, args.content, 'utf-8');
        return `Successfully wrote to ${winPath}`;
      } catch (e) { return `Error: ${e.message}`; }

    case 'search_files':
      try {
        let rawPath = args.path.replace(/^~/, os.homedir());
        if (_wslAvailable) {
          const wslPath = rawPath.startsWith('/') ? rawPath : winToWslPath(rawPath);
          const r = await wslExec(`find "${wslPath.replace(/"/g, '\\"')}" -maxdepth 3 -iname "*${args.pattern.replace(/"/g, '')}*"`, { timeout: 30000 });
          return r.ok ? (r.stdout || 'No matches found.') : `Error: ${r.stderr}`;
        } else {
          return 'Search is currently optimized for WSL2. Fallback search not yet implemented for native Windows.';
        }
      } catch (e) { return `Error: ${e.message}`; }

    case 'open_path':
      try {
        const p = args.path.replace(/^~/, os.homedir());
        if (p.startsWith('http')) {
          await shell.openExternal(p);
          return `Opened URL: ${p}`;
        } else {
          const winPath = p.startsWith('/mnt/') ? wslToWinPath(p) : p;
          const err = await shell.openPath(winPath);
          return err ? `Error opening path: ${err}` : `Opened: ${winPath}`;
        }
      } catch (e) { return `Error: ${e.message}`; }

    case 'execute_command':
      try {
        const useWsl = _wslAvailable && (_config.useWsl2 !== false);
        if (useWsl) {
          const r = await wslExec(args.command, { cwd: args.cwd || os.homedir(), timeout: 45000 });
          let out = r.ok ? r.stdout : `Error (code ${r.code}): ${r.stderr || r.error}`;
          if (!r.ok) out += '\n\n[WSL2 TIP] Check if paths exist in Linux (e.g. /mnt/c/). Run `mount` or `ls /mnt/` if the drive feels detached.';
          return _safeOutput(out, 12000, 'command output');
        } else {
          return new Promise(resolve => {
            exec(args.command, { cwd: args.cwd || os.homedir(), timeout: 45000, shell: true }, (err, stdout, stderr) => {
              const res = stdout || stderr || (err ? err.message : 'Completed (no output)');
              resolve(_safeOutput(res, 12000, 'command output'));
            });
          });
        }
      } catch (e) { return `Error: ${e.message}`; }

    default:
      return `Unknown tool: ${name}`;
  }
}

/** 
 * Wraps a LLM chat function to handle one or more rounds of tool calling.
 * Each round: AI requests tool -> We execute -> Result sent back -> AI decides next step.
 */
async function runWithTools(chatFunc, opts) {
  const messages = [...(opts.messages || [])];
  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    const res = await chatFunc({ ...opts, messages, tools: SCAAI_TOOLS });
    if (!res.ok) return res;

    if (res.tool_calls && res.tool_calls.length > 0) {
      // Add assistant's tool call message
      messages.push({ role: 'assistant', content: res.text || "", tool_calls: res.tool_calls });

      // Execute each tool call and add results
      for (const call of res.tool_calls) {
        const result = await handleScaaiTool(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }

      iterations++;
      continue; // Loop back for final response or more tool calls
    }

    return res; // Final text response
  }

  return { ok: false, error: 'Maximum tool calling iterations exceeded.' };
}

// ── Universal Custom API caller ──
// Auto-detects response format from the endpoint URL.
// Supports: Anthropic Messages API, OpenAI-compatible chat/completions,
//           Google Gemini generateContent, and a raw POST fallback.
async function callCustom({ customApiUrl, customApiKey, customModel, customFmt, customAuthHeader, customAuthPrefix, system, messages, maxTokens }) {
  if (!customApiUrl) return { ok: false, error: 'Custom API URL not set. Go to Settings → Custom API.' };
  if (!customModel) return { ok: false, error: 'Custom model ID not set. Go to Settings → Custom API.' };

  try {
    const url = customApiUrl.trim();
    // Parse hostname + path from the full URL
    let hostname, urlPath;
    try {
      const u = new URL(url);
      hostname = u.hostname;
      urlPath = u.pathname + (u.search || '');
    } catch {
      // Fallback: split on first slash after protocol
      const noProto = url.replace(/^https?:\/\//, '');
      const slashIdx = noProto.indexOf('/');
      hostname = slashIdx > -1 ? noProto.slice(0, slashIdx) : noProto;
      urlPath = slashIdx > -1 ? noProto.slice(slashIdx) : '/';
    }

    // ── Detect API format ──
    // User can override with customFmt, otherwise auto-detect from URL
    const fmt = customFmt || _detectFmt(url);

    // ── Build auth header ──
    // Default: Bearer token. User can override header name (e.g. x-api-key) and prefix (e.g. Bearer, Token, Basic, or empty)
    const authHeaderName = customAuthHeader || 'Authorization';
    const authPrefix = customAuthPrefix !== undefined ? customAuthPrefix : 'Bearer ';
    const authValue = customApiKey ? (authPrefix + customApiKey).trim() : '';
    const authHeaders = authValue ? { [authHeaderName]: authValue } : {};

    // ── Build request body per format ──
    let body, extraHeaders = {};

    if (fmt === 'anthropic') {
      // Convert OpenAI content arrays to Anthropic content blocks
      const anthroMsgs = messages.map(m => {
        if (Array.isArray(m.content)) {
          return {
            role: m.role,
            content: m.content.map(p => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              if (p.type === 'image_url' && p.image_url && p.image_url.url) {
                const dataUrl = p.image_url.url;
                const commaIdx = dataUrl.indexOf(',');
                const meta = dataUrl.slice(0, commaIdx);
                const b64 = dataUrl.slice(commaIdx + 1);
                const mediaType = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
                return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
              }
              return { type: 'text', text: String(p) };
            })
          };
        }
        return m;
      });
      body = { model: customModel, max_tokens: maxTokens || 4096, messages: anthroMsgs };
      if (system) body.system = system;
      extraHeaders = { 'anthropic-version': '2023-06-01' };
    } else if (fmt === 'gemini') {
      const contents = messages.map(m => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (Array.isArray(m.content)) {
          // Convert OpenAI content parts to Gemini parts
          const parts = m.content.map(p => {
            if (p.type === 'text') return { text: p.text };
            if (p.type === 'image_url' && p.image_url && p.image_url.url) {
              const dataUrl = p.image_url.url;
              const commaIdx = dataUrl.indexOf(',');
              const meta = dataUrl.slice(0, commaIdx);
              const b64 = dataUrl.slice(commaIdx + 1);
              const mimeType = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
              return { inlineData: { mimeType, data: b64 } };
            }
            return { text: String(p) };
          });
          return { role, parts };
        }
        return { role, parts: [{ text: m.content }] };
      });
      body = { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: maxTokens || 4096, temperature: 0.7 } };
    } else {
      // openai-compat (default for everything else)
      const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
      body = { model: customModel, messages: msgs, max_tokens: maxTokens || 4096, temperature: 0.7 };
    }

    const res = await httpsPost(hostname, urlPath, { ...authHeaders, ...extraHeaders }, body);

    // ── Parse response per format ──
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true, error: `Auth failed (HTTP ${res.status}). Check your API key and auth header settings.` };
    if (res.status === 404) return { ok: false, error: `Endpoint not found (404): ${url}` };
    if (res.status === 429) return { ok: false, error: 'Rate limit hit. Wait and retry.' };

    let j;
    try { j = JSON.parse(res.body); } catch { return { ok: false, error: `Non-JSON response (HTTP ${res.status}): ${res.body.slice(0, 200)}` }; }

    if (res.status < 200 || res.status > 299) {
      const msg = j.error?.message || j.error || j.message || j.detail || res.body.slice(0, 200);
      return { ok: false, error: `API error HTTP ${res.status}: ${msg}` };
    }

    // Try to extract text from various known response shapes
    let text = '';
    // Anthropic shape
    if (!text && j.content) text = (Array.isArray(j.content) ? j.content.map(c => c.text || '').join('') : j.content) || '';
    // OpenAI shape
    if (!text && j.choices) text = j.choices?.[0]?.message?.content || j.choices?.[0]?.text || '';
    // Gemini shape
    if (!text && j.candidates) text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    // Generic text fields
    if (!text && j.text) text = j.text;
    if (!text && j.response) text = j.response;
    if (!text && j.output) text = typeof j.output === 'string' ? j.output : JSON.stringify(j.output);
    if (!text && j.result) text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
    // Last resort — stringify the full response so the user sees something
    if (!text) text = JSON.stringify(j, null, 2);

    return { ok: !!text, text };
  } catch (e) { return { ok: false, error: e.message }; }
}

// =========================================================
// ── GitHub Models API (Upgrade 2) ──
// Endpoint: models.github.ai/inference/chat/completions
// Auth:     GitHub Personal Access Token (PAT)
//   classic PAT  → no scopes needed
//   fine-grained → requires models:read permission (added May 2025)
// Free models: deepseek/DeepSeek-V3-0324, deepseek/DeepSeek-R1,
//   openai/gpt-4o-mini, meta/Llama-3.3-70B-Instruct, microsoft/phi-4
//
// TOKEN BUDGETS (free tier per-request limits, input + output combined):
//   DeepSeek V3 / R1 → ~4,000 tokens total
//   GPT-4o mini      → ~8,000 tokens total
//   Llama 3.3 70B    → ~8,000 tokens total
//   Phi-4            → ~8,000 tokens total
// SCAAI's full system prompt is 3,000–8,000+ tokens — must be trimmed before sending.
// =========================================================

// Token budgets per model (conservative estimates to stay safely under limits)
const GITHUB_MODEL_BUDGETS = {
  'deepseek/DeepSeek-V3-0324': { inputBudget: 2400, maxOut: 800 },
  'deepseek/DeepSeek-R1': { inputBudget: 2400, maxOut: 800 },
  'openai/gpt-4o-mini': { inputBudget: 5500, maxOut: 1500 },
  'meta/Llama-3.3-70B-Instruct': { inputBudget: 5500, maxOut: 1500 },
  'microsoft/phi-4': { inputBudget: 5500, maxOut: 1500 },
  'mistral-ai/Mistral-Nemo': { inputBudget: 5500, maxOut: 1500 },
};
const GITHUB_DEFAULT_BUDGET = { inputBudget: 2800, maxOut: 800 };

// Rough token estimator: ~3 chars per token for English/Code mix
function _estTokens(str) {
  // Handle multimodal content arrays — count text parts + image penalty
  if (Array.isArray(str)) {
    var textLen = 0;
    var imgCount = 0;
    for (var _pi = 0; _pi < str.length; _pi++) {
      var p = str[_pi];
      if (p.type === 'text' && p.text) textLen += p.text.length;
      if (p.type === 'image_url') imgCount++;
    }
    // Base64 images are already compressed; count text + ~200 tokens per image
    return Math.ceil(textLen / 3) + imgCount * 200;
  }
  return Math.ceil((str || '').length / 3);
}

/**
 * Build a compact system prompt for GitHub Models.
 * Returns { identity, codebaseBlock, skillsBlock }
 *
 * Root-cause fix: the old version matched ═ with /^={4,}/ on line 1
 * and exited immediately — GitHub Models got an empty system prompt every call.
 */
function _githubSystemPrompt(fullSystem, identityCap = 1400) {
  if (!fullSystem) return { identity: '', codebaseBlock: '', skillsBlock: '' };

  // 1. Extract live CODEBASE context block
  let codebaseBlock = '';
  const cbMatch = fullSystem.match(/(\n╔[\s\S]*?=== END CODEBASE CONTEXT ===\n?)/);
  if (cbMatch) codebaseBlock = cbMatch[1].slice(0, 2200);
  if (!codebaseBlock) {
    const noteMatch = fullSystem.match(/(\[CODEBASE NOTE:[^\]]+\])/);
    if (noteMatch) codebaseBlock = noteMatch[1];
  }

  // 2. Extract active skills blocks (always appended last — always truncated without this)
  let skillsBlock = '';
  const skHdr = fullSystem.match(/\n(════+\nACTIVE SKILLS[\s\S]*?)(?=\n════+\nIDENTITY|\n════+\nYOUR CAPABILITIES|$)/);
  if (skHdr) {
    skillsBlock = skHdr[1].slice(0, 2000);
  } else {
    const sBlocks = []; let sTot = 0;
    for (const m of fullSystem.matchAll(/--- SKILL: ([^\n]+) ---\n([\s\S]*?)(?=\n--- SKILL:|$)/g)) {
      const c = `--- SKILL: ${m[1].trim()} ---\n${m[2].slice(0, 600)}`;
      if (sTot + c.length > 2000) break;
      sBlocks.push(c); sTot += c.length;
    }
    if (sBlocks.length) skillsBlock = sBlocks.join('\n');
  }

  // 3. Build identity section — skip decorators and large dynamic blocks
  const lines = fullSystem.split('\n');
  const idLines = []; let chars = 0;
  const cbModeLines = []; let cbModeChars = 0;
  let inCbMode = false, inSurgical = false;
  const DECOR = /^[═╔╚╗╝║─━=\-]{4,}$/;
  const SKIP = /^NOW STATE|^DISK INDEX|^SEMANTIC MEMORY|^RECENT EXCHANGES|^KNOWLEDGE BASE|^╔══|^MEMORY ENTRY|^\[score:|^\[TOOL_UPGRADE\]|^TOOL SYNC|^WEB SEARCH RESULTS|^ACTIVE SKILLS/i;

  for (const line of lines) {
    const t = line.trim();
    if (DECOR.test(t)) continue;
    if (SKIP.test(t)) continue;
    if (/^--- SKILL:|^=== END CODEBASE CONTEXT ===|^\[CODEBASE NOTE:/i.test(t)) continue;
    if (/^CODEBASE MODE ACTIVE/i.test(t)) { inCbMode = true; inSurgical = false; }
    if (/^SURGICAL PATCH OUTPUT FORMAT/i.test(t)) inSurgical = true;
    if (inCbMode) {
      if (!inSurgical && cbModeChars + line.length < 700) { cbModeLines.push(line); cbModeChars += line.length + 1; }
      continue;
    }
    if (chars + line.length > identityCap) break;
    idLines.push(line); chars += line.length + 1;
  }

  const merged = [...idLines, ...(cbModeLines.length ? ['', ...cbModeLines] : [])];
  return { identity: merged.join('\n').trim(), codebaseBlock, skillsBlock };
}

async function callGithub({ githubToken, model, system, messages, maxTokens, tools }) {
  if (!githubToken)
    return { ok: false, error: 'GitHub token not set. Open Settings → GitHub Models and paste your PAT.' };
  if (!model)
    return { ok: false, error: 'No model specified for GitHub Models provider.' };

  const budget = GITHUB_MODEL_BUDGETS[model] || GITHUB_DEFAULT_BUDGET;

  // Step 1: compact system prompt + extract codebase + skills
  const { identity: compactSystem, codebaseBlock, skillsBlock } = _githubSystemPrompt(system);

  // Step 2: trim message history to fit budget
  let usedTokens = _estTokens(compactSystem) + 50;
  const trimmedMsgs = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = _estTokens(m.content);
    if (usedTokens + t > budget.inputBudget && trimmedMsgs.length > 0) break;
    trimmedMsgs.unshift(m);
    usedTokens += t;
  }
  if (trimmedMsgs.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    const maxChars = (budget.inputBudget - _estTokens(compactSystem) - 50) * 4;
    // Handle both string and multimodal array content
    var _fallbackContent = last.content;
    if (typeof _fallbackContent === 'string') {
      _fallbackContent = _fallbackContent.slice(-Math.max(maxChars, 400));
    } else if (Array.isArray(_fallbackContent)) {
      // For multimodal arrays, truncate text parts
      _fallbackContent = _fallbackContent.map(function(p) {
        if (p.type === 'text' && p.text) return { ...p, text: p.text.slice(-Math.max(maxChars, 400)) };
        return p;
      });
    }
    trimmedMsgs.push({ ...last, content: _fallbackContent });
  }

  // Step 2a.5: extract ACTIVE FILES and PRE-READ FILE CONTENT from system prompt
  // These are injected by buildSystemPrompt() in the renderer but dropped by _githubSystemPrompt()
  var fileBlockCtx = '';
  if (system) {
    var _afMatch = system.match(/(=== ACTIVE FILES[\s\S]*?=== END FILES ===\n?)/);
    if (_afMatch) {
      var _af = _afMatch[1];
      var _afBudget = Math.min(2800, Math.floor(budget.inputBudget * 0.35));
      fileBlockCtx = (_af.length > _afBudget ? _af.slice(0, _afBudget) + '\n…[file context truncated to fit budget]' : _af) + '\n\n';
    }
    var _prMatch = system.match(/(=== PRE-READ FILE CONTENT[\s\S]*?=== END FILE CONTENT ===\n?)/);
    if (_prMatch) {
      fileBlockCtx += (_prMatch[1] + '\n\n');
    }
  }

  // Step 2b: inject skills (behavioral), file context, then codebase (factual) into last user message
  if ((skillsBlock || codebaseBlock || fileBlockCtx) && trimmedMsgs.length > 0) {
    const lastIdx = trimmedMsgs.length - 1;
    const last = trimmedMsgs[lastIdx];
    if (last.role === 'user') {
      let ctx = '';
      if (skillsBlock) {
        const st = _estTokens(skillsBlock);
        ctx += (usedTokens + st <= budget.inputBudget ? skillsBlock : skillsBlock.slice(0, 400) + '\n…[skills truncated]') + '\n\n';
        usedTokens += Math.min(st, _estTokens(ctx));
      }
      if (fileBlockCtx) {
        var _ft = _estTokens(fileBlockCtx);
        if (usedTokens + _ft <= budget.inputBudget) {
          ctx += fileBlockCtx + '\n';
          usedTokens += _ft;
        }
      }
      if (codebaseBlock) {
        const ct = _estTokens(codebaseBlock);
        ctx += (usedTokens + ct <= budget.inputBudget ? codebaseBlock : codebaseBlock.slice(0, 400) + '\n…[codebase truncated]') + '\n\n';
      }
      if (ctx) {
        // Handle both string and multimodal array content
        if (Array.isArray(last.content)) {
          trimmedMsgs[lastIdx] = { ...last, content: [{ type: 'text', text: ctx + '---\n' }, ...last.content] };
        } else {
          trimmedMsgs[lastIdx] = { ...last, content: ctx + '---\n' + last.content };
        }
      }
    }
  }

  const msgs = [
    ...(compactSystem ? [{ role: 'system', content: compactSystem }] : []),
    ...trimmedMsgs,
  ];

  const body = {
    model,
    messages: msgs,
    max_tokens: Math.min(maxTokens || budget.maxOut, budget.maxOut),
    temperature: 0.7,
    ...(tools ? { tools } : {})
  };

  try {
    const res = await httpsPost('models.github.ai', '/inference/chat/completions',
      { Authorization: `Bearer ${githubToken}` }, body);
    let j;
    try { j = JSON.parse(res.body); }
    catch { return { ok: false, error: `Non-JSON response (HTTP ${res.status}): ${res.body.slice(0, 300)}` }; }
    if (res.status === 401 || res.status === 403)
      return { ok: false, authError: true, error: 'GitHub token invalid or expired. Generate a new PAT at github.com/settings/tokens' };
    if (res.status === 429)
      return { ok: false, error: 'GitHub Models rate limit hit. Wait a moment and retry.' };
    if (res.status === 404)
      return { ok: false, error: `Model not found on GitHub Models: ${model}. See github.com/marketplace/models` };
    if (res.status === 413) {
      // Still too large after trimming — report clearly
      const msg = j?.error?.message || `Request too large. Estimated tokens sent: ~${usedTokens}. Budget: ~${budget.inputBudget}. Try GPT-4o mini or Llama 3.3 70B which have larger limits.`;
      return { ok: false, error: `GitHub Models 413: ${msg}` };
    }
    if (res.status !== 200) {
      const msg = j?.error?.message || j?.message || res.body.slice(0, 200);
      return { ok: false, error: `GitHub Models HTTP ${res.status}: ${msg}` };
    }
    if (j.error) return { ok: false, error: j.error.message || JSON.stringify(j.error) };
    const msg = j.choices?.[0]?.message;
    const text = msg?.content || '';
    const tool_calls = msg?.tool_calls;
    return { ok: !!(text || tool_calls), text, tool_calls };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Detect API format from URL patterns
function _detectFmt(url) {
  if (/anthropic\.com|claude/i.test(url)) return 'anthropic';
  if (/googleapis\.com|gemini|generativelanguage/i.test(url)) return 'gemini';
  return 'openai'; // default: OpenAI-compat covers OpenAI, Ollama, Mistral, Together, Fireworks, etc.
}

// ── Unified chat handler (Upgrade 3: cascading failover) ──
// Orchestration is now handled by the renderer to preserve key rotation.
// main.js provides the raw API results and detailed error flags.
ipcMain.handle('api:chat', async (_, opts) => {
  try {
    if (opts.provider === 'github') return await runWithTools(callGithub, opts);
    if (opts.provider === 'groq') return await runWithTools(callGroq, opts);
    if (opts.provider === 'custom') return await callCustom(opts); // tools not yet supported for custom
    if (opts.customApiUrl) return await callCustom(opts);
    return { ok: false, error: 'No provider configured. Go to Settings and select a provider.' };
  } catch (e) {
    logApiInteraction(opts.provider || 'unknown', opts.model || 'unknown', 'error', e.message);
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════
// ── GROQ AUDIO — Whisper STT + Orpheus TTS ──
// ══════════════════════════════════════════

/**
 * HTTPS POST with multipart/form-data body (for Groq Whisper transcription).
 * @param {string} hostname
 * @param {string} urlPath
 * @param {object} headers - extra headers (will merge Authorization, etc.)
 * @param {Buffer} fileBuffer - raw audio bytes
 * @param {string} fileName - filename for the Content-Disposition
 * @param {string} fieldName - form field name (default 'file')
 * @param {object} extraFields - extra text fields like { model: 'whisper-large-v3' }
 */
function httpsPostMultipart(hostname, urlPath, headers, fileBuffer, fileName, fieldName, extraFields) {
  return new Promise(resolve => {
    var boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    var bodyParts = [];

    // Extra text fields first
    if (extraFields) {
      var eKeys = Object.keys(extraFields);
      for (var _ei = 0; _ei < eKeys.length; _ei++) {
        var _k = eKeys[_ei];
        bodyParts.push(Buffer.from(
          '--' + boundary + '\r\n' +
          'Content-Disposition: form-data; name="' + _k + '"\r\n\r\n' +
          extraFields[_k] + '\r\n'
        ));
      }
    }

    // File field
    bodyParts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + (fieldName || 'file') + '"; filename="' + (fileName || 'audio.webm') + '"\r\n' +
      'Content-Type: audio/webm\r\n\r\n'
    ));
    bodyParts.push(fileBuffer);
    bodyParts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));

    var body = Buffer.concat(bodyParts);
    var mergedHeaders = {
      'User-Agent': 'SCAAI/1.0 (Desktop)',
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
      ...headers
    };

    var req = https.request({ hostname, path: urlPath, method: 'POST', headers: mergedHeaders }, (res) => {
      var d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'Request timed out' });
    });
    req.write(body); req.end();
  });
}

/**
 * Transcribe audio using Groq Whisper API.
 * Expects { apiKey, audioBuffer (base64), mimeType }
 */
async function _audioTranscribe({ apiKey, audioBase64, mimeType }) {
  try {
    var audioBuf = Buffer.from(audioBase64, 'base64');
    var ext = 'webm';
    if (mimeType) {
      if (mimeType.includes('wav')) ext = 'wav';
      else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) ext = 'mp3';
      else if (mimeType.includes('ogg')) ext = 'ogg';
      else if (mimeType.includes('mp4')) ext = 'mp4';
    }
    var res = await httpsPostMultipart(
      'api.groq.com',
      '/openai/v1/audio/transcriptions',
      { 'Authorization': 'Bearer ' + apiKey },
      audioBuf,
      'audio.' + ext,
      'file',
      { model: 'whisper-large-v3-turbo' }
    );
    if (res.status === 0) return { ok: false, error: res.error || 'Network error' };
    var j;
    try { j = JSON.parse(res.body); } catch (e) { return { ok: false, error: 'Invalid response: ' + res.body.slice(0, 200) }; }
    if (j.error) return { ok: false, error: j.error.message || JSON.stringify(j.error) };
    return { ok: true, text: (j.text || '').trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Generate speech audio using Groq Orpheus TTS.
 * Expects { apiKey, text, voice }.
 * Returns base64-encoded WAV audio.
 * Uses raw buffer collection (not httpsPost) to preserve binary WAV data.
 */
async function _audioSpeak({ apiKey, text, voice }) {
  try {
    var body = JSON.stringify({
      model: 'canopylabs/orpheus-v1-standard',
      input: text,
      voice: voice || 'troy',
      response_format: 'wav'
    });
    return await new Promise(function (resolve) {
      var headers = {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'SCAAI/1.0 (Desktop)',
        'Content-Length': Buffer.byteLength(body)
      };
      var req = https.request({ hostname: 'api.groq.com', path: '/openai/v1/audio/speech', method: 'POST', headers: headers }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(typeof c === 'string' ? Buffer.from(c, 'binary') : c); });
        res.on('end', function () {
          var raw = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            var errStr = raw.toString('utf-8').slice(0, 200);
            return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + errStr });
          }
          resolve({ ok: true, audioBase64: raw.toString('base64'), mimeType: 'audio/wav' });
        });
      });
      req.on('error', function (e) { resolve({ ok: false, error: e.message }); });
      req.setTimeout(60000, function () { req.destroy(); resolve({ ok: false, error: 'TTS request timed out' }); });
      req.write(body); req.end();
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('audio:transcribe', async (_, opts) => {
  return await _audioTranscribe(opts);
});

ipcMain.handle('audio:speak', async (_, opts) => {
  return await _audioSpeak(opts);
});

// ── Grammar polish for voice dictation segments ──
ipcMain.handle('audio:polish', async (_, { apiKey, text }) => {
  if (!text || !text.trim()) return { ok: false, error: 'Empty text' };
  try {
    const body = { model: 'llama-3.1-8b-instant', messages: [
      { role: 'system', content: 'Fix grammar and punctuation only. Return plain text with no quotes, no explanations, no markdown. Preserve the original meaning and wording as much as possible.' },
      { role: 'user', content: text }
    ], max_tokens: 256, temperature: 0 };
    const res = await httpsPost('api.groq.com', '/openai/v1/chat/completions', { 'Authorization': `Bearer ${apiKey}` }, body);
    const j = JSON.parse(res.body);
    const polished = (j.choices?.[0]?.message?.content || text).trim();
    return { ok: true, text: polished };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════
// ── WEB SEARCH — Multi-engine backend ──
// Engines: Tavily | Brave | Google CSE | DuckDuckGo
// ══════════════════════════════════════════

function httpsGet(hostname, urlPath, headers = {}, maxRedirects = 5) {
  return _httpsGetFollow(hostname, urlPath, headers, maxRedirects, 0);
}

function _httpsGetFollow(hostname, urlPath, headers, maxRedirects, depth) {
  return new Promise((resolve) => {
    const mergedHeaders = {
      'User-Agent': 'SCAAI/1.0 (Desktop)',
      'Accept': 'application/json',
      ...headers
    };
    const req = https.request({ hostname, path: urlPath, method: 'GET', headers: mergedHeaders }, (res) => {
      // Follow redirects (301, 302, 307, 308)
      const redirectCode = res.statusCode;
      if (depth < maxRedirects && (redirectCode === 301 || redirectCode === 302 || redirectCode === 307 || redirectCode === 308)) {
        const location = res.headers['location'];
        if (location) {
          const parsed = new URL(location);
          resolve(_httpsGetFollow(parsed.hostname, parsed.pathname + parsed.search, headers, maxRedirects, depth + 1));
          return;
        }
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'Request timed out after 15 seconds' });
    });
    req.end();
  });
}

function httpsPostSearch(hostname, urlPath, headers, body) {
  return new Promise(resolve => {
    const s = JSON.stringify(body);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...headers }
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.write(s); req.end();
  });
}

async function searchTavily(query, apiKey, num) {
  if (!apiKey) return { ok: false, error: 'Tavily API key not configured. Go to Tools → Web Search.' };
  try {
    const res = await httpsPostSearch('api.tavily.com', '/search', {},
      { api_key: apiKey, query, num_results: num, search_depth: 'basic' });
    const j = JSON.parse(res.body);
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid Tavily API key.' };
    if (res.status === 429) return { ok: false, error: 'Tavily rate limit. Try again shortly.' };
    if (res.status !== 200) return { ok: false, error: j.error || j.detail || `HTTP ${res.status}` };
    const items = (j.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.content || '' }));
    return { ok: true, items, query };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function searchBrave(query, apiKey, num) {
  if (!apiKey) return { ok: false, error: 'Brave API key not configured. Go to Tools → Web Search.' };
  try {
    const q = encodeURIComponent(query);
    const res = await httpsGet('api.search.brave.com', `/res/v1/web/search?q=${q}&count=${num}`,
      { 'Accept': 'application/json', 'X-Subscription-Token': apiKey });
    const j = JSON.parse(res.body);
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid Brave API key.' };
    if (res.status === 429) return { ok: false, error: 'Brave rate limit hit.' };
    if (res.status !== 200) return { ok: false, error: j.message || `HTTP ${res.status}` };
    const items = (j.web?.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
    return { ok: true, items, query };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function searchGoogle(query, apiKey, cx, num) {
  if (!apiKey || !cx) return { ok: false, error: 'Google API key or CX not configured. Go to Tools → Web Search.' };
  try {
    const q = encodeURIComponent(query);
    const res = await httpsGet('www.googleapis.com', `/customsearch/v1?key=${apiKey}&cx=${cx}&q=${q}&num=${num}`);
    const j = JSON.parse(res.body);
    if (res.status !== 200) return { ok: false, error: j.error?.message || `HTTP ${res.status}` };
    const items = (j.items || []).map(r => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
    return { ok: true, items, query };
  } catch (e) { return { ok: false, error: e.message }; }
}

//  DDG rate-limit guard: tracks timestamp of last call
let _ddgLastCallTs = 0;

async function searchDuckDuckGo(query, num) {
  // Enforce a 700-1300ms jitter between consecutive DDG calls.
  // Rapid automated requests are the #1 cause of DDG anomaly rejection.
  const MIN_INTERVAL = 700 + Math.floor(Math.random() * 600);
  const sinceLastCall = Date.now() - _ddgLastCallTs;
  if (sinceLastCall < MIN_INTERVAL) {
    await new Promise(res => setTimeout(res, MIN_INTERVAL - sinceLastCall));
  }
  const _attempt = async () => {
    // SafeSearchType.OFF avoids the extra VQD token validation path
    // that STRICT triggers — confirmed primary cause of "anomaly" error.
    const r = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.OFF,
    });
    return (r.results || []).slice(0, num).map(it => ({
      title: it.title,
      url: it.url,
      snippet: it.description || '',
    }));
  };
  try {
    const items = await _attempt();
    _ddgLastCallTs = Date.now();
    if (!items.length) {
      return { ok: false, error: 'DuckDuckGo returned no results.' };
    }
    return { ok: true, items, query };
  } catch (e) {
    const isAnomaly = /anomaly|vqd|rate|429/i.test(e.message || '');
    if (isAnomaly) {
      // Single retry after a 1.5s pause on anomaly/rate errors
      await new Promise(res => setTimeout(res, 1500));
      try {
        const items = await _attempt();
        _ddgLastCallTs = Date.now();
        if (!items.length) {
          return { ok: false, error: 'DuckDuckGo returned no results (retry).' };
        }
        return { ok: true, items, query };
      } catch (e2) {
        return { ok: false, error: `DuckDuckGo blocked after retry: ${e2.message}` };
      }
    }
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('api:web-search', async (_, { query, engine = 'tavily', config = {}, num = 5 }) => {
  try {
    if (engine === 'tavily') return await searchTavily(query, config.tavilyKey, num);
    if (engine === 'brave') return await searchBrave(query, config.braveKey, num);
    if (engine === 'google') return await searchGoogle(query, config.googleKey, config.googleCx, num);
    if (engine === 'duckduckgo') return await searchDuckDuckGo(query, num);
    return { ok: false, error: 'Unknown engine: ' + engine };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ══════════════════════════════════════════
// ── Upgrade 1: Disk Index IPC ──
// Full-disk awareness: scan, live watch, index query
// ══════════════════════════════════════════
ipcMain.handle('fs:disk-scan', async (_, roots) => {
  try {
    const r = roots && roots.length ? roots : [os.homedir()];
    return await diskWatcher.scan(r);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:disk-index', () => {
  try { return { ok: true, index: diskWatcher.getIndex(), count: diskWatcher.getCount() }; }
  catch (e) { return { ok: false, index: {}, count: 0, error: e.message }; }
});
ipcMain.handle('fs:disk-watch', (_, paths) => {
  try { diskWatcher.startWatching(win, paths || []); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:disk-unwatch', () => {
  try { diskWatcher.stopWatching(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Upgrade 3: Index Query API ──
ipcMain.handle('fs:disk-ext-summary', () => {
  try { return { ok: true, summary: diskWatcher.getExtSummary() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:disk-query-ext', (_, ext) => {
  try { return { ok: true, ...diskWatcher.findByExt(ext) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// =========================================================
// ── Upgrade 2: Skill Plugin System IPC ──
// =========================================================

ipcMain.handle('skills:list', () => {
  try { return skillRunner.listSkills(); }
  catch (e) { return { ok: false, error: e.message, skills: [] }; }
});

ipcMain.handle('skills:run', async (_, skillId, args) => {
  try { return await skillRunner.runSkill(skillId, args); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skills:open-dir', () => {
  try { shell.openPath(skillRunner.SKILLS_DIR); return { ok: true, path: skillRunner.SKILLS_DIR }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skills:install', async (_, { id, manifest, script }) => {
  try {
    if (!id || !manifest) return { ok: false, error: 'id and manifest are required' };
    const skillDir = path.join(skillRunner.SKILLS_DIR, id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    if (script) fs.writeFileSync(path.join(skillDir, manifest.entrypoint || 'skill.py'), script, 'utf-8');
    return { ok: true, path: skillDir };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skills:delete', async (_, skillId) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Delete Skill', 'Cancel'], defaultId: 1,
    message: `Delete skill '${skillId}'?`,
    detail: 'This will permanently remove the skill directory from disk.',
  });
  if (r.response !== 0) return { ok: false, error: 'Cancelled' };
  try {
    fs.rmSync(path.join(skillRunner.SKILLS_DIR, skillId), { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// =========================================================
// ── Upgrade 2: Multi-Agent Registry IPC ──
// =========================================================

ipcMain.handle('agents:load', () => { try { return { ok: true, agents: agentsMgr.loadAgents() }; } catch (e) { return { ok: false, error: e.message, agents: [] }; } });
ipcMain.handle('agents:get', (_, id) => { try { const a = agentsMgr.getAgent(id); return a ? { ok: true, agent: a } : { ok: false, error: 'Agent not found' }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('agents:create', (_, data) => { try { return agentsMgr.createAgent(data); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('agents:update', (_, id, d) => { try { return agentsMgr.updateAgent(id, d); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('agents:delete', (_, id) => { try { return agentsMgr.deleteAgent(id); } catch (e) { return { ok: false, error: e.message }; } });

// Chat via a named agent — uses that agent's provider, model, and system prompt.
ipcMain.handle('agents:chat', async (_, {
  agentId, messages, userSystemPrompt, maxTokens,
  githubToken, groqKey, customApiUrl, customApiKey, customModel,
}) => {
  try {
    const agent = agentsMgr.getAgent(agentId);
    if (!agent) return { ok: false, error: `Agent '${agentId}' not found` };
    const system = [agent.systemPrompt, userSystemPrompt].filter(Boolean).join('\n\n') || undefined;
    if (agent.provider === 'github')
      // userSystemPrompt is SCAAI's full system prompt — callGithub will compact it internally
      return await runWithTools(callGithub, { githubToken, model: agent.model, system, messages, maxTokens: maxTokens || 8192 });
    if (agent.provider === 'groq')
      return await runWithTools(callGroq, { apiKey: groqKey, model: agent.model, system, messages, maxTokens: maxTokens || 4096 });
    if (agent.provider === 'custom')
      return await callCustom({ customApiUrl, customApiKey, customModel: customModel || agent.model, system, messages, maxTokens: maxTokens || 4096 });
    return { ok: false, error: `Unknown provider '${agent.provider}' for agent '${agent.name}'` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// =========================================================
// ── RAG XAI Transparency Panel IPC ──
// =========================================================
const XAI_FILE = path.join(os.homedir(), '.scaai', 'xai_history.json');

ipcMain.handle('rag:xai-history', (_, opts = {}) => {
  try {
    if (!fs.existsSync(XAI_FILE)) return { ok: true, history: [] };
    const all = JSON.parse(fs.readFileSync(XAI_FILE, 'utf-8'));
    const limit = opts.limit || 50;
    return { ok: true, history: all.slice(-limit) };
  } catch (e) {
    return { ok: false, error: e.message, history: [] };
  }
});

ipcMain.handle('rag:explain', async (_, opts = {}) => {
  try {
    const {
      query = '',
      retrievedDocs = [],
      response = '',
      provider = 'groq',
      apiKey = '',
      githubToken = '',
      model = 'llama-3.3-70b',
      storeResult = false,
    } = opts;

    const docsText = retrievedDocs.slice(0, 6).map((d, i) =>
      `[Doc ${i + 1}] ${(d.content || d.text || JSON.stringify(d)).slice(0, 400)}`
    ).join('\n');

    const prompt =
      `You are an XAI (Explainable AI) engine. Analyse this RAG exchange and return ONLY valid JSON — no markdown fences, no extra text.

USER QUERY: ${query.slice(0, 500)}

RETRIEVED DOCS (${retrievedDocs.length} total):
${docsText || '(none)'}

AI RESPONSE (first 800 chars): ${response.slice(0, 800)}

Return exactly this JSON shape:
{
  "confidence": <0.0-1.0>,
  "lime": [
    {"token":"<key word>","score":<0.0-1.0>,"direction":"positive","source":"query"}
  ],
  "featureImportance": [
    {"feature":"<concept>","score":<0.0-1.0>,"reason":"<one sentence>"}
  ],
  "sankeyNodes": [{"id":"query"},{"id":"doc1"},{"id":"response"}],
  "sankeyLinks": [{"source":"query","target":"response","value":0.8}],
  "weaknesses": ["<gap or missing coverage>"],
  "improvements": ["<suggestion to improve retrieval or response>"]
}`;

    let result;
    if (provider === 'github' && githubToken) {
      result = await callGithub({
        githubToken,
        model: model || 'openai/gpt-4o-mini',
        system: 'You are an XAI analysis engine. Respond only with valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1200,
      });
    } else {
      result = await callGroq({
        apiKey,
        model: model || 'llama-3.3-70b',
        system: 'You are an XAI analysis engine. Respond only with valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1200,
      });
    }

    if (!result.ok) return { ok: false, error: result.error || 'LLM call failed' };

    // Strip any accidental markdown fences the model may wrap around the JSON
    const raw = result.text.replace(/```json|```/g, '').trim();
    const xai = JSON.parse(raw);

    const meta = { docsAnalysed: retrievedDocs.length, model, ts: Date.now() };

    if (storeResult) {
      const history = fs.existsSync(XAI_FILE)
        ? JSON.parse(fs.readFileSync(XAI_FILE, 'utf-8'))
        : [];
      history.push({ query: query.slice(0, 200), xai, meta });
      if (history.length > 200) history.splice(0, history.length - 200);
      ensureDataDir && ensureDataDir();
      fs.mkdirSync(path.dirname(XAI_FILE), { recursive: true });
      fs.writeFileSync(XAI_FILE, JSON.stringify(history, null, 2), 'utf-8');
    }

    return { ok: true, xai, meta };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Clipboard image extraction
ipcMain.handle('clipboard:read-image', async () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false, error: 'No image in clipboard' };
    const dataUrl = img.toDataURL();
    return { ok: true, dataUrl: dataUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// ── Attachment Cache (Pasted Images) ──
// ═══════════════════════════════════════════════════════════════

/** Max pixels on longest edge after compression */
const ATTACHMENT_MAX_DIM = 2048;
/** JPEG/WebP quality 0–100 */
const ATTACHMENT_QUALITY = 80;
/** Max single-file bytes after compression (~4 MB) */
const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
/** Max attachments per chat on disk */
const ATTACHMENTS_PER_CHAT_MAX = 100;
/** Global attachment cache size cap (bytes) */
const ATTACHMENTS_GLOBAL_CAP = 500 * 1024 * 1024; // 500 MB

/**
 * Compress an image dataUrl using Electron's nativeImage.
 * Resizes to fit ATTACHMENT_MAX_DIM, encodes as JPEG at ATTACHMENT_QUALITY.
 * Returns { base64, mimeType, width, height, sizeBytes }.
 */
function _compressImage(dataUrl) {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return null;

  const origSize = img.getSize();
  let w = origSize.width;
  let h = origSize.height;

  // Resize if larger than max dimension
  if (w > ATTACHMENT_MAX_DIM || h > ATTACHMENT_MAX_DIM) {
    const ratio = Math.min(ATTACHMENT_MAX_DIM / w, ATTACHMENT_MAX_DIM / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const resized = w !== origSize.width || h !== origSize.height
    ? img.resize({ width: w, height: h, quality: 'good' })
    : img;

  // Encode as JPEG for best compression (or keep PNG if it's smaller)
  const jpegBuf = resized.toJPEG(ATTACHMENT_QUALITY);
  const pngBuf = resized.toPNG();
  const useJpeg = jpegBuf.length <= pngBuf.length;
  const buf = useJpeg ? jpegBuf : pngBuf;
  const mimeType = useJpeg ? 'image/jpeg' : 'image/png';
  const base64 = buf.toString('base64');

  return {
    base64,
    mimeType,
    width: w,
    height: h,
    sizeBytes: buf.length,
  };
}

/**
 * Save a compressed attachment to disk.
 * @param {string} dataUrl - The original image data URL
 * @param {string} chatId - The parent chat ID
 * @param {string} [mimeType] - Optional original MIME type hint
 * @returns {object|null} AttachmentRef or null on failure
 */
async function saveAttachment(dataUrl, chatId, mimeType) {
  try {
    const compressed = _compressImage(dataUrl);
    if (!compressed) return null;

    // Check individual file size cap
    if (compressed.sizeBytes > ATTACHMENT_MAX_BYTES) return null;

    const chatDir = path.join(ATTACHMENTS_DIR, chatId);
    fs.mkdirSync(chatDir, { recursive: true });

    // List existing files for per-chat cap
    let existing = [];
    try { existing = fs.readdirSync(chatDir); } catch { /* empty */ }
    if (existing.length >= ATTACHMENTS_PER_CHAT_MAX) return null;

    const ext = compressed.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const fileName = id + ext;
    const filePath = path.join(chatDir, fileName);

    fs.writeFileSync(filePath, Buffer.from(compressed.base64, 'base64'));

    return {
      id,
      chatId,
      mimeType: compressed.mimeType,
      storedRelPath: chatId + '/' + fileName,
      sizeBytes: compressed.sizeBytes,
      width: compressed.width,
      height: compressed.height,
      originalName: 'pasted_image_' + (existing.length + 1) + ext,
      createdAt: Date.now(),
    };
  } catch (e) {
    console.error('[ATTACHMENTS] save error:', e.message);
    return null;
  }
}

// ── Attachment IPC Handlers ──

ipcMain.handle('attachments:save', async (_, { dataUrl, chatId, mimeType }) => {
  const ref = await saveAttachment(dataUrl, chatId, mimeType);
  if (!ref) return { ok: false, error: 'Failed to save attachment (too large, too many, or compression error)' };
  return { ok: true, attachment: ref };
});

ipcMain.handle('attachments:read', async (_, { id }) => {
  try {
    // Scan all chat dirs for the file
    if (!fs.existsSync(ATTACHMENTS_DIR)) return { ok: false, error: 'No attachments directory' };
    const chatDirs = fs.readdirSync(ATTACHMENTS_DIR);
    for (const chatDir of chatDirs) {
      const dirPath = path.join(ATTACHMENTS_DIR, chatDir);
      const entries = fs.readdirSync(dirPath);
      const match = entries.find(e => e.startsWith(id));
      if (match) {
        const buf = fs.readFileSync(path.join(dirPath, match));
        const ext = path.extname(match).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        return { ok: true, base64: buf.toString('base64'), mimeType };
      }
    }
    return { ok: false, error: 'Attachment not found' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('attachments:readBulk', async (_, { ids }) => {
  try {
    if (!fs.existsSync(ATTACHMENTS_DIR)) return { ok: true, attachments: {} };
    const chatDirs = fs.readdirSync(ATTACHMENTS_DIR);
    const found = {};
    for (const chatDir of chatDirs) {
      const dirPath = path.join(ATTACHMENTS_DIR, chatDir);
      let entries;
      try { entries = fs.readdirSync(dirPath); } catch { continue; }
      for (const id of (ids || [])) {
        if (found[id]) continue;
        const match = entries.find(e => e.startsWith(id));
        if (match) {
          const buf = fs.readFileSync(path.join(dirPath, match));
          const ext = path.extname(match).toLowerCase();
          const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
          found[id] = { base64: buf.toString('base64'), mimeType };
        }
      }
    }
    return { ok: true, attachments: found };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('attachments:deleteForChat', async (_, { chatId }) => {
  try {
    const chatDir = path.join(ATTACHMENTS_DIR, chatId);
    if (fs.existsSync(chatDir)) {
      fs.rmSync(chatDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('attachments:gc', async () => {
  try {
    if (!fs.existsSync(ATTACHMENTS_DIR)) return { ok: true, deleted: 0, freedBytes: 0 };
    const chatDirs = fs.readdirSync(ATTACHMENTS_DIR);
    // Load all known chat IDs from chat history
    const chats = readJSON(CHATS_FILE, []);
    const knownChatIds = new Set(chats.map(c => c.id));
    let deleted = 0;
    let freedBytes = 0;

    for (const chatDir of chatDirs) {
      const dirPath = path.join(ATTACHMENTS_DIR, chatDir);
      if (!knownChatIds.has(chatDir)) {
        // Orphaned chat directory — delete all files
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            const fp = path.join(dirPath, f);
            freedBytes += fs.statSync(fp).size;
            fs.unlinkSync(fp);
            deleted++;
          }
          fs.rmdirSync(dirPath);
        }
      } else {
        // Existing chat — check per-chat count cap
        const files = fs.readdirSync(dirPath).filter(f => /\.(jpg|png)$/i.test(f));
        if (files.length > ATTACHMENTS_PER_CHAT_MAX) {
          // Sort by name (which includes timestamp), remove oldest
          files.sort();
          const toRemove = files.length - ATTACHMENTS_PER_CHAT_MAX;
          for (let i = 0; i < toRemove; i++) {
            const fp = path.join(dirPath, files[i]);
            freedBytes += fs.statSync(fp).size;
            fs.unlinkSync(fp);
            deleted++;
          }
        }
      }
    }

    // Global cap check
    let totalBytes = 0;
    const allFiles = [];
    const walkAtt = (dir) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const e of entries) {
          const fp = path.join(dir, e);
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) walkAtt(fp);
          else allFiles.push({ fp, size: stat.size, mtime: stat.mtimeMs });
        }
      } catch { /* skip */ }
    };
    walkAtt(ATTACHMENTS_DIR);
    allFiles.sort((a, b) => a.mtime - b.mtime); // oldest first

    for (const f of allFiles) {
      if (totalBytes + f.size > ATTACHMENTS_GLOBAL_CAP) {
        fs.unlinkSync(f.fp);
        freedBytes += f.size;
        deleted++;
      } else {
        totalBytes += f.size;
      }
    }

    return { ok: true, deleted, freedBytes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── MCP Server Config Persistence ──
const MCP_CONFIG_FILE = path.join(DATA_DIR, 'mcp_servers.json');

ipcMain.handle('mcp:loadConfig', async () => {
  try {
    return { ok: true, servers: readJSON(MCP_CONFIG_FILE, []) };
  } catch (e) {
    return { ok: false, servers: [], error: e.message };
  }
});

ipcMain.handle('mcp:saveConfig', async (_, servers) => {
  try {
    ensureDataDir();
    writeJSON(MCP_CONFIG_FILE, servers || []);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// MCP Subprocess Manager
// Manages external MCP server processes spawned by the renderer.
const _mcpProcesses = {};

ipcMain.handle('mcp:start', async (event, { id, cmd, env, cwd }) => {
  try {
    if (_mcpProcesses[id]) {
      try { _mcpProcesses[id].kill(); } catch (_) {}
      delete _mcpProcesses[id];
    }
    const parts = [];
    let current = '';
    let inQuote = false;
    for (const ch of cmd) {
      if (ch === '"' || ch === "'") { inQuote = !inQuote; continue; }
      if (ch === ' ' && !inQuote) {
        if (current) { parts.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    if (!parts.length) return { ok: false, error: 'Empty command' };
    let prog = parts[0];
    let args = parts.slice(1);
    // ── Windows fix: .cmd/.bat files (npx, npm) need cmd /c ──
    if (process.platform === 'win32') {
      const basename = path.basename(prog).toLowerCase();
      if (basename === 'npx' || basename === 'npm' || basename === 'node' ||
          basename.endsWith('.cmd') || basename.endsWith('.bat') ||
          prog.indexOf(' ') > -1) {
        const fullCmd = [prog].concat(args).join(' ');
        prog = 'cmd';
        args = ['/d', '/s', '/c', fullCmd];
      }
    }
    const spawnOpts = {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : { ...process.env },
    };
    if (cwd) spawnOpts.cwd = cwd;
    const proc = spawn(prog, args, spawnOpts);
    _mcpProcesses[id] = proc;
    let stdoutData = '';
    let stderrData = '';
    proc.stdout.on('data', (d) => { stdoutData += d.toString(); });
    proc.stderr.on('data', (d) => { stderrData += d.toString(); });
    proc.on('error', (err) => {
      console.error('[MCP:' + id + '] error:', err.message);
      delete _mcpProcesses[id];
    });
    proc.on('close', (code) => {
      console.log('[MCP:' + id + '] exited with code ' + code);
      delete _mcpProcesses[id];
    });
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      var errMsg = 'Process exited with code ' + proc.exitCode + ': ' + stderrData.slice(0, 500);
      // Windows ENOENT / -4058 guidance
      if (proc.exitCode === -4058 || /ENOENT/i.test(errMsg)) {
        errMsg += '\n\nTip: On Windows, use cmd /c prefix for npx/npm commands.\nExample: { "command": "cmd", "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-sequential-thinking"] }';
      }
      return { ok: false, error: errMsg };
    }
    return { ok: true, pid: proc.pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mcp:stop', async (event, id) => {
  try {
    var proc = _mcpProcesses[id];
    if (!proc) return { ok: true, note: 'Not running' };
    proc.kill();
    delete _mcpProcesses[id];
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mcp:list', async () => {
  var entries = Object.keys(_mcpProcesses).map(function (id) {
    var proc = _mcpProcesses[id];
    return { id: id, pid: proc.pid, alive: proc.exitCode === null };
  });
  return { ok: true, servers: entries };
});

// Clean up MCP processes on app quit
app.on('before-quit', function () {
  for (var id of Object.keys(_mcpProcesses)) {
    try { _mcpProcesses[id].kill(); } catch (_) {}
  }
});