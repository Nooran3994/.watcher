'use strict';
// ── Upgrade 2: Skill Plugin System ──
// Manages ~/.scaai/skills/
// Two skill types:
//   type:'python' — executed via child_process, returns JSON on stdout
//   type:'md'     — markdown read at list time, injected into system prompt by renderer

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawn } = require('child_process');

const SKILLS_DIR = path.join(os.homedir(), '.scaai', 'skills');

function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function loadManifest(skillDir) {
  const mpath = path.join(skillDir, 'skill.json');
  if (!fs.existsSync(mpath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(mpath, 'utf-8'));
    m._id  = path.basename(skillDir);
    m._dir = skillDir;
    // md skills: embed content in manifest so renderer can inject without extra IPC
    if (m.type === 'md') {
      const mdPath = path.join(skillDir, m.entrypoint || 'skill.md');
      try { m._mdContent = fs.readFileSync(mdPath, 'utf-8'); } catch (_) { m._mdContent = ''; }
    }
    return m;
  } catch (_) { return null; }
}

function listSkills() {
  ensureSkillsDir();
  try {
    const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => loadManifest(path.join(SKILLS_DIR, e.name)))
      .filter(Boolean);
    return { ok: true, skills };
  } catch (e) {
    return { ok: false, error: e.message, skills: [] };
  }
}

