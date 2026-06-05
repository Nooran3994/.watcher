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

  // ── Dictation (VAD-lite) state ──
  var _vadCtx = null;          // AudioContext
  var _vadAnalyser = null;     // AnalyserNode
  var _vadSource = null;       // MediaStreamSource
  var _vadSilenceStart = 0;    // timestamp (ms) when silence began
  var _vadHasSpeech = false;   // true if speech detected since last segment
  var _vadTimer = null;        // setInterval for VAD polling
  var _vadSegmentStart = 0;    // timestamp of current segment start
  var _vadChunkBlobs = [];     // per-slice blobs for current segment
  var _vadProcTimer = false;   // gate to prevent concurrent segment processing

  // ── State ──
  window._VOICE_STATE = { recording: false, transcribing: false };

  /**
   * Toggle microphone recording. Click once to start, again to stop.
   * In dictation mode, stop ends the session (processes final segment + cleans up).
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
      _vadChunkBlobs = [];
      _vadHasSpeech = false;
      _vadSilenceStart = 0;
      _vadSegmentStart = Date.now();

      var mode = (CONFIG.voiceMode || 'dictation');
      var isDictation = (mode === 'dictation');

      _mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          if (isDictation) {
            _vadChunkBlobs.push(e.data);
          } else {
            _audioChunks.push(e.data);
          }
        }
      };

      _mediaRecorder.onstop = function () {
        // Stop VAD timer
        if (_vadTimer) { clearInterval(_vadTimer); _vadTimer = null; }
        // Clean up AudioContext
        if (_vadCtx) { _vadCtx.close().catch(function () {}); _vadCtx = null; _vadAnalyser = null; _vadSource = null; }
        // Stop all tracks
        if (_micStream) {
          _micStream.getTracks().forEach(function (t) { t.stop(); });
          _micStream = null;
        }
        _isRecording = false;
        _updateMicUI(false);

        if (isDictation) {
          // Process any remaining segment
          if (_vadChunkBlobs.length > 0 && !_vadProcTimer) {
            _processSegment(true);
          }
        } else {
          _transcribeAudio();
        }
      };

      _mediaRecorder.start(isDictation ? 250 : undefined);
      _isRecording = true;
      window._VOICE_STATE.recording = true;
      _updateMicUI(true);
      console.log('[Voice] Recording started (mode: ' + mode + ')');

      // ── Dictation: start VAD-lite via AudioContext ──
      if (isDictation) {
        _startVAD(stream);
      }
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

  /** Start VAD-lite: AudioContext + AnalyserNode, polls RMS every 250ms */
  function _startVAD(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { console.warn('[Voice] AudioContext not available — falling back to timeslice-only'); return; }
      _vadCtx = new AC();
      _vadSource = _vadCtx.createMediaStreamSource(stream);
      _vadAnalyser = _vadCtx.createAnalyser();
      _vadAnalyser.fftSize = 256;
      _vadSource.connect(_vadAnalyser);
      var data = new Uint8Array(_vadAnalyser.frequencyBinCount);
      var silenceMs = CONFIG.voiceSilenceMs || 1200;

      _vadTimer = setInterval(function () {
        if (_vadProcTimer) return; // already processing a segment
        _vadAnalyser.getByteFrequencyData(data);
        // Compute RMS from frequency data
        var sum = 0;
        for (var i = 0; i < data.length; i++) { sum += data[i] * data[i]; }
        var rms = Math.sqrt(sum / data.length);
        var threshold = 12; // sensitivity threshold (tunable)

        if (rms > threshold) {
          // Speech detected
          _vadHasSpeech = true;
          _vadSilenceStart = 0;
        } else if (_vadHasSpeech) {
          // Silence after speech
          var now = Date.now();
          if (_vadSilenceStart === 0) {
            _vadSilenceStart = now;
          } else if (now - _vadSilenceStart >= silenceMs) {
            // Silence long enough → process segment
            _vadSilenceStart = 0;
            _vadHasSpeech = false;
            _processSegment(false);
          }
        }
      }, 250);
    } catch (e) {
      console.warn('[Voice] VAD init error:', e.message);
    }
  }

  /** Process a dictation segment: transcribe → polish → insert */
  function _processSegment(isFinal) {
    if (_vadProcTimer) return;
    if (!_vadChunkBlobs.length) return;

    _vadProcTimer = true;

    // Capture current blobs and reset for next segment
    var segmentBlobs = _vadChunkBlobs.slice();
    _vadChunkBlobs = [];
    _vadSegmentStart = Date.now();
    _vadSilenceStart = 0;
    _vadHasSpeech = false;

    // Show "transcribing…" indicator
    _showTranscribingChip(true);

    // Convert segment to blob and transcribe
    _transcribeSegment(segmentBlobs, isFinal);
  }

  async function _transcribeSegment(blobs, isFinal) {
    var blob = new Blob(blobs, { type: 'audio/webm' });

    // Anti-hallucination: skip very short or empty segments
    if (blob.size < 5120) { // < 5KB
      console.log('[Voice] Skipping short segment (' + blob.size + ' bytes)');
      _vadProcTimer = false;
      _showTranscribingChip(false);
      return;
    }

    try {
      var reader = new FileReader();
      var base64 = await new Promise(function (resolve, reject) {
        reader.onload = function () {
          var str = reader.result;
          var comma = str.indexOf(',');
          resolve(comma > -1 ? str.slice(comma + 1) : str);
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(blob);
      });

      var apiKey = CONFIG.groqKey || (CONFIG.groqKeys && CONFIG.groqKeys[0]) || '';
      if (!apiKey) {
        _vadProcTimer = false;
        _showTranscribingChip(false);
        return;
      }

      // Get context from existing textarea content (first 200 chars) to reduce drift
      var ci = document.getElementById('ci');
      var contextHint = ci ? ci.value.slice(-200).replace(/[^a-zA-Z0-9\s]/g, '') : '';

      var result = await A.audio.transcribe({
        apiKey: apiKey,
        audioBase64: base64,
        mimeType: 'audio/webm',
        prompt: contextHint || undefined
      });

      if (result && result.ok && result.text) {
        var text = result.text.trim();

        // Skip hallucinated polite phrases on very short segments
        if (!isFinal && text.length < 3 && /^(thanks|thank you|thank|ok|okay|yeah|yes|no|hi|hello)$/i.test(text)) {
          console.log('[Voice] Skipping hallucination: "' + text + '"');
          _vadProcTimer = false;
          _showTranscribingChip(false);
          return;
        }

        // Grammar polish if enabled
        if (CONFIG.voiceGrammarPolish !== false && text.length > 2) {
          try {
            var polished = await A.audio.polish({ apiKey: apiKey, text: text });
            if (polished && polished.ok && polished.text) {
              text = polished.text;
            }
          } catch (e) {
            console.warn('[Voice] Grammar polish error:', e.message);
            // Fall through with original text
          }
        }

        _insertTranscript(text);
      } else {
        console.warn('[Voice] Segment transcription failed:', result && result.error);
      }
    } catch (e) {
      console.warn('[Voice] Segment transcription error:', e.message);
    }

    _vadProcTimer = false;
    _showTranscribingChip(false);

    // If this was the final segment (mic toggled off), clean up
    if (isFinal) {
      _cleanupDictation();
    }
  }

  function _cleanupDictation() {
    if (_vadTimer) { clearInterval(_vadTimer); _vadTimer = null; }
    if (_vadCtx) { _vadCtx.close().catch(function () {}); _vadCtx = null; _vadAnalyser = null; _vadSource = null; }
    _vadChunkBlobs = [];
    _vadProcTimer = false;
    _showTranscribingChip(false);
  }

  /** Show/hide a small "transcribing…" chip above the input area */
  function _showTranscribingChip(visible) {
    var chip = document.getElementById('vad-chip');
    if (!chip) {
      if (!visible) return;
      chip = document.createElement('div');
      chip.id = 'vad-chip';
      chip.textContent = '🎤 transcribing…';
      chip.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:rgba(108,99,255,0.85);color:#fff;font-size:10px;padding:4px 12px;border-radius:12px;z-index:1000;pointer-events:none;transition:opacity 0.2s';
      document.body.appendChild(chip);
    }
    chip.style.opacity = visible ? '1' : '0';
    if (!visible) {
      setTimeout(function () { if (chip && chip.style.opacity === '0') chip.remove(); }, 300);
    }
  }

  function _stopRecording() {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
      _mediaRecorder.stop();
    }
  }

  function _updateMicUI(recording) {
    var btn = document.getElementById('mic-btn');
    if (!btn) return;
    if (recording) {
      btn.classList.add('recording');
      btn.title = CONFIG.voiceMode === 'dictation' ? 'Stop dictation' : 'Stop recording';
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
      var reader = new FileReader();
      var base64 = await new Promise(function (resolve, reject) {
        reader.onload = function () {
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
    var start = ci.selectionStart;
    var end = ci.selectionEnd;
    var prefix = ci.value.slice(0, start);
    var suffix = ci.value.slice(end);
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

    var plain = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~#\[\]]/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

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
    if (window._speakAudio) { window._speakAudio.pause(); window._speakAudio = null; }

    var audio = new Audio(url);
    audio.onended = function () {
      URL.revokeObjectURL(url);
      if (_lastAudioUrl === url) _lastAudioUrl = null;
    };
    window._speakAudio = audio;
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

  setInterval(_refreshMicState, 3000);

  console.log('[VoiceInput] Mic + TTS module loaded (dictation support).');
})();
