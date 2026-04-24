# Application Watcher - Integration Guide

## 📋 Overview

The Application Watcher is a standalone monitoring system that integrates with any web application running on localhost. It requires **zero code changes** to your existing codebase.

## 🚀 Quick Integration (3 Steps)

### Step 1: Copy to Your Project

```bash
# In your project root directory
cp app_watcher.py ./.watcher/
cp setup_watcher.py ./.watcher/
python .watcher/setup_watcher.py
```

### Step 2: Update .gitignore

```bash
# Add to your .gitignore
.watcher/logs/
.watcher/reports/
*.csv
*.log
```

### Step 3: Start Your App + Watcher

```bash
# Terminal 1: Start your application
npm start          # or python app.py, go run ./main.go, etc.

# Terminal 2: Start the watcher
python .watcher/app_watcher.py --host localhost --port 3000
```

## 🔧 Configuration

### Command-Line Options

```bash
python app_watcher.py \
  --host localhost \           # Application host
  --port 3000 \               # Application port
  --watcher-dir ./.watcher \  # Where to store reports
  --check-interval 2 \        # Seconds between checks
  --response-threshold 1000   # Slow request threshold (ms)
```

### Environment Variables

Create `.watcher/config/watcher.config`:

```
HOST=localhost
PORT=3000
CHECK_INTERVAL_SECONDS=2
RESPONSE_TIME_THRESHOLD_MS=1000
CPU_ALERT_THRESHOLD=80
MEMORY_ALERT_THRESHOLD=85
```

## 📊 Understanding Reports

### Generated Files

After the watcher stops, CSV and JSON reports are created in `.watcher/reports/`:

```
reports/
├── events_20240115_143022.csv         # All events
├── performance_20240115_143022.csv    # Response times
├── resources_20240115_143022.csv      # CPU/memory/disk
├── summary_20240115_143022.csv        # Key metrics
└── error_analysis_20240115_143022.json # Debugging tips
```

### Reading Performance CSV

```
event_id,timestamp,event_type,severity,message,duration_ms,endpoint,status_code
1234567,2024-01-15T14:30:22,performance,warning,Slow response on /api/users: 1523.45ms,1523.45,/api/users,200
```

**Key columns:**
- `severity` = info | warning | error | critical
- `duration_ms` = request time
- `status_code` >= 400 = failed request
- `event_type` = performance | error | network | resource | custom

### Reading Error Analysis JSON

```json
{
  "error_patterns": {
    "timeout_count": 2,
    "connection_count": 0,
    "slow_endpoints": [
      {
        "endpoint": "/api/users",
        "occurrences": 5,
        "avg_response_time": 1523.45
      }
    ]
  },
  "debugging_suggestions": [
    "🟡 /api/users averaging 1523ms (slow): Check database indices, n+1 queries...",
    "🔴 High error rate: 12.5% of requests failed. Review recent code changes..."
  ]
}
```

## 🎯 Use Cases

### Case 1: Performance Regression Detection

**Scenario:** New feature is slow

**Steps:**
1. Start watcher while running feature
2. Interact with feature for 5 minutes
3. Stop watcher (Ctrl+C)
4. Check `performance_*.csv` for slow endpoints
5. Look at `error_analysis_*.json` for specific suggestions

**Example Output:**
```
🟡 /api/new-feature averaging 3200ms (slow): 
   Check database indices, n+1 queries, large payloads, or caching
```

### Case 2: Debugging Production-Like Issues

**Scenario:** App works locally but seems slow

**Steps:**
1. Start watcher on same conditions as production
2. Simulate realistic user load
3. Monitor for 10-30 minutes
4. Review error patterns and suggestions
5. Fix identified bottlenecks

### Case 3: Memory Leak Detection

**Scenario:** App gets slower over time

**Steps:**
1. Start watcher in long-running test
2. Watcher logs CPU/memory continuously
3. Check `resources_*.csv` for growth patterns
4. Memory line = leak if consistently increasing
5. Add breakpoint at suggested functions

### Case 4: Network Issue Diagnosis

**Scenario:** Intermittent connection failures

**Steps:**
1. Start watcher during peak load
2. Connection errors trigger events
3. Review `error_analysis_*.json`
4. Suggestions include timeout/firewall checks
5. Implement fixes based on pattern

## 🔌 Advanced Integration

### Integration with Existing Logging

```python
# In your app (e.g., Flask, Django, FastAPI)

import subprocess
import json
from datetime import datetime

def log_to_watcher(message, severity="info", **context):
    """Send custom events to watcher"""
    event = {
        "message": message,
        "severity": severity,
        "timestamp": datetime.now().isoformat(),
        "context": context
    }
    # Watcher would read this from a log file or API
    print(f"[WATCHER] {json.dumps(event)}")
```

