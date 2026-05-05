# System Documentation: Tool Execution Engine

## Overview

The SCAAI Tool Execution Engine is the interface between the LLM and the host operating system. It allows the agent to interact with the filesystem, run shell commands, and automate system tasks. On Windows, it specifically manages the boundary between the Electron host environment and the WSL2 (Windows Subsystem for Linux) distribution.

## Command Lifecycle

1.  **Detection**: The engine uses the `executeTools()` function to scan every incoming message for tags matching `[EXEC: command]`, `[LIST: path]`, or `[READ: path]`.
2.  **Truncation Recovery**: If a tag is truncated (e.g., `[EXEC: ls`), the engine uses a greedy fallback regex to catch the command before the message stream ends.
3.  **OS Mapping (WSL2)**:
    -   If WSL2 is active, the engine automatically prepends `wsl.exe -e` to the command.
    -   Host paths (e.g., `C:\Users`) are mapped to Linux mount points (e.g., `/mnt/c/Users`) using the `wsl.exe wslpath` utility or internal mapping logic.
4.  **Auto-Quoting & Safety**:
    -   Commands are scanned for spaces and special characters.
    -   A de-duplication pass ensures paths are not double-quoted.
    -   Dangerous character sequences (e.g., recursive deletes on system dirs) are blocked via prompt-level guards.
5.  **Execution**: Commands are executed via `child_process.exec`.
6.  **Formatting**: Result output is wrapped in a `⚙ COMPUTER` message block and injected back into the LLM context.

## WSL2 Interface Guarantees

To ensure reliable execution, the following rules are enforced via the System Prompt:

-   **Binary Extensions**: Any Windows-native executable called from bash must explicitly include the `.exe` extension (e.g., `cmd.exe`, `explorer.exe`).
-   **Utility Execution**: System utilities like the Control Panel or Registry Editor should be launched via the `cmd.exe /c start <utility>` pattern to ensure proper detachment from the shell.
-   **Path Resolution**: The engine assumes `/mnt/c/` is the primary mount point for Windows drives.

## Integrity & Anti-Hallucination

The engine implements several layers of ground-truth enforcement:

-   **Stop Sequence**: The model is instructed to stop immediately after emitting a tool tag. This prevents it from writing predicted outcomes before the tool actually runs.
-   **UI Reservation**: The ⚙ icon and the `SYSTEM` / `TOOL RESULT` labels are reserved for the engine. The model is forbidden from mocking these in its responses.
-   **Empty Result Handling**: If a command returns no output, the engine injects an explicit `(no output)` message to prevent the model from assuming it failed or hallucinating "imaginary" files.

## References

- **ADR-0003**: [Resolving Tool Anomalies](../adr/0003-resolve-tool-anomalies-and-hallucinations.md)
- **Mitigation Docs**: [Context Budgeting for Tool Turn Caps](./rate-limiting-mitigation.md)
