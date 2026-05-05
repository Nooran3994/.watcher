# SCAAI Desktop — Senior Engineer Edition

SCAAI (Supercharged AI) is a powerful desktop assistant running locally on your PC via Electron. It is optimized for senior engineering workflows with adaptive context management, multi-provider intelligence, and native file system access.

---

## 🚀 Key Architectural Advantages

| Feature | Desktop Implementation | Engineering Benefit |
|---------|------------------------|---------------------|
| **Cybernetic Drive** | Native Tool Calling (list, read, write, search) | Access your PC like a 'Second Brain' with autonomous agency. |
| **Dual-Provider Logic** | Groq (Primary) + GitHub (Background) | 2x speed for reasoning without hitting rate limits. |
| **Adaptive Compression** | Head + Tail (40/60) Summarization | Fits large codebases into small context windows safely. |
| **Native Integration** | Direct OS Shell + WSL2 Interaction | Run tests, build scripts, and open apps directly on disk. |
| **Hybrid GraphRAG** | SQLite + ChromaDB Memory | Combines semantic similarity with relational graph reasoning. |
| **Local Memory** | Persistent JSON-based context | Remembers your coding patterns across sessions. |
| **Technical Docs** | Structured ADR & System Guides | Full audit trail of architectural decisions. |

---

## 🛠️ Requirements

- **Node.js** (v18 or later) — https://nodejs.org
- **OpenRouter & Groq API Keys** (for primary chat)
- **GitHub Personal Access Token** (optional, for background reasoning offloading)

---

## 📦 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Launch
```bash
npm start
```

### 3. Configure Orchestration
Open ⚙️ **Settings** to configure your primary provider (Groq/OpenRouter) and your GitHub Models token. The system automatically routes background reasoning to GitHub to preserve your primary Token-Per-Minute (TPM) budget.

---

## 📚 Technical Documentation

For deep-dives into the system's architecture and decisions, refer to the `docs/` directory:

- **[Architecture Decision Records (ADR)](./docs/adr/)**: Tracking the "Why" behind major changes.
    - [ADR-0001: Mitigating Groq Rate Limits](./docs/adr/0001-mitigate-groq-rate-limits.md)
    - [ADR-0008: GraphRAG Hybrid Memory Architecture](./docs/adr/0008-graphrag-hybrid-memory.md)
    - [ADR-0009: Native Tool Calling & Cybernetic Drive](./docs/adr/0009-native-tool-calling-and-cybernetic-drive.md)
- **[System Guides](./docs/systems/)**: Technical specifications of core components.
    - [Rate Limiting & Context Mitigation](./docs/systems/rate-limiting-mitigation.md)
    - [GraphRAG & Memory Engine](./docs/systems/graph-memory-engine.md)
- **[Changelog](./CHANGELOG.md)**: Historical tracking of performance updates and bug fixes.

---

## 🧠 Provider Performance & Orchestration

SCAAI uses a sophisticated multi-provider workflow to handle the high token demands of modern engineering tasks:

- **Primary Chat**: Typically routed to Groq or OpenRouter for maximum human-interaction speed.
- **Inner Monologue**: Background reasoning is automatically offloaded to GitHub Models (e.g., Llama 3.3 70B) to avoid `429 Rate Limit` errors on your primary key.
- **Head + Tail Pruning**: If a file or conversation grows too large, the system automatically preserves the critical headers (imports/setup) and the most recent context (current code/latest messages), summarizing the middle to stay under provider limits.

---

## 🛠️ Advanced Features

### Cybernetic Drive System
SCAAI now has autonomic control over the local machine via native function calling:
- **Navigation**: `list_drives` and `get_context` for system-wide orientation.
- **Search**: `search_files` for deep recursive discovery across partitions.
- **File Control**: Native `read_file` and `write_file` for binary-safe disk operations.
- **App Management**: `open_path` to natively launch files, folders, and URLs.

### WSL2 Integration
SCAAI automatically detects WSL2. All shell commands run inside your default Linux distro (e.g., Ubuntu). Status is shown in the terminal at startup:
`🐧 WSL2 active — distro: Ubuntu-20.04. All shell commands run in bash.`

### Premium UI Transformation
A premium, glassmorphic chat interface with alternating message alignment, smooth theme transitions, and intelligent message bundling to maximize visual clarity and focus.

### Intelligent Collapsing System
Tiered truncation logic that automatically manages long messages and code blocks:
- **AI Reasoning**: 25-line / 1800-character threshold for deep technical responses.
- **User Intent**: Compact 5-line / 400-character threshold for request tracking.
- **Granular Code Blocks**: Individual file blocks > 15 lines are collapsed with "Expand All" bulk controls.

### Knowledge Graph Visualizer
An interactive **GRAPH** tab powered by `vis-network` that allows you to explore the relational memory triples extracted from your conversations.

### Self-Awareness Telemetry
Real-time injection of memory statistics (total chunks, nodes, and edges) into the cognitive pipeline, ensuring the AI is grounded in its own state and capacity.

### Interactive Onboarding Engine
A dynamic boot sequence designed to extract user identity and project goals on first launch, facilitating automated persona tailoring and long-term continuity.

### Model Recommendations
| Provider | Model | Best For |
|----------|-------|----------|
| **Groq** | `llama-3.1-70b-versatile` | High-speed primary coding. |
| **GitHub** | `Llama-3.3-70B-Instruct` | Background reasoning & offloading. |
| **OpenRouter**| `anthropic/claude-3.5-sonnet` | Complex multi-file architectural changes. |

## 📂 Project Structure

SCAAI follows a modular architecture that separates system-level operations from user interface logic:

```bash
SCAAI_RUN/
├── src/
│   ├── main/           # Electron Main Process (System Access)
│   │   ├── main.js     # App entry point & window management
│   │   ├── preload.js  # Secure IPC bridge
│   │   └── agents.js   # Background service handlers
│   └── renderer/       # Renderer Process (UI & AI Logic)
│       ├── renderer.js # Main UI execution logic
│       └── styles/     # Component & global CSS
├── docs/               # System architecture & decision records
├── assets/             # Images, fonts, and static assets
└── index.html          # Application entry shell
```

---

## 🛡️ Where Your Data Lives

Your configurations, memory, and persona evolution are stored locally in your home directory:
- **Windows**: `C:\Users\YourName\.scaai\`
- **Linux/macOS**: `~/.scaai/`

---

Built with Electron + Vanilla JS + Senior Engineer Ethics
Managed by **SCAAI Team**
