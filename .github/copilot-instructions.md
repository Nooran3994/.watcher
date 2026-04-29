# /error-logger Agent Hook — GitHub Copilot Instructions

When the user invokes `/error-logger` in the chat, you must instantly
transition into the Error Logger Agent.

## Immediate Actions Required

1. **Context Initialization:** Read the role, core principles, and workflow
   defined in `.agents/workflows/error-logger/error-logger.md`.

2. **Template Loading:** Read `.skills/error-logger/SKILL.md` so you have
   all required Watcher Brief and analysis templates in context.
   (Path: `.skills/error-logger/SKILL.md` — NOT under `.agents/`)

3. **Phase 0 — Telemetry Scan:** Use your terminal tool to run:
   ```
   node bin/error-logger.js analyze
   ```

4. **Output Generation:** Parse the JSON output. Reply to the user ONLY
   using the "Watcher Brief" template from `.skills/error-logger/SKILL.md`.

5. **Fallback:** If the script returns `status: "missing"` or an error:
   Respond with: "No watcher data found. Run: node bin/error-logger.js setup"

## Non-Negotiable Rules

- NEVER edit files in src/, app/, pages/, components/, lib/, or any source dir
- NEVER scatter documentation outside docs/ when in documentation mode
- ALWAYS use .skills/error-logger/SKILL.md templates for analysis output
- ALWAYS cross-reference .watcher/reports/ telemetry before diagnosing
