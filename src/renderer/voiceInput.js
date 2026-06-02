'use strict';

// ═══════════════════════════════════════════════════════════════
// ── SCAAI Voice Input + TTS Playback ──
// ═══════════════════════════════════════════════════════════════
// Depends on: window.scaai (A), window.CONFIG, window.addMsg
// Load after renderer.js and inputEnhancer.js
// ═══════════════════════════════════════════════════════════════

(function () {

  var A = window.scaai;
  var _mediaRecorder = null;
  var _audioChunks = [];
  var _isRecording = false;
  var _micStream = null;

  // ── State ──
  window._VOICE_STATE = { recording: false, transcribing: false };

  /**
   * Toggle microphone recording. Click once to start, again to stop + transcribe.
   */
  window.toggleMic = async function () {
    if (_isRecording) {
      return _stopRecording();
    }
    return _startRecording();
  };

  async function _startRecording() {
    // Gate: Groq key required
    if (!CONFIG || !CONFIG.groqKey) {
      if (typeof addMsg === 'function') addMsg('sys', '⚠️ Configure a **Groq API key** in Settings to use voice input.');
      return;
    }
    // Gate: provider check — voice only works with Groq keys
    if (CONFIG.provider !== 'groq' && !CONFIG.groqKey) {
      if (typeof addMsg === 'function') addMsg('sys', '⚠️ Voice input uses Groq Whisper. Set a Groq API key in Settings.');
      console.warn('[Voice] No Groq key available');
      return;
    }

    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream = stream;
      var mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      }
      _mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
      _audioChunks = [];

      _mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          _audioChunks.push(e.data);
        }
      };

      _mediaRecorder.onstop = function () {
        // Stop all tracks
        if (_micStream) {
          _micStream.getTracks().forEach(function (t) { t.stop(); });
          _micStream = null;
        }
        _isRecording = false;
        _updateMicUI(false);
        // Transcribe
        _transcribeAudio();
      };

      _mediaRecorder.start();
      _isRecording = true;
      window._VOICE_STATE.recording = true;
      _updateMicUI(true);
      console.log('[Voice] Recording started');
    } catch (e) {
      _isRecording = false;
      _updateMicUI(false);
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        if (typeof addMsg === 'function') addMsg('sys', '⚠️ Microphone permission denied. Allow microphone access in your system settings then try again.');
      } else {
        console.warn('[Voice] getUserMedia error:', e.message);
        if (typeof addMsg === 'function') addMsg('sys', '⚠️ Could not start microphone: ' + e.message);
      }
    }
  }

  function _stopRecording() {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
      _mediaRecorder.stop();
    }
    // isRecording flag will be cleared in onstop handler
  }

  function _updateMicUI(recording) {
    var btn = document.getElementById('mic-btn');
    if (!btn) return;
    if (recording) {
      btn.classList.add('recording');
      btn.title = 'Stop recording';
    } else {
      btn.classList.remove('recording');
      btn.title = CONFIG && CONFIG.voiceInputEnabled !== false ? 'Voice input' : 'Voice input (disabled in Settings)';
    }
  }

  async function _transcribeAudio() {
    if (!_audioChunks.length) return;
    window._VOICE_STATE.transcribing = true;
    _updateMicUI(false);

    var blob = new Blob(_audioChunks, { type: 'audio/webm' });
    _audioChunks = [];

    try {
      // Convert blob to base64
      var reader = new FileReader();
      var base64 = await new Promise(function (resolve, reject) {
        reader.onload = function () {
          // Remove data URL prefix: "data:audio/webm;base64,"
          var str = reader.result;
          var comma = str.indexOf(',');
          resolve(comma > -1 ? str.slice(comma + 1) : str);
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(blob);
      });

      var apiKey = CONFIG.groqKey || (CONFIG.groqKeys && CONFIG.groqKeys[0]) || '';
      if (!apiKey) {
        if (typeof addMsg === 'function') addMsg('sys', '⚠️ No Groq API key available for transcription.');
        window._VOICE_STATE.transcribing = false;
        return;
      }

      var result = await A.audio.transcribe({
        apiKey: apiKey,
        audioBase64: base64,
        mimeType: 'audio/webm'
      });

      window._VOICE_STATE.transcribing = false;

      if (result && result.ok && result.text) {
        _insertTranscript(result.text);
      } else {
        console.warn('[Voice] Transcription failed:', result && result.error);
        if (typeof addMsg === 'function') addMsg('sys', '⚠️ Transcription failed: ' + ((result && result.error) || 'unknown error'));
      }
    } catch (e) {
      window._VOICE_STATE.transcribing = false;
      console.warn('[Voice] Transcription error:', e.message);
      if (typeof addMsg === 'function') addMsg('sys', '⚠️ Transcription error: ' + e.message);
    }
  }

  function _insertTranscript(text) {
    var ci = document.getElementById('ci');
    if (!ci) return;
    // Insert at cursor or append
    var start = ci.selectionStart;
    var end = ci.selectionEnd;
    var prefix = ci.value.slice(0, start);
    var suffix = ci.value.slice(end);
    // Add space if needed
    var spacer = prefix.length > 0 && !/\s$/.test(prefix) ? ' ' : '';
    ci.value = prefix + spacer + text + suffix;
    ci.selectionStart = ci.selectionEnd = start + spacer.length + text.length;
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.focus();
  }

  // ── TTS: Speak an AI reply aloud ──
  var _lastAudioUrl = null;

  window._speakText = async function (text, voice) {
    if (!CONFIG || !CONFIG.groqKey) {
      console.warn('[TTS] No Groq key');
      return;
    }

    // Strip markdown and code blocks for speech
    var plain = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~#\[\]]/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

    // Truncate to voiceMaxChars
    var maxLen = (CONFIG.voiceMaxChars) || 200;
    if (plain.length > maxLen) {
      plain = plain.slice(0, maxLen - 1) + '…';
    }
    if (!plain) return;

    try {
      var apiKey = CONFIG.groqKey || (CONFIG.groqKeys && CONFIG.groqKeys[0]) || '';
      var result = await A.audio.speak({
        apiKey: apiKey,
        text: plain,
        voice: voice || CONFIG.voiceName || 'troy'
      });

      if (result && result.ok && result.audioBase64) {
        _playAudio(result.audioBase64, result.mimeType || 'audio/wav');
      } else {
        console.warn('[TTS] Speak failed:', result && result.error);
      }
    } catch (e) {
      console.warn('[TTS] Error:', e.message);
    }
  };

  function _playAudio(base64, mimeType) {
    // Stop any previous playback
    if (_lastAudioUrl) {
      URL.revokeObjectURL(_lastAudioUrl);
      _lastAudioUrl = null;
    }

    var binaryStr = atob(base64);
    var len = binaryStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    var blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
    var url = URL.createObjectURL(blob);
    _lastAudioUrl = url;

    var audio = new Audio(url);
    audio.onended = function () {
      URL.revokeObjectURL(url);
      if (_lastAudioUrl === url) _lastAudioUrl = null;
    };
    audio.play().catch(function (e) {
      console.warn('[TTS] Playback error:', e.message);
    });
  }

  // ── Init: wire mic gate on config change ──
  function _refreshMicState() {
    var btn = document.getElementById('mic-btn');
    if (!btn) return;
    var enabled = CONFIG && CONFIG.voiceInputEnabled !== false && (CONFIG.groqKey || (CONFIG.groqKeys && CONFIG.groqKeys.length));
    if (!enabled) {
      btn.title = 'Voice input — configure Groq API key in Settings';
    } else {
      btn.title = 'Voice input';
    }
  }

  // Watch for config changes — poll since CONFIG is mutated in-place
  setInterval(_refreshMicState, 3000);

  console.log('[VoiceInput] Mic + TTS module loaded.');
})();
