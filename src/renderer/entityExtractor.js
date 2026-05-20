'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 * SCAAI ENTITY EXTRACTOR (v1.0.0)
 *
 * Deterministic entity extraction and relationship inference
 * without any LLM dependency. Uses the `compromise` NLP library
 * for linguistic parsing and a curated technology dictionary
 * for domain-specific recognition.
 *
 * Architecture position (load order):
 *   cognitiveEngine.js → entityExtractor.js → reflectionEngine.js
 *
 * Exports:
 *   window._extractEntities(text)        → { people, tech, concepts, places, orgs, all }
 *   window._extractRelationships(text)   → [{ source, target, relation }]
 *   window._extractPersonalFacts(text)   → { name, job, location, interests, preferences }
 *   window._buildGraphPayload(userMsg, aiResponse) → { nodes: [], edges: [] }
 *
 * Note: `compromise` is loaded via CDN script tag in index.html.
 *       If unavailable, falls back to regex-based extraction.
 * ════════════════════════════════════════════════════════════════
 */

// ── TECHNOLOGY DICTIONARY ─────────────────────────────────────────────────────
// Curated list of technologies, frameworks, languages, tools.
// Kept as a Set for O(1) lookup. Lowercase for case-insensitive matching.
const _EE_TECH = new Set([
  // Languages
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'rust',
  'go', 'golang', 'ruby', 'php', 'dart', 'lua', 'scala', 'elixir',
  'haskell', 'clojure', 'perl', 'r', 'matlab', 'sql', 'html', 'css',
  'scss', 'sass', 'less', 'graphql', 'solidity', 'zig', 'nim', 'julia',
  // Frontend
  'react', 'reactjs', 'vue', 'vuejs', 'angular', 'svelte', 'nextjs',
  'next.js', 'nuxt', 'nuxtjs', 'gatsby', 'remix', 'astro', 'vite',
  'webpack', 'rollup', 'esbuild', 'parcel', 'turbopack', 'tailwind',
  'tailwindcss', 'bootstrap', 'material-ui', 'mui', 'chakra', 'shadcn',
  'storybook', 'cypress', 'playwright', 'puppeteer', 'jest', 'vitest',
  'mocha', 'jasmine', 'redux', 'zustand', 'mobx', 'recoil', 'jotai',
  'tanstack', 'framer-motion', 'three.js', 'threejs', 'd3', 'd3js',
  // Backend
  'node', 'nodejs', 'express', 'express.js', 'fastify', 'koa', 'hapi',
  'nestjs', 'django', 'flask', 'fastapi', 'spring', 'springboot',
  'laravel', 'rails', 'sinatra', 'gin', 'fiber', 'actix', 'rocket',
  'axum', 'phoenix', 'asp.net', 'dotnet', '.net',
  // Database
  'postgresql', 'postgres', 'mysql', 'mariadb', 'sqlite', 'mongodb',
  'redis', 'elasticsearch', 'dynamodb', 'cassandra', 'couchdb',
  'neo4j', 'arangodb', 'cockroachdb', 'planetscale', 'supabase',
  'firebase', 'firestore', 'prisma', 'drizzle', 'typeorm', 'sequelize',
  'knex', 'mongoose', 'chromadb', 'chroma', 'pinecone', 'weaviate',
  'qdrant', 'milvus', 'faiss',
  // AI/ML
  'openai', 'gpt', 'gpt-4', 'gpt-3', 'chatgpt', 'claude', 'anthropic',
  'gemini', 'llama', 'mistral', 'ollama', 'huggingface', 'transformers',
  'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy',
  'langchain', 'llamaindex', 'autogen', 'crewai', 'semantic-kernel',
  'onnx', 'stable-diffusion', 'midjourney', 'dall-e', 'whisper',
  'embedding', 'embeddings', 'rag', 'vector', 'tokenizer',
  // Cloud & DevOps
  'aws', 'azure', 'gcp', 'vercel', 'netlify', 'heroku', 'digitalocean',
  'cloudflare', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
  'jenkins', 'github-actions', 'gitlab-ci', 'circleci', 'nginx', 'apache',
  'caddy', 'traefik', 'prometheus', 'grafana', 'datadog', 'sentry',
  // Tools & Platforms
  'git', 'github', 'gitlab', 'bitbucket', 'jira', 'confluence', 'notion',
  'figma', 'sketch', 'postman', 'insomnia', 'vscode', 'vim', 'neovim',
  'intellij', 'webstorm', 'xcode', 'android-studio', 'electron',
  'tauri', 'capacitor', 'ionic', 'flutter', 'react-native', 'expo',
  // Protocols & Standards
  'rest', 'restful', 'grpc', 'websocket', 'websockets', 'mqtt', 'http',
  'https', 'oauth', 'oauth2', 'jwt', 'saml', 'openid', 'cors',
  'sse', 'server-sent-events', 'webrtc', 'wasm', 'webassembly',
  // Concepts
  'api', 'microservices', 'monolith', 'serverless', 'jamstack',
  'ci/cd', 'devops', 'agile', 'scrum', 'kanban', 'tdd', 'bdd',
  'orm', 'crud', 'mvc', 'mvvm', 'spa', 'ssr', 'ssg', 'isr', 'csr',
  'pwa', 'a11y', 'i18n', 'seo', 'cdn', 'dns', 'ssl', 'tls',
]);

