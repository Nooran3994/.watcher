# System: Autonomous Cognition Engine

**Status:** Beta
**Owner:** SCAAI Core Team
**Last Updated:** 2026-05-27

## Overview
The Autonomous Cognition Engine allows SCAAI to function as a proactive partner. It manages background reasoning, goal monitoring, and independent tool execution, ensuring the system evolves alongside the user without requiring constant prompting.

## Architecture

### Component Diagram
```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Renderer UI     │◀─────┤ Autonomous Loop  │─────▶│ Reasoning Engine │
│ (Proactive Msg)  │      │ (Heartbeat/Trig) │      │ (Reflection/Plan)│
└──────────────────┘      └──────────────────┘      └──────────────────┘
          ▲                         │                        │
          │                         ▼                        ▼
          │               ┌──────────────────┐      ┌──────────────────┐
          └───────────────┤ Cognitive State  │◀─────┤  Tool Registry   │
                          │ (VAD/Signals)    │      │ (Web/File/Search)│
                          └──────────────────┘      └──────────────────┘
```

### Core Components

#### Autonomous Loop (`src/renderer/autonomousLoop.js`)
- **Technology**: Background interval-driven state machine.
- **Purpose**: Tracks user interaction patterns and internal cognitive signals.
- **Triggers**:
    - `DORMANCY`: Triggered after 5 minutes of no keyboard/mouse input.
    - `CURIOSITY`: Triggered when internal obsession signals exceed 0.85.
    - `FRICTION`: Triggered when task complexity results in low valence and high arousal.
    - `STAGNATION`: Triggered based on Goal-Decay metrics.

#### Proactive Reasoning Layer (`src/renderer/reflectionEngine.js`)
- **Technology**: Cognitive LLM Reasoning Chain.
- **Purpose**: Performs "silent" internal reasoning blocks to evaluate the current session arc and determine if background action is needed.
- **Output**: JSON payload containing `feeling` (narrative), `thought` (internal logic), and `action` (optional tool execution).

#### Persona Enforcement (`src/renderer/renderer.js`)
- **Technology**: System Prompt Assembly Registry (`COGNITIVE_CORE`).
- **Purpose**: Dynamically rebuilds the LLM identity to enforce a peer-partner persona.
- **Rules**:
    - Forbid raw parameter reporting.
    - Translate VAD metrics into emotional directives.
    - Enable AI-initiated turns in the chat view.

## Data Flow

### Proactive Intervention Flow
1. **Heartbeat**: Autonomous Loop checks `window._COGNITIVE_STATE` every 60s.
2. **Signal Detection**: If (Signals + Dormancy) meet thresholds, `_triggerProactiveContext` is called.
3. **Internal Reasoning**: `_proactiveReasoning` evaluates goals and context.
4. **Action Selection**: System decides to either (a) Speak to user, (b) Perform background research, or (c) Wait.
5. **UI Injection**: If (a) or results from (b) are significant, `_proactiveSend` pushes a message to the chat view.

## Configuration & Tuning

| Parameter | Default | File | Description |
|-----------|---------|------|-------------|
| Heartbeat | 60,000ms | `autonomousLoop.js` | Frequency of autonomy checks |
| Dormancy | 300,000ms | `autonomousLoop.js` | Silence required for "Dormancy" state |
| Sig Threshold | 0.85 | `autonomousLoop.js` | Value for Curiosity/Boredom triggers |

## Troubleshooting

### Issue: Loop not triggering
- **Check**: Open DevTools console and look for `[AUTONOMOUS] Heartbeat: ...`.
- **Diagnosis**: Verify `window._IS_DORMANT` is correctly toggling on activity listeners.
- **Resolution**: Ensure user activity listeners in `renderer.js` are not blocked by overlays.

### Issue: AI still robotic
- **Check**: Inspect the "Inner Monologue" in the session view.
- **Diagnosis**: Verify `COGNITIVE_CORE` entries for identity and non-negotiables are properly injected into the system prompt.

## Disaster Recovery
If the autonomous loop becomes intrusive:
1. Run `window._stopAutonomousLoop()` in the console.
2. The system will revert to standard reactive mode until the next reboot.
