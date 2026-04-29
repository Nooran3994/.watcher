# Watcher Auto-Start

The setup script can optionally inject a VS Code task into your project's
`.vscode/tasks.json` that starts the watcher automatically whenever
the workspace is opened.

## How It Works

When setup runs with `--auto-start`, it merges the task from
`vscode-task-template.json` into your project's `.vscode/tasks.json`.

The task:
- Runs `watch.bat` (Windows) or `watch.sh` (Mac/Linux) in a dedicated terminal panel
- Starts in the background — does not block your other tasks
- Prompts once for your dev server port (default: 3000)
- Triggers on `folderOpen` — fires automatically when VS Code opens the project

## Disabling Auto-Start

To stop the watcher from auto-starting:

1. Open `.vscode/tasks.json` in your project
2. Remove the task with `"label": "Start Watcher"`
3. Save the file

## Manual Start (Alternative)

If you prefer to start manually, run in a terminal:

```bash
# Windows
.watcher\watch.bat -p 3000

# Mac / Linux
./.watcher/watch.sh -p 3000
```

## Supported IDEs

| IDE        | Auto-start method                          |
|------------|--------------------------------------------|
| VS Code    | .vscode/tasks.json (this directory)        |
| JetBrains  | Run Configuration — Shell Script           |
| Cursor     | .vscode/tasks.json (same as VS Code)       |
| Windsurf   | .vscode/tasks.json (same as VS Code)       |
| Other      | Run watch.bat / watch.sh manually          |