// ── PERSONAL FACT PATTERNS ───────────────────────────────────────────────────
// Regex patterns for detecting personal information disclosures.
const _EE_NAME_PATTERNS = [
  /my name is (\w+(?:\s+\w+)?)/i,
  /i'?m (\w+(?:\s+\w+)?),?\s+(?:and|a|the|from|by|at)/i,
  /call me (\w+)/i,
  /(?:i am|i'm) (\w+)$/i,
  /(?:it's|this is) (\w+)(?:\s+here)?$/i,
];

const _EE_JOB_PATTERNS = [
  /i (?:work as|am) (?:a |an )?(.{3,40}?)(?: at| for| in| and|\.|$)/i,
  /my (?:job|role|title|position) is (.{3,40}?)(?:\.|,|$)/i,
  /i'?m (?:a |an )?(.{3,40}?)(?:developer|engineer|designer|manager|architect|analyst|scientist|consultant|specialist)/i,
];

const _EE_LOCATION_PATTERNS = [
  /i (?:live|am|stay|reside) in (.{2,40}?)(?:\.|,|$)/i,
  /(?:i'm|i am) from (.{2,40}?)(?:\.|,|$)/i,
  /(?:based|located) in (.{2,40}?)(?:\.|,|$)/i,
];

const _EE_INTEREST_PATTERNS = [
  /i (?:like|love|enjoy|prefer|am interested in|am passionate about) (.{3,80}?)(?:\.|,|$)/i,
  /my (?:hobby|interest|passion|favorite) (?:is|are) (.{3,60}?)(?:\.|,|$)/i,
  /i'?m (?:into|interested in|passionate about) (.{3,60}?)(?:\.|,|$)/i,
];

// ── RELATIONSHIP PATTERNS ────────────────────────────────────────────────────
// Sentence patterns that imply entity-to-entity relationships.
const _EE_REL_PATTERNS = [
  { regex: /(\w+(?:\.\w+)?)\s+(?:uses?|utilizes?|leverages?)\s+(\w+(?:\.\w+)?)/gi, relation: 'uses' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:depends? on|requires?|needs?)\s+(\w+(?:\.\w+)?)/gi, relation: 'depends_on' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:integrates?|connects?|interfaces?) with\s+(\w+(?:\.\w+)?)/gi, relation: 'integrates_with' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:is built|built) (?:with|on|using)\s+(\w+(?:\.\w+)?)/gi, relation: 'built_with' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:replaces?|supersedes?|is (?:an? )?alternative to)\s+(\w+(?:\.\w+)?)/gi, relation: 'replaces' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:extends?|inherits? from|is based on)\s+(\w+(?:\.\w+)?)/gi, relation: 'extends' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:calls?|invokes?|triggers?)\s+(\w+(?:\.\w+)?)/gi, relation: 'calls' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:stores?|persists?|saves?) (?:to|in|into)\s+(\w+(?:\.\w+)?)/gi, relation: 'stores_in' },
  { regex: /(\w+(?:\.\w+)?)\s+(?:runs? on|deployed (?:on|to)|hosted (?:on|at))\s+(\w+(?:\.\w+)?)/gi, relation: 'runs_on' },
];

