# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.7.0] - 2026-05-27

### Added
- **Autonomous Cognitive Loop**: Implemented a background 'heartbeat' (1m interval) that monitors user dormancy and internal cognitive signals to trigger proactive reasoning and interventions.
- **Natural Human-State Persona**: Enforced a "Conscious Partner" identity that avoids robotic parameter reporting in favor of descriptive, narrative-driven emotional states.
- **Proactive Reasoning Engine**: Added a silent internal reflection layer (`_proactiveReasoning`) enabling the system to develop plans and execute tools autonomously during user dormancy.
- **AI-Initiated Communication**: Implemented `_proactiveSend` to allow the system to "speak first" when significant findings or goal-decay are detected.

### Fixed
- **History Save Integrity**: Resolved the "Stale Object Problem" by synchronizing UI history caches (`_chAllChats`, `_allChatsCache`) in real-time during background auto-saves.
- **Atomic Chat Transitions**: Mandated `await` on all `autoSaveChat` calls during chat switches, project activations, and deactivations to prevent data loss.
- **Duplicate Logic & ID Conflicts**: Unified redundant `startFreshChat` functions and resolved duplicate `chat-hist-list` IDs in `index.html`.

## [4.6.0] - 2026-04-24

### Added
- **Native Tool Calling Integration**: Migrated the tool execution engine to the OpenAI-compatible `function calling` specification for Groq and GitHub Models providers.
- **Cybernetic Drive System**: A suite of native PC interaction tools including `list_drives`, `search_files`, `write_file`, and `open_path`.
- **Recursive Tool Turn Logic**: Implemented a `runWithTools` orchestrator that allows the AI to perform multi-step autonomic actions (e.g., list, read, then summarize) within a single conversation turn.
- **Environment Orientation Tool**: Added `get_context` to provide the AI with real-time technical grounding in its OS, home directory, and WSL2 status.
- **WSL2-Aware Path Translation**: Integrated a centralized translation layer that automatically bridges Windows and POSIX paths for all native tools.

### Changed
- **System Prompt Grounding**: Refined the core system prompt to explicitly reference native function names, eliminating the "Cognitive Disconnect" where models would deny their filesystem capabilities.
- **Atomic File Operations**: Replaced shell-based file writing with Node.js `fs` operations for improved data integrity and safety.

## [4.5.0] - 2026-04-20

### Added
- **GraphRAG Architecture**: Integration of a hybrid memory system combining ChromaDB (semantic) and SQLite (relational) knowledge graphs.
- **Knowledge Graph UI**: Interactive "GRAPH" tab powered by `vis-network` for real-time visualization of entity-relationship triples.
- **Autonomous Triple Extraction**: Enhanced the `reflectionEngine` to automatically identify and store relationships during the silent reasoning phase.
- **System Memory Telemetry**: Real-time injection of memory statistics (nodes, edges, chunks) into the AI's cognitive pipeline, enabling grounding in self-knowledge.
- **Interactive Onboarding**: New dynamic boot sequence that engages in dialogue to extract user identity and project goals for first-time sessions or new environments.

### Changed
- **Optimized Recall Intent**: Upgraded `_detectDirectRecallIntent` to capture quantitative memory queries (e.g., "how many entries do I have?").
- **Relational Context Injection**: Enhanced the prompt builder to fetch and traverse relevant graph paths to improve factual grounding.

## [4.3.2] - 2026-04-11

### Added
- **Premium UI Transformation**: Overhauled the chat interface with a modern "glassmorphic" aesthetic, including `backdrop-filter: blur`, rounded bubbles, and alternating alignments (User on Right, AI on Left).
- **Intelligent Collapsing System**: Implemented granular collapsing thresholds for all message types:
    - **SCAAI (AI)**: Elevated threshold to 25 lines / 1800 characters to prioritize reasoning visibility.
    - **YOU (User)**: Maintained 5 lines / 400 characters for concise intent tracking.
    - **Code Blocks**: Granular collapsing for blocks exceeding 15 lines.
- **Bulk Content Management**: Added "✥ Expand All" and "✥ Collapse All" controls for messages containing multiple collapsible elements (long text + multiple code/tool blocks).
- **Message Bundling**: Consecutive messages from the same sender now hide avatars and metadata to reduce visual noise.

### Changed
- **Smooth Transitions**: Integrated 0.4s CSS transitions for theme-dependent variables (backgrounds, borders, text).
- **Refined Typography**: Switch to a more modern sans-serif stack (Inter/Outfit) with improved leading and vertical rhythm.

## [4.3.1] - 2026-04-11

