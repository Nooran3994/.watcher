// ════════════════════════════════════════════════════════════════
// browser.js — SCAAI Tabbed Mini Browser  v2
// ════════════════════════════════════════════════════════════════
// Changes in v2:
//  • Reload-loop fix: overlay debounced, sub-frame loads ignored
//  • 8-direction resize (all edges + corners)
//  • Google account quick-add button (opens accounts.google.com in partition)
//  • Page context tracking → window._mbPageContext
//  • "Summarize this page" button → injects prompt into SCAAI chat
//  • Responsive: min-width/height enforced, panel stays in viewport
// ════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── New Tab Page HTML (Google-style search) ─────────────────────
  const NEW_TAB_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0f0f1a;color:#e0e0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}
.logo{font-size:48px;font-weight:900;letter-spacing:4px;background:linear-gradient(135deg,#6c63ff,#00c9a7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:28px;user-select:none}
.search-wrap{position:relative;width:540px;max-width:90vw}
.search-box{width:100%;padding:14px 50px 14px 22px;font-size:16px;border-radius:30px;border:1.5px solid rgba(108,99,255,.35);background:rgba(255, 255, 255, 0.03);color:#e0e0f0;outline:none;font-family:inherit;transition:all .2s}
.search-box:focus{border-color:rgba(108,99,255,.7);background:rgba(108,99,255,.06);box-shadow:0 0 0 3px rgba(108,99,255,.12)}
.search-box::placeholder{color:#404060}
.search-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(108,99,255,.25);border:none;color:#a0a0e8;cursor:pointer;font-size:18px;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all .15s}
.search-btn:hover{background:rgba(108,99,255,.5)}
.shortcuts{display:flex;gap:16px;margin-top:32px;flex-wrap:wrap;justify-content:center;max-width:600px}
.shortcut{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 16px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);cursor:pointer;transition:all .15s;text-decoration:none;color:inherit;min-width:80px}
.shortcut:hover{background:rgba(108,99,255,.1);border-color:rgba(108,99,255,.3);transform:translateY(-2px)}
.shortcut-icon{font-size:22px}
.shortcut-label{font-size:10px;color:#6060a0}
.clock{font-size:13px;color:#303050;margin-top:24px;letter-spacing:1px}
</style></head><body>
<div class="logo">SCAAI</div>
<div class="search-wrap">
  <input class="search-box" id="q" type="text" placeholder="Search Google or enter address…" autofocus/>
  <button class="search-btn" onclick="doSearch()">⌕</button>
</div>
<div class="shortcuts">
  <a class="shortcut" href="https://google.com" onclick="nav('https://google.com');return false"><span class="shortcut-icon">🔍</span><span class="shortcut-label">Google</span></a>
  <a class="shortcut" href="https://gmail.com" onclick="nav('https://gmail.com');return false"><span class="shortcut-icon">📧</span><span class="shortcut-label">Gmail</span></a>
  <a class="shortcut" href="https://youtube.com" onclick="nav('https://youtube.com');return false"><span class="shortcut-icon">▶️</span><span class="shortcut-label">YouTube</span></a>
  <a class="shortcut" href="https://github.com" onclick="nav('https://github.com');return false"><span class="shortcut-icon">🐱</span><span class="shortcut-label">GitHub</span></a>
  <a class="shortcut" href="https://claude.ai" onclick="nav('https://claude.ai');return false"><span class="shortcut-icon">🤖</span><span class="shortcut-label">Claude</span></a>
  <a class="shortcut" href="https://chat.openai.com" onclick="nav('https://chat.openai.com');return false"><span class="shortcut-icon">💬</span><span class="shortcut-label">ChatGPT</span></a>
</div>
<div class="clock" id="clk"></div>
<script>
function doSearch(){
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var url=/^https?:\/\//.test(q)||(/\./.test(q)&&!/\s/.test(q))?(/^https?:\/\//.test(q)?q:'https://'+q):'https://www.google.com/search?q='+encodeURIComponent(q);
  nav(url);
}
function nav(url){
  try{if(window.parent&&window.parent.mbGo){window.parent.mbGo(url);}else{location.href=url;}}catch(e){location.href=url;}
}
document.getElementById('q').addEventListener('keydown',function(e){if(e.key==='Enter')doSearch();});
(function tick(){var d=new Date();document.getElementById('clk').textContent=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});setTimeout(tick,1000);})();
</script></body></html>`;
  const NEW_TAB_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(NEW_TAB_HTML);

  // ── Constants ──────────────────────────────────────────────────
  const MAX_TABS = 8;
  const PROFILES_KEY = 'scaai_mb_profiles';
  const ACTIVE_PROF_KEY = 'scaai_mb_active_profile';
  const DEFAULT_PROFILE = { id: 'default', name: 'Default', color: '#6c63ff' };
  const GOOGLE_ACCOUNTS = 'https://accounts.google.com/';
  const OVERLAY_DEBOUNCE_MS = 320;

  // ── State ──────────────────────────────────────────────────────
  let tabs = [];
  let activeTabId = null;
  let profiles = [];
  let activeProfile = DEFAULT_PROFILE;
  let _resz = { active: false, dir: '', x0: 0, y0: 0, w0: 0, h0: 0, l0: 0, t0: 0 };
  let _drag = false, _ox = 0, _oy = 0;

  // ── Page context (shared with SCAAI chat) ──────────────────────
  window._mbPageContext = null;

  // ── Persistence ────────────────────────────────────────────────
  function loadProfiles() {
    try { profiles = JSON.parse(localStorage.getItem(PROFILES_KEY)) || [DEFAULT_PROFILE]; }
    catch (_) { profiles = [DEFAULT_PROFILE]; }
    if (!profiles.length) profiles = [DEFAULT_PROFILE];
    try {
      const aid = localStorage.getItem(ACTIVE_PROF_KEY);
      activeProfile = profiles.find(p => p.id === aid) || profiles[0];
    } catch (_) { activeProfile = profiles[0]; }
  }

  function saveProfiles() {
    try {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
      localStorage.setItem(ACTIVE_PROF_KEY, activeProfile.id);
    } catch (_) { }
  }

  function partitionFor(profileId) {
    return 'persist:scaai_browser_' + (profileId || 'default');
  }

  let _tabSeq = 0;
  function nextTabId() { return 'tab_' + (++_tabSeq); }
  function el(id) { return document.getElementById(id); }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Tab strip ──────────────────────────────────────────────────
  function renderTabStrip() {
    const strip = el('mb-tab-strip');
    if (!strip) return;
    strip.innerHTML = '';

    tabs.forEach(tab => {
      const t = document.createElement('div');
      t.className = 'mb-tab' + (tab.id === activeTabId ? ' mb-tab-active' : '');
      t.dataset.id = tab.id;
      const favHtml = tab.favicon
        ? `<img class="mb-tab-fav" src="${escHtml(tab.favicon)}" onerror="this.style.display='none'"/>`
        : `<span class="mb-tab-fav-ph">🌐</span>`;
      t.innerHTML = favHtml +
        `<span class="mb-tab-label">${escHtml(tab.title || tab.url || 'New Tab')}</span>` +
        (tab.loading ? `<span class="mb-tab-spin"></span>` : '') +
        `<button class="mb-tab-close" data-id="${tab.id}" title="Close tab">✕</button>`;

      t.addEventListener('mousedown', e => {
        if (e.target.classList.contains('mb-tab-close')) return;
        switchTab(tab.id);
      });
      t.querySelector('.mb-tab-close').addEventListener('click', e => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      strip.appendChild(t);
    });

    if (tabs.length < MAX_TABS) {
      const btn = document.createElement('button');
      btn.className = 'mb-new-tab-btn';
      btn.title = 'New tab (Ctrl+T)';
      btn.textContent = '+';
      btn.addEventListener('click', () => openNewTab(NEW_TAB_URL));
      strip.appendChild(btn);
    }
  }

  // ── Webview factory ────────────────────────────────────────────
  function createWebview(partition) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', partition);
    wv.setAttribute('allowpopups', 'false');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no');
    wv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;display:none;';
    return wv;
  }

  // ── Open new tab ───────────────────────────────────────────────
  function openNewTab(url) {
    if (tabs.length >= MAX_TABS) {
      navigateTab(tabs[0].id, url);
      switchTab(tabs[0].id);
      return tabs[0].id;
    }
    const id = nextTabId();
    const wv = createWebview(partitionFor(activeProfile.id));
    const tab = { id, url: url || NEW_TAB_URL, title: 'New Tab', favicon: null, wv, loading: false, _overlayTimer: null, _pageContext: null };

    wireWebview(tab);
    const stack = el('mb-webview-stack');
    if (stack) stack.appendChild(wv);
    tabs.push(tab);
    switchTab(id);

    if (url && url !== 'about:blank') {
      tab.loading = true;
      wv.src = url;
    }
    return id;
  }

  // ── Navigate existing tab ──────────────────────────────────────
  function navigateTab(tabId, url) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !url || url === 'about:blank') return;
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    tab.url = url;
    tab.title = 'Loading…';
    tab.loading = true;
    tab.wv.src = url;
    window._mbUrl = url;
    updateAddressBar(url);
    renderTabStrip();
  }

  // ── Switch tab ─────────────────────────────────────────────────
  function switchTab(tabId) {
    const prev = tabs.find(t => t.id === activeTabId);
    if (prev) prev.wv.style.display = 'none';

    activeTabId = tabId;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.wv.style.display = '';
    window._mbUrl = tab.url;
    syncPageContext(tab);
    updateAddressBar(tab.url);
    updateTitle(tab.title, tab.favicon);
    showOverlay(tab.loading);
    renderTabStrip();
  }

  // ── Close tab ──────────────────────────────────────────────────
  function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    const tab = tabs[idx];
    clearTimeout(tab._overlayTimer);
    tab.wv.src = 'about:blank';
    const stack = el('mb-webview-stack');
    if (stack && tab.wv.parentNode === stack) stack.removeChild(tab.wv);
    tabs.splice(idx, 1);
    if (tabs.length === 0) { mbClose(); return; }
    if (activeTabId === tabId) switchTab(tabs[Math.min(idx, tabs.length - 1)].id);
    else renderTabStrip();
  }

  // ── Wire webview events ────────────────────────────────────────
  function wireWebview(tab) {
    const wv = tab.wv;

    // Main-frame navigation start — debounced overlay
    wv.addEventListener('did-start-navigation', e => {
      if (!e.isMainFrame) return;
      tab.loading = true;
      clearTimeout(tab._overlayTimer);
      tab._overlayTimer = setTimeout(() => {
        if (tab.loading && tab.id === activeTabId) showOverlay(true);
        renderTabStrip();
      }, OVERLAY_DEBOUNCE_MS);
    });

    // All frames finished — correct place to hide overlay
    wv.addEventListener('did-stop-loading', () => {
      clearTimeout(tab._overlayTimer);
      tab.loading = false;
      if (tab.id === activeTabId) {
        showOverlay(false);
        wv.style.display = '';
      }
      renderTabStrip();
      extractPageContext(tab);
    });

    wv.addEventListener('did-fail-load', e => {
      if (e.errorCode === -3) return;   // aborted redirect — not real error (common on first load)
      if (e.errorCode === -6) return;   // file not found on data: / initial partition
      if (e.errorCode === -2) return;   // ERR_FAILED — about:blank and webview teardown
      if (!e.isMainFrame) return;       // sub-frame failure — ignore
      // If the tab already has a real URL (navigated successfully), the error is stale
      if (tab.url && tab.url !== 'about:blank' && !tab.url.startsWith('data:') &&
        e.validatedURL && tab.url !== e.validatedURL) return;
      clearTimeout(tab._overlayTimer);
      tab.loading = false;
      // Map common network error codes to friendly messages
      const NET_ERRORS = {
        '-324': 'Site returned no response (ERR_EMPTY_RESPONSE). The server may be down.',
        '-105': 'Host not found. Check the URL or your internet connection.',
        '-106': 'No internet connection.',
        '-7': 'Timed out waiting for the server to respond.',
        '-21': 'Network access denied.',
        '-130': 'Proxy connection failed.',
      };
      const friendlyMsg = NET_ERRORS[String(e.errorCode)] || ('Failed to load: ' + (e.errorDescription || 'Unknown error'));
      if (tab.id === activeTabId) showOverlayError(friendlyMsg);
      renderTabStrip();
    });

    wv.addEventListener('page-title-updated', e => {
      tab.title = e.title || tab.url || 'Tab';
      if (tab.id === activeTabId) updateTitle(tab.title, tab.favicon);
      renderTabStrip();
    });

    wv.addEventListener('page-favicon-updated', e => {
      if (e.favicons && e.favicons[0]) {
        tab.favicon = e.favicons[0];
        if (tab.id === activeTabId) updateTitle(tab.title, tab.favicon);
        renderTabStrip();
      }
    });

    wv.addEventListener('did-navigate', e => {
      tab.url = e.url;
      window._mbUrl = e.url;
      if (tab.id === activeTabId) updateAddressBar(e.url);
    });

    wv.addEventListener('did-navigate-in-page', e => {
      if (!e.isMainFrame) return;
      tab.url = e.url;
      window._mbUrl = e.url;
      if (tab.id === activeTabId) updateAddressBar(e.url);
    });

    wv.addEventListener('new-window', e => {
      e.preventDefault();
      if (e.url && e.url !== 'about:blank') openNewTab(e.url);
    });
  }

  // ── Page context extraction ────────────────────────────────────
  function extractPageContext(tab) {
    if (!tab || !tab.wv || !tab.url || tab.url === 'about:blank' || tab.url.startsWith('data:')) return;
    tab.wv.executeJavaScript(`
      (function() {
        try {
          var title = document.title || '';
          var url   = location.href;
          var meta  = '';
          var md = document.querySelector('meta[name="description"]');
          if (md) meta = md.getAttribute('content') || '';
          var body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          body = body.replace(/\\s{3,}/g, '\\n').trim().slice(0, 4000);
          return JSON.stringify({ title: title, url: url, meta: meta, text: body });
        } catch(e) { return JSON.stringify({ title: document.title || '', url: location.href, meta: '', text: '' }); }
      })()
    `).then(result => {
      try {
        const ctx = JSON.parse(result);
        ctx.tabId = tab.id;
        tab._pageContext = ctx;
        if (tab.id === activeTabId) {
          window._mbPageContext = ctx;
          updateSummarizeBtn(ctx);
        }
      } catch (_) { }
    }).catch(() => { });
  }

  function syncPageContext(tab) {
    if (tab && tab._pageContext) {
      window._mbPageContext = tab._pageContext;
      updateSummarizeBtn(tab._pageContext);
    } else {
      window._mbPageContext = null;
      updateSummarizeBtn(null);
    }
  }

  function updateSummarizeBtn(ctx) {
    const btn = el('mb-summarize-btn');
    if (!btn) return;
    if (ctx && ctx.url && ctx.url !== 'about:blank') {
      btn.style.display = '';
      btn.title = 'Ask SCAAI to summarize: ' + (ctx.title || ctx.url);
    } else {
      btn.style.display = 'none';
    }
  }

  // ── AI page context injection ──────────────────────────────────
  window.mbSummarizePage = function () {
    const ctx = window._mbPageContext;
    if (!ctx) return;
    const ci = el('ci');
    if (!ci) return;
    const prompt =
      `[Browser context — ${ctx.url}]\n` +
      `Page title: ${ctx.title}\n` +
      (ctx.meta ? `Description: ${ctx.meta}\n` : '') +
      (ctx.text ? `\nPage content:\n${ctx.text}\n\n` : '\n') +
      `Please summarize what is on this page and let me know the key points.`;
    ci.value = prompt;
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.focus();
    ci.style.height = '';
    ci.style.height = Math.min(ci.scrollHeight, 110) + 'px';
    const mb = el('mini-browser');
    if (mb) mb.classList.add('mb-minimized');
    const minBtn = el('mb-min');
    if (minBtn) minBtn.textContent = '▲';
  };

  // Called by user to ask a custom question about the current page
  window.mbAskAboutPage = function (question) {
    const ctx = window._mbPageContext;
    if (!ctx) return;
    const ci = el('ci');
    if (!ci) return;
    const q = question || 'What can you tell me about this page?';
    ci.value =
      `[Context: I am viewing "${ctx.title}" at ${ctx.url}]\n${q}`;
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.focus();
    ci.style.height = '';
    ci.style.height = Math.min(ci.scrollHeight, 110) + 'px';
    const mb = el('mini-browser');
    if (mb) mb.classList.add('mb-minimized');
    const minBtn = el('mb-min');
    if (minBtn) minBtn.textContent = '▲';
  };

  // ── UI helpers ─────────────────────────────────────────────────
  function showOverlay(show) {
    const ov = el('mb-overlay');
    const sp = el('mb-spinner');
    const tx = el('mb-overlay-text');
    if (!ov) return;
    if (show) {
      ov.style.display = 'flex';
      if (sp) { sp.style.display = ''; sp.style.animation = 'mbspin .7s linear infinite'; }
      if (tx) tx.textContent = 'Loading…';
    } else {
      ov.style.display = 'none';
    }
  }

  function showOverlayError(msg) {
    const ov = el('mb-overlay');
    const sp = el('mb-spinner');
    const tx = el('mb-overlay-text');
    if (!ov) return;
    ov.style.display = 'flex';
    if (sp) sp.style.display = 'none';
    if (tx) tx.textContent = msg;
  }

  function updateAddressBar(url) {
    const ui = el('mb-url');
    if (ui && url && url !== 'about:blank' && !url.startsWith('data:')) ui.value = url;
  }

  function updateTitle(title, favicon) {
    const tl = el('mb-title');
    if (tl) tl.textContent = title || '🌐 Mini Browser';
    const fv = el('mb-favicon');
    if (fv) {
      if (favicon) { fv.src = favicon; fv.style.display = ''; }
      else fv.style.display = 'none';
    }
  }

  // ── Profile panel ──────────────────────────────────────────────
  function renderProfilePanel() {
    const panel = el('mb-profile-panel');
    if (!panel) return;
    const colors = ['#6c63ff', '#00c9a7', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
    let pickedColor = colors[0];

    panel.innerHTML = `
      <div style="padding:10px 12px 10px;">
        <div style="font-size:9px;font-weight:800;color:#4a4a88;letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px;">Browser Profiles</div>
        <div style="font-size:9px;color:#444468;line-height:1.55;margin-bottom:10px;">
          Each profile keeps separate cookies &amp; logins.<br>
          Sign in to Google once — stays signed in permanently.
        </div>

        <button id="mb-google-btn"
          style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin-bottom:10px;border-radius:7px;
                 border:1px solid rgba(66,133,244,.35);background:rgba(66,133,244,.08);cursor:pointer;transition:all .15s;font-family:inherit;text-align:left;">
          <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          <div style="flex:1;">
            <div style="font-size:10px;font-weight:700;color:#7090d8;">Sign in with Google</div>
            <div style="font-size:8px;color:#333360;margin-top:1px;">Opens Google account sign-in in active profile</div>
          </div>
        </button>

        <div id="mb-profile-list" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;max-height:160px;overflow-y:auto;"></div>

        <div style="border-top:1px solid rgba(108,99,255,.1);padding-top:8px;">
          <div style="font-size:8px;color:#333358;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px;">New Profile</div>
          <div style="display:flex;gap:5px;align-items:center;">
            <input id="mb-new-profile-name" placeholder="Profile name…" maxlength="20"
              style="flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(108,99,255,.2);border-radius:5px;
                     color:#c0c0e8;font-size:10px;padding:5px 8px;outline:none;font-family:inherit;min-width:0;"/>
            <div id="mb-new-profile-colors" style="display:flex;gap:3px;flex-shrink:0;">
              ${colors.map((c, i) =>
      `<div class="mb-color-swatch" data-color="${c}"
                  style="width:11px;height:11px;border-radius:50%;background:${c};cursor:pointer;box-sizing:border-box;
                         border:2px solid ${i === 0 ? '#fff' : 'transparent'};transition:all .12s;" title="${c}"></div>`
    ).join('')}
            </div>
            <button id="mb-add-profile-btn"
              style="background:rgba(108,99,255,.18);border:1px solid rgba(108,99,255,.3);color:#a0a0e8;
                     font-size:9px;padding:5px 8px;border-radius:5px;cursor:pointer;font-family:inherit;flex-shrink:0;white-space:nowrap;">
              + Add
            </button>
          </div>
        </div>
      </div>
    `;

    renderProfileList();

    panel.querySelector('#mb-google-btn').addEventListener('click', () => {
      panel.style.display = 'none';
      el('mini-browser').style.display = 'flex';
      openNewTab(GOOGLE_ACCOUNTS);
    });

    panel.querySelectorAll('.mb-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        pickedColor = sw.dataset.color;
        panel.querySelectorAll('.mb-color-swatch').forEach(s => s.style.borderColor = 'transparent');
        sw.style.borderColor = '#fff';
      });
    });

    el('mb-add-profile-btn').addEventListener('click', () => {
      const inp = el('mb-new-profile-name');
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      profiles.push({ id: 'profile_' + Date.now(), name, color: pickedColor });
      saveProfiles();
      inp.value = '';
      renderProfileList();
    });
  }

  function renderProfileList() {
    const list = el('mb-profile-list');
    if (!list) return;
    list.innerHTML = '';
    profiles.forEach(p => {
      const isActive = p.id === activeProfile.id;
      const row = document.createElement('div');
      row.style.cssText =
        `display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:7px;cursor:pointer;
         border:1px solid ${isActive ? 'rgba(108,99,255,.35)' : 'rgba(255,255,255,.05)'};
         background:${isActive ? 'rgba(108,99,255,.1)' : 'rgba(255,255,255,.02)'};transition:all .15s;`;
      row.innerHTML =
        `<div style="width:7px;height:7px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
         <span style="flex:1;font-size:10px;color:${isActive ? '#e0e0ff' : '#7070a0'};font-weight:${isActive ? '700' : '400'};">${escHtml(p.name)}</span>
         ${isActive ? '<span style="font-size:8px;color:#6c63ff;flex-shrink:0;">● Active</span>' : ''}
         ${p.id !== 'default'
          ? `<button class="mb-del-profile" data-id="${p.id}"
                style="background:none;border:none;color:#2a2a48;cursor:pointer;font-size:9px;padding:1px 4px;border-radius:3px;transition:all .15s;flex-shrink:0;"
                title="Delete">✕</button>`
          : ''}`;
      row.addEventListener('click', e => {
        if (e.target.classList.contains('mb-del-profile')) return;
        switchProfile(p);
        el('mb-profile-panel').style.display = 'none';
      });
      row.querySelectorAll('.mb-del-profile').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (p.id === activeProfile.id) return;
          profiles = profiles.filter(x => x.id !== p.id);
          saveProfiles();
          renderProfileList();
        });
      });
      list.appendChild(row);
    });
  }

  function switchProfile(profile) {
    if (profile.id === activeProfile.id) return;
    activeProfile = profile;
    saveProfiles();
    const currentUrl = window._mbUrl && window._mbUrl !== 'about:blank' ? window._mbUrl : null;
    const stack = el('mb-webview-stack');
    tabs.forEach(tab => {
      clearTimeout(tab._overlayTimer);
      tab.wv.src = 'about:blank';
      if (stack && tab.wv.parentNode === stack) stack.removeChild(tab.wv);
    });
    tabs = []; activeTabId = null;
    updateProfileIndicator();
    openNewTab(currentUrl || NEW_TAB_URL);
  }

  function updateProfileIndicator() {
    const ind = el('mb-profile-indicator');
    if (ind) ind.style.background = activeProfile.color;
    const lbl = el('mb-profile-label');
    if (lbl) lbl.textContent = activeProfile.name;
  }

  // ── 8-Direction Resize ─────────────────────────────────────────
  function injectResizeHandles() {
    const mb = el('mini-browser');
    if (!mb) return;
    mb.querySelectorAll('.mb-resize-handle').forEach(h => h.remove());
    [
      { dir: 'nw', s: 'top:0;left:0;width:12px;height:12px;cursor:nw-resize;' },
      { dir: 'ne', s: 'top:0;right:0;width:12px;height:12px;cursor:ne-resize;' },
      { dir: 'sw', s: 'bottom:0;left:0;width:12px;height:12px;cursor:sw-resize;' },
      { dir: 'se', s: 'bottom:0;right:0;width:12px;height:12px;cursor:se-resize;' },
      { dir: 'n', s: 'top:0;left:12px;right:12px;height:5px;cursor:n-resize;' },
      { dir: 's', s: 'bottom:0;left:12px;right:12px;height:5px;cursor:s-resize;' },
      { dir: 'w', s: 'left:0;top:12px;bottom:12px;width:5px;cursor:w-resize;' },
      { dir: 'e', s: 'right:0;top:12px;bottom:12px;width:5px;cursor:e-resize;' },
    ].forEach(({ dir, s }) => {
      const h = document.createElement('div');
      h.className = 'mb-resize-handle';
      h.dataset.dir = dir;
      h.style.cssText = `position:absolute;z-index:10;-webkit-app-region:no-drag;${s}`;
      h.addEventListener('mousedown', onResizeStart);
      mb.appendChild(h);
    });
  }

  function onResizeStart(e) {
    e.preventDefault(); e.stopPropagation();
    if (el('mini-browser').dataset.max === '1') return;
    const r = el('mini-browser').getBoundingClientRect();
    _resz = { active: true, dir: e.currentTarget.dataset.dir, x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height, l0: r.left, t0: r.top };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = e.currentTarget.style.cursor;
  }

  function onResizeMove(e) {
    if (!_resz.active) return;
    const mb = el('mini-browser'); if (!mb) return;
    const dx = e.clientX - _resz.x0, dy = e.clientY - _resz.y0;
    const { dir, w0, h0, l0, t0 } = _resz;
    const MIN_W = 400, MIN_H = 280;
    let nW = w0, nH = h0, nL = l0, nT = t0;
    if (dir.includes('e')) nW = Math.max(MIN_W, w0 + dx);
    if (dir.includes('s')) nH = Math.max(MIN_H, h0 + dy);
    if (dir.includes('w')) { nW = Math.max(MIN_W, w0 - dx); nL = l0 + (w0 - nW); }
    if (dir.includes('n')) { nH = Math.max(MIN_H, h0 - dy); nT = t0 + (h0 - nH); }
    nL = Math.max(0, Math.min(window.innerWidth - MIN_W, nL));
    nT = Math.max(0, Math.min(window.innerHeight - 40, nT));
    Object.assign(mb.style, { width: nW + 'px', height: nH + 'px', left: nL + 'px', top: nT + 'px', right: 'auto', bottom: 'auto' });
  }

  function onResizeEnd() {
    if (_resz.active) {
      _resz.active = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    _drag = false;
  }

  // ── Drag ───────────────────────────────────────────────────────
  function initDrag() {
    const tb = el('mb-titlebar');
    if (!tb) return;
    tb.addEventListener('mousedown', e => {
      const mb = el('mini-browser'); if (!mb) return;
      // Ignore clicks on interactive children
      if (e.target.closest('button, input, #mb-profile-btn, #mb-profile-panel')) return;
      if (mb.classList.contains('mb-minimized') || mb.dataset.max === '1') return;
      const r = mb.getBoundingClientRect();
      _drag = true; _ox = e.clientX - r.left; _oy = e.clientY - r.top;
      document.body.style.userSelect = 'none';
    });
  }

  function onDragMove(e) {
    if (!_drag) return;
    const mb = el('mini-browser'); if (!mb) return;
    let nx = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - _ox));
    let ny = Math.max(0, Math.min(window.innerHeight - 36, e.clientY - _oy));
    Object.assign(mb.style, { left: nx + 'px', top: ny + 'px', right: 'auto', bottom: 'auto' });
  }

  // ── Public window API ──────────────────────────────────────────
  window.openMiniBrowser = function (url) {
    if (!url || url === 'about:blank') return;
    // Sanitize: decode %27 back to ', strip trailing junk punctuation from markdown
    url = decodeURIComponent(url).replace(/[).,;!?\]]+$/, '').trim();
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    const mb = el('mini-browser'); if (!mb) return;
    mb.style.display = 'flex';
    mb.classList.remove('mb-minimized');
    const existing = tabs.find(t => t.url === url);
    if (existing) { switchTab(existing.id); return; }
    openNewTab(url);
    window._mbUrl = url;
  };

  window.mbClose = function () {
    const mb = el('mini-browser');
    if (mb) { mb.style.display = 'none'; mb.classList.remove('mb-minimized'); mb.dataset.max = ''; }
  };

  window.mbMinimize = function () {
    const mb = el('mini-browser'), btn = el('mb-min');
    if (!mb) return;
    const m = mb.classList.toggle('mb-minimized');
    if (btn) btn.textContent = m ? '▲' : '─';
  };

  window.mbMaximize = function () {
    const mb = el('mini-browser'), btn = el('mb-max');
    if (!mb) return;
    if (mb.dataset.max === '1') {
      const p = mb.dataset.prev
        ? JSON.parse(mb.dataset.prev)
        : { top: '55px', left: 'auto', right: '18px', bottom: 'auto', width: '760px', height: '560px' };
      Object.assign(mb.style, p);
      mb.dataset.max = '';
      if (btn) btn.textContent = '⬜';
    } else {
      const r = mb.getBoundingClientRect();
      mb.dataset.prev = JSON.stringify({ top: r.top + 'px', left: r.left + 'px', right: 'auto', bottom: 'auto', width: r.width + 'px', height: r.height + 'px' });
      Object.assign(mb.style, { top: '4px', left: '4px', right: '4px', bottom: '4px', width: 'calc(100vw - 8px)', height: 'calc(100vh - 8px)' });
      mb.dataset.max = '1';
      if (btn) btn.textContent = '❐';
    }
  };

  window.mbNav = function (a) {
    const tab = tabs.find(t => t.id === activeTabId); if (!tab) return;
    if (a === 'back' && tab.wv.canGoBack()) tab.wv.goBack();
    else if (a === 'fwd' && tab.wv.canGoForward()) tab.wv.goForward();
    else if (a === 'reload') tab.wv.reload();
  };

  window.mbGo = function (url) {
    if (!url) return;
    // Sanitize: strip trailing punctuation from markdown syntax bleed
    url = url.replace(/[).,;!?\]]+$/, '').trim();
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    const mb = el('mini-browser'); if (mb) mb.style.display = 'flex';
    if (tabs.length === 0) { openNewTab(url); return; }
    navigateTab(activeTabId, url);
  };

  window.mbExt = function () {
    if (window._mbUrl && window._mbUrl !== 'about:blank')
      if (window.A && window.A.sys) window.A.sys.openUrl(window._mbUrl);
  };

  window.mbToggleProfiles = function () {
    const panel = el('mb-profile-panel'); if (!panel) return;
    const open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) {
      renderProfilePanel();
      setTimeout(() => {
        document.addEventListener('click', function _c(e) {
          const pb = el('mb-profile-btn');
          if (!panel.contains(e.target) && (!pb || !pb.contains(e.target))) {
            panel.style.display = 'none';
          }
          document.removeEventListener('click', _c);
        });
      }, 0);
    }
  };

  window.mbNewTab = function () {
    const mb = el('mini-browser'); if (mb) mb.style.display = 'flex';
    openNewTab(NEW_TAB_URL);
  };

  // ── Init ───────────────────────────────────────────────────────
  function init() {
    loadProfiles();
    updateProfileIndicator();
    injectResizeHandles();
    initDrag();

    document.addEventListener('mousemove', e => { onDragMove(e); onResizeMove(e); });
    document.addEventListener('mouseup', onResizeEnd);

    const urlInput = el('mb-url');
    if (urlInput) {
      urlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); window.mbGo(urlInput.value); }
        if (e.key === 'Escape') urlInput.blur();
      });
      urlInput.addEventListener('focus', () => urlInput.select());
    }

    document.addEventListener('keydown', e => {
      const mb = el('mini-browser');
      if (!mb || mb.style.display === 'none') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); openNewTab(NEW_TAB_URL); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
      if ((e.ctrlKey || e.metaKey) && /^[1-8]$/.test(e.key)) {
        const t = tabs[parseInt(e.key) - 1]; if (t) switchTab(t.id);
      }
    });

    const sumBtn = el('mb-summarize-btn');
    if (sumBtn) sumBtn.addEventListener('click', window.mbSummarizePage);

    showOverlay(false);
    updateSummarizeBtn(null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

})();
