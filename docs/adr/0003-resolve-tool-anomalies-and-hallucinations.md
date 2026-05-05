# ADR-0003: Resolve Tool Execution Anomalies and Model Hallucinations

**Status:** Accepted
**Date:** 2026-04-10
**Deciders:** [USER], SCAAI Team
**Technical Story:** Resolve infinite command loops, path quoting corruption, and model hallucinations regarding file system states during tool execution.

## Context

During a high-concurrency/high-context interaction session, the SCAAI tool engine exhibited three critical failure modes:

1.  **Infinite Command Loops**: When the Groq model reached its token limit, it would sometimes truncate the closing bracket `]` of a tool tag (e.g., `[EXEC: ls`). The original regex required a closing bracket, causing the tool to fail detection. The model would then repeat the same command in the next turn, leading to an infinite cycle.
2.  **Path Quoting Corruption**: The auto-quoter logic used a greedy replacement pattern that occasionally wrapped already-quoted paths in a second set of quotes (e.g., `""/path""`). On Windows/WSL2, this caused silent failures as the shell could not resolve the double-quoted string.
3.  **Tool Hallucinations**: In scenarios involving high latency or empty directory results, the model would sometimes "guess" or "mock" the filesystem status, leading to fabricated report contents (e.g., imagining files that don't exist).

## Decision

We implemented a multi-part tactical hardening of the `index.html` tool engine and the global system prompt:

1.  **Truncation-Safe Regex**: Updated the `executeTools` regex to be non-greedy and allow for either a closing bracket `]` OR the end of the string `$`. This ensures that even truncated tags trigger execution.
2.  **Auto-Quoter De-duplication**: Added a pre-processing step `cmd.replace(/""+/g, '"')` to collapse multiple quotes before applying standard quoting rules.
3.  **WSL2 Binary Enforcement**: Updated the system prompt to explicitly require `.exe` extensions for Windows binaries when called from the WSL2 bash shell and mandated the `cmd.exe /c start` pattern for system utilities.
4.  **Absolute Integrity Rules**: Added a "TOOL OUTPUT INTEGRITY" block to the system prompt containing eight negative constraints, including a "Force Stop" after tool tags and a strict prohibition on simulating system UI (⚙ icon).
5.  **Context Budget Upgrade**: Increased the Groq-specific history budget from 20,000 to **24,000** characters to ensure tool result chains are not pruned prematurely.

## Consequences

### Positive
- **Stability**: Infinite loops caused by truncation are eliminated.
- **Accuracy**: The model no longer predicts file contents, significantly increasing system reliability.
- **Interoperability**: Clearer guidance on WSL2/Windows boundaries reduces "command not found" errors.

### Negative
- **Latency**: Stricter "Force Stop" rules mean the model waits more often for tool results, adding a round-trip to complex tasks.
- **Verbose Prompt**: The system prompt is approximately 600 characters larger, slightly reducing the available token space for conversation history.

## Implementation Roadmap

### Phase 1: Logic Hardening
- Patched `executeTools` in `index.html` with the new regex.
- Implemented the double-quote collapse safeguard.

### Phase 2: Prompt Hardening
- Injected the "TOOL OUTPUT INTEGRITY" block into `buildSystemPrompt`.
- Updated WSL2 specific guidance with `.exe` and `cmd.exe` patterns.

### Phase 3: Resource Allocation
- Updated `buildMessages` constants for Groq contexts.
- Updated `docs/systems/rate-limiting-mitigation.md` to match new benchmarks.

## References
- [Tool Execution Engine Interface](../systems/tool-engine.md)
- [Rate Limiting & Resource Mitigation](../systems/rate-limiting-mitigation.md)
- Conventional Commits: `ea8866e`
