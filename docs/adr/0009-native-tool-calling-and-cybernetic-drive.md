# ADR-0009: Native Tool Calling and Cybernetic Drive Architecture

**Status:** Accepted
**Date:** 2026-04-24
**Deciders:** SCAAI Team
**Technical Story:** Enabling autonomic PC interaction and resolving the "Cognitive Disconnect" in LLM reasoning.

## Context

The previous version of SCAAI's tool execution relied on **textual parsing** (Regular Expressions) of model outputs (e.g., matching `[EXEC: command]`). This approach faced several fundamental limitations:

1.  **Hallucination Loops**: Models frequently simulated tool outputs inside their own messages, leading the "Awareness Engine" to believe actions were performed when they were actually ignored by the engine.
2.  **Cognitive Disconnect**: High-parameter models (like Llama 3.3 or GPT-4o) are trained via RLHF to be honest about their capabilities. Without seeing structured `tools` in the API request, they would correctly deny access to the filesystem despite being told they had it in the system prompt.
3.  **Brittle Path Handling**: Managing Windows vs. WSL2 path conventions via simple string manipulation often led to broken execution flows, especially for critical user folders like Downloads or Documents.

## Decision

We have transitioned the core architecture to **Native Function Calling** (Tool Use), moving the specialized execution logic from the Renderer string parser into a structured **Main Process Registry**.

### 1. Structured Tool Registry
We implemented a schema-based tool registry in `src/main/main.js` that exposes the following native functions to the LLM:
- `get_context`: Initial orientation (home, user, platform, wsl status).
- `list_drives`: Global system searchability.
- `list_directory`: Detailed file/folder listing.
- `read_file` / `write_file`: Binary-safe, atomic disk operations.
- `search_files`: Deep recursive pattern searching.
- `open_path`: OS-native application and URL opening.
- `execute_command`: Full shell access (viam `wslExec` or native CMD).

### 2. Recursive Conversation Loop
Implemented a `runWithTools` orchestrator that manages multiple turns of interaction. This allows a model to "explore" (e.g., list a directory, then read a file, then search for a string) before providing a final grounded response to the user.

### 3. Hardened Cross-Platform Translation
All tools are now **WSL2-Aware**. They use centralized path translation logic (`winToWslPath` and `wslToWinPath`) to ensure that `~/Downloads` or `/mnt/c/Users/...` work regardless of the user's active environment.

## Consequences

### Positive
- **Grounded Honesty**: Models no longer deny their capabilities because they see the structured tools in their technical interface.
- **Atomic Operations**: `write_file` and `read_file` are now handled as controlled Node.js operations rather than vulnerable shell redirects.
- **Autonomic Efficiency**: Recursive turns allow complex multi-step intentions to be resolved in a single user turn.
- **Drive Awareness**: The ability to list drives and search globally makes SCAAI a true "Second Brain" for the local machine.

### Negative
- **Latency**: Recursive calls to the LLM increase the total time-to-first-token for complex requests.
- **Provider Dependency**: This architecture requires models that support the OpenAI/Groq function-calling specification.

### Neutral
- **Process Shift**: Tool execution logic has migrated from `renderer.js` to `main.js`, increasing the complexity of the Electron backend.

## Alternatives Considered

### Alternative 1: Improved Regex Parsing
**Pros**: Lower developer effort, backward compatible with all models.
**Cons**: Fails to solve the "Cognitive Disconnect" issue (LLM logic remains unaware of capabilities).

### Alternative 2: Manual "Skill" Injection
**Pros**: Low latency, very specific.
**Cons**: Requires the user to manually trigger skills; lacks the autonomic agency required for a "Senior Engineer" assistant.

## References
- [ADR-0003: Resolving Tool Anomalies](./0003-resolve-tool-anomalies-and-hallucinations.md)
- [Groq API Tool Calling Docs](https://console.groq.com/docs/tool-use)
- [GitHub Models Tool Use Guide](https://docs.github.com/en/github-models/prototyping-with-github-models)
