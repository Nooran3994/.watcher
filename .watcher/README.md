# Application Watcher

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