### Integration with CI/CD

**GitHub Actions Example:**

```yaml
name: Performance Test
on: [pull_request]

jobs:
  performance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Start app
        run: npm start &
        
      - name: Start watcher
        run: python app_watcher.py --host localhost --port 3000 &
        
      - name: Run tests
        run: npm test
        
      - name: Upload reports
        uses: actions/upload-artifact@v2
        with:
          name: watcher-reports
          path: .watcher/reports/
```

### Integration with Docker

**Dockerfile:**

```dockerfile
FROM node:18

WORKDIR /app
COPY . .

RUN npm install
RUN pip install requests psutil

COPY app_watcher.py .

# Start both app and watcher
CMD ["sh", "-c", "npm start & python app_watcher.py --host localhost --port 3000"]
```

### Custom Monitoring

Add extra endpoints to monitor:

```python
# Extend ApplicationWatcher class
class CustomWatcher(ApplicationWatcher):
    def monitor_performance(self, endpoint="/"):
        # Monitor multiple endpoints
        endpoints = ["/", "/api/health", "/api/users", "/api/products"]
        for ep in endpoints:
            super().monitor_performance(ep)
```

## 🐛 Troubleshooting

### Problem: "Cannot connect to localhost:3000"

**Solution:**
```bash
# Check if app is running
curl http://localhost:3000

# Check firewall
sudo lsof -i :3000

# Start app first, then watcher
```

### Problem: "No events generated"

**Solution:**
```bash
# Watcher only logs events when:
# 1. Response time > threshold (default 1000ms)
# 2. Error occurs
# 3. Resource usage is high

# Force events by stressing the app
for i in {1..100}; do curl http://localhost:3000/api/heavy; done
```

### Problem: "ModuleNotFoundError: No module named 'requests'"

**Solution:**
```bash
pip install requests psutil beautifulsoup4
# or
python -m pip install -r .watcher/requirements.txt
```

### Problem: "Permission denied"

**Solution:**
```bash
chmod +x app_watcher.py setup_watcher.py
```

## 📈 Performance Tips

### Optimize for Monitoring

1. **Set appropriate threshold:**
   ```bash
   # For fast APIs (React, Vue)
   python app_watcher.py --response-threshold 100
   
   # For slow APIs (data-heavy)
   python app_watcher.py --response-threshold 5000
   ```

2. **Adjust check interval:**
   ```bash
   # More frequent checks = more CPU
   python app_watcher.py --check-interval 1  # Every 1 second
   
   # Less frequent = might miss issues
   python app_watcher.py --check-interval 10  # Every 10 seconds
   ```

3. **Filter endpoints:**
   ```python
   # Monitor only critical endpoints
   watcher.monitor_performance("/api/critical")
   ```

## 📚 Example Workflow

### Typical Debugging Session

```bash
# 1. Start your application
cd my-app && npm start
# App running on http://localhost:3000

# 2. In another terminal, start watcher
python .watcher/app_watcher.py

# 3. Use app normally or run tests
# Make requests, interact with UI
# Watcher logs everything in background

# 4. After testing, stop watcher (Ctrl+C)
^C
# Watcher generates reports and prints summary:
# 
# ================================================================================
# APPLICATION WATCHER - SESSION SUMMARY
# ================================================================================
# 
# 📊 REQUEST STATISTICS:
#   Total Requests:     234
#   Failed Requests:    12
#   Slow Requests:      8
#   Success Rate:       94.9%
# 
# ⚠️  ERROR STATISTICS:
#   Total Errors:       15
#   Session Duration:   5.2 minutes
#
# 🔍 DEBUGGING SUGGESTIONS:
#   1. 🟡 /api/users averaging 1523ms (slow): Check database indices...
#   2. 🔴 5% error rate detected on /api/auth: Review recent changes...

# 5. Review generated reports
cat .watcher/reports/error_analysis_*.json
```

## 🎓 Best Practices

1. **Run periodically** - Don't leave watcher on all day
2. **Use during development** - Catch issues early
3. **Run before deployment** - Verify performance
4. **Keep reports** - Track performance over time
5. **Automate with CI/CD** - Catch regressions

## 📝 Common Questions

**Q: Does watcher slow down my app?**
A: No. It makes HTTP requests to monitor, minimal overhead.

**Q: Can it monitor multiple applications?**
A: Run separate watcher instances on different ports.

**Q: What's the overhead?**
A: ~5% CPU for monitoring thread, depends on check interval.

**Q: Does it capture sensitive data?**
A: No. It only records response times and errors, not payloads.

**Q: Can I use it in production?**
A: Yes, but recommended for staging/pre-production.

---

**Created:** 2024
**License:** MIT
**Support:** Check generated error_analysis JSON for debugging tips
