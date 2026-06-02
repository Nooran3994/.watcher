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
  window._MCP_SERVERS = window._MCP_SERVERS || [];

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
    bubble.innerHTML = '<img src="' + dataUrl.replace(/"/g, '&quot;') + '" alt="Pasted image" />'
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
      bubble.innerHTML = '<img src="' + img.dataUrl.replace(/"/g, '&quot;') + '" alt="Pasted image" />'
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
    var input = document.getElementById('mcp-cmd-input');
    var cmd = input ? input.value.trim() : '';
    if (!cmd) {
      if (typeof addMsg === 'function') addMsg('sys', '\u26A0\uFE0F Enter a server command.');
      return;
    }
    var id = 'mcp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    var name = cmd.split(/\s+/).slice(0, 2).join(' ');
    window._MCP_SERVERS.push({ id: id, name: name, cmd: cmd, status: 'connecting' });
    _renderMCPServerList();
    if (input) input.value = '';
    if (typeof addMsg === 'function') addMsg('sys', '\uD83D\uDD0C Connecting MCP server: **' + name + '**...');

    try {
      var r = await (A.mcp && A.mcp.start ? A.mcp.start({ id: id, cmd: cmd })
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
    if (typeof addMsg === 'function') addMsg('sys', '\uD83D\uDD0C MCP server **' + srv.name + '** disconnected.');
  };

  window.mcpRemoveServer = window._mcpRemove;

  // ═══════════════════════════════════════════════════════════
  // ── Image Handling in Send Logic ──
  // ═══════════════════════════════════════════════════════════

  (function _patchSendForImages() {
    var checkSend = setInterval(function () {
      if (typeof window.send === 'function') {
        clearInterval(checkSend);
        var _origSend = window.send;
        window.send = function () {
          _injectImagesBeforeSend();
          return _origSend.apply(this, arguments);
        };
      }
    }, 200);
    setTimeout(function () { clearInterval(checkSend); }, 8000);
  })();

  function _injectImagesBeforeSend() {
    if (!window._PASTED_IMAGES || !window._PASTED_IMAGES.length) return;
    var ci = document.getElementById('ci');
    if (!ci) return;

    var numImages = window._PASTED_IMAGES.length;
    var modelCanSee = window._modelCanAnalyzeImages();

    var imageBlock = '\n\n---\n**Pasted Images (' + numImages + ')**\n';
    if (modelCanSee) {
      imageBlock += 'The following images were pasted. Analyze them directly:\n';
    } else {
      imageBlock += 'Note: The current model (' + (window.CONFIG.model || 'unknown') + ') may not support image analysis.\n';
      imageBlock += 'If analysis fails, switch to a vision-capable model (e.g., GPT-4o, Claude Sonnet, Gemini).\n';
    }
    imageBlock += '\n';
    window._PASTED_IMAGES.forEach(function (img, i) {
      imageBlock += 'Image ' + (i + 1) + ': ' + img.dataUrl + '\n';
    });
    imageBlock += '---\n';

    ci.value = ci.value + imageBlock;
    ci.dispatchEvent(new Event('input', { bubbles: true }));

    window._PASTED_IMAGES = [];
    _reRenderImagePreviews();
  }

  console.log('[InputEnhancer] Plus Menu, Image Paste & MCP bridge loaded.');
})();
