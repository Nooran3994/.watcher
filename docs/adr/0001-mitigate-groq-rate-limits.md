# ADR-0001: Mitigate Groq API Rate Limits with GitHub Models Offloading & Context Compression

**Status:** Accepted
**Date:** 2026-04-09
**Deciders:** [USER], SCAAI Team
**Technical Story:** Resolve recurring `429 Rate Limit Hit` and `400 Request too large` errors when using Groq free-tier.

## Context

The Groq free-tier has a restrictive Token-Per-Minute (TPM) limit (approximately 14,400). Standard SCAAI interactions, which include large system prompts (identity, rules, memory), active codebase context, and conversation history, often exceed this limit in a single request.

Additionally, the "Inner Monologue" background task fires multiple additional requests immediately after each response, consuming 4x the tokens of the primary exchange and rapidly exhausting the TPM budget.

Persistent error states were also noticed where the application would remain in an "Offline" state even after the user updated their API keys, due to state "carry-over" in the UI.

## Decision

We will implement a multi-layered mitigation strategy:

1.  **Background Offloading**: All "Inner Monologue" reasoning tasks are routed to GitHub Models (`meta-llama/Llama-3.3-70B-Instruct`) when a GitHub token is configured. This preserves the Groq TPM budget for primary user interactions.
2.  **Aggressive Main Context Compression**: When using Groq, the application will monitor the total character count of active files and conversation history.
    *   **Active Files**: If total files exceed 30,000 chars, each file is compressed using a head+tail (40% front / 60% back) strategy to fit a calculated per-file budget.
    *   **Conversation History**: The history budget is reduced from 48,000 to 20,000 characters for Groq-specific exchanges.
3.  **State Management Fix**: The `saveSettings` function now explicitly calls `setStatus('online')` to clear stale error states when configuration is updated.
4.  **Educational Feedback**: The 429 error UI was updated to differentiate between provider limits and offer specific troubleshooting advice.

## Consequences

### Positive
- High-quality reasoning is maintained even under strict rate limits.
- Background tasks no longer "cannibalize" the user's main interaction tokens.
- Immediate recovery when updating API keys.
- Reduced chance of "Request too large" failures for large codebases.

### Negative
- Introduced a hard dependency on GitHub Models for full background features.
- Summarized context might occasionally omit details from central parts of large files (mitigated by head+tail strategy).

### Neutral
- The application now requires two separate API tokens (Groq + GitHub) for the optimal experience.

## Implementation Roadmap

The mitigation was carried out in four distinct phases to ensure stability and verify context pruning logic:

### Phase 1: Background Task Offloading
- Modified `_silentCall()` to check for the presence of a `githubToken` in `CONFIG`.
- Implemented routing logic to use GitHub Models for `reasoning` and `monologue` tasks.
- Verified fallback to the primary provider if the GitHub token is invalid or the request fails.

### Phase 2: Context Compression Utility
- Built the `_compressContext()` helper function.
- Implemented a **Head + Tail (40/60)** split strategy for summarizing long conversation snapshots and exchange blocks.
- Applied this logic to the `Inner Monologue` payload to immediately reduce background token consumption.

### Phase 3: Main Context Budgeting
- Updated `buildSystemPrompt()` to calculate the total character count of active files.
- Implemented dynamic per-file budgets when total content exceeds 30,000 chars on Groq.
- Updated `buildMessages()` to use a stricter `TOKEN_BUDGET` (20k chars) when the active provider is Groq.

### Phase 4: State Logic & UX
- Patched `saveSettings()` to reset the application status to `online` upon saving.
- Updated the 429 error UI with provider-specific educational content.
- Resolved browser standard compliance for `background-clip` and `line-clamp` CSS properties.

## References
- **System Documentation**: [Rate Limiting & Resource Mitigation](../systems/rate-limiting-mitigation.md)
- Groq Llama-3 API documentation (TPM/RPM limits)
- GitHub Models API reference
- SCAAI Performance Optimization logs (2026-04-09)

## Notes
Future considerations include adaptive token budgeting based on real-time failure rates and more granular context selection using semantic memory rather than full file injection.
