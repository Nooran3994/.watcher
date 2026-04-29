#!/usr/bin/env python3
"""
Setup script for Application Watcher
Creates the .watcher directory structure inside the user's project,
injects .gitignore entries, and installs Python dependencies.

Usage:
    python setup_watcher.py
    python setup_watcher.py --project-dir /path/to/user/project

IMPORTANT: This script ONLY creates files inside <project>/.watcher/
           It NEVER touches /src/, /app/, /components/, or any source directory.
"""

import subprocess
import sys
import os
import argparse
from pathlib import Path


# ---------------------------------------------------------------------------
# Python detection
# ---------------------------------------------------------------------------

def detect_python():
    """Auto-detect python or python3 command."""
    for cmd in ["python", "python3"]:
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True, text=True
            )
            if result.returncode == 0 and "Python 3" in result.stdout + result.stderr:
                return cmd
        except (FileNotFoundError, OSError):
            continue
    return sys.executable  # fallback to the interpreter running this script


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_pip_install(python_cmd, packages):
    """Install packages using pip."""
    print(f"\n[INFO] Installing Python packages: {', '.join(packages)}...")
    try:
        result = subprocess.run(
            [python_cmd, "-m", "pip", "install", "-q"] + packages,
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"[WARN] pip install returned non-zero: {result.stderr.strip()}")
            return False
        print("[OK] Packages installed.")
        return True
    except Exception as e:
        print(f"[WARN] pip install failed: {e}")
        return False


def inject_gitignore(project_dir):
    """Append .watcher entries to the project's .gitignore if not already present."""
    gitignore_path = project_dir / ".gitignore"
    entries = [
        "# Application Watcher (auto-generated monitoring data — not source code)",
        ".watcher/logs/",
        ".watcher/reports/",
        ".watcher/*.log",
    ]

    existing_content = ""
    if gitignore_path.exists():
        existing_content = gitignore_path.read_text(encoding="utf-8")

    lines_to_add = [e for e in entries if e not in existing_content]
    if not lines_to_add:
        print("[OK] .gitignore already contains .watcher entries.")
        return

    with open(gitignore_path, "a", encoding="utf-8") as f:
        f.write("\n" + "\n".join(lines_to_add) + "\n")

    print(f"[OK] Appended to .gitignore: {', '.join(l for l in lines_to_add if not l.startswith('#'))}")


def create_config(watcher_dir):
    """Create watcher.config if it doesn't already exist."""
    config_file = watcher_dir / "config" / "watcher.config"
    if config_file.exists():
        print(f"[OK] Config already exists: {config_file}")
        return

    config_content = """\
# Application Watcher Configuration
# =====================================

# Application settings
HOST=localhost
PORT=3000

# Monitoring settings
CHECK_INTERVAL_SECONDS=2
RESOURCE_CHECK_INTERVAL_SECONDS=5
RESPONSE_TIME_THRESHOLD_MS=1000
REQUEST_TIMEOUT_SECONDS=10

# Alerting thresholds
CPU_ALERT_THRESHOLD=80
MEMORY_ALERT_THRESHOLD=85
ERROR_RATE_ALERT_THRESHOLD=0.1

# Report generation
GENERATE_REPORTS_ON_STOP=true
REPORT_FORMAT=csv

# Logging
LOG_LEVEL=INFO
LOG_TO_FILE=true
LOG_TO_CONSOLE=true
"""
    config_file.write_text(config_content, encoding="utf-8")
    print(f"[OK] Created: {config_file}")


# ---------------------------------------------------------------------------
# Main setup
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Set up Application Watcher in a user project."
    )
    parser.add_argument(
        "--project-dir",
        type=str,
        default=None,
        help="Absolute path to the target project root (default: current working directory)"
    )
    args = parser.parse_args()

    # Resolve project directory
    if args.project_dir:
        project_dir = Path(args.project_dir).resolve()
    else:
        project_dir = Path.cwd()

    watcher_dir = project_dir / ".watcher"

    print("=" * 70)
    print("APPLICATION WATCHER SETUP")
    print("=" * 70)
    print(f"  Project:  {project_dir}")
    print(f"  Watcher:  {watcher_dir}")
    print()

    # Step 1 — Detect Python
    python_cmd = detect_python()
    print(f"[OK] Python command: {python_cmd}")

    # Step 2 — Create directory structure (ONLY inside .watcher/)
    for subdir in ["logs", "reports", "config"]:
        (watcher_dir / subdir).mkdir(parents=True, exist_ok=True)
        print(f"[OK] Created: {watcher_dir / subdir}")

    # Step 3 — Create config file
    create_config(watcher_dir)

    # Step 4 — Inject .gitignore entries
    inject_gitignore(project_dir)

    # Step 5 — Install Python dependencies
    packages = ["requests", "psutil", "beautifulsoup4"]
    run_pip_install(python_cmd, packages)

    print()
    print("=" * 70)
    print("[SUCCESS] SETUP COMPLETE")
    print("=" * 70)
    print(f"""
Directory structure created:
  {watcher_dir}/
  - logs/          (watcher logs — gitignored)
  - reports/       (generated CSV/JSON reports — gitignored)
  - config/        (watcher.config)

To start monitoring:
  Windows:  .watcher\\watch.bat -p <PORT>
  Mac/Linux: ./.watcher/watch.sh -p <PORT>

In IDE AI chat, type:  /error-logger
""")


if __name__ == "__main__":
    main()
