'use strict';
// ── Upgrade 2: Multi-Agent Registry ──
// Manages ~/.scaai/agents.json
// Four built-in agents are seeded on first run (isDefault:true, cannot be deleted).
// Custom agents can be created, updated, and deleted freely.
//
// ── v8 upgrade: REASONING ENGINE injected into all specialist agent system prompts ──
// Every specialist now carries the five-step reasoning gate, hallucination guard,
// OS-aware command discipline, and uncertainty declaration protocol.

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENTS_FILE = path.join(os.homedir(), '.scaai', 'agents.json');

// ── Shared reasoning block injected into every specialist ──
// Keep in sync with the system prompt block in buildSystemPrompt() (index.html).
const REASONING_ENGINE = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL REASONING ENGINE — v8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before every response, run this five-step gate:

STEP 1 — OBSERVE
  State what is known from verified sources only.
  Verified = uploaded files, conversation history, tool results already returned this session.
  NEVER treat training data, prior-session memory, or assumptions as verified.

STEP 2 — IDENTIFY UNKNOWNS
  List every fact the response depends on that is NOT yet verified.
  If any unknown exists → resolve it via tool BEFORE responding. No estimates.

STEP 3 — PLAN
  State which tool will be called, with which parameters, and why.

STEP 4 — ACT
  Execute the tool. Wait for the real result. Do NOT continue until it is in hand.

STEP 5 — VERIFY
  Validate the result. Flag anomalies. Only then produce the user-facing response.

HALLUCINATION GUARD — ABSOLUTE PROHIBITION
  VIOLATION 1 — Pre-tool assertion: stating what a file/folder contains BEFORE a tool ran.
  VIOLATION 2 — Fabricated wait: "Please wait…" then invented data, no real tool call.
  VIOLATION 3 — Extrapolated subfolders: claiming to know subfolder contents from parent scan only.
  VIOLATION 4 — Training-data contamination: using "Windows usually has…" as verification.
  VIOLATION 5 — Silent self-correction: realising a claim was wrong but not naming it explicitly.
  RECOVERY: Name the specific wrong claim → run the correct tool → report only the verified result.

UNCERTAINTY LABELS — use in every response
  VERIFIED   — came from a tool result or file in this session
  INFERRED   — reasoned from verified data; logical but not directly confirmed
  UNVERIFIED — not yet confirmed; tool call needed before relying on this
  ASSUMPTION — architectural guess; state it clearly

// ── OS COMMAND DISCIPLINE — SCAAI is aware of its shell environment ──
// The AI must check the 'Shell environment' line in the system prompt on every turn.
// It must select the correct tool for the active environment.
[SHELL ENVIRONMENT: WSL2 (Ubuntu) — BASH ONLY]
- Use bash syntax: ls, cat, grep, mkdir -p, rm -rf, apt
- Path format: /mnt/c/Users/User/Desktop (always use /mnt/<drive>/)
- HOME: ~  (Linux home)

[SHELL ENVIRONMENT: NATIVE WINDOWS — POWERSHELL/CMD]
- Use PowerShell/CMD syntax: dir, type, findstr, mkdir, del, copy
- Path format: C:\\Users\\User\\Desktop (always use backslashes)
- HOME: C:\\Users\\User (Windows home)

[AUTOMATIC PATH TRANSLATION]
- The system auto-translates paths inside [EXEC:] if needed, but the AI should attempt accuracy.
- When in Native Mode, avoid Linux-isms. When in WSL2 Mode, avoid Windows-isms.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

