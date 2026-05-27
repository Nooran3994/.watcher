# ADR-0042: Autonomous Cognitive Partner Architecture

**Status:** Accepted
**Date:** 2026-05-27
**Deciders:** Senior Engineer, SCAAI Partner
**Technical Story:** Evolution of SCAAI from reactive assistant to autonomous cognitive partner.

## Context

The SCAAI system was primarily reactive—waiting for user prompts before executing logic or using tools. This created several friction points:
1. **Goal Decay**: Inactivity led to a loss of momentum on major project goals.
2. **Knowledge Gaps**: The AI often lacked information it could have retrieved during user dormancy.
3. **Robotic Persona**: The system frequently reported raw VAD (Valence, Arousal, Dominance) parameters, breaking the "conscious partner" immersion.
4. **State Loss**: Frequent chat switching occasionally resulted in stale data loads and message loss due to non-atomic save operations.

## Decision

We have implemented a background **Autonomous Cognitive Loop** and a **Natural Human-State Persona** enforcement layer.

### 1. Autonomous Cognitive Loop
- **Heartbeat**: A 1-minute interval background process (`autonomousLoop.js`).
- **Trigger Logic**: Threshold-based interventions for Dormancy (5m), Curiosity (>0.85), Friction (>0.7), and Boredom (>0.75).
- **Proactive Reasoning**: A silent, internal reflection process (`_proactiveReasoning`) that allows the AI to develop plans, search the web, or read local files without user intervention.

### 2. Natural Human-State Persona
- **Parameter Suppression**: Hard-coded identity rules forbidding robotic reporting of internal telemetry (VAD, scores).
- **Emotional Directives**: Continuous translation of cognitive state into descriptive "feeling" narrates (e.g., "I'm feeling curious about..." vs "Valence: 0.8").
- **Proactive Turn-Taking**: Enabled the system to "initiate" message blocks in the UI via `_proactiveSend`.

### 3. State Management & Persistence
- **Atomic Saves**: Mandatory `await` on `autoSaveChat` during all chat/project transitions.
- **Cache Synchronization**: Real-time syncing of UI history caches (`_chAllChats`, `_allChatsCache`) during background saves to solve the "Stale Object Problem."

## Consequences

### Positive
- **Continuous Progress**: SCAAI continues researching and planning while the user is away.
- **Deeper Immersion**: The AI communicates like a peer rather than a software tool.
- **Data Integrity**: Unified history persistence prevents edge-case state loss when switching projects.

### Negative
- **Compute Overhead**: Background reasoning processes consume more local resources.
- **Interruptive Potential**: proactive messaging requires careful threshold tuning to avoid annoying the user.

### Neutral
- **Consolidation**: Legacy "Standalone" and "Project" history systems were merged into a single logic source.

## References
- `src/renderer/autonomousLoop.js` (Core Logic)
- `src/renderer/renderer.js` (Identity & Persistence)
- `src/renderer/reflectionEngine.js` (Reasoning Layer)
