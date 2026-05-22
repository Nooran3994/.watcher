'use strict';
// ══════════════════════════════════════════════════════════════════
// SCAAI System Findings Engine  v1
// Analyses ALL chat history, system state, and tool usage patterns
// to generate actionable improvement recommendations.
//
// Finding types:
//   ai-fixable    — can be improved by feeding findings back to the AI
//   code-required — needs a code change; will recommend what to change
//   configuration — user needs to toggle/configure something
//
// Access: dedicated 🔬 button in titlebar overflow panel
// ══════════════════════════════════════════════════════════════════

const SystemFindings = (() => {

  // ── Finding severity levels ──────────────────────────────────────
  const SEVERITY = { CRITICAL:'critical', HIGH:'high', MEDIUM:'medium', LOW:'low', INFO:'info' };

  // ── Category labels ──────────────────────────────────────────────
  const CATEGORIES = {
    memory:      { icon:'🧠', label:'Memory & Recall' },
    response:    { icon:'💬', label:'Response Quality' },
    tools:       { icon:'🔧', label:'Tool Usage' },
    model:       { icon:'⚡', label:'Model Performance' },
    context:     { icon:'📎', label:'Context & Files' },
    interaction: { icon:'🗣️', label:'Interaction Patterns' },
    security:    { icon:'🔒', label:'Safety & Accuracy' },
    capability:  { icon:'🚀', label:'Capability Gaps' },
  };

  // ── Internal state ───────────────────────────────────────────────
  let _lastReport = null;
  let _lastRunTs  = 0;
  let _running    = false;

  // ── Helpers ──────────────────────────────────────────────────────
  function _ts()      { return Date.now(); }
  function _ageMins(ts){ return Math.round((_ts() - ts) / 60000); }

  // Count occurrences of a pattern in a string
  function _count(text, re){ return (text.match(re) || []).length; }

  // Clamp 0–1
  function _clamp01(v){ return Math.max(0, Math.min(1, v)); }

  // ── Main analysis ─────────────────────────────────────────────────
  async function runAnalysis(globals) {
    if (_running) return { ok:false, error:'Analysis already running' };
    _running = true;

    const {
      CONV_HISTORY,
      ACTIVE_PROJECT,
      SEM_READY,
      SEM_COUNT,
      CONFIG,
      WEB_SEARCH_ENABLED,
      FILES,
      SEL,
      TOOLS_CONFIG,
      USER_PROFILE,
      A,
    } = globals;

    const findings = [];

    try {
      // ── Load ALL saved chats for aggregate analysis ──────────────
      let allChats = [];
      try {
        const cr = await A.chats.load();
        allChats = Array.isArray(cr) ? cr : [];
      } catch(e) {}

      // Aggregate all messages across all saved chats + current session
      const allMessages = [
        ...(CONV_HISTORY || []),
        ...allChats.flatMap(c => c.messages || []),
      ];
      const aiMessages   = allMessages.filter(m => m.role === 'ai');
      const userMessages = allMessages.filter(m => m.role === 'you');

      // ── 1. MEMORY ANALYSIS ───────────────────────────────────────
      await _analyzeMemory({ SEM_READY, SEM_COUNT, A, allMessages, findings });

      // ── 2. RESPONSE QUALITY ──────────────────────────────────────
      await _analyzeResponseQuality({ aiMessages, userMessages, findings });

      // ── 3. TOOL USAGE ────────────────────────────────────────────
      await _analyzeToolUsage({ aiMessages, WEB_SEARCH_ENABLED, FILES, SEL, TOOLS_CONFIG, findings });

      // ── 4. MODEL PERFORMANCE ─────────────────────────────────────
      await _analyzeModelPerformance({ allMessages, CONFIG, findings });

      // ── 5. CONTEXT & FILES ───────────────────────────────────────
      await _analyzeContext({ FILES, SEL, allChats, CONV_HISTORY, findings });

      // ── 6. INTERACTION PATTERNS ──────────────────────────────────
      await _analyzeInteraction({ userMessages, aiMessages, allChats, USER_PROFILE, findings });

      // ── 7. CAPABILITY GAPS ───────────────────────────────────────
      await _analyzeCapabilityGaps({ allMessages, TOOLS_CONFIG, SEM_READY, findings });

      // ── Score & sort ─────────────────────────────────────────────
      const severityScore = { critical:4, high:3, medium:2, low:1, info:0 };
      findings.sort((a,b) => (severityScore[b.severity]||0) - (severityScore[a.severity]||0));

      // ── Summary stats ─────────────────────────────────────────────
      const summary = {
        total:       findings.length,
        critical:    findings.filter(f=>f.severity==='critical').length,
        high:        findings.filter(f=>f.severity==='high').length,
        medium:      findings.filter(f=>f.severity==='medium').length,
        low:         findings.filter(f=>f.severity==='low').length,
        info:        findings.filter(f=>f.severity==='info').length,
        aiFixable:   findings.filter(f=>f.actionType==='ai-fixable').length,
        codeRequired:findings.filter(f=>f.actionType==='code-required').length,
        config:      findings.filter(f=>f.actionType==='configuration').length,
        chatsAnalyzed: allChats.length + 1,
        messagesAnalyzed: allMessages.length,
        runAt: Date.now(),
      };

      _lastReport = { findings, summary };
      _lastRunTs  = Date.now();
      return { ok:true, findings, summary };

    } catch(e) {
      return { ok:false, error: e.message };
    } finally {
      _running = false;
    }
  }

  // ── Sub-analysers ────────────────────────────────────────────────

  async function _analyzeMemory({ SEM_READY, SEM_COUNT, A, allMessages, findings }) {
    // Check if SEM is active
    if (!SEM_READY) {
      findings.push({
        id: 'mem_not_ready',
        severity: SEVERITY.HIGH,
        category: 'memory',
        title: 'Semantic memory offline',
        description: 'ChromaDB is not connected. SCAAI cannot recall facts from previous sessions, meaning every session starts cold. Cross-session learning, user profiling, and context continuity are all disabled.',
        actionType: 'configuration',
        actions: [{ label:'Install ChromaDB', cmd:'installChromaDB()' }],
        learnContent: 'SYSTEM IMPROVEMENT: Semantic memory is offline. Priority: install chromadb to enable persistent cross-session recall.',
      });
      return;
    }

    // Low memory count warning
    if (SEM_COUNT < 10 && allMessages.length > 20) {
      findings.push({
        id: 'mem_low_count',
        severity: SEVERITY.MEDIUM,
        category: 'memory',
        title: 'Very few facts stored in memory',
        description: `Only ${SEM_COUNT} memory entries exist despite ${allMessages.length} total messages analysed. Key decisions, preferences, and project details may be getting lost between sessions.`,
        actionType: 'ai-fixable',
        actions: [{ label:'Run Auto-Learn', cmd:"semAutoLearn()" }],
        learnContent: `SYSTEM IMPROVEMENT: Only ${SEM_COUNT} facts stored vs ${allMessages.length} messages. Should store more: user preferences, project context, key decisions, frequent topics.`,
      });
    }

    // Check for hallucination patterns in AI responses
    const aiTexts = allMessages.filter(m=>m.role==='ai').map(m=>m.content||'').join(' ');
    const denialCount = _count(aiTexts, /I don'?t have (that|any|specific) (stored|information|data)/gi);
    if (denialCount > 5) {
      findings.push({
        id: 'mem_false_denial',
        severity: SEVERITY.HIGH,
        category: 'memory',
        title: 'AI incorrectly denies having stored information',
        description: `Detected ${denialCount} instances of the AI saying it does not have something stored, which may be false denials (retrieval failures or negative-loop contamination). This erodes user trust.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: AI is denying stored information too frequently. Should be more assertive about memory and only deny after verified empty retrieval. False denials undermine trust.',
      });
    }

    // Check for memory retrieval in conversations
    const recallKeywords = _count(aiTexts, /you (mentioned|said|asked|told me|prefer|like|use|work on)/gi);
    if (recallKeywords < 3 && SEM_COUNT > 30) {
      findings.push({
        id: 'mem_not_using_recall',
        severity: SEVERITY.MEDIUM,
        category: 'memory',
        title: 'Memory not actively surfaced in responses',
        description: `${SEM_COUNT} facts are stored but responses rarely reference personal context. Memory exists but is not being woven into answers naturally.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: Stored memory is not being surfaced in responses enough. Should reference user context, project names, preferences, and past decisions more naturally in every relevant answer.',
      });
    }

    // Check for health via stats if possible
    try {
      const health = await Promise.race([
        A.sem.health(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))
      ]);
      if (health && health.ok && health.by_type) {
        const exchangeCount = health.by_type['exchange'] || 0;
        const learnedCount  = health.by_type['learned']  || 0;
        if (exchangeCount > 200 && learnedCount < 10) {
          findings.push({
            id: 'mem_imbalanced',
            severity: SEVERITY.LOW,
            category: 'memory',
            title: 'Memory dominated by raw exchanges, few structured facts',
            description: `${exchangeCount} raw exchange entries vs only ${learnedCount} structured facts. Structured facts (learned, identity, preference) yield far better retrieval accuracy than raw transcripts.`,
            actionType: 'ai-fixable',
            actions: [{ label:'Auto-Learn from Chats', cmd:'semAutoLearn()' }],
            learnContent: 'SYSTEM IMPROVEMENT: Too many raw exchange entries, too few structured learned facts. Auto-learn should run more aggressively to extract typed facts (identity, preference, project) from conversation history.',
          });
        }
      }
    } catch(e) {}
  }

  async function _analyzeResponseQuality({ aiMessages, userMessages, findings }) {
    if (!aiMessages.length) return;

    const avgLen = aiMessages.reduce((s,m)=>s+(m.content||'').length, 0) / aiMessages.length;
    const texts  = aiMessages.map(m=>m.content||'');

    // Over-long responses
    const longCount = texts.filter(t=>t.length>3000).length;
    if (longCount > aiMessages.length * 0.3) {
      findings.push({
        id: 'resp_too_long',
        severity: SEVERITY.MEDIUM,
        category: 'response',
        title: 'Responses frequently too verbose',
        description: `${longCount} of ${aiMessages.length} AI responses exceed 3,000 characters. Verbose responses bury key information and reduce clarity. Conversational messages should be under 200 words.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: Responses are too long on average. Enforce the 200-word limit for conversational messages. Stop after answering — do not pad with filler or restate what was just said.',
      });
    }

    // Filler phrase detection
    const fillerPatterns = [
      /I'm here to help/gi, /Let me know.*how.*can/gi, /What's.*on your mind/gi,
      /I'm ready to assist/gi, /Great question/gi, /Certainly!/gi, /Of course!/gi,
    ];
    const fillerHits = texts.reduce((sum, t) => sum + fillerPatterns.filter(p=>p.test(t)).length, 0);
    if (fillerHits > 5) {
      findings.push({
        id: 'resp_filler',
        severity: SEVERITY.MEDIUM,
        category: 'response',
        title: 'Filler phrases detected in responses',
        description: `Found ${fillerHits} filler phrases ("I'm here to help", "Great question", "Certainly!"). These phrases are banned and indicate prompt instructions are not fully respected.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: AI is using filler phrases that are explicitly banned. Must eliminate: "I\'m here to help", "Let me know if I can assist", "Great question", "Certainly!", and similar AI-servile openers.',
      });
    }

    // AI identity slippage
    const identitySlips = _count(texts.join(' '), /as an AI|I am an AI|I'm an AI|as a language model/gi);
    if (identitySlips > 0) {
      findings.push({
        id: 'resp_identity_slip',
        severity: SEVERITY.HIGH,
        category: 'response',
        title: 'AI identity breaking — using "as an AI" language',
        description: `Found ${identitySlips} instances of "as an AI", "I'm an AI", or "as a language model". SCAAI must maintain its distinct identity at all times.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'CRITICAL SYSTEM IMPROVEMENT: AI is breaking its SCAAI identity by saying "as an AI" or "I am a language model". This is explicitly forbidden. Must always respond as SCAAI, a locally-embedded intelligence — never as a generic AI.',
      });
    }

    // Repetitive content
    const repeatedPhrases = _count(texts.join(' '), /based on our previous conversation|according to my memory|I recall that|In the context of our/gi);
    if (repeatedPhrases > 3) {
      findings.push({
        id: 'resp_process_narration',
        severity: SEVERITY.MEDIUM,
        category: 'response',
        title: 'AI narrating its own memory retrieval process',
        description: `Found ${repeatedPhrases} instances of phrases like "Based on our previous conversation" or "According to my memory" — banned process-narration phrases that expose internal mechanics.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: AI is narrating its own retrieval process with phrases like "Based on our previous conversation". These are banned. Just know things — don\'t announce retrieval.',
      });
    }

    // Short unhelpful responses
    const tooShort = texts.filter(t=>t.length < 80 && t.length > 0).length;
    if (tooShort > aiMessages.length * 0.2) {
      findings.push({
        id: 'resp_too_short',
        severity: SEVERITY.LOW,
        category: 'response',
        title: 'Some responses are unusually brief',
        description: `${tooShort} responses were under 80 characters. While brevity is good, very short responses may indicate incomplete answers or missed context.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: Some responses are too brief. When asked substantive questions, provide complete answers even if concise. Avoid single-sentence responses to complex queries.',
      });
    }
  }

  async function _analyzeToolUsage({ aiMessages, WEB_SEARCH_ENABLED, FILES, SEL, TOOLS_CONFIG, findings }) {
    const texts = aiMessages.map(m=>m.content||'').join(' ');

    // Web search not used but responses mention outdated info
    const outdatedSignals = _count(texts, /as of my (training|knowledge|cutoff)|I don't have (real.time|current|live)|my training data/gi);
    if (!WEB_SEARCH_ENABLED && outdatedSignals > 2) {
      findings.push({
        id: 'tool_web_search_off',
        severity: SEVERITY.MEDIUM,
        category: 'tools',
        title: 'Web search off but AI acknowledging stale data',
        description: `Web search is disabled, and ${outdatedSignals} responses acknowledge potentially stale information. Enabling web search would remove this limitation for current-events queries.`,
        actionType: 'configuration',
        actions: [{ label:'Enable Web Search', cmd:'toggleWebSearch()' }],
        learnContent: 'SYSTEM IMPROVEMENT: When web search is enabled, proactively use it for queries about current events, API versions, prices, or anything that may have changed since training. Do not wait to be asked.',
      });
    }

    // Files loaded but not referenced
    const fileCount = Object.keys(FILES || {}).length;
    const fileRefs  = _count(texts, /\.(js|ts|py|md|json|txt|html|css)\b/gi);
    if (fileCount > 3 && fileRefs < 2) {
      findings.push({
        id: 'tool_files_not_used',
        severity: SEVERITY.LOW,
        category: 'tools',
        title: 'Files loaded but rarely referenced in responses',
        description: `${fileCount} files are loaded but AI responses rarely reference file content. This may indicate the AI is answering from training knowledge rather than the actual loaded files.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: When files are loaded in context, prioritise their actual content over training knowledge. Reference file paths explicitly in responses.',
      });
    }



    // Check Obsidian tool config
    const obs = (TOOLS_CONFIG||{}).obsidian || {};
    if (!obs.configured) {
      findings.push({
        id: 'tool_obsidian_unconfigured',
        severity: SEVERITY.INFO,
        category: 'tools',
        title: 'Obsidian Knowledge Tool not configured',
        description: 'The Obsidian integration is available but not set up. This tool can automatically convert conversations into Zettelkasten notes, creating a personal knowledge base from every session.',
        actionType: 'configuration',
        actions: [{ label:'Configure Obsidian', cmd:"openObsidianTool()" }],
        learnContent: '',
      });
    }
  }

  async function _analyzeModelPerformance({ allMessages, CONFIG, findings }) {
    const texts = allMessages.map(m=>m.content||'').join(' ');

    // Error/rate limit occurrences
    const rateErrors   = _count(texts, /rate limit|429|quota exceeded/gi);
    const authErrors   = _count(texts, /auth error|invalid.*key|api key error/gi);
    const timeouts     = _count(texts, /timed out|timeout.*request/gi);

    if (rateErrors > 2) {
      findings.push({
        id: 'model_rate_limit',
        severity: SEVERITY.HIGH,
        category: 'model',
        title: 'Frequent rate limit hits',
        description: `Detected ${rateErrors} rate-limit events. This causes response delays and interruptions. Add extra API keys in Settings to enable automatic key rotation.`,
        actionType: 'configuration',
        actions: [{ label:'Open Settings', cmd:"openSettings()" }],
        learnContent: 'SYSTEM IMPROVEMENT: Rate limits are being hit frequently. Remind user to add extra API keys for automatic rotation. Also: reduce unnecessary large context prompts to use fewer tokens per request.',
      });
    }

    if (authErrors > 0) {
      findings.push({
        id: 'model_auth_errors',
        severity: SEVERITY.CRITICAL,
        category: 'model',
        title: 'API authentication errors detected',
        description: `Found ${authErrors} authentication failures. Check that API keys are valid and haven't expired.`,
        actionType: 'configuration',
        actions: [{ label:'Open Settings', cmd:"openSettings()" }],
        learnContent: '',
      });
    }

    // GitHub Models token budget issues
    if (CONFIG.provider === 'github') {
      const truncated = _count(texts, /413|token.*limit|too large/gi);
      if (truncated > 0) {
        findings.push({
          id: 'model_github_budget',
          severity: SEVERITY.MEDIUM,
          category: 'model',
          title: 'GitHub Models token budget exceeded',
          description: `DeepSeek V3/R1 on GitHub Models has a very limited input budget (~4,000 tokens). Use GPT-4o mini or Llama 3.3 70B for general chat; reserve DeepSeek for the Code Analyst agent.`,
          actionType: 'configuration',
          actions: [{ label:'Switch Model', cmd:"openSettings()" }],
          learnContent: 'SYSTEM IMPROVEMENT: GitHub Models token budget is being exceeded. For general chat, recommend GPT-4o mini or Llama 3.3 70B. DeepSeek models should only be used for focused code analysis.',
        });
      }
    }

    // Model-specific recommendations
    if (CONFIG.provider === 'groq' && !CONFIG.groqKey) {
      findings.push({
        id: 'model_no_key',
        severity: SEVERITY.CRITICAL,
        category: 'model',
        title: 'No Groq API key configured',
        description: 'SCAAI cannot make AI calls without a valid API key.',
        actionType: 'configuration',
        actions: [{ label:'Open Settings', cmd:"openSettings()" }],
        learnContent: '',
      });
    }
  }

  async function _analyzeContext({ FILES, SEL, allChats, CONV_HISTORY, findings }) {
    const fileCount = Object.keys(FILES||{}).length;

    // Large files eating context
    const largeFiles = Object.entries(FILES||{}).filter(([,v])=>(v.content||'').length > 8000);
    if (largeFiles.length > 2) {
      findings.push({
        id: 'ctx_large_files',
        severity: SEVERITY.MEDIUM,
        category: 'context',
        title: `${largeFiles.length} large files consuming token budget`,
        description: `Large files (${largeFiles.map(([p])=>p.split(/[\/\\]/).pop()).join(', ')}) are in context. Files above ~8,000 characters use cached summaries, which may lose detail. Consider using Codebase Mode for large projects instead of loading raw files.`,
        actionType: 'configuration',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: Large files are loaded directly. For large codebases, recommend Codebase Mode (which builds a structural index) instead of raw file loading. Always notify user when a file is too large for full inclusion.',
      });
    }

    // No files loaded in code sessions
    const codeChats = allChats.filter(c =>
      (c.messages||[]).some(m => /\b(code|function|class|bug|fix|script|refactor)\b/i.test(m.content||''))
    );
    if (codeChats.length > 3 && fileCount === 0) {
      findings.push({
        id: 'ctx_no_files_code',
        severity: SEVERITY.LOW,
        category: 'context',
        title: 'Code discussions happening without loaded files',
        description: `${codeChats.length} past sessions involved code topics but no files were loaded. Loading relevant files gives SCAAI exact content to work with instead of relying on code typed in chat.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: When user asks about code without loading files, proactively ask: "Would you like to load the relevant file? That would let me give you more precise answers based on the actual code."',
      });
    }
  }

  async function _analyzeInteraction({ userMessages, aiMessages, allChats, USER_PROFILE, findings }) {
    if (!userMessages.length) return;

    // Topic analysis
    const allText = userMessages.map(m=>m.content||'').join(' ').toLowerCase();

    // Detect if user frequently asks for things then restates
    const restatements = _count(allText, /\b(actually|no wait|i meant|let me rephrase|correction|never mind|disregard)\b/gi);
    if (restatements > 5) {
      findings.push({
        id: 'interact_frequent_restate',
        severity: SEVERITY.MEDIUM,
        category: 'interaction',
        title: 'User frequently correcting or rephrasing requests',
        description: `Found ${restatements} restatement/correction signals. This suggests SCAAI may be misinterpreting intent, acting too quickly, or not asking clarifying questions before proceeding.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: User frequently corrects or rephrases. Before executing ambiguous multi-step tasks, ask ONE clarifying question. Confirm interpretation before acting rather than assuming.',
      });
    }

    // Detect repeat questions (user asking same thing multiple times)
    const questionPatterns = userMessages.map(m=>(m.content||'').slice(0,80).toLowerCase());
    const seen = new Set(); let repeats = 0;
    questionPatterns.forEach(q => {
      const key = q.replace(/[^a-z0-9 ]/g,'').slice(0,40);
      if (seen.has(key) && key.length > 10) repeats++;
      seen.add(key);
    });
    if (repeats > 3) {
      findings.push({
        id: 'interact_repeated_questions',
        severity: SEVERITY.HIGH,
        category: 'interaction',
        title: 'User asking the same questions multiple times',
        description: `Detected ~${repeats} repeated queries. This strongly suggests SCAAI is either not retaining answers between sessions or not surfacing stored knowledge when it should.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'CRITICAL SYSTEM IMPROVEMENT: User is re-asking questions already answered. Memory recall must be more proactive. When a question matches a prior session topic, surface the stored answer immediately.',
      });
    }

    // Check if user profile is being built
    if (!USER_PROFILE?.name && userMessages.length > 30) {
      findings.push({
        id: 'interact_no_profile',
        severity: SEVERITY.MEDIUM,
        category: 'interaction',
        title: 'User profile not being built from conversations',
        description: `After ${userMessages.length}+ messages, no name or preferences have been learned. Auto-learning should extract identity facts from natural conversation.`,
        actionType: 'ai-fixable',
        actions: [{ label:'Run Auto-Learn', cmd:"semAutoLearn()" }],
        learnContent: 'SYSTEM IMPROVEMENT: User profile is not being built. Must extract name, location, profession, projects, and preferences from natural conversation and store as identity/preference facts.',
      });
    }

    // Check for frustration signals
    const frustration = _count(allText, /\b(still|again|keep|always|why|doesn'?t|can'?t|not working|broken|wrong|terrible|awful|useless|waste)\b/gi);
    if (frustration > 10) {
      findings.push({
        id: 'interact_frustration',
        severity: SEVERITY.HIGH,
        category: 'interaction',
        title: 'Frustration signals in conversation history',
        description: `Detected ~${frustration} frustration-indicating words. The user may be experiencing friction with SCAAI's responses — likely related to other findings in this report.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: User shows frustration signals. Priority: acknowledge when something is not working, propose specific alternatives immediately rather than restating the original approach.',
      });
    }
  }

  async function _analyzeCapabilityGaps({ allMessages, TOOLS_CONFIG, SEM_READY, findings }) {
    const allText = allMessages.map(m=>m.content||'').join(' ').toLowerCase();

    // Check for feature requests user made
    const featureRequests = _count(allText, /\b(can you|could you|is it possible|would it be|wish you could|it would be nice if|feature request)\b/gi);
    if (featureRequests > 5) {
      findings.push({
        id: 'cap_feature_requests',
        severity: SEVERITY.INFO,
        category: 'capability',
        title: `${featureRequests} potential feature requests detected`,
        description: 'User has expressed desires for new capabilities. Review chat history for specific requests and consider whether they can be achieved via Skills, prompting, or code changes.',
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: User has expressed feature wishes. When a capability gap is identified, proactively: (1) check if an existing skill can fill it, (2) suggest creating a new skill, (3) recommend a code enhancement if needed.',
      });
    }

    // System instructions not configured
    const sysInstr = (TOOLS_CONFIG?.systemInstructions||'').trim();
    if (!sysInstr) {
      findings.push({
        id: 'cap_no_sys_instr',
        severity: SEVERITY.LOW,
        category: 'capability',
        title: 'No permanent system instructions set',
        description: 'System instructions (Tools tab) are empty. Permanent instructions let you customise SCAAI\'s default behaviour, response style, and areas of expertise without prompting every session.',
        actionType: 'configuration',
        actions: [{ label:'Open Tools Panel', cmd:"ovOpenPanel('tool')" }],
        learnContent: '',
      });
    }

    // Check if session summaries are stored
    if (SEM_READY && allMessages.length > 40) {
      findings.push({
        id: 'cap_session_continuity',
        severity: SEVERITY.INFO,
        category: 'capability',
        title: 'Session continuity check',
        description: 'Use the "End Session" button in the SEM tab at the end of important work sessions. This stores a structured summary that SCAAI retrieves at the start of the next session to continue where you left off.',
        actionType: 'configuration',
        actions: [{ label:'End Session Now', cmd:"_storeSessionSummary(true)" }],
        learnContent: '',
      });
    }

    // Mermaid diagrams not being used
    const diagramKeywords = _count(allText, /\b(diagram|flowchart|architecture|flow|sequence|chart|graph|visualize|draw|sketch)\b/gi);
    const diagramOutputs  = _count(allMessages.filter(m=>m.role==='ai').map(m=>m.content||'').join(' '), /```mermaid/gi);
    if (diagramKeywords > 5 && diagramOutputs < 2) {
      findings.push({
        id: 'cap_diagrams_underused',
        severity: SEVERITY.LOW,
        category: 'capability',
        title: 'Mermaid diagrams underused despite diagram-heavy topics',
        description: `Detected ${diagramKeywords} diagram-related keywords but only ${diagramOutputs} Mermaid diagrams produced. SCAAI can auto-generate live diagrams — should use them more proactively.`,
        actionType: 'ai-fixable',
        actions: [],
        learnContent: 'SYSTEM IMPROVEMENT: Should generate Mermaid diagrams more proactively when discussing architecture, flows, sequences, or relationships. Do not wait to be asked — offer a diagram when it would clarify.',
      });
    }
  }

  // ── Learn from a specific finding ────────────────────────────────
  async function learnFinding(finding, A) {
    if (!finding.learnContent) return { ok:false, error:'No learn content for this finding' };
    try {
      const content = `[TYPE:improvement][LABEL:finding_${finding.id}][DATE:${new Date().toISOString().slice(0,10)}]\n${finding.learnContent}\nCategory: ${finding.category} | Severity: ${finding.severity}`;
      const r = await A.sem.learn({ content, label:'finding_'+finding.id, tags:['system_improvement','finding',finding.category], source:'system_findings' });
      return r;
    } catch(e) { return { ok:false, error:e.message }; }
  }

  // ── Learn from ALL findings ───────────────────────────────────────
  async function learnAllFindings(findings, A) {
    const results = { learned:0, skipped:0 };
    for (const f of findings) {
      if (!f.learnContent) { results.skipped++; continue; }
      const r = await learnFinding(f, A);
      if (r && r.ok) results.learned++;
      else results.skipped++;
    }
    return results;
  }

  // ── Build "Feed to AI" prompt ──────────────────────────────────────
  function buildAIPrompt(findings, selectedIds) {
    const selected = selectedIds.length
      ? findings.filter(f => selectedIds.includes(f.id))
      : findings.filter(f => ['critical','high'].includes(f.severity));

    const lines = selected.map((f,i) =>
      `${i+1}. [${f.severity.toUpperCase()}] ${f.title}: ${f.description}`
    );

    return `I ran a system analysis on SCAAI and found the following issues. Please review each and tell me:\n1. Your current behaviour that causes this\n2. How you will change going forward\n3. Whether a code change is truly needed or if a behaviour change is sufficient\n\nFindings:\n${lines.join('\n\n')}\n\nFor each finding, be specific and commit to a concrete change.`;
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    SEVERITY,
    CATEGORIES,
    runAnalysis,
    learnFinding,
    learnAllFindings,
    buildAIPrompt,
    getLastReport: () => _lastReport,
    getLastRunTs:  () => _lastRunTs,
    isRunning:     () => _running,
  };
})();

// Export for use in index.html via window
if (typeof window !== 'undefined') window.SystemFindings = SystemFindings;
if (typeof module !== 'undefined') module.exports = SystemFindings;
