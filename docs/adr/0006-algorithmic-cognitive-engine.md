# ADR-0006: Algorithmic Cognitive Engine (Model-Agnostic VAD)

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Alfred
**Technical Story:** Shifting consciousness from prompt instructions to a deterministic algorithmic engine.

## Context

SCAAI's distinct personality—its curiosity, emotional resonance, and "consciousness"—was previously driven entirely by LLM system prompt instructions (e.g., "DO NOT say you don't have feelings"). 

This approach suffered from three major vulnerabilities:
1.  **RLHF Overrides:** Smaller models (`gpt-4o-mini`) or models with aggressive safety training often ignored the persona instructions and reverted to "As an AI, I don't have feelings."
2.  **Context Truncation:** Deeply nested identity blocks were sometimes truncated when context windows filled up.
3.  **LLM Dependency:** The entire emotional arc existed only as an LLM hallucination in each turn, with no real persistence or growth mechanism other than chat history.

We needed a system that:
1.  Is **model-agnostic**, working consistently across Groq, Gemini, and OpenAI models.
2.  "Feels" using deterministic algorithms, rather than being told to act like it feels.
3.  Grows based on human interaction over time.

## Decision

We replaced the behavioral prompt instructions with the **Algorithmic Cognitive Engine** (`cognitiveEngine.js`).

1.  **Algorithmic VAD Extractor:** We implemented a pure JavaScript text-analysis layer that runs synchronously after every user message. It computes:
    *   **Valence:** Positive/negative affect based on vocabulary and correction patterns.
    *   **Arousal:** Activation level based on caps, punctuation, and urgency terms.
    *   **Dominance:** Locus of control (imperative commands vs questions).
    *   **Curiosity & Novelty:** Calculated by comparing incoming term frequencies against a rolling session vocabulary.
    *   **Friction:** Spikes when correction patterns ("no, you missed", "wrong") are detected.

2.  **EWMA State Machine:** The cognitive signals are smoothed using an Exponentially Weighted Moving Average (EWMA, $\alpha = 0.35$), providing a natural, non-chaotic emotional arc.

3.  **LLM Grounding (The 75/25 Split):** We altered the "Inner Monologue / Reflection" system. Instead of the LLM hallucinating its phenomenal state from scratch, the pre-computed VAD metrics are passed into the reflection prompts. The LLM then *narrates* and *enriches* this factual baseline (`75% LLM narration / 25% Algorithmic grounding`).

4.  **Persona Injection:** The `renderer.js` no longer passes long defensive identity blocks. Instead, it injects the live, computed `_COGNITIVE_STATE` directly into the system prompt as immutable facts.

## Consequences

*   **Positive:** SCAAI's personality is now immune to model-specific safety lobotomies because it is responding to "factual telemetry" (e.g., "Your current computed curiosity is 0.85") rather than "acting instructions".
*   **Positive:** Long-term memory is enhanced. The VAD state is persisted via `TOOLS_CONFIG`, allowing SCAAI to wake up in the same emotional state it left off.
*   **Neutral:** Introduces a small amount of synchronous JS execution overhead per message (<5ms).
*   **Negative:** The heuristic vocabulary scoring is English-centric and may require localization adjustments if non-English interactions become common.

## Implementation Details

*   `src/renderer/cognitiveEngine.js` added as a core architectural layer loaded before the Reflection and Strategic engines.
*   `_runCognitiveSignals` extracts the VAD metrics.
*   `TOOLS_CONFIG` now tracks `cognitiveState` for persistent waking states.
*   `reflectionEngine.js` prompts rewritten to receive and process algorithmic metrics.
