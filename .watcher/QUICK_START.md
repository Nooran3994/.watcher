# Application Watcher - Quick Start & Examples

## 🚀 30-Second Setup

```bash
# 1. Copy to your project
mkdir -p .watcher
cp app_watcher.py ./.watcher/
cp setup_watcher.py ./.watcher/
python .watcher/setup_watcher.py

# 2. Start your app
npm start &  # (in another terminal)

# 3. Start watching
python .watcher/app_watcher.py --port 3000

# 4. When done, press Ctrl+C
# Reports appear in .watcher/reports/
```

## 📋 Common Commands

### Monitor Default App (localhost:3000)
```bash
python app_watcher.py
```

### Monitor Custom Host/Port
```bash
python app_watcher.py --host 127.0.0.1 --port 8080
```

### Adjust Sensitivity
```bash
# Mark requests slower than 500ms as slow
python app_watcher.py --response-threshold 500

# Check performance every 1 second (more detailed)
python app_watcher.py --check-interval 1
```

### Custom Watcher Directory
```bash
python app_watcher.py --watcher-dir ./monitoring
```

### Using Shell Wrapper (Linux/Mac)
```bash
chmod +x watch.sh
./watch.sh                                  # localhost:3000
./watch.sh -p 8080                          # localhost:8080
./watch.sh -h 192.168.1.100 -p 3000         # Remote server
./watch.sh --setup                          # Initialize
```

### Using Batch Wrapper (Windows)
```cmd
watch.bat                                   :: localhost:3000
watch.bat -p 8080                           :: localhost:8080
watch.bat -h 192.168.1.100 -p 3000          :: Remote server
watch.bat --setup                           :: Initialize
```

## 🎯 Real-World Scenarios

### Scenario 1: Debugging a Slow Endpoint

**Problem:** Your API is responding slowly

**Steps:**
```bash
# Start your app
npm start

# In another terminal, start watcher
python app_watcher.py --response-threshold 500

# Simulate realistic traffic (curl in a loop, or use your app)
for i in {1..50}; do curl http://localhost:3000/api/users; done

# Press Ctrl+C when done
# Check the reports
cat .watcher/reports/error_analysis_*.json
```

**Example Output:**
```json
{
  "debugging_suggestions": [
    "🟡 /api/users averaging 2341ms (slow): Check database indices, n+1 queries, large payloads, or caching"
  ]
}
```

**What to Do:**
1. Check database queries in that endpoint
2. Look for N+1 query problems
3. Add caching if fetching static data
4. Optimize payload size

---

### Scenario 2: Finding Memory Leaks

**Problem:** App gets slower over time

**Steps:**
```bash
# Start monitoring
python app_watcher.py --check-interval 5

# Let the app run for 30 minutes while using it normally

# Stop monitoring
# Ctrl+C

# Check resource metrics
cat .watcher/reports/resources_*.csv
```

**Look for:**
```csv
timestamp,cpu_percent,memory_percent,memory_mb,disk_percent,open_files
2024-01-15T14:00:00,5.2,12.5,256.3,45.2,12
2024-01-15T14:05:00,6.1,15.3,312.5,45.2,15    # Memory growing
2024-01-15T14:10:00,7.2,18.9,385.2,45.2,18    # Still growing
```

**Consistent increase = memory leak**

**What to Do:**
1. Check for event listeners not being removed
2. Look for growing arrays that never clear
3. Check promise chains that don't resolve
4. Use Chrome DevTools Memory profiler

---

### Scenario 3: Network Reliability Testing

**Problem:** Getting intermittent connection errors

**Steps:**
```bash
# Start with longer monitoring
python app_watcher.py

# Simulate network stress (optional)
# Use tools like tc (Linux) to introduce latency/packet loss

# Run intensive tests
for i in {1..500}; do 
  curl -s http://localhost:3000/api/data > /dev/null & 
done

# Ctrl+C to stop

# Analyze failures
cat .watcher/reports/error_analysis_*.json
```

**Example Output:**
```json
{
  "error_patterns": {
    "timeout_count": 15,
    "connection_count": 3
  },
  "debugging_suggestions": [
    "🔴 15 timeout(s) detected: Check server response times, database queries, or increase request timeout"
  ]
}
```

---

### Scenario 4: Performance Before/After

**Problem:** You optimized something, need to verify improvement

**Before Optimization:**
```bash
python app_watcher.py --response-threshold 1000
# Run workload for 5 minutes
# Ctrl+C
# Note: average response time from summary
```

**After Optimization:**
```bash
python app_watcher.py --response-threshold 1000
# Run same workload for 5 minutes
# Ctrl+C
# Compare: average response time should be lower
```

**Check CSV:**
```bash
# Compare both session's performance CSVs
# Sort by endpoint and compare response_time_ms
```

---

### Scenario 5: Error Pattern Analysis

**Problem:** Certain requests fail randomly

**Steps:**
```bash
# Start watcher
python app_watcher.py

# Make problematic requests repeatedly
for i in {1..100}; do 
  python -c "
import requests
try:
    requests.get('http://localhost:3000/api/problematic', timeout=5)
except Exception as e:
    print(f'Error: {e}')
" &
done

# Wait and stop
# Ctrl+C

# View error distribution
cat .watcher/reports/summary_*.csv | grep "error"
```