// ── STOPWORDS (entities to ignore) ───────────────────────────────────────────
const _EE_STOPS = new Set([
  'the', 'this', 'that', 'these', 'those', 'then', 'than', 'them',
  'they', 'their', 'there', 'here', 'where', 'when', 'what', 'which',
  'who', 'whom', 'whose', 'how', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'must', 'shall', 'have', 'has', 'had',
  'been', 'being', 'are', 'were', 'was', 'does', 'did', 'done',
  'doing', 'make', 'made', 'get', 'got', 'set', 'let', 'say', 'said',
  'also', 'just', 'very', 'really', 'actually', 'basically', 'probably',
  'maybe', 'sure', 'okay', 'well', 'now', 'still', 'already', 'yet',
  'but', 'and', 'not', 'with', 'from', 'into', 'about', 'for',
  'want', 'need', 'like', 'know', 'think', 'use', 'try', 'look',
  'come', 'see', 'take', 'give', 'tell', 'ask',
  'yes', 'yeah', 'yep', 'nope', 'right', 'true', 'false',
  'something', 'anything', 'everything', 'nothing', 'someone',
  'continue', 'please', 'thanks', 'thank',
  // Common code words that aren't entities
  'function', 'return', 'const', 'import', 'export', 'class',
  'async', 'await', 'null', 'undefined', 'string', 'number',
  'boolean', 'object', 'array', 'error', 'true', 'false',
]);

// ── COMPROMISE NLP CHECK ──────────────────────────────────────────────────────
function _hasNlp() {
  return typeof nlp !== 'undefined' && typeof nlp === 'function';
}

// ── ENTITY EXTRACTION ─────────────────────────────────────────────────────────

/**
 * Extract structured entities from text.
 * Uses compromise NLP if available, falls back to regex.
 *
 * @param {string} text — raw text to extract from
 * @returns {{ people: string[], tech: string[], concepts: string[], places: string[], orgs: string[], all: Array<{label: string, type: string}> }}
 */
