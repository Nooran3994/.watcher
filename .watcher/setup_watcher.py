#!/usr/bin/env python3
"""
Setup script for Application Watcher
Installs dependencies and initializes the .watcher directory structure
"""

import subprocess
import sys
import os
from pathlib import Path


def run_command(cmd, description):
    """Run a shell command with error handling"""
    print(f"\n[INFO] {description}...")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[ERROR] {result.stderr}")
            return False
        print(f"[SUCCESS] {description} complete")
        return True
    except Exception as e:
        print(f"[ERROR] {str(e)}")
        return False


def create_directory_structure(watcher_dir):
    """Create the .watcher directory structure"""
    directories = [
        watcher_dir,
        watcher_dir / "logs",
        watcher_dir / "reports",
        watcher_dir / "config"
    ]
    
    print(f"\n[INFO] Creating directory structure in {watcher_dir}...")
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
        print(f"  [OK] {directory}")


def create_config_file(watcher_dir):
    """Create a sample configuration file"""
    config_file = watcher_dir / "config" / "watcher.config"
    
    config_content = """# Application Watcher Configuration
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
    
    with open(config_file, 'w') as f:
        f.write(config_content)
    
    print(f"[SUCCESS] Configuration file created: {config_file}")


def create_readme(watcher_dir):
    """Create a README with usage instructions"""
    readme_file = watcher_dir / "README.md"
    
    readme_content = """# Application Watcher

Real-time performance monitoring and error detection for your application.

## Installation

```bash
pip install -r requirements.txt
```

## Quick Start

```bash
# Monitor app on localhost:3000
python app_watcher.py --host localhost --port 3000

# Custom configuration
python app_watcher.py --host 127.0.0.1 --port 8080 --check-interval 5
```

## Output

### Directories
- `logs/` - Application logs
- `reports/` - Generated CSV and JSON reports
- `config/` - Configuration files

### Generated Reports

1. **events_*.csv** - All monitoring events
2. **performance_*.csv** - Response times and latency
3. **resources_*.csv** - CPU, memory, disk usage
4. **summary_*.csv** - Key statistics
5. **error_analysis_*.json** - Error patterns and debugging suggestions

## Features

* Real-time performance tracking
* Error detection and classification
* Resource monitoring (CPU, memory, disk)
* Automatic error pattern analysis
* Debugging suggestions
* Comprehensive CSV reports
* Network health checks

## Configuration

Edit `config/watcher.config` to customize:
- Check intervals
- Alert thresholds
- Response time limits
- Resource monitoring levels

## Interpreting Reports

### Performance CSV
- `response_time_ms` > threshold = slow request (WARNING)
- `status_code` >= 400 = failed request (ERROR)

### Error Analysis
- Suggestions show patterns and fixes
- Top errors list most frequent issues
- Pattern detection identifies root causes

## Tips for Debugging

1. **Slow Requests**: Check database queries, n+1 problems, caching
2. **Timeouts**: Increase timeout or check server load
3. **Memory Growth**: Look for leaks in event handlers
4. **High CPU**: Profile code hotspots
5. **Connection Errors**: Verify server is running

## Example Integration

```python
# In your app, call custom logging
import subprocess
import json

def log_custom_metric():
    subprocess.run([
        'python', 'app_watcher.py', '--log-custom',
        '--message', 'Payment processed',
        '--severity', 'info'
    ])
```

## Support

For issues or feature requests, check the generated error analysis JSON.
"""
    
    with open(readme_file, 'w') as f:
        f.write(readme_content)
    
    print(f"[SUCCESS] README created: {readme_file}")


def create_requirements_file(watcher_dir):
    """Create requirements.txt for dependencies"""
    requirements_file = watcher_dir / "requirements.txt"
    
    requirements_content = """requests==2.31.0
psutil==5.9.6
beautifulsoup4==4.12.2
"""
    
    with open(requirements_file, 'w') as f:
        f.write(requirements_content)
    
    print(f"[SUCCESS] Requirements file created: {requirements_file}")


def main():
    """Main setup function"""
    print("=" * 70)
    print("APPLICATION WATCHER SETUP")
    print("=" * 70)
    
    # Define watcher directory
    watcher_dir = Path(".watcher")
    
    # Step 1: Create directory structure
    create_directory_structure(watcher_dir)
    
    # Step 2: Create configuration
    create_config_file(watcher_dir)
    
    # Step 3: Create requirements file
    create_requirements_file(watcher_dir)
    
    # Step 4: Create README
    create_readme(watcher_dir)
    
    # Step 5: Install dependencies
    print("\n" + "=" * 70)
    print("INSTALLING DEPENDENCIES")
    print("=" * 70)
    
    success = run_command(
        f"{sys.executable} -m pip install -q requests psutil beautifulsoup4",
        "Installing Python packages"
    )
    
    if success:
        print("\n" + "=" * 70)
        print("[SUCCESS] SETUP COMPLETE!")
        print("=" * 70)
        print(f"""
Your watcher is ready to use. To start monitoring:

    python app_watcher.py --host localhost --port 3000

Directory structure created:
  .watcher/
  - logs/
  - reports/
  - config/
  - requirements.txt
  - README.md

For more info, see .watcher/README.md
        """)
    else:
        print("\n[WARNING] Some setup steps failed. Please check the errors above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
