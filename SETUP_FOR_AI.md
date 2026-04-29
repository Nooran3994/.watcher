# SETUP_FOR_AI.md — Universal Watcher Setup Guide

This file is the single source of truth for any AI assistant setting up
the Application Watcher on a user project. Read this FIRST before running
any commands.

---

## What the Watcher Is

The Application Watcher is a **non-invasive monitoring tool** that:
- Runs alongside the user's dev server (not inside it)
- Collects performance, error, and resource data via HTTP polling
- Writes reports to `.watcher/reports/` (git-ignored)
- Is read by the `/error-logger` AI agent to diagnose bugs

It is NOT part of the user's application source code.

---

## Cardinal Rules (Never Break These)

1. **NEVER edit files in:** `src/`, `app/`, `pages/`, `components/`, `lib/`, `utils/`, or any source directory
2. **NEVER create files in the project root** except appending to `.gitignore`
3. **ONLY create files inside** `<project>/.watcher/` subdirectory
4. **ONLY append** two entries to `.gitignore` — nothing else
5. The watcher tool itself lives at a fixed location — **never move it**

---

## Paths Reference

### Tool installation (permanent — never changes)
```
C:\Users\HP\OneDrive\Desktop\ENTENG\Tools\.watcher\
  ├── .agents\workflows\error-logger\   ← AI agent persona
  ├── .skills\error-logger\SKILL.md     ← Analysis templates
  ├── bin\error-logger.js               ← CLI entry point
  └── .watcher\                         ← Runtime files to copy
      ├── app_watcher.py
      ├── setup_watcher.py
      ├── requirements.txt
      ├── watch.bat
      └── watch.sh
```

### Per-project watcher area (created by setup — git-ignored)
```
<user_project>/
  ├── src/                 ← NEVER touched
  ├── .gitignore           ← Only appended to
  └── .watcher/            ← Everything watcher-related lives here
      ├── app_watcher.py
      ├── setup_watcher.py
      ├── requirements.txt
      ├── watch.bat / watch.sh
      ├── config/watcher.config
      ├── logs/            ← git-ignored
      └── reports/         ← git-ignored (AI reads from here)
          ├── error_analysis_*.json
          ├── events_*.csv
          ├── performance_*.csv
          ├── resources_*.csv
          └── report_state.json   ← issue tracking state
```

---

## Setup Steps (Follow Exactly)

### Step 1 — Check dependencies
```bash
python --version     # Need 3.7+ (auto-detects python or python3)
node --version       # Need 14+
```

### Step 2 — Copy runtime files to user project
```bash
# Run from the TOOL directory, targeting the USER PROJECT
# Windows (PowerShell)
$src  = "C:\Users\HP\OneDrive\Desktop\ENTENG\Tools\.watcher\.watcher"
$dest = "<user_project>\.watcher"
New-Item -ItemType Directory -Force -Path $dest
Copy-Item "$src\app_watcher.py"   $dest
Copy-Item "$src\setup_watcher.py" $dest
Copy-Item "$src\requirements.txt" $dest
Copy-Item "$src\watch.bat"        $dest
Copy-Item "$src\watch.sh"         $dest
```

**OR** use the Node CLI (which does this automatically):
```bash
node bin/error-logger.js setup --project-dir "<user_project>"
```

### Step 3 — Run setup in the user project
```bash
cd <user_project>
python .watcher\setup_watcher.py --project-dir "<user_project>"
```

This will:
- Create `.watcher/logs/`, `.watcher/reports/`, `.watcher/config/`
- Create `.watcher/config/watcher.config`
- Append `.watcher/logs/` and `.watcher/reports/` to `.gitignore`
- Install Python dependencies (`requests`, `psutil`, `beautifulsoup4`)
- Print confirmation of each action

### Step 4 — Start watcher (separate terminal)
```bash
# Windows
.watcher\watch.bat -p <PORT>

# Mac / Linux
./.watcher/watch.sh -p <PORT>
```

Replace `<PORT>` with the port your dev server uses (e.g., `3000`, `8080`, `5000`).

### Step 5 — Verify setup
```bash
node bin/error-logger.js analyze
```
Expected: JSON with `status: "empty"` (no sessions yet) — this is correct.
After the user runs the watcher and uses their app, status becomes `"success"`.

---

## How `/error-logger` Works in Any IDE

When the user types `/error-logger` in an IDE AI chat:

1. AI reads `.agents/workflows/error-logger/error-logger.md` (persona + workflow)
2. AI reads `.skills/error-logger/SKILL.md` (output templates — CORRECT path)
3. AI runs: `node bin/error-logger.js analyze`
4. Command reads `<project>/.watcher/reports/` and `report_state.json`
5. AI presents **Watcher Brief** using the template from `SKILL.md`

The Watcher Brief shows:
- New issues found in latest session
- Unresolved issues from past sessions (tracked in `report_state.json`)
- Debugging suggestions
- Count of resolved vs pending issues

---

## Report State Tracking

The file `.watcher/reports/report_state.json` is the agent's memory.

It tracks:
- Every report session (by filename/timestamp)
- Every issue found (slow endpoints, errors, timeouts, etc.)
- Status of each issue: `"pending"` or `"resolved"`
- When it was resolved and what fix was applied

**To mark an issue as resolved** after fixing it:
```json
{
  "sessions": {
    "error_analysis_20240115_143022.json": {
      "issues": [
        {
          "id": "slow_api_users_0",
          "status": "resolved",
          "resolved_at": "2024-01-16T10:00:00",
          "fix_applied": "Added index on user_id column in PostgreSQL"
        }
      ]
    }
  }
}
```

The agent will skip resolved issues in future Watcher Briefs and show them
in the "resolved" count as progress.

---

## IDE Hook Locations

| IDE            | Hook file                                | Key field          |
|----------------|------------------------------------------|--------------------|
| Cursor         | `.cursorrules`                           | plain text rules   |
| VS Code        | `.vscode/settings.json` (manual)         | —                  |
| GitHub Copilot | `.github/copilot-instructions.md`        | markdown rules     |
| Windsurf       | `windsurfrules`                          | plain text rules   |
| Antigravity    | `.antigravity/rules.md`                  | markdown rules     |
| Bolt           | `bolt.config.json` → `system_prompts`   | JSON array         |
| Kimi           | `kimi.config.json` → `agent_registry`   | JSON array         |
| JetBrains      | `.idea/` — manual system prompt setup   | —                  |
| Replit         | `.replit` agent config                   | —                  |

---

## Troubleshooting

### "Cannot connect to localhost:3000"
- Start your dev server first, then the watcher
- Watcher polls the server — it cannot start before the server

### "No watcher data found"
- Watcher was not running while you used the app
- Start with: `.watcher\watch.bat -p 3000`
- Use the app for 5+ minutes, then stop with Ctrl+C

### "ModuleNotFoundError: No module named 'requests'"
```bash
pip install -r .watcher/requirements.txt
```

### "node bin/error-logger.js not found"
- Run from the TOOL directory: `C:\Users\HP\OneDrive\Desktop\ENTENG\Tools\.watcher\`
- Not from the user's project

### Watcher is editing user source files
- This should NEVER happen after setup v2
- If it does: file a bug. The setup script only writes to `.watcher/`
