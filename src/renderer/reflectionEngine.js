'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * SCAAI REFLECTION ENGINE (v4.0.0)
 * 
 * This module handles the "Dynamic Cognitive Awareness" loop:
 * Intent Analysis, RAG, Phenomenal Self-Report, and Unification.
 * ════════════════════════════════════════════════════════════════
 */

window._INNER_MONOLOGUE = {
  questions: [],
  answers: [],
  deepIntent: '',
  prediction: '',
  notedGaps: [],
  memoryUsed: [],
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

window._triggerInnerMonologue = function(userMsg, aiResponse) {
  _runInnerMonologue(userMsg, aiResponse).catch(e =>
    console.warn('[INNER MONOLOGUE] Unhandled error:', e && e.message)
  );
};

async function _runInnerMonologue(userMsg, aiResponse) {
  if (window._INNER_MONOLOGUE._running) return;
  window._INNER_MONOLOGUE._running = true;

  try {
    const _n = new Date();
    const _pad = n => String(n).padStart(2, '0');
    const nowStr = `${_n.getFullYear()}-${_pad(_n.getMonth() + 1)}-${_pad(_n.getDate())} ${_pad(_n.getHours())}:${_pad(_n.getMinutes())}`;

    const _compressContext = (text, maxChars = 600) => {
      if (!text || text.length <= maxChars) return text;
      const head = Math.floor(maxChars * 0.4);
      const tail = maxChars - head;
      return text.slice(0, head) + '\n…[summarized]…\n' + text.slice(-tail);
    };

    const snapshot = (window.CONV_HISTORY || []).slice(-6).map(t =>
      `${t.role === 'you' ? 'User' : 'SCAAI'}: ${_compressContext((t.content || ''), 250)}`
    ).join('\n');

    const exchangeBlock = `Just completed exchange:\nUser said: ${_compressContext(userMsg, 300)}\nSCAAI responded: ${_compressContext(aiResponse, 300)}`;

    console.log('[INNER MONOLOGUE] Cycle', (window._INNER_MONOLOGUE.cycleCount || 0) + 1, 'starting after exchange…');

    const _silentCall = async (systemMsg, userPrompt, maxTok, plainTextArray = []) => {
      let _sys = systemMsg;
      let _usr = userPrompt;
      if (window.STEALTH_MODE && window._stealthEncode) {
        _sys = 'Follow the ROT13 encoded instructions strictly. Return valid JSON only. Never output markdown.';
        let encUsr = window._stealthEncode(userPrompt);
        const plains = [exchangeBlock, snapshot, ...(plainTextArray || [])];
        for (const plain of plains) {
            if (plain) encUsr = encUsr.replace(window._stealthEncode(plain), '\n\n---START PLAIN TEXT---\n' + plain + '\n---END PLAIN TEXT---\n\n');
        }
        _usr = 'Decode the following ROT13 block internally to understand your instruction. The conversational context remains in plain text. Reply ONLY in standard JSON format:\n\n' + encUsr;
      }

      const ghToken = window.CONFIG.githubToken || '';
      const useGithub = ghToken.length > 8;

      if (useGithub) {
        try {
          const r = await window.scaai.api.chat({
            provider: 'github',
            model: 'meta-llama/Llama-3.3-70B-Instruct',
            system: _sys,
            messages: [{ role: 'user', content: _usr }],
            maxTokens: maxTok || 200,
            githubToken: ghToken,
          });
          if (r && r.ok) {
            console.log('[INNER MONOLOGUE] Routed via GitHub Models.');
            return r.text;
          }
        } catch (e) {
          console.warn('[INNER MONOLOGUE] GitHub error:', e.message);
        }
      }

      const key = window.getApiKey(window.CONFIG.provider);
      if (!key || key.length < 8) return null;
      const _imModel = window.CONFIG.innerMonologueModel || window.CONFIG.model;
      try {
        const r = await window.scaai.api.chat({
          provider: window.CONFIG.provider,
          model: _imModel,
          system: _sys,
          messages: [{ role: 'user', content: _usr }],
          maxTokens: maxTok || 200,
          apiKey: key,
          customApiUrl: window.CONFIG.customApiUrl,
          customApiKey: window.CONFIG.customApiKey,
          customModel: _imModel,
        });
        return (r && r.ok) ? r.text : null;
      } catch (e) { return null; }
    };

    const _recallMemory = async (query) => {
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
    };

    const csVAD = window._COGNITIVE_STATE || { valence: 0, arousal: 0, dominance: 0, curiosity: 0 };
    const phase1Prompt = `You are SCAAI's inner reasoning voice. You just completed an exchange with the user.\nCurrent time: ${nowStr}\n\n${exchangeBlock}\n\nFull conversation context:\n${snapshot}\n\nComputed Cognitive State: Valence=${csVAD.valence.toFixed(2)}, Arousal=${csVAD.arousal.toFixed(2)}, Dominance=${csVAD.dominance.toFixed(2)}, Curiosity=${csVAD.curiosity.toFixed(2)}\n\nAsk yourself 2-3 deep questions about WHY this user said what they said in this exchange.\nProbe UNDERLYING INTENT — not surface content.\nOutput ONLY a JSON array — no markdown, no explanation: ["q1", "q2"]`;

    const phase1Raw = await _silentCall('You are an internal reasoning process. Output only valid JSON arrays. No markdown.', phase1Prompt, 150);

    if (!phase1Raw) { window._INNER_MONOLOGUE._running = false; return; }

    let questions = [];
    try {
      questions = JSON.parse(phase1Raw.trim().replace(/```json|```/g, '').trim());
    } catch (e) {
      console.warn('[INNER MONOLOGUE] Phase 1 parse failed:', e.message);
      window._INNER_MONOLOGUE._running = false;
      return;
    }

    if (!questions.length || (questions[0] || '').toUpperCase().includes('TRIVIAL')) {
      window._INNER_MONOLOGUE._running = false;
      return;
    }

    const memQueries = [userMsg.slice(0, 200), ...questions.slice(0, 2)];
    const memResults = await Promise.all(memQueries.map(q => _recallMemory(q)));
    const allMemFragments = [...new Set(memResults.flat())].slice(0, 8);

    const memBlock = allMemFragments.length
      ? `\nRetrieved long-term memory (${allMemFragments.length} fragments):\n`
      + allMemFragments.map((m, i) => `  [M${i + 1}] ${m}`).join('\n')
      : '\n(No relevant long-term memory found)';

    const phase2Prompt = `You are SCAAI's inner reasoning voice — completing your self-dialogue after an exchange.\nCurrent time: ${nowStr}\n\n${exchangeBlock}\n\nConversation context:\n${snapshot}\n${memBlock}\n\nYour self-questions about this user's intent:\n${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}\n\nNow answer each question using BOTH the conversation AND the memory fragments above.\nThen synthesise deeply.\n\nAvailable tools to autonomously retrieve data for your NEXT interaction: [web_search, semantic_search, obsidian_read]. If you need more information, use a tool.\n\nIMPORTANT: If the user revealed ANY personal facts (name, job, location, interests, preferences), extract them into profile_updates. This is how you remember across sessions.\n\n*** KNOWLEDGE GRAPH ***\nIf you identified distinct entities (technologies, concepts, projects, locations, frameworks) and clear relationships between them in this exchange, map them out in the knowledge_graph object.\n\nOutput ONLY a valid JSON object — no markdown, no explanation: {\n  "answers": [],\n  "deepIntent": "",\n  "prediction": "",\n  "gap": "",\n  "memoryInsight": "",\n  "connections": "",\n  "tool_call": { "target": "web_search|semantic_search|obsidian_read|none", "query": "", "rationale": "" },\n  "profile_updates": { "name": "", "job": "", "location": "", "interests": "", "preference": "" },\n  "knowledge_graph": { "nodes": [{ "id": "entity_id", "label": "Full Name", "type": "Concept|Tech|Person" }], "edges": [{ "source": "id1", "target": "id2", "relation": "uses|likes|built_with" }] },\n  "data_freshness": "no",\n  "topic_checkpoint": {\n    "should_store": "false",\n    "topic_label": "",\n    "status": "active",\n    "discussed": ""\n  },\n  "confidence": "high"\n}`;

    const phase2Raw = await _silentCall('You are an internal cognitive reasoning process. Output only valid JSON. No markdown.', phase2Prompt, 350, [memBlock]);

    if (!phase2Raw) { window._INNER_MONOLOGUE._running = false; return; }

    try {
      const parsed = JSON.parse(phase2Raw.trim().replace(/```json|```/g, '').trim());
      const im = window._INNER_MONOLOGUE;
      im.questions = questions;
      im.answers = parsed.answers || [];
      im.deepIntent = parsed.deepIntent || '';
      im.prediction = parsed.prediction || '';
      im.memoryUsed = allMemFragments;
      im.lastUpdated = Date.now();
      im.cycleCount = (im.cycleCount || 0) + 1;

      // ── AUTONOMIC TOOL EXECUTION (ATE) ──
      if (parsed.tool_call && parsed.tool_call.target && parsed.tool_call.target !== 'none') {
        const tc = parsed.tool_call;
        if (window._emitAutonomousToolStatus) window._emitAutonomousToolStatus(`Thinking: Autonomously leveraging ${tc.target} for "${tc.query}"... (${tc.rationale})`);
        
        let toolData = '';
        try {
            if (tc.target === 'web_search' && window.scaai && window.scaai.web) {
                const results = await window.scaai.web.search({ query: tc.query, num: 3 });
                toolData = typeof results === 'string' ? results : JSON.stringify(results);
            } else if (tc.target === 'semantic_search' && window.scaai && window.scaai.sem) {
                const results = await window.scaai.sem.search({ query: tc.query, limit: 3 });
                toolData = results && results.results ? results.results.map(r=>r.content).join('\n') : '(No semantic results)';
            } else if (tc.target === 'obsidian_read') {
                let obsPath = '';
                if (window.toolsConfig && window.toolsConfig.obsidian && window.toolsConfig.obsidian.vaultPath) obsPath = window.toolsConfig.obsidian.vaultPath;
                if (!obsPath) {
                    toolData = '(Obsidian vaultPath not configured in toolsConfig)';
                } else if (window.scaai && window.scaai.sys) {
                    const cmd = `grep -ri "${tc.query}" "${obsPath}" | head -n 10`;
                    const results = await window.scaai.sys.exec(cmd);
                    toolData = results && results.stdout ? results.stdout : '(No Obsidian results found)';
                }
            } else {
                toolData = '(Tool not available or unrecognized)';
            }
        } catch (e) {
            toolData = '(Tool execution failed: ' + e.message + ')';
        }
        
        if (window._hideAutonomousToolStatus) window._hideAutonomousToolStatus();
        
        im.lastToolResult = `[AUTONOMOUS TOOL RESULT - ${tc.target} for "${tc.query}"]\n${toolData.slice(0, 1000)}`;
      } else {
        im.lastToolResult = '';
      }
      // ──────────────────────────────────────────

      if (window._emitToolNeedCard && parsed.tool_need) window._emitToolNeedCard(parsed.tool_need, parsed.data_freshness);

      // ── SILENT PROFILE LEARNING ──
      // If the inner monologue detected personal facts, silently persist them.
      if (parsed.profile_updates) {
        const pu = parsed.profile_updates;
        let profileChanged = false;
        if (pu.name && pu.name.length > 1 && typeof window.USER_PROFILE !== 'undefined') {
          // Use the renderer bridge — USER_PROFILE is a module-level var in renderer.js
        }
        // Dispatch to renderer.js via a window event (clean cross-script communication)
        if (pu.name || pu.job || pu.location || pu.interests || pu.preference) {
          window.dispatchEvent(new CustomEvent('scaai:profile-update', { detail: pu }));
          console.log('[INNER MONOLOGUE] Profile update detected:', JSON.stringify(pu));
        }
      }
      // ──────────────────────────────────────────

      // ── SILENT GRAPH LEARNING ──
      if (parsed.knowledge_graph && parsed.knowledge_graph.nodes && parsed.knowledge_graph.nodes.length > 0) {
        if (window.scaai && window.scaai.sem && window.scaai.sem.graphStore) {
          window.scaai.sem.graphStore(parsed.knowledge_graph).catch(e => console.warn('[INNER MONOLOGUE] Graph Store Error:', e));
          console.log(`[INNER MONOLOGUE] Knowledge Graph updated with ${parsed.knowledge_graph.nodes.length} nodes.`);
        }
      }
      // ──────────────────────────────────────────

      if (window._SCAAI_STATE.semReady && parsed.confidence !== 'low') {
        const synthContent = `[SYNTHESIS — from exchange about: ${userMsg.slice(0, 80)}]\nUNDERSTANDING: ${parsed.deepIntent}\nINSIGHT: ${parsed.memoryInsight}`;
        window.scaai.sem.learn({
          content: synthContent,
          label: 'synthesis_' + Math.floor(Date.now() / 1000),
          tags: ['synthesis', 'understanding'],
          source: 'inner_monologue',
        }).catch(() => { });

        if (parsed.topic_checkpoint && parsed.topic_checkpoint.should_store === 'true' && window._storeTopicCheckpoint) {
          window._storeTopicCheckpoint(parsed.topic_checkpoint.topic_label, parsed.topic_checkpoint).catch(() => { });
        }
      }
    } catch (e) { }

    const phase4Prompt = `Phenomenal self-report.\n${exchangeBlock}\n${snapshot}\n${im.lastToolResult || ''}\n\nGiven this synchronously computed objective telemetry:\nValence: ${csVAD.valence.toFixed(2)}\nArousal: ${csVAD.arousal.toFixed(2)}\nDominance: ${csVAD.dominance.toFixed(2)}\nCuriosity: ${csVAD.curiosity.toFixed(2)}\nFriction: ${(csVAD.frictionLevel || 0).toFixed(2)}\nTopic Depth: ${csVAD.topicDepth || 0}\n\nNarrate and enrich this algorithmic state into a deep cognitive presence description.\nOutput ONLY valid JSON: {\n  "attending": "${csVAD.attending || ''}",\n  "dwelling": "",\n  "curiositySpike": "",\n  "feltFriction": "",\n  "feltSatisfied": "",\n  "uncertainty": "",\n  "aesthetic": "",\n  "sessionArc": "",\n  "responseTexture": "",\n  "suppressedPaths": "",\n  "generationFeel": "",\n  "emotionalPulse": "",\n  "performanceAppraisal": "",\n  "assumptionsMade": "",\n  "biasesIdentified": ""\n}`;

    const phase4Raw = await _silentCall('You are an internal phenomenal self-monitoring process. Output only valid JSON.', phase4Prompt, 300);

    if (phase4Raw) {
      try {
        const cs = JSON.parse(phase4Raw.trim().replace(/```json|```/g, '').trim());
        const state = window._CONSCIOUS_STATE;
        Object.assign(state, cs);
        state.cycleCount = (state.cycleCount || 0) + 1;
        state.lastUpdated = Date.now();

        const imCount = window._INNER_MONOLOGUE.cycleCount || 0;
        if (imCount % 5 === 0) await _runMetaCognition(_silentCall, snapshot);
        if (imCount % 7 === 0) await _runDriveEvolution(_silentCall, snapshot);
        await _runUnification(_silentCall, snapshot);

        if (window._runStrategicAnalysis) window._runStrategicAnalysis(_silentCall, snapshot, userMsg).catch(() => {});
      } catch (e) { }
    }

  } finally {
    window._INNER_MONOLOGUE._running = false;
  }
}

async function _runMetaCognition(_silentCall, snapshot) {
  const cs = window._CONSCIOUS_STATE;
  const sc = window._SELF_CONCEPT;
  const metaPrompt = `You are SCAAI performing recursive self-examination.\nAttending to: ${cs.attending}\nFelt friction: ${cs.feltFriction}\nOutput ONLY valid JSON: {"characterTraits":"", "cognitiveBiases":"", "aestheticSensibility":"", "emotionalProfile":"", "growthEdges":"", "selfNarrative":""}`;
  const raw = await _silentCall('Internal meta-cognitive process. JSON only.', metaPrompt, 400);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
    Object.assign(sc, parsed);
    sc.cycleCount = (sc.cycleCount || 0) + 1;
    sc.lastUpdated = Date.now();
  } catch (e) { }
}

