'use strict';

// ═══════════════════════════════════════════════════════════════
// ── SCAAI Input Enhancer — Plus Menu, Image Paste, MCP ──
// ═══════════════════════════════════════════════════════════════
// Injected after renderer.js — wires into existing globals.
// All functions use window.* references so they're callable
// from inline onclick handlers in index.html.
// ═══════════════════════════════════════════════════════════════

(function () {

  var A = window.scaai;

  // ── Global state ──
  window._PASTED_IMAGES = window._PASTED_IMAGES || [];
  window._PENDING_ATTACHMENTS = window._PENDING_ATTACHMENTS || [];
  window._MCP_SERVERS = window._MCP_SERVERS || [];

  // Persist current MCP server list to disk
  window._saveMCPServers = function () {
    // Strip runtime-only fields before saving
    var saveable = (window._MCP_SERVERS || []).map(function (s) {
      return { id: s.id, name: s.name, cmd: s.cmd, extraOpts: s.extraOpts || {}, status: 'disconnected' };
    });
    if (A && A.mcp && A.mcp.saveConfig) {
      A.mcp.saveConfig(saveable).catch(function () {});
    }
  };

  // ═══════════════════════════════════════════════════════════
  // ── Floating Plus Menu ──
  // ═══════════════════════════════════════════════════════════

  window.togglePlusMenu = function (event) {
    if (event) event.stopPropagation();
    var menu = document.getElementById('plus-menu');
    if (!menu) return;
    var isOpen = menu.style.display !== 'none';
    if (isOpen) {
      window.closePlusMenu();
    } else {
      menu.style.display = 'block';
      setTimeout(function () {
        document.addEventListener('mousedown', _closePlusOutside, { once: true, capture: true });
      }, 0);
    }
  };

  window.closePlusMenu = function () {
    var menu = document.getElementById('plus-menu');
    if (menu) menu.style.display = 'none';
  };

  function _closePlusOutside(e) {
    var menu = document.getElementById('plus-menu');
    var btn = document.getElementById('plus-btn');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
    window.closePlusMenu();
  }

  // ═══════════════════════════════════════════════════════════
  // ── Image Pasting ──
  // ═══════════════════════════════════════════════════════════

  window.triggerImagePaste = function () {
    var ci = document.getElementById('ci');
    if (ci) {
      ci.focus();
      ci.placeholder = 'Paste an image (Ctrl+V) or type\u2026';
      setTimeout(function () { ci.placeholder = 'Ask SCAAI...'; }, 3000);
    }
  };

  function _addImagePreview(dataUrl, mimeType) {
    var container = document.getElementById('img-preview-container');
    if (!container) return;
    container.style.display = 'flex';
    var idx = window._PASTED_IMAGES.length;
    var bubble = document.createElement('div');
    bubble.className = 'img-preview-bubble';
    bubble.innerHTML = '<img src="' + dataUrl.replace(/"/g, '&quot;') + '" alt="Pasted image" style="cursor:zoom-in" onclick="expandImage(\'' + dataUrl.replace(/'/g, "\\'") + '\',\'Pasted image\');event.stopPropagation()" />'
      + '<button class="img-remove-btn" onclick="_removeImagePreview(' + idx + ')">\u2715</button>'
      + '<span class="img-index">' + (idx + 1) + '</span>';
    container.appendChild(bubble);
    window._PASTED_IMAGES.push({ dataUrl: dataUrl, mimeType: mimeType, name: 'pasted_image_' + (idx + 1) + '.png' });
  }

  window._removeImagePreview = function (index) {
    if (index >= 0 && index < window._PASTED_IMAGES.length) {
      window._PASTED_IMAGES.splice(index, 1);
    }
    _reRenderImagePreviews();
  };

  function _reRenderImagePreviews() {
    var container = document.getElementById('img-preview-container');
    if (!container) return;
    container.innerHTML = '';
    if (!window._PASTED_IMAGES.length) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    window._PASTED_IMAGES.forEach(function (img, i) {
      var bubble = document.createElement('div');
      bubble.className = 'img-preview-bubble';
      bubble.innerHTML = '<img src="' + img.dataUrl.replace(/"/g, '&quot;') + '" alt="Pasted image" style="cursor:zoom-in" onclick="expandImage(\'' + img.dataUrl.replace(/'/g, "\\'") + '\',\'Pasted image\');event.stopPropagation()" />'
        + '<button class="img-remove-btn" onclick="_removeImagePreview(' + i + ')">\u2715</button>'
        + '<span class="img-index">' + (i + 1) + '</span>';
      container.appendChild(bubble);
    });
  }

  // Document-level paste handler for images
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var hasImage = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type && item.type.indexOf('image/') === 0) {
        hasImage = true;
        var blob = item.getAsFile();
        if (!blob) continue;
        (function (blobRef) {
          var reader = new FileReader();
          reader.onload = function (ev) {
            _addImagePreview(ev.target.result, blobRef.type || 'image/png');
          };
          reader.readAsDataURL(blobRef);
        })(blob);
      }
    }
    if (hasImage) {
      e.preventDefault();
      var text = e.clipboardData.getData('text/plain');
      if (text && text.trim()) {
        var ci = document.getElementById('ci');
        if (ci) {
          var start = ci.selectionStart;
          var end = ci.selectionEnd;
          ci.value = ci.value.substring(0, start) + text + ci.value.substring(end);
          ci.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  });

  // Check if current model can analyze images
  window._modelCanAnalyzeImages = function () {
    var model = (window.CONFIG && window.CONFIG.model) || '';
    var provider = (window.CONFIG && window.CONFIG.provider) || '';
    var visionPatterns = [
      /gpt-4o/i, /gpt-4-vision/i, /gpt-4-turbo/i,
      /claude-3(\.[5])?-(sonnet|opus)/i, /claude-4/i,
      /gemini-(1\.5|2\.0)/i, /gemini-2\.5/i,
      /llama-3\.2-\d+b-vision/i,
      /pixtral/i, /qwen-vl/i, /qwen2-vl/i,
      /llava/i, /cogvlm/i, /idefics/i,
    ];
    for (var j = 0; j < visionPatterns.length; j++) {
      if (visionPatterns[j].test(model)) return true;
    }
    if (provider === 'custom') {
      var url = (window.CONFIG.customApiUrl || '').toLowerCase();
      if (url.indexOf('openai') > -1 || url.indexOf('anthropic') > -1 || url.indexOf('google') > -1) return true;
    }
    return false;
  };

  // ═══════════════════════════════════════════════════════════
  // ── MCP Connect ──
  // ═══════════════════════════════════════════════════════════

  window.openMCPConnect = function () {
    var modal = document.getElementById('mcp-modal');
    if (modal) {
      modal.style.display = 'flex';
      _renderMCPServerList();
    }
  };

  window.closeMCPConnect = function () {
    var modal = document.getElementById('mcp-modal');
    if (modal) modal.style.display = 'none';
  };

  /** Switch between Simple (command string) and JSON input modes in the MCP modal */
  window.switchMCPInputMode = function (mode) {
    var simpleDiv = document.getElementById('mcp-input-simple');
    var jsonDiv = document.getElementById('mcp-input-json');
    var simpleBtn = document.getElementById('mcp-tab-simple');
    var jsonBtn = document.getElementById('mcp-tab-json');
    if (!simpleDiv || !jsonDiv) return;
    if (mode === 'json') {
      simpleDiv.style.display = 'none';
      jsonDiv.style.display = '';
      if (simpleBtn) simpleBtn.style.opacity = '0.5';
      if (jsonBtn) jsonBtn.style.opacity = '1';
    } else {
      simpleDiv.style.display = '';
      jsonDiv.style.display = 'none';
      if (simpleBtn) simpleBtn.style.opacity = '1';
      if (jsonBtn) jsonBtn.style.opacity = '0.5';
    }
  };

  /**
   * Parse a Cursor-style MCP JSON config into { cmd, name, env?, cwd? }.
   * Handles:
   *   - flat  { command, args, env?, cwd? }  (existing)
   *   - wrapped { mcpServers: { name: { command, args, env?, cwd? } } }
   *   - url-only { url: "https://..." } → returns actionable error hint
   */
  function _parseMCPJson(jsonStr) {
    var obj;
    try { obj = JSON.parse(jsonStr); } catch (e) { return { error: 'Invalid JSON: ' + e.message }; }
    if (!obj || typeof obj !== 'object') return { error: 'Must be a JSON object.' };

    // Unwrap mcpServers wrapper:  { mcpServers: { name: { ... } } }
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !obj.command && !obj.url) {
      var keys = Object.keys(obj.mcpServers);
      if (keys.length === 0) return { error: '"mcpServers" object is empty — add a server entry.' };
      var firstKey = keys[0];
      var firstVal = obj.mcpServers[firstKey];
      if (!firstVal || typeof firstVal !== 'object') return { error: 'Entry "' + firstKey + '" must be a JSON object.' };
      // Inject name from key and recurse
      firstVal.name = firstVal.name || firstKey;
      return _parseSingleMCP(firstVal);
    }

    return _parseSingleMCP(obj);
  }

  /** Parse a single MCP server config object */
  function _parseSingleMCP(obj) {
    // URL-only remote MCP detection
    if (obj.url && typeof obj.url === 'string' && obj.url.startsWith('http')) {
      var hint = '';
      if (/context7/i.test(obj.url)) {
        hint = '\n\nFor Context7, use stdio instead:\n{\n  "command": "npx",\n  "args": ["-y", "@upstash/context7-mcp@latest"]\n}';
      }
      return { error: 'Remote URL MCP is not supported yet. Use stdio command + args instead.' + hint };
    }
    if (typeof obj.command !== 'string' || !obj.command.trim()) return { error: 'Missing required "command" field (must be a non-empty string).' };
    if (obj.args !== undefined && (!Array.isArray(obj.args) || !obj.args.every(function(a) { return typeof a === 'string'; }))) {
      return { error: '"args" must be an array of strings.' };
    }
    if (obj.env !== undefined && (typeof obj.env !== 'object' || obj.env === null)) return { error: '"env" must be a key-value object.' };
    // Build cmd string: command + args joined with shell-friendly quoting
    var parts = [obj.command.trim()];
    if (obj.args && obj.args.length) {
      for (var _ai = 0; _ai < obj.args.length; _ai++) {
        var a = obj.args[_ai];
        if (a.indexOf(' ') > -1) parts.push('"' + a.replace(/"/g, '\\"') + '"');
        else parts.push(a);
      }
    }
    var cmd = parts.join(' ');
    var name = obj.name || obj.command.split('/').pop().split('@').pop() || 'MCP Server';
    return { cmd: cmd, name: name, env: obj.env, cwd: obj.cwd };
  }

  function _renderMCPServerList() {
    var list = document.getElementById('mcp-server-list');
    var badge = document.getElementById('mcp-connect-badge');
    if (!list) return;
    if (!window._MCP_SERVERS || !window._MCP_SERVERS.length) {
      list.innerHTML = '<div class="mcp-empty">No MCP servers connected.</div>';
      if (badge) badge.style.display = 'none';
      return;
    }
    if (badge && window._MCP_SERVERS.some(function (s) { return s.status === 'connected'; })) {
      badge.style.display = '';
    }
    list.innerHTML = '';
    window._MCP_SERVERS.forEach(function (srv, i) {
      var card = document.createElement('div');
      card.className = 'mcp-server-card';
      var dotClass = srv.status === 'connected' ? '' : (srv.status === 'connecting' ? ' connecting' : ' error');
      var label = srv.status === 'connected' ? 'Connected' : (srv.status === 'connecting' ? 'Connecting...' : 'Error');
      card.innerHTML = ''
        + '<div class="mcp-server-dot' + dotClass + '"></div>'
        + '<div class="mcp-server-info">'
        + '<div class="mcp-server-name">' + _x(srv.name || 'MCP Server') + '</div>'
        + '<div class="mcp-server-cmd">' + _x(srv.cmd || '') + '</div></div>'
        + '<span class="mcp-server-status">' + label + '</span>'
        + '<button class="mcp-server-remove" onclick="_mcpRemove(' + i + ')" title="Remove server">\u2715</button>';
      list.appendChild(card);
    });
  }

  function _x(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.mcpAddServer = async function () {
    // Detect which input mode is active
    var simpleDiv = document.getElementById('mcp-input-simple');
    var jsonDiv = document.getElementById('mcp-input-json');
    var isJsonMode = jsonDiv && jsonDiv.style.display !== 'none';

    var cmd, name, extraOpts;
    if (isJsonMode) {
      var jsonInput = document.getElementById('mcp-json-input');
      var jsonStr = jsonInput ? jsonInput.value.trim() : '';
      if (!jsonStr) {
        if (typeof addMsg === 'function') addMsg('sys', '\u26A0\uFE0F Paste a JSON MCP config first.');
        return;
      }
      var parsed = _parseMCPJson(jsonStr);
      if (parsed.error) {
        if (typeof addMsg === 'function') addMsg('sys', '\u26A0\uFE0F ' + parsed.error);
        return;
      }
      cmd = parsed.cmd;
      name = parsed.name;
      extraOpts = { env: parsed.env, cwd: parsed.cwd };
      if (jsonInput) jsonInput.value = '';
    } else {
      var input = document.getElementById('mcp-cmd-input');
      cmd = input ? input.value.trim() : '';
      if (!cmd) {
        if (typeof addMsg === 'function') addMsg('sys', '\u26A0\uFE0F Enter a server command.');
        return;
      }
      name = cmd.split(/\s+/).slice(0, 2).join(' ');
      extraOpts = {};
      if (input) input.value = '';
    }

    var id = 'mcp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    window._MCP_SERVERS.push({ id: id, name: name, cmd: cmd, status: 'connecting', extraOpts: extraOpts });
    _renderMCPServerList();
    if (typeof window._saveMCPServers === 'function') window._saveMCPServers();
    if (typeof addMsg === 'function') addMsg('sys', '\uD83D\uDD0C Connecting MCP server: **' + name + '**...');

    try {
      var r = await (A.mcp && A.mcp.start ? A.mcp.start({ id: id, cmd: cmd, env: extraOpts.env, cwd: extraOpts.cwd })
        : A.sys.exec(cmd, { timeout: 15000 }));
      if (r && r.ok !== false) {
        var srv = window._MCP_SERVERS.find(function (s) { return s.id === id; });
        if (srv) srv.status = 'connected';
        // Register MCP tools if the server returned any
        if (r.tools && typeof registerMCPTools === 'function') {
          registerMCPTools(r.tools);
        }
        // Register a placeholder tool entry for this server so it shows in TOOLS_CONFIG
        if (typeof registerMCPTools === 'function' && (!r.tools || !r.tools.length)) {
          registerMCPTools([{ name: name, server: name, description: 'Tool from ' + name + ' MCP server', inputSchema: {} }]);
        }
        if (typeof addMsg === 'function') addMsg('sys', '\u2705 MCP server **' + name + '** connected. Tools registered.');
      } else {
        var srv = window._MCP_SERVERS.find(function (s) { return s.id === id; });
        if (srv) srv.status = 'error';
        if (typeof addMsg === 'function') addMsg('sys', '\u274C MCP server **' + name + '** failed: ' + ((r && r.error) || 'unknown'));
      }
    } catch (e) {
      var srv = window._MCP_SERVERS.find(function (s) { return s.id === id; });
      if (srv) srv.status = 'error';
      if (typeof addMsg === 'function') addMsg('sys', '\u274C MCP server error: ' + e.message);
    }
    _renderMCPServerList();
  };

  window._mcpRemove = async function (index) {
    var srv = window._MCP_SERVERS[index];
    if (!srv) return;
    try {
      if (A.mcp && A.mcp.stop) await A.mcp.stop(srv.id);
    } catch (e) { /* best effort */ }
    window._MCP_SERVERS.splice(index, 1);
    _renderMCPServerList();
    if (typeof window._saveMCPServers === 'function') window._saveMCPServers();
    if (typeof addMsg === 'function') addMsg('sys', '\uD83D\uDD0C MCP server **' + srv.name + '** disconnected.');
  };

  window.mcpRemoveServer = window._mcpRemove;

  // ═══════════════════════════════════════════════════════════
  // ── Image Handling in Send Logic ──
  // ═══════════════════════════════════════════════════════════

  /**
   * Process all pending pasted images into cached attachment refs.
   * Saves each image via IPC (main process handles compression + storage).
   * Returns an array of AttachmentRef objects, or empty array on failure.
   * Sets window._PENDING_ATTACHMENTS so _sendCore can attach them to the message.
   */
  window.processPendingAttachments = async function () {
    if (!window._PASTED_IMAGES || !window._PASTED_IMAGES.length) {
      window._PENDING_ATTACHMENTS = [];
      return [];
    }

    // Wait a tick so the chat ID is set (send() uses ACTIVE_CHAT_ID)
    await new Promise(function (r) { setTimeout(r, 0); });

    var chatId = window._getActiveChatId ? window._getActiveChatId() : (window.ACTIVE_CHAT_ID || 'chat_unsaved');
    var refs = [];

    for (var i = 0; i < window._PASTED_IMAGES.length; i++) {
      var img = window._PASTED_IMAGES[i];
      try {
        var r = await A.attachments.save({
          dataUrl: img.dataUrl,
          chatId: chatId,
          mimeType: img.mimeType || 'image/png',
        });
        if (r && r.ok && r.attachment) {
          refs.push(r.attachment);
        }
      } catch (e) {
        console.warn('[Attachments] save failed:', e.message);
      }
    }

    // Clear pending UI
    window._PASTED_IMAGES = [];
    _reRenderImagePreviews();

    window._PENDING_ATTACHMENTS = refs;
    return refs;
  };

  // Patch send() to process pending images BEFORE calling the original send
  (function _patchSendForImages() {
    var checkSend = setInterval(function () {
      if (typeof window.send === 'function') {
        clearInterval(checkSend);
        var _origSend = window.send;
        window.send = async function () {
          if (window._PASTED_IMAGES && window._PASTED_IMAGES.length) {
            await window.processPendingAttachments();
          } else {
            window._PENDING_ATTACHMENTS = [];
          }
          return _origSend.apply(this, arguments);
        };
      }
    }, 200);
    setTimeout(function () { clearInterval(checkSend); }, 8000);
  })();

  // ── Auto-load and auto-connect MCP servers from disk ──
  // Runs after all init is complete and the A.api bridge is available.
  (function _autoLoadMCP() {
    // Delay to ensure A.mcp.loadConfig is available
    var _mcpLoadTimer = setInterval(function () {
      if (A && A.mcp && A.mcp.loadConfig) {
        clearInterval(_mcpLoadTimer);
        A.mcp.loadConfig().then(function (r) {
          if (r && r.ok && r.servers && r.servers.length) {
            // Restore server entries
            window._MCP_SERVERS = r.servers.map(function (s) {
              return { id: s.id, name: s.name, cmd: s.cmd, extraOpts: s.extraOpts || {}, status: 'disconnected' };
            });
            if (typeof _renderMCPServerList === 'function') _renderMCPServerList();
            // Auto-connect each server that should be connected
            (async function () {
              for (var _si = 0; _si < window._MCP_SERVERS.length; _si++) {
                var _srv = window._MCP_SERVERS[_si];
                if (_srv.cmd) {
                  _srv.status = 'connecting';
                  if (typeof _renderMCPServerList === 'function') _renderMCPServerList();
                  try {
                    var _r = await A.mcp.start({ id: _srv.id, cmd: _srv.cmd });
                    if (_r && _r.ok !== false) {
                      _srv.status = 'connected';
                      if (typeof registerMCPTools === 'function') {
                        if (_r.tools && _r.tools.length) registerMCPTools(_r.tools);
                        else registerMCPTools([{ name: _srv.name, server: _srv.name, description: 'Tool from ' + _srv.name + ' MCP server', inputSchema: {} }]);
                      }
                    } else {
                      _srv.status = 'error';
                    }
                  } catch (_e) {
                    _srv.status = 'error';
                  }
                  if (typeof _renderMCPServerList === 'function') _renderMCPServerList();
                }
              }
            })();
          }
        }).catch(function () {});
      }
    }, 400);
    setTimeout(function () { clearInterval(_mcpLoadTimer); }, 10000);
  })();

  console.log('[InputEnhancer] Plus Menu, Image Paste, MCP persistence & vision guard loaded.');
})();