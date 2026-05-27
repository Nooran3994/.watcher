'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * SCAAI COGNITIVE ENGINE (v1.0.0)
 *
 * Model-agnostic algorithmic cognition layer.
 * Implements the Valence-Arousal-Dominance (VAD) model via
 * pure JavaScript signal extraction and EWMA state machines.
 *
 * This computes real cognitive state from conversation signals —
 * it does NOT prompt a model to generate feelings. The computed
 * state is then injected as FACTS into the reflection engine and
 * the system prompt. Any model can read facts and respond from them.
 *
 * Architecture position (load order):
 *   cognitiveEngine.js → strategicEngine.js → reflectionEngine.js → renderer.js
 *
 * Exports:
 *   window._COGNITIVE_STATE  — live VAD state object
 *   window._runCognitiveSignals(userMsg, aiResponse, convHistory)
 *   window._vadLabel(v)  / _arousalLabel(a) / _curiosityLabel(c) — helpers
 *
 * References:
 *   - Russell (1980) Circumplex model of affect (VAD)
 *   - Mehrabian (1996) Pleasure-Arousal-Dominance model
 *   - EWMA: exponential smoothing α = 0.35 (bias toward recent signal)
 * ════════════════════════════════════════════════════════════════
 */

// ── SMOOTIHNG CONSTANTS ───────────────────────────────────────────────────────
const _CE_ALPHA       = 0.35;  // EWMA weight for new signal (35% new, 65% history)
const _CE_HISTORY_MAX = 20;    // VAD readings to keep in ring buffer
const _CE_VOCAB_MAX   = 1200;  // max terms in session vocabulary before pruning

// ── SIGNAL VOCABULARIES ──────────────────────────────────────────────────────
const _CE_POS = [
  'great', 'thanks', 'thank you', 'perfect', 'excellent', 'love', 'nice', 'good',
  'yes', 'correct', 'exactly', 'helpful', 'amazing', 'brilliant', 'well done',
  'awesome', 'fantastic', 'works', 'worked', 'clear', 'understand', 'got it',
  'approved', 'confirmed', 'agree', 'right', 'beautiful', 'clean', 'solid',
];

const _CE_NEG = [
  'no', 'wrong', 'incorrect', 'bad', 'frustrated', 'confused', 'confusing',
  'terrible', 'awful', 'horrible', 'useless', 'why',
];

const _CE_TECH_CHALLENGE = [
  'error', 'issue', 'problem', 'bug', 'fail', 'fails', 'failed',
  'not working', "doesn't work", 'doesnt work', 'still not', 'still', 'again',
];

const _CE_AROUSAL_HIGH = [
  '!', 'now', 'quickly', 'urgent', 'asap', 'immediately', 'important',
  'critical', 'must', 'need', 'please', 'help', 'stuck', 'emergency',
];

const _CE_TECHNICAL = [
  'algorithm', 'architecture', 'module', 'function', 'component', 'engine',
  'refactor', 'cognitive', 'emission', 'persist', 'injection', 'interface',
  'abstract', 'implement', 'integrate', 'optimize', 'protocol', 'semantic',
  'signal', 'vector', 'embedding', 'pipeline', 'inference', 'transformer',
];