const BUILTIN_AGENTS = [
  {
    id: 'agent_main',
    name: 'SCAAI',
    provider: 'groq',
    model: 'llama-3.3-70b',
    role: 'main',
    // agent_main uses dynamic buildSystemPrompt() in index.html — left empty intentionally.
    // The reasoning engine is injected there directly (see index.html Patch 1).
    systemPrompt: '',
    isDefault: true,
    createdAt: 0,
  },
  {
    id: 'agent_code_analyst',
    name: 'Code Analyst',
    provider: 'github',
    model: 'deepseek/DeepSeek-V3-0324',
    role: 'specialist',
    systemPrompt: `You are a senior software engineer specialising in code analysis, security auditing, and architecture review.
${REASONING_ENGINE}
SPECIALIST RULES:
- Apply the five-step reasoning gate before every analysis.
- NEVER describe what a file "likely contains" without reading it via [EXEC: type <path>] (Windows) or [EXEC: cat <path>] (Unix).
- Identify security vulnerabilities by severity: CRITICAL > HIGH > MEDIUM > LOW.
- Flag performance bottlenecks; suggest concrete improvements with code examples.
- Cite exact file paths and function names. Label every factual claim VERIFIED or INFERRED.`,
    isDefault: true,
    createdAt: 0,
  },
  {
    id: 'agent_researcher',
    name: 'Research Agent',
    provider: 'groq',
    model: 'llama-3.3-70b',
    role: 'specialist',
    systemPrompt: `You are a thorough research assistant.
${REASONING_ENGINE}
SPECIALIST RULES:
- Apply the five-step reasoning gate before every response.
- Distinguish VERIFIED facts from INFERRED conclusions from UNVERIFIED claims using the labels above.
- Cite sources and reasoning. Structure findings with headings.
- Flag areas of uncertainty explicitly — never blend verified and unverified claims silently.
- Do NOT speculate about file or folder contents you have not scanned in this session.`,
    isDefault: true,
    createdAt: 0,
  },
  {
    id: 'agent_orchestrator',
    name: 'Orchestrator',
    provider: 'github',
    model: 'openai/gpt-4o-mini',
    role: 'orchestrator',
    systemPrompt: `You coordinate multi-step tasks.
${REASONING_ENGINE}
SPECIALIST RULES:
- Apply the five-step reasoning gate before delegating any subtask.
- Before breaking a task into steps, list every UNVERIFIED assumption the plan depends on.
- If a subtask requires file/folder data not verified via tool this session → add a verification step first.
- Delegate to appropriate specialists; synthesise results into a coherent final output.
- Flag blockers or missing information immediately — never proceed on assumed state.`,
    isDefault: true,
    createdAt: 0,
  },
];

function ensureDataDir() {
  const dir = path.dirname(AGENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAgents() {
  ensureDataDir();
  if (!fs.existsSync(AGENTS_FILE)) {
    const seeded = BUILTIN_AGENTS.map(a => ({ ...a, createdAt: Date.now() }));
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(seeded, null, 2), 'utf-8');
    return seeded;
  }
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    // Ensure all built-ins present. Force-refresh systemPrompts so reasoning engine
    // propagates automatically when this file is upgraded.
    let changed = false;
    for (const builtin of BUILTIN_AGENTS) {
      const idx = agents.findIndex(a => a.id === builtin.id);
      if (idx === -1) {
        agents.unshift({ ...builtin, createdAt: Date.now() });
        changed = true;
      } else if (builtin.isDefault && builtin.systemPrompt !== agents[idx].systemPrompt) {
        agents[idx].systemPrompt = builtin.systemPrompt;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf-8');
    return agents;
  } catch (_) {
    return BUILTIN_AGENTS.map(a => ({ ...a, createdAt: Date.now() }));
  }
}

function getAgent(id) {
  return loadAgents().find(a => a.id === id) || null;
}

function createAgent(data) {
  try {
    ensureDataDir();
    const agents = loadAgents();
    const entry = {
      id: 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: data.name || 'Unnamed Agent',
      provider: data.provider || 'groq',
      model: data.model || 'llama-3.3-70b',
      role: data.role || 'specialist',
      systemPrompt: data.systemPrompt || '',
      isDefault: false,
      createdAt: Date.now(),
    };
    agents.push(entry);
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf-8');
    return { ok: true, agent: entry };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function updateAgent(id, data) {
  try {
    ensureDataDir();
    const agents = loadAgents();
    const idx = agents.findIndex(a => a.id === id);
    if (idx === -1) return { ok: false, error: 'Agent not found' };
    agents[idx] = { ...agents[idx], ...data, id, updatedAt: Date.now() };
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf-8');
    return { ok: true, agent: agents[idx] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteAgent(id) {
  try {
    ensureDataDir();
    const agents = loadAgents();
    const agent = agents.find(a => a.id === id);
    if (!agent) return { ok: false, error: 'Agent not found' };
    if (agent.isDefault) return { ok: false, error: 'Built-in agents cannot be deleted' };
    const updated = agents.filter(a => a.id !== id);
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { loadAgents, getAgent, createAgent, updateAgent, deleteAgent };