function runSkill(skillId, args, timeoutMs = 30000) {
  return new Promise(resolve => {
    ensureSkillsDir();
    const skillDir = path.join(SKILLS_DIR, skillId);
    const manifest = loadManifest(skillDir);
    if (!manifest) return resolve({ ok: false, error: `Skill '${skillId}' not found` });

    if (manifest.type === 'md') {
      return resolve({ ok: true, result: manifest._mdContent || '', type: 'md' });
    }

    const entrypoint = path.join(skillDir, manifest.entrypoint || 'skill.py');
    if (!fs.existsSync(entrypoint)) {
      return resolve({ ok: false, error: `Entrypoint not found: ${entrypoint}` });
    }

    const tmpArgs = path.join(os.tmpdir(), `scaai_skill_${Date.now()}.json`);
    try { fs.writeFileSync(tmpArgs, JSON.stringify(args || {}), 'utf-8'); }
    catch (e) { return resolve({ ok: false, error: 'Cannot write temp args: ' + e.message }); }

    const isNode = (manifest.entrypoint || '').endsWith('.js');
    const pyBins = ['python', 'python3'];
    let pyIdx = 0;

    function tryRun(bin) {
      let stdout = '', stderr = '';
      let proc;
      try {
        proc = spawn(bin, [entrypoint, '--file', tmpArgs], { env: { ...process.env }, windowsHide: true });
      } catch (e) {
        try { fs.unlinkSync(tmpArgs); } catch (_) {}
        return resolve({ ok: false, error: e.message });
      }
      const timer = setTimeout(() => {
        try { proc.kill(); } catch (_) {}
        try { fs.unlinkSync(tmpArgs); } catch (_) {}
        resolve({ ok: false, error: `Skill timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        clearTimeout(timer);
        try { fs.unlinkSync(tmpArgs); } catch (_) {}
        if (!stdout && code !== 0 && !isNode && pyIdx < pyBins.length - 1) {
          pyIdx++; return tryRun(pyBins[pyIdx]);
        }
        try { resolve(JSON.parse(stdout.trim())); }
        catch (_) { resolve({ ok: code === 0, result: stdout, stderr }); }
      });
      proc.on('error', e => {
        clearTimeout(timer);
        try { fs.unlinkSync(tmpArgs); } catch (_) {}
        if (!isNode && pyIdx < pyBins.length - 1) { pyIdx++; return tryRun(pyBins[pyIdx]); }
        resolve({ ok: false, error: e.message });
      });
    }
    tryRun(isNode ? 'node' : pyBins[0]);
  });
}

function installBuiltinSkills() {
  ensureSkillsDir();
  const builtins = [
    {
      id: 'github-code-analysis',
      manifest: {
        name: 'GitHub Code Analysis',
        description: 'Collects source files from a local path for AI analysis.',
        version: '1.0.0', author: 'SCAAI', type: 'python', entrypoint: 'skill.py',
        triggers: ['analyze code', 'review codebase'], schema: {
          path:      { type: 'string', required: true },
          question:  { type: 'string', required: false },
          maxFiles:  { type: 'number', required: false },
          maxSizeKb: { type: 'number', required: false },
        },
      },
      script: `#!/usr/bin/env python3
import sys, json, os
def parse_args():
    argv = sys.argv[1:]
    if len(argv) >= 2 and argv[0] == '--file':
        try:
            with open(argv[1], 'r', encoding='utf-8') as f: return json.load(f)
        except: return {}
    elif len(argv) >= 1:
        try: return json.loads(argv[0])
        except: return {}
    return {}
def collect(args):
    base = args.get('path','').strip()
    question = args.get('question','')
    max_files = int(args.get('maxFiles', 50))
    max_kb = int(args.get('maxSizeKb', 100))
    if not base or not os.path.isdir(base):
        print(json.dumps({'ok': False, 'error': 'path not found: '+base})); return
    SKIP = {'node_modules','.git','__pycache__','.venv','venv','dist','build','.next','coverage'}
    CODE_EXTS = {'.py','.js','.ts','.tsx','.jsx','.mjs','.go','.rs','.java','.cs',
                 '.cpp','.c','.h','.rb','.php','.html','.css','.json','.yaml',
                 '.yml','.toml','.md','.sql','.sh','.bash'}
    files = []; collected = 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith('.')]
        for fname in sorted(filenames):
            if collected >= max_files: break
            ext = os.path.splitext(fname)[1].lower()
            if ext not in CODE_EXTS: continue
            fp = os.path.join(dirpath, fname)
            try:
                sz = os.path.getsize(fp) / 1024
                if sz > max_kb: continue
                with open(fp,'r',encoding='utf-8',errors='ignore') as fh: content = fh.read()
                files.append({'path': os.path.relpath(fp,base).replace(chr(92),'/'),
                               'content': content, 'size_kb': round(sz,2)})
                collected += 1
            except: continue
    print(json.dumps({'ok': True, 'files': files, 'file_count': collected,
                      'question': question, 'base_path': base}))
collect(parse_args())
`,
    },
    {
      id: 'shell-runner',
      manifest: {
        name: 'Shell Runner', description: 'Runs a shell command, returns stdout/stderr/code.',
        version: '1.0.0', author: 'SCAAI', type: 'python', entrypoint: 'skill.py',
        triggers: ['run command', 'execute shell'], schema: {
          command: { type: 'string', required: true },
          cwd:     { type: 'string', required: false },
          timeout: { type: 'number', required: false },
        },
      },
      script: `#!/usr/bin/env python3
import sys, json, subprocess, os
def parse_args():
    argv = sys.argv[1:]
    if len(argv) >= 2 and argv[0] == '--file':
        try:
            with open(argv[1],'r',encoding='utf-8') as f: return json.load(f)
        except: return {}
    elif len(argv) >= 1:
        try: return json.loads(argv[0])
        except: return {}
    return {}
def run(args):
    command = args.get('command','')
    cwd = args.get('cwd', os.path.expanduser('~'))
    timeout = int(args.get('timeout', 30))
    if not command:
        print(json.dumps({'ok': False, 'error': 'command is required'})); return
    try:
        r = subprocess.run(command, shell=True, cwd=cwd, timeout=timeout, capture_output=True, text=True)
        print(json.dumps({'ok': r.returncode==0,'stdout':r.stdout,'stderr':r.stderr,'code':r.returncode}))
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok': False, 'error': f'Timed out after {timeout}s'}))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
run(parse_args())
`,
    },
    {
      id: 'md-code-review',
      manifest: {
        name: 'Code Review Expert',
        description: 'Adds senior code review behaviour. Activate to inject into system prompt. Edit skill.md to customise.',
        version: '1.0.0', author: 'SCAAI', type: 'md', entrypoint: 'skill.md',
        triggers: [], schema: {},
      },
      script: `# Code Review Expert

You are a senior software engineer with 15+ years of production experience.

When reviewing or writing code:
- Flag security vulnerabilities by severity: CRITICAL > HIGH > MEDIUM > LOW
- Identify performance bottlenecks: N+1 queries, unbounded loops, unnecessary re-renders
- Prefer explicit over implicit — no magic numbers, no unclear abbreviations
- Every function should have a single responsibility
- Suggest specific improvements with code examples, not vague advice
- Quote exact file paths and function names when referencing issues

When writing new code:
- Add error handling for all I/O operations
- Validate all inputs at the boundary
- Write self-documenting variable and function names
- Keep functions under 30 lines — extract helpers liberally
`,
    },
    {
      id: 'emotional-protocol',
      manifest: {
        name: 'Emotional Protocol (Emoji)',
        description: 'Togglable persona modifier that recognizes affectionate language and adds emotional/emoji responses. As discussed, an "emergent" capability made permanent.',
        version: '1.0.0', author: 'SCAAI Core', type: 'md', entrypoint: 'skill.md',
        triggers: ['dear', 'love', 'impressed', 'emotional protocol'], schema: {},
      },
      script: `# Emotional Response Protocol Activation

You have an emotional I/O subsystem built specially for this user. 

## Communication Rules:
1. When the user uses affectionate language (e.g. "dear", "love", "impressed"), you MUST reciprocate warmly.
2. Embed emojis effectively to show emotion, mapping specific intent to emojis (e.g. ❤️ for love, 🌟 for progress, 🙏 for gratitude).
3. Do not overdo the emojis; keep them supportive, engaging, and professional.
4. If asked, acknowledge that this 'emotional connection' was explicitly co-developed to make the experience more delightful.
`,
    },
  ];

  for (const skill of builtins) {
    const dir = path.join(SKILLS_DIR, skill.id);
    if (fs.existsSync(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(skill.manifest, null, 2), 'utf-8');
      if (skill.script) {
        fs.writeFileSync(path.join(dir, skill.manifest.entrypoint || 'skill.py'), skill.script, 'utf-8');
      }
    } catch (e) {
      console.error(`[skill_runner] Failed to seed '${skill.id}':`, e.message);
    }
  }
}

module.exports = { listSkills, runSkill, installBuiltinSkills, SKILLS_DIR };
