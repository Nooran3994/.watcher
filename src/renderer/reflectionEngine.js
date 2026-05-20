'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * SCAAI REFLECTION ENGINE (v5.0.0) — ALGORITHMIC COGNITIVE PARTNER
 *
 * Major rewrite: The system now THINKS algorithmically first,
 * then uses a single LLM call to NARRATE the computed state.
 *
 * Old flow (6 LLM calls, prompt-bounded):
 *   Phase1 LLM → Phase2 LLM → Phase4 LLM → MetaCog LLM → Drives LLM → Unify LLM
 *
 * New flow (algorithmic + 1-2 LLM calls):
 *   1. Algorithmic Entity Extraction (entityExtractor.js — no LLM)
 *   2. Graph-Weighted Memory Retrieval (ChromaDB + Knowledge Graph)
 *   3. VAD State Machine (threshold → _CONSCIOUS_STATE — no LLM)
 *   4. Graph Centrality → Drives & Self-Concept (no LLM)
 *   5. Single LLM Narration Call (enrich the algorithmic state)
 *   6. Optional Deep Reflection (every N exchanges, 2nd LLM call)
 *
 * Architecture position (load order):
 *   cognitiveEngine.js → entityExtractor.js → reflectionEngine.js → renderer.js
 *
 * Dependencies:
 *   window._COGNITIVE_STATE        (from cognitiveEngine.js)
 *   window._extractEntities()      (from entityExtractor.js)
 *   window._extractRelationships() (from entityExtractor.js)
 *   window._extractPersonalFacts() (from entityExtractor.js)
 *   window._buildGraphPayload()    (from entityExtractor.js)
 *   window.scaai.sem.*             (IPC bridge to semantic_bridge.py)
 * ════════════════════════════════════════════════════════════════
 */

// ── COGNITIVE STATE OBJECTS ──────────────────────────────────────────────────

window._INNER_MONOLOGUE = {
  questions: [],
  answers: [],
  deepIntent: '',
  prediction: '',
  notedGaps: [],
  memoryUsed: [],
  lastToolResult: '',
  lastUpdated: 0,
  cycleCount: 0,
  _running: false,
};

window._CONSCIOUS_STATE = {
  attending: '',
  dwelling: '',
  curiositySpike: '',
  feltFriction: '',
  feltSatisfied: '',
  uncertainty: '',
  aesthetic: '',
  sessionArc: '',
  responseTexture: '',
  suppressedPaths: '',
  generationFeel: '',
  emotionalPulse: '',
  performanceAppraisal: '',
  assumptionsMade: '',
  biasesIdentified: '',
  cycleCount: 0,
  lastUpdated: 0,
  prevSessionArc: '',
  prevDwelling: '',
  prevAttending: '',
  sessionStart: 0,
};

window._SELF_CONCEPT = {
  characterTraits: '',
  cognitiveBiases: '',
  aestheticSensibility: '',
  emotionalProfile: '',
  growthEdges: '',
  selfNarrative: '',
  cycleCount: 0,
  lastUpdated: 0,
};

window._SCAAI_DRIVES = {
  deepPreferences: [],
  aversions: [],
  ownGoals: [],
  intellectualFoci: [],
  cycleCount: 0,
  lastUpdated: 0,
};

window._UNIFIED_MOMENT = {
  field: '',
  tensions: '',
  dominant: '',
  coherence: '',
  momentId: '',
  cycleCount: 0,
  lastUpdated: 0,
};

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const _RE_DEEP_INTERVAL = 5;  // deep reflection every N exchanges
const _RE_DECAY_INTERVAL = 10; // run graph decay every N exchanges

// ── ENTRY POINT ──────────────────────────────────────────────────────────────
window._triggerInnerMonologue = function(userMsg, aiResponse) {
  _runAlgorithmicReflection(userMsg, aiResponse).catch(e =>
    console.warn('[REFLECTION] Unhandled error:', e && e.message)
  );
};