**Example Summary:**
```
metric,value
Total Errors,23
Top Errors:
1. Connection error on /api/problematic: 12 times
2. Timeout on /api/problematic: 11 times
```

---

## 📊 Reading the Reports

### events_*.csv
Contains all events:
- Errors, warnings, slow requests
- Resources usage peaks
- Connection failures

**Sort by severity:**
```bash
grep "critical\|error" events_*.csv
```

### performance_*.csv
Request-by-request metrics:
- response_time_ms: How long each request took
- status_code: HTTP status (200=ok, 500=error)
- is_slow: true if response_time_ms > threshold

**Find slow requests:**
```bash
grep "true" performance_*.csv
```

**Get endpoint statistics:**
```bash
# Linux/Mac
cut -d',' -f2 performance_*.csv | sort | uniq -c | sort -rn
```

### resources_*.csv
System resource usage over time:
- cpu_percent: CPU usage
- memory_percent: Memory percentage
- memory_mb: Actual memory in MB
- open_files: File handles

**Check for resource growth:**
```bash
# Last 10 entries should show trends
tail -10 resources_*.csv
```

### summary_*.csv
High-level statistics:
- Total request count
- Error rates
- Session duration
- Slow request count

**One-page overview of session**

### error_analysis_*.json
Debugging suggestions:
- Error patterns identified
- Specific debugging tips
- Top errors breakdown

**Your actionable debugging guide**

---

## 🛠️ Advanced Usage

### Monitor Multiple Endpoints (Custom)

```python
from app_watcher import ApplicationWatcher

watcher = ApplicationWatcher("localhost", 3000, ".watcher", logger)
watcher.start()

# Monitor specific endpoints
endpoints = ["/", "/api/users", "/api/products", "/api/auth/login"]

import time
while watcher.is_running:
    for endpoint in endpoints:
        watcher.monitor_performance(endpoint)
    time.sleep(2)

watcher.stop()
```

### Integrate with Your App

```python
# In your Flask/FastAPI app
from app_watcher import ApplicationWatcher

watcher = None

@app.before_first_request
def start_watcher():
    global watcher
    watcher = ApplicationWatcher("localhost", 5000, ".watcher", logger)
    watcher.start()

@app.teardown_appcontext
def stop_watcher(error=None):
    if watcher:
        watcher.stop()
```

### CI/CD Integration

**GitHub Actions:**
```yaml
- name: Performance Testing
  run: |
    python app_watcher.py &
    WATCHER_PID=$!
    npm test
    kill $WATCHER_PID
    
- name: Upload Reports
  uses: actions/upload-artifact@v2
  with:
    name: watcher-reports
    path: .watcher/reports/
```

### Docker Integration

```dockerfile
RUN pip install requests psutil
COPY app_watcher.py .
CMD sh -c "npm start & python app_watcher.py"
```

---

## 🔍 Interpretation Guide

### Response Time Analysis

| Response Time | Assessment | Action |
|---|---|---|
| < 100ms | Fast | ✅ Good |
| 100-500ms | Normal | ✅ OK |
| 500-1000ms | Slow | ⚠️ Monitor |
| 1000-5000ms | Very Slow | 🔴 Investigate |
| > 5000ms | Critical | 🔴 Fix ASAP |

### Error Rate Analysis

| Error Rate | Assessment | Action |
|---|---|---|
| 0-1% | Excellent | ✅ Good |
| 1-5% | Good | ✅ OK |
| 5-10% | Concerning | ⚠️ Monitor |
| > 10% | Critical | 🔴 Investigate |

### Resource Usage

| CPU | Status | Action |
|---|---|---|
| < 20% | Normal | ✅ Good |
| 20-50% | Moderate | ✅ OK |
| 50-80% | High | ⚠️ Monitor |
| > 80% | Critical | 🔴 Optimize |

| Memory | Status | Action |
|---|---|---|
| < 30% | Normal | ✅ Good |
| 30-60% | Moderate | ✅ OK |
| 60-85% | High | ⚠️ Monitor |
| > 85% | Critical | 🔴 Free memory |

---

## ❓ FAQ

**Q: Does watcher affect app performance?**
A: Minimal. It makes HTTP requests (~2 per second) and checks system resources.

**Q: Can I monitor production?**
A: Not recommended. Use for staging/testing. In production, use dedicated APM tools.

**Q: How long should I run it?**
A: 5-10 minutes for quick checks. 30+ minutes for comprehensive analysis.

**Q: What if app crashes?**
A: Watcher still generates reports with data up to the crash point.

**Q: Can I view reports while watcher is running?**
A: Yes, reports are updated live in .watcher/reports/

**Q: How do I compare two sessions?**
A: Keep old reports, save new ones separately. Use tools like `diff` or Excel.

---

## 📚 Next Steps

1. **Try it out** - Run the 30-second setup
2. **Review reports** - Check .watcher/reports/ after first run
3. **Customize** - Adjust thresholds for your app's baseline
4. **Automate** - Integrate with your CI/CD pipeline
5. **Monitor regularly** - Use before releases to catch regressions

---

**Happy debugging! 🚀**