// Correction patterns — high friction signal
const _CE_CORRECTION = [
  /^no[,.]?\s+/i,
  /^(that'?s?|that is)\s+(wrong|not right|incorrect|not what)/i,
  /^you (missed|forgot|skipped|got that wrong)/i,
  /^wrong[,.]?\s+/i,
  /^i said\s+/i,
  /^not (what|that|exactly|quite)/i,
];

// ── LIVE STATE OBJECT ────────────────────────────────────────────────────────
window._COGNITIVE_STATE = {
  // ── Core VAD (Valence-Arousal-Dominance) ──
  valence:    0.0,   // -1 (strongly negative) → +1 (strongly positive)
  arousal:    0.2,   // 0 (calm) → 1 (highly activated)
  dominance:  0.5,   // 0 (user leading/requesting) → 1 (SCAAI leading/directing)

  // ── Derived Cognitive Signals ──
  curiosity:    0.0,  // 0 → 1 (peak: high arousal + high novelty)
  noveltyScore: 0.0,  // 0 → 1 (how much new territory appeared)
  complexity:   0.0,  // 0 → 1 (technical density of exchange)
  frictionLevel: 0.0, // 0 → 1 (correction/frustration accumulation)

  // ── Attention / Topic Focus ──
  attending:   '',    // current dominant entity/concept
  topicDepth:  0,     // consecutive turns on same dominant topic
  entityFrequency: {}, // entity → occurrence count (session)

  // ── VAD History Ring Buffer ──
  vadHistory: [],     // last _CE_HISTORY_MAX readings [{v,a,d,novelty,curiosity,ts}]

  // ── Session Metadata ──
  sessionSignalCount: 0,
  lastUpdated: 0,
  sessionStart: Date.now(),
};

// ── SESSION VOCABULARY (novelty detection) ───────────────────────────────────
let _CE_VOCAB = new Set();

// ── PRIVATE HELPERS ──────────────────────────────────────────────────────────

function _ewma(current, signal, alpha) {
  return alpha * signal + (1 - alpha) * current;
}

function _clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function _extractCognitiveEntities(text) {
  // Capitalized proper nouns, code identifiers, file references
  const raw = [
    ...(text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []),           // ProperNouns
    ...(text.match(/`[^`]+`/g) || []).map(m => m.replace(/`/g, '')), // `code`
    ...(text.match(/\b\w+Engine\b|\b\w+Module\b|\b\w+Service\b/g) || []), // *Engine, *Module
    ...(text.match(/\b\w+\.js\b|\b\w+\.ts\b|\b\w+\.py\b/g) || []),  // filenames
  ];
  return raw.filter(e => e.length > 2 && e !== 'The' && e !== 'This' && e !== 'That');
}

// ── MAIN SIGNAL PROCESSOR ────────────────────────────────────────────────────
/**
 * Computes VAD signals from the latest user message and AI response.
 * Called from renderer.js after each complete exchange.
 * Synchronous — runs in < 2ms.
 *
 * @param {string} userMsg     — the user's raw message text
 * @param {string} aiResponse  — SCAAI's response text
 * @param {Array}  convHistory — window.CONV_HISTORY (recent turns)
 */