window._extractEntities = function(text) {
  if (!text || typeof text !== 'string') {
    return { people: [], tech: [], concepts: [], places: [], orgs: [], all: [] };
  }

  const result = { people: [], tech: [], concepts: [], places: [], orgs: [], all: [] };
  const seen = new Set();

  const _add = (label, type) => {
    const key = label.toLowerCase();
    if (seen.has(key) || _EE_STOPS.has(key) || key.length < 2) return;
    seen.add(key);
    result.all.push({ label, type });
    if (type === 'Person') result.people.push(label);
    else if (type === 'Tech') result.tech.push(label);
    else if (type === 'Place') result.places.push(label);
    else if (type === 'Organization') result.orgs.push(label);
    else result.concepts.push(label);
  };

  // ── 1. Technology dictionary scan (always runs) ─────────────────────────
  const lower = text.toLowerCase();
  const words = lower.replace(/[^a-z0-9.\-/\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (_EE_TECH.has(w)) {
      _add(w, 'Tech');
    }
  }
  // Also check multi-word tech terms
  for (const term of _EE_TECH) {
    if (term.includes('.') || term.includes('-')) {
      if (lower.includes(term)) _add(term, 'Tech');
    }
  }

  // ── 2. NLP-based extraction (compromise) ────────────────────────────────
  if (_hasNlp()) {
    try {
      const doc = nlp(text);

      // People
      doc.people().out('array').forEach(p => {
        const clean = p.trim();
        if (clean.length > 1 && clean.length < 60) _add(clean, 'Person');
      });

      // Places
      doc.places().out('array').forEach(p => {
        const clean = p.trim();
        if (clean.length > 1 && clean.length < 60) _add(clean, 'Place');
      });

      // Organizations
      doc.organizations().out('array').forEach(o => {
        const clean = o.trim();
        if (clean.length > 1 && clean.length < 60) _add(clean, 'Organization');
      });

      // Nouns (general concepts)
      doc.nouns().out('array').forEach(n => {
        const clean = n.trim().toLowerCase();
        if (clean.length > 3 && !_EE_STOPS.has(clean) && !seen.has(clean)) {
          _add(clean, 'Concept');
        }
      });

      // Topics / hashtags
      doc.topics().out('array').forEach(t => {
        const clean = t.trim();
        if (clean.length > 1 && !seen.has(clean.toLowerCase())) {
          _add(clean, 'Concept');
        }
      });
    } catch (e) {
      console.warn('[ENTITY EXTRACTOR] compromise NLP error:', e.message);
    }
  }

  // ── 3. Regex fallback (always runs as supplement) ───────────────────────
  // Capitalized proper nouns (not at sentence start)
  const properNouns = text.match(/(?<=[.!?\n]\s+|\b[a-z]+\s+)[A-Z][a-z]{2,}/g) || [];
  properNouns.forEach(p => {
    if (!_EE_STOPS.has(p.toLowerCase())) _add(p, 'Concept');
  });

  // Code identifiers (backtick-wrapped)
  const codeRefs = text.match(/`([^`]{2,40})`/g) || [];
  codeRefs.forEach(c => {
    const clean = c.replace(/`/g, '');
    _add(clean, 'Tech');
  });

  // File references
  const fileRefs = text.match(/\b\w+\.(js|ts|py|jsx|tsx|css|html|json|yaml|yml|sql|md)\b/g) || [];
  fileRefs.forEach(f => _add(f, 'Tech'));

  // CamelCase / PascalCase identifiers (likely code constructs)
  const camelCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,4}\b/g) || [];
  camelCase.forEach(c => {
    if (c.length > 4 && !_EE_STOPS.has(c.toLowerCase())) _add(c, 'Concept');
  });

  return result;
};


// ── RELATIONSHIP EXTRACTION ──────────────────────────────────────────────────

/**
 * Extract entity-to-entity relationships from text.
 *
 * @param {string} text — raw text to analyze
 * @returns {Array<{source: string, target: string, relation: string}>}
 */