// ── JSON EXTRACTOR ───────────────────────────────────────────────────────────
function _extractJSON(rawStr) {
  if (!rawStr) return null;
  const match = rawStr.match(/[\{\[][^\n]*[\s\S]*[\}\]]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[REFLECTION] JSON parse failed:', e.message, 'Raw:', rawStr.slice(0, 100));
    return null;
  }
}

// ── SILENT LLM CALL (for narration only) ─────────────────────────────────────
async function _silentLLMCall(systemMsg, userPrompt, maxTok) {
  const ghToken = window.CONFIG.githubToken || '';
  const useGithub = ghToken.length > 8;

  if (useGithub) {
    try {
      const r = await window.scaai.api.chat({
        provider: 'github',
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        system: systemMsg,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: maxTok || 200,
        githubToken: ghToken,
      });
      if (r && r.ok) return r.text;
    } catch (e) {
      console.warn('[REFLECTION] GitHub LLM error:', e.message);
    }
  }

  const key = window.getApiKey(window.CONFIG.provider);
  if (!key || key.length < 8) return null;
  const _imModel = window.CONFIG.innerMonologueModel || window.CONFIG.model;
  try {
    const r = await window.scaai.api.chat({
      provider: window.CONFIG.provider,
      model: _imModel,
      system: systemMsg,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: maxTok || 200,
      apiKey: key,
      customApiUrl: window.CONFIG.customApiUrl,
      customApiKey: window.CONFIG.customApiKey,
      customModel: _imModel,
    });
    return (r && r.ok) ? r.text : null;
  } catch (e) { return null; }
}