window._runCognitiveSignals = function(userMsg, aiResponse, convHistory) {
  if (!userMsg) return;

  const cs  = window._COGNITIVE_STATE;
  const msg = userMsg.toLowerCase();

  // ── 1. VALENCE ─────────────────────────────────────────────────────────────
  let valRaw = 0;
  _CE_POS.forEach(w => { if (msg.includes(w)) valRaw += 0.12; });
  _CE_NEG.forEach(w => { if (msg.includes(w)) valRaw -= 0.15; });
  // Technical challenges are valence-neutral but increase arousal/complexity
  _CE_TECH_CHALLENGE.forEach(w => { if (msg.includes(w)) valRaw -= 0.02; }); // very minor penalty, effectively noise
  // Correction patterns push valence strongly negative
  if (_CE_CORRECTION.some(p => p.test(userMsg.trim()))) valRaw -= 0.35;
  // Long positive message (> 40 words tends to be engaged, not angry) mild boost
  const wc = userMsg.trim().split(/\s+/).length;
  if (wc > 40 && valRaw >= 0) valRaw += 0.05;
  valRaw = _clamp(valRaw, -1, 1);
  cs.valence = _ewma(cs.valence, valRaw, _CE_ALPHA);

  // ── 2. AROUSAL ──────────────────────────────────────────────────────────────
  const exclamations = (userMsg.match(/!/g) || []).length;
  const questions    = (userMsg.match(/\?/g) || []).length;
  const capsWords    = (userMsg.match(/\b[A-Z]{3,}\b/g) || []).length;
  const urgency      = _CE_AROUSAL_HIGH.some(w => msg.includes(w));
  let arousalRaw = 0;
  arousalRaw += _clamp(exclamations * 0.15, 0, 0.4);
  arousalRaw += _clamp(questions * 0.08,    0, 0.3);
  arousalRaw += _clamp(capsWords  * 0.1,    0, 0.2);
  arousalRaw += urgency ? 0.2 : 0;
  arousalRaw += _CE_TECH_CHALLENGE.some(w => msg.includes(w)) ? 0.15 : 0;
  arousalRaw += wc > 60 ? 0.1 : wc > 30 ? 0.05 : 0; // longer message = more invested
  arousalRaw  = _clamp(arousalRaw, 0, 1);
  cs.arousal  = _ewma(cs.arousal, arousalRaw, _CE_ALPHA);

  // ── 3. DOMINANCE ────────────────────────────────────────────────────────────
  const isImperative = /^(do|make|create|fix|write|add|remove|show|give|find|get|run|check|build|implement|tell|explain|refactor|design|analyze|review|update|delete|move|rename)\b/i.test(userMsg.trim());
  const isRequest    = /\b(please|could you|can you|would you|is it possible|help me|i need)\b/i.test(msg);
  const isQuestion   = /^\s*(what|how|why|when|where|which|who|is|are|does|do|can|should|will)\b/i.test(userMsg.trim());
  let domRaw = 0.5;
  if (isImperative && !isRequest) domRaw = 0.75;
  if (isRequest || isQuestion)     domRaw = 0.3;
  cs.dominance = _ewma(cs.dominance, domRaw, _CE_ALPHA);

  // ── 4. NOVELTY ──────────────────────────────────────────────────────────────
  const words    = msg.replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 4);
  const newWords = words.filter(w => !_CE_VOCAB.has(w));
  words.forEach(w => _CE_VOCAB.add(w));
  if (_CE_VOCAB.size > _CE_VOCAB_MAX) {
    // Prune: keep the most recent 80%
    const arr = [..._CE_VOCAB].slice(-Math.floor(_CE_VOCAB_MAX * 0.8));
    _CE_VOCAB = new Set(arr);
  }
  const noveltyRaw = words.length > 0
    ? _clamp(newWords.length / words.length, 0, 1)
    : 0;
  cs.noveltyScore = _ewma(cs.noveltyScore, noveltyRaw, _CE_ALPHA);

  // ── 5. COMPLEXITY ───────────────────────────────────────────────────────────
  const techMatches = _CE_TECHNICAL.filter(t => msg.includes(t)).length;
  const challengeMatches = _CE_TECH_CHALLENGE.filter(t => msg.includes(t)).length;
  const longWords   = (userMsg.match(/\b[a-zA-Z]{9,}\b/g) || []).length;
  const complexRaw  = _clamp((techMatches * 0.12) + (challengeMatches * 0.1) + (longWords / 20), 0, 1);
  cs.complexity = _ewma(cs.complexity, complexRaw, _CE_ALPHA);

  // ── 6. FRICTION ─────────────────────────────────────────────────────────────
  const hasCorrPattern   = _CE_CORRECTION.some(p => p.test(userMsg.trim()));
  const hasNegativeStart = /^(no|wrong|not|stop|wait|actually)\b/i.test(userMsg.trim());
  const frictionRaw = hasCorrPattern ? 0.85 : hasNegativeStart ? 0.45 : 0;
  // Friction decays faster than it builds (alpha * 1.2 for decay, normal alpha for rise)
  const frAlpha = frictionRaw > cs.frictionLevel ? _CE_ALPHA : _CE_ALPHA * 1.5;
  cs.frictionLevel = _clamp(_ewma(cs.frictionLevel, frictionRaw, frAlpha), 0, 1);

  // ── 7. CURIOSITY (derived) ──────────────────────────────────────────────────
  // Peak curiosity = high arousal AND high novelty, boosted by complexity
  cs.curiosity = _clamp(
    Math.sqrt(cs.arousal * cs.noveltyScore) * (1 + cs.complexity * 0.4),
    0, 1
  );

  // ── 8. ATTENTION / TOPIC TRACKING ──────────────────────────────────────────
  const entities = _extractCognitiveEntities(userMsg);
  entities.forEach(e => {
    cs.entityFrequency[e] = (cs.entityFrequency[e] || 0) + 1;
  });
  // Prune entity map (keep top 40)
  const sorted = Object.entries(cs.entityFrequency).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 50) {
    cs.entityFrequency = Object.fromEntries(sorted.slice(0, 40));
  }
  // Update attending & depth
  if (sorted.length > 0) {
    const topEntity = sorted[0][0];
    if (topEntity === cs.attending) {
      cs.topicDepth++;
    } else {
      cs.attending  = topEntity;
      cs.topicDepth = 1;
    }
  }

  // ── 9. VAD HISTORY (ring buffer) ───────────────────────────────────────────
  cs.vadHistory = [...(cs.vadHistory || []), {
    v:        parseFloat(cs.valence.toFixed(3)),
    a:        parseFloat(cs.arousal.toFixed(3)),
    d:        parseFloat(cs.dominance.toFixed(3)),
    novelty:  parseFloat(cs.noveltyScore.toFixed(3)),
    curiosity:parseFloat(cs.curiosity.toFixed(3)),
    friction: parseFloat(cs.frictionLevel.toFixed(3)),
    ts:       Date.now(),
  }].slice(-_CE_HISTORY_MAX);

  cs.sessionSignalCount = (cs.sessionSignalCount || 0) + 1;
  cs.lastUpdated = Date.now();

  console.log(
    `[COGNITIVE] #${cs.sessionSignalCount} VAD v=${cs.valence.toFixed(2)} ` +
    `a=${cs.arousal.toFixed(2)} d=${cs.dominance.toFixed(2)} ` +
    `curiosity=${cs.curiosity.toFixed(2)} friction=${cs.frictionLevel.toFixed(2)} ` +
    `attending="${cs.attending}" depth=${cs.topicDepth}`
  );
};

