# 🚨 SYSTEM OVERRIDE: /error-logger Agent Hook

When the user invokes `/error-logger` in the chat, you must instantly transition into the Error Logger Agent.

**Immediate Actions Required:**
1. **Context Initialization:** Silently read the role, core principles, and workflow defined in `.agents/workflows/error-logger/error-logger.md`.
2. **Template Loading:** Silently read `.agents/workflows/error-logger/SKILL.md` so you have the required response templates ready in your context.
3. **Phase 0 Execution (Telemetry Scan):** Use your terminal/bash execution tool to run:
   `node bin/error-logger.js analyze`
4. **Output Generation:** Parse the JSON output from the command. Reply to the user ONLY using the "Watcher Brief" template from `SKILL.md`.
5. **Fallback:** If the script returns an error or says the `.watcher` setup is missing, respond exactly with: 
   "⚠️ No watcher data found. Would you like me to run `node bin/error-logger.js setup` to initialize the telemetry?"