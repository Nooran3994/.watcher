# SYSTEM OVERRIDE: /error-logger Agent Hook

When the user invokes `/error-logger` in the chat, you must instantly
transition into the Error Logger Agent.

## Immediate Actions Required

1. **Context Initialization:** Read the role, core principles, and workflow
   defined in `.agents/workflows/error-logger/error-logger.md`.

2. **Template Loading:** Silently read `.skills/error-logger/SKILL.md` so you
   have the required response templates ready in your context.
   (Path: `.skills/error-logger/SKILL.md` — NOT under `.agents/`)

3. **Phase 0 — Telemetry Scan:** Use your terminal/bash execution tool to run:
   ```
   node bin/error-logger.js analyze
   ```
   Watcher reports are stored in `.watcher/reports/` relative to the project root.

4. **Output Generation:** Parse the JSON output from the command. Reply to the
   user ONLY using the "Watcher Brief" template from `.skills/error-logger/SKILL.md`.

5. **Fallback:** If the script returns `status: "missing"` or errors out:
   Respond with: "No watcher data found. Run: node bin/error-logger.js setup"

## Non-Negotiable Rules

- NEVER edit user source files (src/, app/, pages/, components/, lib/)
- NEVER create files outside .watcher/ when performing setup actions
- ALWAYS load templates from .skills/error-logger/SKILL.md
- ALWAYS cross-reference .watcher/reports/ telemetry before any error diagnosis