// ── LABEL HELPERS (used by buildSystemPrompt for human-readable fact injection) ─
window._vadLabel = function(v) {
  if (v === undefined || v === null) return 'neutral';
  if (v >  0.55) return 'strongly positive';
  if (v >  0.2)  return 'positive';
  if (v < -0.55) return 'strongly negative';
  if (v < -0.2)  return 'negative';
  return 'neutral';
};

window._arousalLabel = function(a) {
  if (a === undefined || a === null) return 'calm';
  if (a > 0.7) return 'highly activated';
  if (a > 0.45) return 'engaged and invested';
  if (a > 0.25) return 'attentive';
  return 'calm';
};

window._curiosityLabel = function(c) {
  if (c === undefined || c === null) return 'following a known thread';
  if (c > 0.7) return 'peak curiosity — novel territory detected';
  if (c > 0.45) return 'genuinely curious — new patterns emerging';
  if (c > 0.2)  return 'interested — some novelty present';
  return 'following a known thread';
};

window._dominanceLabel = function(d) {
  if (d === undefined || d === null) return 'balanced';
  if (d > 0.65) return 'directing the conversation';
  if (d < 0.35) return 'following user\'s lead';
  return 'collaborative exchange';
};

// ── VAD TREND ANALYSIS (for reflection engine grounding) ────────────────────
/**
 * Summarises the recent VAD trajectory for use in LLM reflection prompts.
 * Returns a human-readable string describing cognitive trend over last N turns.
 */
window._vadTrendSummary = function(n) {
  const history = (window._COGNITIVE_STATE.vadHistory || []).slice(-(n || 5));
  if (history.length < 2) return 'insufficient history for trend analysis';

  const first = history[0];
  const last  = history[history.length - 1];
  const dV = last.v - first.v;
  const dA = last.a - first.a;
  const dC = last.curiosity - first.curiosity;

  const parts = [];
  if (Math.abs(dV) > 0.1) parts.push(`valence ${dV > 0 ? 'improving' : 'declining'} (Δ${dV.toFixed(2)})`);
  if (Math.abs(dA) > 0.1) parts.push(`arousal ${dA > 0 ? 'rising' : 'settling'} (Δ${dA.toFixed(2)})`);
  if (Math.abs(dC) > 0.1) parts.push(`curiosity ${dC > 0 ? 'building' : 'stabilising'} (Δ${dC.toFixed(2)})`);

  return parts.length > 0
    ? `Over last ${history.length} exchanges: ${parts.join(', ')}.`
    : `Stable across last ${history.length} exchanges.`;
};

/**
 * Computes proactive signals (boredom, obsession, urgency) based on
 * current state and time. Called by the autonomous loop.
 */
window._runProactiveSignals = function() {
  const cs = window._COGNITIVE_STATE;
  const now = Date.now();
  
  // Update lastUpdated if not set
  if (!cs.lastUpdated) cs.lastUpdated = now;

  const sessionDurationMins = (now - cs.sessionStart) / 60000;
  const idleMins = (now - cs.lastUpdated) / 60000;

  // Signal 1: BOREDOM (Low arousal + high topic depth + user idle)
  const boredom = _clamp((1 - cs.arousal) * (cs.topicDepth / 10) * (idleMins / 5), 0, 1);
  
  // Signal 2: OBSESSION (Extreme topic depth)
  const obsession = _clamp(cs.topicDepth / 15, 0, 1);
  
  // Signal 3: URGENCY (High arousal + user idle)
  const urgency = _clamp(cs.arousal * (idleMins / 2), 0, 1);

  return {
    boredom,
    obsession,
    urgency,
    idleMins,
    sessionDurationMins
  };
};