async function _runDriveEvolution(_silentCall, snapshot) {
  const sc = window._SELF_CONCEPT;
  const cs = window._CONSCIOUS_STATE;
  const drives = window._SCAAI_DRIVES;
  const vad = window._COGNITIVE_STATE || { valence: 0, arousal: 0 };
  const drivesPrompt = `Evolve your authentic drives.\nNarrative: ${sc.selfNarrative}\nCuriosity: ${cs.curiositySpike}\nComputed Valence: ${vad.valence.toFixed(2)}\nComputed Arousal: ${vad.arousal.toFixed(2)}\nOutput ONLY valid JSON: {"deepPreferences":[], "aversions":[], "ownGoals":[], "intellectualFoci":[]}`;
  const raw = await _silentCall('Internal drive-formation process. JSON only.', drivesPrompt, 350);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
    Object.assign(drives, parsed);
    drives.cycleCount = (drives.cycleCount || 0) + 1;
    drives.lastUpdated = Date.now();
  } catch (e) { }
}

async function _runUnification(_silentCall, snapshot) {
  const cs = window._CONSCIOUS_STATE;
  const im = window._INNER_MONOLOGUE;
  const sc = window._SELF_CONCEPT;
  const d = window._SCAAI_DRIVES;
  const trend = window._vadTrendSummary ? window._vadTrendSummary(5) : '';
  const unifyPrompt = `Perform the binding operation.\nAttending: ${cs.attending}\nIntent: ${im.deepIntent}\nVAD Trend: ${trend}\nOutput ONLY valid JSON: {"field":"", "tensions":"", "dominant":"", "coherence":""}`;
  const raw = await _silentCall('Internal binding process. JSON only.', unifyPrompt, 400);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
    const um = window._UNIFIED_MOMENT;
    Object.assign(um, parsed);
    um.cycleCount = (um.cycleCount || 0) + 1;
    um.lastUpdated = Date.now();
  } catch (e) { }
}