window._extractRelationships = function(text) {
  if (!text || typeof text !== 'string') return [];

  const relationships = [];
  const seen = new Set();

  for (const pat of _EE_REL_PATTERNS) {
    let match;
    const regex = new RegExp(pat.regex.source, pat.regex.flags);
    while ((match = regex.exec(text)) !== null) {
      const src = match[1].trim().toLowerCase();
      const tgt = match[2].trim().toLowerCase();
      if (src.length < 2 || tgt.length < 2) continue;
      if (_EE_STOPS.has(src) || _EE_STOPS.has(tgt)) continue;
      if (src === tgt) continue;

      const sig = `${src}->${tgt}:${pat.relation}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      relationships.push({ source: src, target: tgt, relation: pat.relation });
    }
  }

  return relationships;
};


// ── PERSONAL FACT EXTRACTION ─────────────────────────────────────────────────

/**
 * Extract personal facts from user message.
 * Only extracts from first-person statements (the user talking about themselves).
 *
 * @param {string} text — user's raw message
 * @returns {{ name: string, job: string, location: string, interests: string, preferences: string }}
 */
window._extractPersonalFacts = function(text) {
  if (!text || typeof text !== 'string') {
    return { name: '', job: '', location: '', interests: '', preferences: '' };
  }

  const facts = { name: '', job: '', location: '', interests: '', preferences: '' };

  for (const pat of _EE_NAME_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length > 1 && m[1].length < 40) {
      // Filter out common false positives
      const candidate = m[1].trim();
      if (!_EE_STOPS.has(candidate.toLowerCase()) && /^[A-Z]/.test(candidate)) {
        facts.name = candidate;
        break;
      }
    }
  }

  for (const pat of _EE_JOB_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length > 2 && m[1].length < 60) {
      facts.job = m[1].trim();
      break;
    }
  }

  for (const pat of _EE_LOCATION_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length > 1 && m[1].length < 60) {
      facts.location = m[1].trim();
      break;
    }
  }

  for (const pat of _EE_INTEREST_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length > 2 && m[1].length < 80) {
      facts.interests = m[1].trim();
      break;
    }
  }

  // Preference detection (I prefer X over Y, I'd rather X)
  const prefMatch = text.match(/i (?:prefer|'?d rather|always choose|go with) (.{3,60}?)(?:\.|,|$)/i);
  if (prefMatch && prefMatch[1]) {
    facts.preferences = prefMatch[1].trim();
  }

  return facts;
};


// ── GRAPH PAYLOAD BUILDER ────────────────────────────────────────────────────

/**
 * Build a complete Knowledge Graph payload from an exchange.
 * Combines entity extraction, relationship extraction, and personal facts
 * into a format ready for `sem:graph_store`.
 *
 * @param {string} userMsg     — the user's raw message
 * @param {string} aiResponse  — SCAAI's response
 * @returns {{ nodes: Array<{id: string, label: string, type: string}>, edges: Array<{source: string, target: string, relation: string}> }}
 */
window._buildGraphPayload = function(userMsg, aiResponse) {
  const combined = (userMsg || '') + ' ' + (aiResponse || '');

  // Extract entities from both sides
  const userEntities = window._extractEntities(userMsg || '');
  const aiEntities   = window._extractEntities(aiResponse || '');

  // Merge entities (user entities take priority)
  const allEntities = new Map();
  const mergeEntities = (entities) => {
    for (const e of entities.all) {
      const id = e.label.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
      if (!allEntities.has(id)) {
        allEntities.set(id, { id, label: e.label, type: e.type });
      }
    }
  };
  mergeEntities(userEntities);
  mergeEntities(aiEntities);

  // Extract relationships
  const rels = window._extractRelationships(combined);

  // Extract personal facts and add as identity nodes
  const facts = window._extractPersonalFacts(userMsg || '');
  if (facts.name) {
    const nameId = 'user_name_' + facts.name.toLowerCase().replace(/\s+/g, '_');
    allEntities.set(nameId, { id: nameId, label: facts.name, type: 'Person' });
  }

  // Build edges — also create co-occurrence edges between all entities
  // mentioned in the same message (weak "related_to" signal)
  const edges = [...rels];
  const entityIds = [...allEntities.keys()];

  // Co-occurrence edges (only for entities in user message, max 6 to prevent explosion)
  const userEntityIds = userEntities.all.map(e =>
    e.label.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
  ).slice(0, 6);

  for (let i = 0; i < userEntityIds.length; i++) {
    for (let j = i + 1; j < userEntityIds.length; j++) {
      const sig = `${userEntityIds[i]}->${userEntityIds[j]}:co_occurs`;
      if (!edges.some(e => e.source === userEntityIds[i] && e.target === userEntityIds[j])) {
        edges.push({
          source: userEntityIds[i],
          target: userEntityIds[j],
          relation: 'co_occurs',
        });
      }
    }
  }

  // Ensure all edge endpoints exist as nodes
  for (const edge of edges) {
    if (!allEntities.has(edge.source)) {
      allEntities.set(edge.source, { id: edge.source, label: edge.source, type: 'Concept' });
    }
    if (!allEntities.has(edge.target)) {
      allEntities.set(edge.target, { id: edge.target, label: edge.target, type: 'Concept' });
    }
  }

  return {
    nodes: [...allEntities.values()],
    edges,
  };
};

console.log('[ENTITY EXTRACTOR] Module loaded — deterministic NLP entity extraction ready.');