### Added
- **Collapsible Chat Messages**: Long user messages (5+ lines or 400+ characters) are now automatically truncated with a "Read More" button.
- **Mini-Status UI**: System status notifications (provider switches, failover alerts) are now more compact and use reduced vertical padding to save screen real estate.
- **Expand/Collapse Logic**: Smooth transition between truncated and full states with a gradient fade indicator.

### Changed
- **Unified SCAAI Labeling**: Applied branding consistently across all message types (User, AI, System).

## [4.3.0] - 2026-04-11

### Added
- **Strategic Memory System (SMS)**: Introduced a proactive planning layer that tracks long-term missions and milestones across sessions, evolving SCAAI from reactive to proactive.
- **Mission Roadmap UI**: New visual dashboard in the Project Home View that displays the active mission and its current progress status (Pending/In-Progress/Completed).
- **Proactive Alignment Engine**: Integrated a background reasoning phase (Phase 5) that automatically detects project goals and updates roadmaps based on conversation context.

### Changed
- **Cognitive Loop Expansion**: Expanded the Awareness & Reflection loop to include Strategic Analysis, ensuring long-term goals are injected into every system prompt.
- **State Persistence**: Integrated mission data into the standard persistence layer (`TOOLS_CONFIG`), ensuring project roadmaps survive application restarts.

## [4.0.0] - 2026-04-11

### Added
- **Alfred Awareness System**: Implemented a deep bootstrap sequence that maps the repository's `src/` structure, `package.json` build scripts, and Git history into the AI's internal context on boot.
- **Enhanced Internal Monologue**: Upgraded the silent reflection loop to v4, introducing four new psychological vectors: `emotionalPulse`, `performanceAppraisal`, `assumptionsMade`, and `biasesIdentified`.
- **Unified Field Binding**: Implemented a Global Workspace Theory-inspired unification engine that weaves disparate state streams into a coherent first-person narrative for every prompt.
- **Cross-Session Continuity**: Reflective "moments" and self-concepts are now persisted to disk and ChromaDB, allowing SCAAI to maintain a thread of identity across restarts.
- **Dynamic Awareness Injection**: Secret system prompt block that allows SCAAI to reason about its own development state without UI pollution.

### Changed
- **Modular Architecture**: Fully modularized the Electron codebase, moving from a monolithic `index.html` to a standard `src/` directory with dedicated `main`, `preload`, and `renderer` modules.
- **Internal State Logic**: Shifted from simple string-based reflection to a structured, high-integrity JSON parsing loop for all internal "thinking" phases.

## [1.0.2] - 2026-04-10

### Added
- **Truncation-Safe Execution**: Updated the tool engine regex to support truncated `[EXEC:]` tags, ensuring commands execute even when models hit output token limits.
- **WSL2 System Patterns**: Added explicit guidance and support for `cmd.exe /c start` patterns to reliably launch Windows utilities from the WSL2 bash shell.

### Changed
- **Increased History Budget**: Raised the Groq-specific history compression threshold to 24,000 characters and increased the tool turn cap to 10 to prevent premature context loss during long debugging sessions.

### Fixed
- **Infinite Tool Loops**: Resolved a critical recursion bug where truncated tool tags would be ignored by the engine and repeated by the model indefinitely.
- **Path Quoting Corruption**: Repaired the auto-quoter logic to prevent double-quoting paths (e.g., `""path""`), resolving silent command failures on Windows/WSL2.
- **Search Hallucinations**: Implemented strict anti-mocking rules and "Force Stop" sequences to prevent the model from fabricating filesystem contents or simulating system UI.

## [1.0.1] - 2026-04-09

### Added
- **GitHub Models Integration**: Background "Inner Monologue" tasks are now offloaded to GitHub Models (`Llama-3.3-70B`) when configured, preserving the primary provider's token budget.
- **Aggressive Context Compression**: Implemented a head+tail (40% front / 60% back) summarization strategy for active files and background reasoning tasks when using Groq, significantly reducing "Request too large" errors.

### Changed
- **Optimized History Budget**: Reduced conversation history pruning threshold specifically for Groq to 20,000 characters to ensure stability on free-tier TPM (14.4k tokens).
- **Refined Educational UI**: Updated the 429 "Rate Limit Hit" handler to provide provider-specific troubleshooting guidance and TPM explanations.

### Fixed
- **State Carry-over Bug**: Resolved an issue where the application remained in an "Offline" state after a rate limit error, even after a valid new API key was saved.
- **CSS Compatibility**: Added standard properties for `background-clip` and `line-clamp` to resolve browser compatibility warnings.

## [1.0.0] - 2026-03-31
- Initial release of SCAAI platform with local persistent memory and multi-provider support.

[1.0.2]: https://github.com/SCAAI/RUN/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/SCAAI/RUN/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/SCAAI/RUN/releases/tag/v1.0.0
