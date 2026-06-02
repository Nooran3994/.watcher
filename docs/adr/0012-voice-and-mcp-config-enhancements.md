# ADR-0012: Voice Input/Output and MCP Config Ergonomics

**Status:** Accepted · **Date:** 2026-06-02

## Context

SCAAI needed two focused UX improvements and one new capability:

1. **Image lightbox** — markdown images already expanded to full-size lightbox, but attachment thumbnails and paste previews had no click handler. Users couldn't view pasted images at full size.

2. **MCP JSON config** — the parser only accepted flat `{ command, args }` objects. Users pasting Cursor-style configs with `mcpServers` wrapper or URL-only remote servers got cryptic "missing command" errors. Environment variables (`env`) in parsed config were ignored at spawn time.

3. **Voice input/output** — the mic button existed but was labeled "Coming soon" with no handler. SCAAI already had a Groq API key configured for chat; that same key could drive Whisper STT (speech-to-text) and Orpheus TTS (text-to-speech).

## Decision

### 1. Image Lightbox
Wire `expandImage()` — already defined for markdown-rendered images — to all image surfaces:
- Attachment thumbnails in user messages (`addMsg`)
- AI-rendered images (`renderImageMessage`)
- Paste preview bubbles before send (`inputEnhancer.js`)
- Add Escape key listener and `role="dialog"` / `aria-label` for accessibility

### 2. MCP Config Parser
Extend `_parseMCPJson` to handle three input shapes:

| Input shape | Behavior |
|---|---|
| `{ command, args, env?, cwd? }` | Keep existing parse |
| `{ mcpServers: { name: { command, args, env? } } }` | Unwrap first server entry |
| `{ url: "https://..." }` | Return error with Context7 stdio hint |

Pass `env` from parsed config through to `mcp:start` IPC handler, merging into `process.env` at spawn time.

**Deliberately scoped:** True HTTP/SSE remote MCP transport is not implemented. URL-only configs get a clear conversion hint rather than a generic parse error.

### 3. Groq Audio (Whisper STT + Orpheus TTS)

**Architecture:**
- **Main process** (`main.js`): two new IPC handlers + `httpsPostMultipart` helper for binary multipart upload
  - `audio:transcribe` — receives base64 audio → sends to Groq Whisper → returns transcript text
  - `audio:speak` — receives text → sends to Groq Orpheus TTS → returns WAV as base64 (raw buffer collection preserves binary integrity)
- **Preload** (`preload.js`): `A.audio.transcribe` / `A.audio.speak` bridge
- **Renderer** (`voiceInput.js`): mic toggle with `MediaRecorder` → blob → base64 → IPC → insert transcript at cursor
- **TTS hook** in `addMsg`: when `CONFIG.voiceReplyEnabled === true`, calls `_speakText` after non-system AI messages
- **Settings UI**: checkbox toggles (voice input + speak replies), voice selector, max chars slider

**Constraints:**
- Groq-only in v1 (Whisper and Orpheus models)
- TTS limited to 200 chars (configurable) to avoid Orpheus input limits
- Audio blobs remain in renderer memory (no disk persistence)
- Mic gated on Groq key presence

## Consequences

### Positive
- Users can view any chat image at full size via click + Escape close
- Context7 and Cursor-style `mcpServers` JSON paste produces clear errors or works directly
- MCP server env vars (e.g. API keys) pass through to spawned process
- Voice input works with existing Groq key; no additional signup
- Settings UI keeps voice config alongside other system preferences

### Negative
- Remote URL-only MCP (SSE transport) still won't connect — explicit error with conversion hint
- MCP process "connected" check is still liveness-only (no real JSON-RPC handshake)
- TTS WAV playback on Windows depends on HTML5 Audio support (tested OK)
- Long replies (>200 chars) are silently truncated for TTS

### Future Work
- Implement full HTTP/SSE MCP client for remote servers
- Real MCP JSON-RPC tool calls over stdio (today: process-alive check only)
- Streaming TTS for long replies (concatenate Orpheus segments)
- Provider-agnostic audio (switch between Groq, OpenAI, ElevenLabs)