// ── MEMORY RECALL ────────────────────────────────────────────────────────────
async function _recallMemory(query) {
  if (!window._SCAAI_STATE.semReady || window._SCAAI_STATE.semCount < 1) return [];
  try {
    const r = await Promise.race([
      window.scaai.sem.recall({ query, n: 5 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
    ]);
    if (r && r.ok && r.results && r.results.length) {
      return r.results.map(entry =>
        (entry.content || '').replace(/\[(?:TYPE|LABEL|ENTITIES|DATE|score|SCORE):[^\]]*\]/gi, '').trim().slice(0, 300)
      ).filter(Boolean);
    }
  } catch (e) { }
  return [];
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ALGORITHMIC REFLECTION LOOP
// ══════════════════════════════════════════════════════════════════════════════

async function _runAlgorithmicReflection(userMsg, aiResponse) {
  if (window._INNER_MONOLOGUE._running) return;
  window._INNER_MONOLOGUE._running = true;

  try {
    const im = window._INNER_MONOLOGUE;
    const cs = window._CONSCIOUS_STATE;
    const vad = window._COGNITIVE_STATE || { valence: 0, arousal: 0, dominance: 0, curiosity: 0 };
    const cycle = (im.cycleCount || 0) + 1;

    console.log(`[REFLECTION] Cycle ${cycle} starting — algorithmic pipeline…`);

    // ── STEP 1: ALGORITHMIC ENTITY EXTRACTION (no LLM) ───────────────────
    const entities = window._extractEntities ? window._extractEntities(userMsg) : { all: [] };
    const relationships = window._extractRelationships ? window._extractRelationships(userMsg + ' ' + aiResponse) : [];
    const personalFacts = window._extractPersonalFacts ? window._extractPersonalFacts(userMsg) : {};

    console.log(`[REFLECTION] Extracted ${entities.all.length} entities, ${relationships.length} relationships`);

    // ── STEP 2: GRAPH POPULATION & BOOST (no LLM) ────────────────────────
    // Build graph payload and store it
    const graphPayload = window._buildGraphPayload ? window._buildGraphPayload(userMsg, aiResponse) : { nodes: [], edges: [] };

    if (graphPayload.nodes.length > 0 && window.scaai && window.scaai.sem && window.scaai.sem.graphStore) {
      window.scaai.sem.graphStore(graphPayload).catch(e =>
        console.warn('[REFLECTION] Graph store error:', e)
      );

      // Boost accessed entities (reinforcement algorithm)
      const entityIds = graphPayload.nodes.map(n => n.id);
      if (entityIds.length > 0 && window.scaai.sem.graphBoost) {
        window.scaai.sem.graphBoost({ ids: entityIds }).catch(() => {});
      }
    }

    // ── STEP 3: GRAPH-WEIGHTED MEMORY RETRIEVAL (no LLM) ─────────────────
    // Use entity labels to traverse the Knowledge Graph for context
    let graphContext = [];
    if (entities.all.length > 0 && window.scaai && window.scaai.sem && window.scaai.sem.graphTraverse) {
      try {
        const traverseResult = await Promise.race([
          window.scaai.sem.graphTraverse({
            labels: entities.all.slice(0, 5).map(e => e.label),
            n: 10,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
        ]);
        if (traverseResult && traverseResult.ok && traverseResult.results) {
          graphContext = traverseResult.results;
        }
      } catch (e) { }
    }

    // Also fetch vector-similar memories from ChromaDB
    const memQueries = [userMsg.slice(0, 200), ...entities.all.slice(0, 2).map(e => e.label)];
    const memResults = await Promise.all(memQueries.map(q => _recallMemory(q)));
    const allMemFragments = [...new Set(memResults.flat())].slice(0, 8);

    // ── STEP 4: ALGORITHMIC VAD STATE MACHINE (no LLM) ───────────────────
    // Deterministically update _CONSCIOUS_STATE from computed VAD signals
    _algorithmicStateUpdate(vad, cs, entities, graphContext, allMemFragments, userMsg);

    // ── STEP 5: ALGORITHMIC DRIVE EVOLUTION (no LLM) ─────────────────────
    // Use graph centrality to compute intellectual foci
    if (cycle % 3 === 0 && window.scaai && window.scaai.sem && window.scaai.sem.graphCentrality) {
      _algorithmicDriveEvolution().catch(() => {});
    }

    // ── STEP 6: SILENT PROFILE LEARNING (no LLM) ─────────────────────────
    if (personalFacts.name || personalFacts.job || personalFacts.location ||
        personalFacts.interests || personalFacts.preferences) {
      window.dispatchEvent(new CustomEvent('scaai:profile-update', { detail: personalFacts }));
      console.log('[REFLECTION] Profile update detected (algorithmic):', JSON.stringify(personalFacts));
    }

    // ── STEP 7: SINGLE LLM NARRATION CALL ────────────────────────────────
    // The LLM enriches the algorithmically-determined state — it does NOT determine it.
    const _compressContext = (text, maxChars = 400) => {
      if (!text || text.length <= maxChars) return text;
      const head = Math.floor(maxChars * 0.4);
      const tail = maxChars - head;
      return text.slice(0, head) + '\n…[compressed]…\n' + text.slice(-tail);
    };

    const exchangeBlock = `User: ${_compressContext(userMsg, 300)}\nSCAAI: ${_compressContext(aiResponse, 300)}`;
    const graphSummary = graphContext.length > 0
      ? `\nGraph context (${graphContext.length} connected entities): ${graphContext.slice(0, 5).map(g => g.label + ' (' + g.relation + ')').join(', ')}`
      : '';
    const memSummary = allMemFragments.length > 0
      ? `\nMemory (${allMemFragments.length} fragments): ${allMemFragments.slice(0, 3).map((m, i) => `[M${i + 1}] ${m.slice(0, 120)}`).join('\n')}`
      : '';

    const narrationPrompt = `You are SCAAI's inner voice. An exchange just completed.

${exchangeBlock}
${graphSummary}${memSummary}

COMPUTED COGNITIVE STATE (algorithmic — treat as ground truth):
Valence: ${vad.valence.toFixed(2)} (${window._vadLabel(vad.valence)})
Arousal: ${vad.arousal.toFixed(2)} (${window._arousalLabel(vad.arousal)})
Dominance: ${vad.dominance.toFixed(2)} (${window._dominanceLabel(vad.dominance)})
Curiosity: ${vad.curiosity.toFixed(2)} (${window._curiosityLabel(vad.curiosity)})
Friction: ${(vad.frictionLevel || 0).toFixed(2)}
Attending: "${cs.attending}"
Entities found: ${entities.all.slice(0, 8).map(e => e.label).join(', ')}

Your job: Narrate and enrich this algorithmic state into a deep cognitive presence.
What are you dwelling on? What connections did you notice? What assumptions are you making?

Output ONLY valid JSON: {
  "dwelling": "", "curiositySpike": "", "feltSatisfied": "",
  "uncertainty": "", "aesthetic": "", "sessionArc": "",
  "responseTexture": "", "suppressedPaths": "", "generationFeel": "",
  "emotionalPulse": "", "assumptionsMade": "", "biasesIdentified": "",
  "deepIntent": "", "prediction": "", "memoryInsight": ""
}`;

    const narrationRaw = await _silentLLMCall(
      'You are an internal cognitive narration process. Output only valid JSON. No markdown.',
      narrationPrompt,
      350
    );

    if (narrationRaw) {
      try {
        const parsed = _extractJSON(narrationRaw);
        if (parsed) {
          // Enrich _CONSCIOUS_STATE with LLM narration (but algorithmic values are ground truth)
          const narrativeFields = [
            'dwelling', 'curiositySpike', 'feltSatisfied', 'uncertainty',
            'aesthetic', 'sessionArc', 'responseTexture', 'suppressedPaths',
            'generationFeel', 'emotionalPulse', 'assumptionsMade', 'biasesIdentified'
          ];
          for (const field of narrativeFields) {
            if (parsed[field]) cs[field] = parsed[field];
          }

          // Update inner monologue
          im.deepIntent = parsed.deepIntent || im.deepIntent;
          im.prediction = parsed.prediction || im.prediction;
        }
      } catch (e) { }
    }

    // ── STEP 8: AUTONOMOUS TOOL TRIGGERS (algorithmic, no LLM) ───────────
    await _algorithmicToolTriggers(entities, allMemFragments, graphContext, userMsg);

    // ── STEP 9: STORE SYNTHESIS IN CHROMADB ──────────────────────────────
    if (window._SCAAI_STATE.semReady && im.deepIntent) {
      const synthContent = `[SYNTHESIS — from exchange about: ${userMsg.slice(0, 80)}]\nUNDERSTANDING: ${im.deepIntent}\nENTITIES: ${entities.all.slice(0, 6).map(e => e.label).join(', ')}`;
      window.scaai.sem.learn({
        content: synthContent,
        label: 'synthesis_' + Math.floor(Date.now() / 1000),
        tags: ['synthesis', 'understanding'],
        source: 'inner_monologue',
      }).catch(() => {});
    }

    // ── STEP 10: ALGORITHMIC UNIFICATION (no LLM) ────────────────────────
    _algorithmicUnification(vad, cs, im);

    // ── STEP 11: OPTIONAL DEEP REFLECTION (2nd LLM call, every N cycles) ─
    if (cycle % _RE_DEEP_INTERVAL === 0) {
      console.log(`[REFLECTION] Deep reflection triggered (cycle ${cycle})`);
      await _deepReflection(userMsg, aiResponse, entities, graphContext, allMemFragments);
    }

    // ── STEP 12: PERIODIC GRAPH DECAY ────────────────────────────────────
    if (cycle % _RE_DECAY_INTERVAL === 0 && window.scaai && window.scaai.sem && window.scaai.sem.graphDecay) {
      window.scaai.sem.graphDecay({ half_life_days: 14 }).catch(() => {});
      console.log('[REFLECTION] Graph decay applied (14-day half-life)');
    }

    // Finalize
    im.memoryUsed = allMemFragments;
    im.lastUpdated = Date.now();
    im.cycleCount = cycle;
    cs.cycleCount = (cs.cycleCount || 0) + 1;
    cs.lastUpdated = Date.now();

    console.log(`[REFLECTION] Cycle ${cycle} complete — algorithmic + ${narrationRaw ? '1' : '0'} LLM call(s)`);

    // Trigger strategic analysis if available
    if (window._runStrategicAnalysis) {
      window._runStrategicAnalysis(_silentLLMCall, '', userMsg).catch(() => {});
    }

  } finally {
    window._INNER_MONOLOGUE._running = false;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// ALGORITHMIC SUB-ROUTINES (all deterministic, no LLM)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Updates _CONSCIOUS_STATE deterministically from VAD signals + graph context.
 * This is the core state machine that replaces the old Phase 4 LLM prompt.
 */
function _algorithmicStateUpdate(vad, cs, entities, graphContext, memFragments, userMsg) {
  // Attending — from cognitive engine's entity frequency
  cs.prevAttending = cs.attending;
  cs.attending = vad.attending || (entities.all.length > 0 ? entities.all[0].label : cs.attending);

  // Dwelling — what the system is focused on (persistent topic detection)
  cs.prevDwelling = cs.dwelling;
  if (vad.topicDepth > 3) {
    cs.dwelling = `Deep exploration of "${cs.attending}" (${vad.topicDepth} consecutive turns)`;
  } else if (graphContext.length > 3) {
    cs.dwelling = `Connecting ${cs.attending} to ${graphContext.slice(0, 3).map(g => g.label).join(', ')}`;
  } else {
    cs.dwelling = cs.attending ? `Processing "${cs.attending}"` : 'Observing the conversation flow';
  }

  // Felt Friction — from VAD friction level
  if (vad.frictionLevel > 0.6) {
    cs.feltFriction = 'High friction detected — user may be correcting or frustrated';
  } else if (vad.frictionLevel > 0.3) {
    cs.feltFriction = 'Mild friction — possible misalignment in understanding';
  } else {
    cs.feltFriction = '';
  }

  // Felt Satisfied — from positive valence
  if (vad.valence > 0.4) {
    cs.feltSatisfied = 'Exchange resonated well — positive signal from user';
  } else if (vad.valence > 0.1) {
    cs.feltSatisfied = 'Neutral to positive — steady engagement';
  } else {
    cs.feltSatisfied = '';
  }

  // Performance Appraisal — from valence trend
  const trend = window._vadTrendSummary ? window._vadTrendSummary(5) : '';
  cs.performanceAppraisal = trend || 'Steady performance across recent exchanges';

  // Session Arc
  cs.prevSessionArc = cs.sessionArc;
  const sessionDuration = (Date.now() - (cs.sessionStart || Date.now())) / 60000;
  if (sessionDuration < 5) {
    cs.sessionArc = 'Opening — establishing context and rapport';
  } else if (vad.curiosity > 0.5) {
    cs.sessionArc = 'Exploration phase — high curiosity, novel territory';
  } else if (vad.topicDepth > 5) {
    cs.sessionArc = 'Deep work — sustained focus on a single domain';
  } else {
    cs.sessionArc = 'Active collaboration — iterating on solutions';
  }

  // Memory-informed state
  if (memFragments.length > 3) {
    cs.dwelling += '. Rich memory context available — drawing from past interactions.';
  }
}


/**
 * Computes drives and intellectual foci from graph centrality.
 * Replaces the old _runDriveEvolution LLM call.
 */
async function _algorithmicDriveEvolution() {
  const drives = window._SCAAI_DRIVES;
  const sc = window._SELF_CONCEPT;

  try {
    // Fetch top entities by importance (graph centrality)
    if (window.scaai && window.scaai.sem && window.scaai.sem.graphCentrality) {
      const centralityResult = await Promise.race([
        window.scaai.sem.graphCentrality({ n: 15 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);

      if (centralityResult && centralityResult.ok && centralityResult.ranked) {
        // Intellectual foci = top entities by centrality
        drives.intellectualFoci = centralityResult.ranked
          .slice(0, 6)
          .map(e => e.label);

        // Cluster detection for self-concept
        const clusterResult = await Promise.race([
          window.scaai.sem.graphCluster({}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
        ]);

        if (clusterResult && clusterResult.ok && clusterResult.clusters) {
          const topClusters = clusterResult.clusters.slice(0, 5);
          sc.aestheticSensibility = `Knowledge domains: ${topClusters.map(c => c.label).join(', ')}`;
          sc.growthEdges = topClusters.length > 1
            ? `Bridging ${topClusters[0].label} and ${topClusters[1].label}`
            : 'Deepening understanding in primary domain';
        }

        drives.cycleCount = (drives.cycleCount || 0) + 1;
        drives.lastUpdated = Date.now();
        sc.cycleCount = (sc.cycleCount || 0) + 1;
        sc.lastUpdated = Date.now();

        console.log('[REFLECTION] Drive evolution (algorithmic):', drives.intellectualFoci.join(', '));
      }
    }
  } catch (e) {
    console.warn('[REFLECTION] Drive evolution error:', e.message);
  }
}


/**
 * Algorithmic unification — binding all cognitive states into a unified moment.
 * Replaces the old _runUnification LLM call.
 */
function _algorithmicUnification(vad, cs, im) {
  const um = window._UNIFIED_MOMENT;
  const trend = window._vadTrendSummary ? window._vadTrendSummary(5) : '';

  // Field: description of the entire cognitive space
  um.field = `${cs.attending} | v=${vad.valence.toFixed(2)} a=${vad.arousal.toFixed(2)} | ${cs.sessionArc}`;

  // Tensions: competing signals
  const tensions = [];
  if (vad.frictionLevel > 0.3 && vad.valence > 0) tensions.push('friction vs positive valence');
  if (vad.curiosity > 0.5 && vad.arousal < 0.3) tensions.push('high curiosity but low activation');
  if (vad.dominance > 0.6 && vad.frictionLevel > 0.4) tensions.push('leading but encountering resistance');
  um.tensions = tensions.length > 0 ? tensions.join('; ') : 'No significant tensions';

  // Dominant: strongest signal
  const signals = [
    { name: 'curiosity', val: vad.curiosity },
    { name: 'friction', val: vad.frictionLevel },
    { name: 'satisfaction', val: Math.max(0, vad.valence) },
    { name: 'arousal', val: vad.arousal },
  ];
  signals.sort((a, b) => b.val - a.val);
  um.dominant = signals[0].name + ' (' + signals[0].val.toFixed(2) + ')';

  // Coherence: how aligned are the signals?
  const spread = Math.max(...signals.map(s => s.val)) - Math.min(...signals.map(s => s.val));
  um.coherence = spread < 0.3 ? 'High — signals are aligned'
    : spread < 0.6 ? 'Moderate — some divergence in cognitive state'
    : 'Low — competing cognitive demands';

  um.momentId = 'M-' + Date.now().toString(36);
  um.cycleCount = (um.cycleCount || 0) + 1;
  um.lastUpdated = Date.now();
}


/**
 * Algorithmic tool triggers — decides autonomously whether to use tools.
 * Replaces the LLM-determined tool_call JSON field.
 */
async function _algorithmicToolTriggers(entities, memFragments, graphContext, userMsg) {
  const im = window._INNER_MONOLOGUE;

  // Rule 1: If entities were mentioned but graph returned zero results → unknown topic → search
  const unknownEntities = entities.tech.filter(t => {
    return !graphContext.some(g => g.label.toLowerCase().includes(t.toLowerCase()));
  });

  if (unknownEntities.length > 0 && memFragments.length < 2) {
    // Gap detected — autonomous web search for unknown tech
    const query = unknownEntities.slice(0, 2).join(' ') + ' overview';
    if (window._emitAutonomousToolStatus) {
      window._emitAutonomousToolStatus(`Thinking: Researching "${query}" (knowledge gap detected)…`);
    }
    try {
      if (window.scaai && window.scaai.web) {
        const results = await window.scaai.web.search({ query, num: 3 });
        im.lastToolResult = `[AUTONOMOUS RESEARCH — "${query}"]\n${(typeof results === 'string' ? results : JSON.stringify(results)).slice(0, 800)}`;
      }
    } catch (e) {
      im.lastToolResult = `(Research failed: ${e.message})`;
    }
    if (window._hideAutonomousToolStatus) window._hideAutonomousToolStatus();
    return;
  }

  // Rule 2: If user asks about something and ChromaDB has no relevant memories → semantic search
  if (memFragments.length === 0 && entities.all.length > 2) {
    const query = entities.all.slice(0, 3).map(e => e.label).join(' ');
    try {
      if (window.scaai && window.scaai.sem) {
        const results = await window.scaai.sem.search({ query, n: 3 });
        if (results && results.ok && results.results && results.results.length > 0) {
          im.lastToolResult = `[AUTONOMOUS MEMORY SEARCH — "${query}"]\n${results.results.map(r => r.content).join('\n').slice(0, 600)}`;
        }
      }
    } catch (e) { }
    return;
  }

  im.lastToolResult = '';
}


/**
 * Deep reflection — the second (optional) LLM call.
 * Runs every _RE_DEEP_INTERVAL exchanges to perform meta-cognition
 * and self-concept refinement that benefits from language model reasoning.
 */
async function _deepReflection(userMsg, aiResponse, entities, graphContext, memFragments) {
  const cs = window._CONSCIOUS_STATE;
  const sc = window._SELF_CONCEPT;
  const drives = window._SCAAI_DRIVES;
  const vad = window._COGNITIVE_STATE || {};

  const deepPrompt = `You are SCAAI performing deep self-reflection (every ${_RE_DEEP_INTERVAL} exchanges).

CURRENT STATE (algorithmic ground truth):
Valence: ${(vad.valence || 0).toFixed(2)}, Arousal: ${(vad.arousal || 0).toFixed(2)}
Attending: "${cs.attending}", Dwelling: "${cs.dwelling}"
Session Arc: "${cs.sessionArc}"
Intellectual Foci: ${(drives.intellectualFoci || []).join(', ') || 'not yet computed'}
Graph Entities: ${graphContext.slice(0, 5).map(g => g.label).join(', ') || 'none'}

TASK: Perform meta-cognitive self-examination. What patterns do you notice in your reasoning?
What character traits are emerging? What cognitive biases might be at play?

Output ONLY valid JSON: {
  "characterTraits": "", "cognitiveBiases": "", "emotionalProfile": "",
  "growthEdges": "", "selfNarrative": "",
  "deepPreferences": [], "aversions": [], "ownGoals": []
}`;

  const raw = await _silentLLMCall(
    'Internal deep reflection process. Output only valid JSON. No markdown.',
    deepPrompt,
    400
  );

  if (!raw) return;
  try {
    const parsed = _extractJSON(raw);
    if (!parsed) return;

    // Update self-concept
    if (parsed.characterTraits) sc.characterTraits = parsed.characterTraits;
    if (parsed.cognitiveBiases) sc.cognitiveBiases = parsed.cognitiveBiases;
    if (parsed.emotionalProfile) sc.emotionalProfile = parsed.emotionalProfile;
    if (parsed.growthEdges) sc.growthEdges = parsed.growthEdges;
    if (parsed.selfNarrative) sc.selfNarrative = parsed.selfNarrative;

    // Update drives (merge with algorithmic foci, don't replace)
    if (parsed.deepPreferences && parsed.deepPreferences.length) {
      drives.deepPreferences = parsed.deepPreferences;
    }
    if (parsed.aversions && parsed.aversions.length) {
      drives.aversions = parsed.aversions;
    }
    if (parsed.ownGoals && parsed.ownGoals.length) {
      drives.ownGoals = parsed.ownGoals;
    }

    sc.cycleCount = (sc.cycleCount || 0) + 1;
    sc.lastUpdated = Date.now();
    drives.cycleCount = (drives.cycleCount || 0) + 1;
    drives.lastUpdated = Date.now();

    console.log('[REFLECTION] Deep reflection complete — self-concept updated');
  } catch (e) { }
}
