# ADR-0006: Strategic Memory & Planning System

**Status:** Accepted
**Date:** 2026-04-11
**Deciders:** Alfred, SCAAI
**Technical Story:** Integration of Strategic Planning into the Cognitive Architecture

## Context

SCAAI has successfully achieved "Self-Awareness" (v4.0.0) and "Reflective Reasoning." However, it remained primarily **reactive**. It would respond to the immediate prompt but often lose track of the "Big Picture" (the overall mission) during long development sessions or between application restarts.

We needed a way to:
1. Track high-level, multi-day missions (e.g., "Refactor to Modular Architecture").
2. Persist these goals across sessions.
3. Keep the "Active Mission" present in the AI's internal reasoning without cluttering the user interface or requiring the user to repeat themselves.

## Decision

We will implement a **Strategic Memory System (SMS)** as the fifth phase of the cognitive cycle.

1. **Strategic Engine**: A background reasoning module (`strategicEngine.js`) that analyzes every interaction to determine if a mission was started, if a milestone was reached, or if a plan needs to pivot.
2. **Persistent State**: The strategic plan (active mission + milestones) will be stored in `TOOLS_CONFIG`, ensuring it survives application restarts.
3. **Cognitive Loop Integration**: The engine is hooked into the post-reflection unify phase.
4. **Proactive System Prompt**: The active mission and roadmap are dynamically injected into the system prompt, making the model "consciously aware" of the long-term goal in every turn.
5. **UI Transparency**: A subtle "Mission Roadmap" section is added to the Project Home View to visualize the internal strategic state.

## Consequences

### Positive
- **Reduced Cognitive Load**: The user no longer needs to remind SCAAI of the overall mission.
- **Proactive Alignment**: SCAAI can identify when a granular task (e.g., "fixing a bug") conflicts with the broader mission or when it's time to move to the next milestone.
- **Cross-Session Continuity**: Goals are preserved even after the main process is terminated.

### Negative
- **Latency**: Adding a fifth reasoning phase slightly increases the post-response processing time.
- **Complexity**: Adds a new state management layer between `renderer.js` and `TOOLS_CONFIG`.

## Alternatives Considered

### Manual Mission Definition
**Description:** User must explicitly type "New Mission: [Title]" to start tracking.
**Pros:** High precision.
**Cons:** High friction. SCAAI should be smart enough to detect a mission from context.

### Semantic Search (RAG) only
**Description:** Rely solely on searching past logs to find goals.
**Pros:** No new data structures needed.
**Cons:** Unreliable. High-level goals can get buried under granular technical logs.

## References
- [Reflective Loop Documentation](file:///c:/Users/HP/OneDrive/Desktop/Agentic/SCAAI_RUN/docs/systems/reflective-loop.md)
- [Strategic Memory System Documentation](file:///c:/Users/HP/OneDrive/Desktop/Agentic/SCAAI_RUN/docs/systems/strategic-memory-system.md)
