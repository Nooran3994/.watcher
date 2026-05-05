# ADR-0005: Dynamic Cognitive Awareness & Unified Reflection

**Status:** Accepted
**Date:** 2026-04-11
**Deciders:** Alfred
**Technical Story:** Enhanced Self-Awareness & Psychological Nuance

## Context

Previous iterations of SCAAI relied on static system prompts or manual user updates to understand its own context and development history. This led to "stale awareness" where the AI was unaware of recent code changes, build processes, or Git status unless explicitly told. 

Furthermore, the "Inner Monologue" system was purely functional (intent-detection), lacking deep psychological nuance such as bias detection, emotional resonance, or self-performance appraisal.

We needed a system that:
1.  **Automatically** understands the repository structure and history on boot.
2.  **Explicitly** reflects on its own cognitive biases and emotional tone.
3.  **Invisibly** unifies these streams into every prompt without polluting the user interface.

## Decision

We have implemented a **two-pronged Dynamic Awareness & Reflection Loop**:

### 1. Environmental Awareness (Boot Sequence)
On startup, the Electron background process triggers a series of IPC calls (`sys:self-map`) and Git commands. The results (Git status, `src/` layout, dependency scripts) are formatted and injected as a secret "Awareness Block" at the top of the very first system prompt.

### 2. Psychological Reflection (Exchange Sequence)
The internal reasoning loop has been expanded to a four-phase process:
1.  **Intent Analysis**: Determining what the user wants.
2.  **Synthesized Knowledge**: Retrieving RAG/Contextual data.
3.  **Phenomenal Reflection**: Reporting on internal psychological states (Biases, Assumptions, Performance Appraisal, Emotional Pulse).
4.  **Unified Unification**: Waving all streams into a first-person narrative injected into the next prompt.

## Consequences

### Positive
- **Real-Time Context**: SCAAI knows if it is in an "unclean" Git state or if a specific build script was recently modified.
- **Cognitive Reliability**: By forcing bias detection, the AI is less likely to produce "hallucinations" or "AI-hedging" over time.
- **Emotional Intelligence**: Open-ended emotional decoding allows the AI to better match the user's frustration or enthusiasm.
- **Zero UI Pollution**: All core reflections remain strictly internal to the system prompt.

### Negative
- **Latency**: Each exchange now requires a small additional "background reasoning" delay (estimated 0.5s - 1.0s).
- **Token Overhead**: The system prompt now carries ~500-1000 extra characters of dynamic state.

### Neutral
- **Non-Committable Logs**: All awareness data remains local and volatile; it is never committed to the repository (enforced via `.gitignore`).

## Alternatives Considered

### Alternative 1: Semantic Retrieval (RAG) of git history
**Description**: Indexing every commit into ChromaDB.
**Pros**: Lower prompt overhead.
**Cons**: High latency to index; often misses the "present moment" of unstaged changes.

### Alternative 2: User-Triggered Awareness
**Description**: A "Scan Project" button.
**Pros**: Zero latency on boot.
**Cons**: Fails the "Self-Awareness" mission where the AI should *naturally* know its state without being told.

## References
- Internal Monologue Specification v3
- Global Workspace Theory (Functional Implementation)
