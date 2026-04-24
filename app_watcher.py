#!/usr/bin/env python3
"""
Application Watcher - Real-time Performance & Error Monitoring System
================================================================================
Monitors web applications running on localhost, tracks performance metrics,
detects errors, and generates detailed CSV reports for debugging.

Install: pip install requests selenium beautifulsoup4 psutil
Usage: python app_watcher.py --host localhost --port 3000 [--headless]
"""

import os
import sys
import json
import time
import argparse
import csv
import threading
import logging
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict, deque
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, asdict, field
from enum import Enum
import traceback

import requests
from requests.exceptions import RequestException, Timeout, ConnectionError
import psutil


# ============================================================================
# CONFIGURATION & ENUMS
# ============================================================================

class EventType(Enum):
    """Event type classification"""
    PERFORMANCE = "performance"
    ERROR = "error"
    NETWORK = "network"
    UI_INTERACTION = "ui_interaction"
    RESOURCE = "resource"
    CUSTOM = "custom"


class SeverityLevel(Enum):
    """Event severity levels"""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class PerformanceMetrics:
    """Response time and performance data"""
    endpoint: str
    response_time_ms: float
    status_code: int
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    size_bytes: int = 0
    is_slow: bool = False
    threshold_ms: int = 1000


@dataclass
class ErrorEvent:
    """Error and exception tracking"""
    timestamp: str
    error_type: str
    message: str
    severity: str
    endpoint: Optional[str] = None
    stack_trace: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class UIInteraction:
    """UI interaction event"""
    timestamp: str
    element: str
    action: str
    response_time_ms: float
    success: bool
    error_message: Optional[str] = None


@dataclass
class ResourceMetrics:
    """System resource usage"""
    timestamp: str
    cpu_percent: float
    memory_percent: float
    memory_mb: float
    disk_percent: float
    open_files: int


@dataclass
class WatcherEvent:
    """Unified event structure for all monitoring data"""
    event_id: str
    timestamp: str
    event_type: str
    severity: str
    message: str
    duration_ms: Optional[float] = None
    endpoint: Optional[str] = None
    status_code: Optional[int] = None
    cpu_percent: Optional[float] = None
    memory_percent: Optional[float] = None
    error_details: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)


# ============================================================================
# LOGGER SETUP
# ============================================================================

def setup_logging(watcher_dir: Path) -> logging.Logger:
    """Configure logging for the watcher"""
    log_dir = watcher_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    
    log_file = log_dir / f"watcher_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    
    logger = logging.getLogger("AppWatcher")
    logger.setLevel(logging.DEBUG)
    
    # File handler
    fh = logging.FileHandler(log_file)
    fh.setLevel(logging.DEBUG)
    
    # Console handler
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    
    # Formatter
    formatter = logging.Formatter(
        '[%(asctime)s] %(levelname)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    fh.setFormatter(formatter)
    ch.setFormatter(formatter)
    
    logger.addHandler(fh)
    logger.addHandler(ch)
    
    return logger


# ============================================================================
# MAIN WATCHER CLASS
# ============================================================================

class ApplicationWatcher:
    """
    Real-time application monitoring system.
    
    Features:
    - Performance tracking (response times, latency)
    - Error detection and reporting
    - Resource monitoring (CPU, memory, disk)
    - Network health checks
    - Automatic error correction suggestions
    - CSV report generation
    """
    
    def __init__(self, host: str, port: int, watcher_dir: Path, logger: logging.Logger):
        self.host = host
        self.port = port
        self.watcher_dir = watcher_dir
        self.logger = logger
        self.is_running = False
        
        # Data storage
        self.events: List[WatcherEvent] = []
        self.performance_history: deque = deque(maxlen=1000)
        self.error_history: deque = deque(maxlen=500)
        self.resource_history: deque = deque(maxlen=500)
        
        # Statistics
        self.stats = {
            "total_requests": 0,
            "failed_requests": 0,
            "avg_response_time": 0,
            "slow_requests": 0,
            "total_errors": 0,
            "error_distribution": defaultdict(int),
            "endpoints_tracked": set(),
        }
        
        # Configuration
        self.response_time_threshold_ms = 1000
        self.check_interval_seconds = 2
        self.resource_check_interval_seconds = 5
        self.request_timeout_seconds = 10
        
        # Threading
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        
        self.logger.info(f"Watcher initialized for {host}:{port}")
    
    @property
    def base_url(self) -> str:
        """Get base URL for the application"""
        return f"http://{self.host}:{self.port}"
    
    # ========================================================================
    # HEALTH CHECK & MONITORING
    # ========================================================================
    
    def health_check(self) -> bool:
        """Check if application is accessible"""
        try:
            response = requests.get(
                f"{self.base_url}/",
                timeout=self.request_timeout_seconds
            )
            return response.status_code < 500
        except Exception as e:
            self.logger.warning(f"Health check failed: {str(e)}")
            return False
    
    def monitor_performance(self, endpoint: str = "/") -> Optional[PerformanceMetrics]:
        """Monitor endpoint performance"""
        try:
            start_time = time.time()
            response = requests.get(
                f"{self.base_url}{endpoint}",
                timeout=self.request_timeout_seconds
            )
            duration_ms = (time.time() - start_time) * 1000
            
            metrics = PerformanceMetrics(
                endpoint=endpoint,
                response_time_ms=duration_ms,
                status_code=response.status_code,
                size_bytes=len(response.content),
                is_slow=duration_ms > self.response_time_threshold_ms
            )
            
            with self._lock:
                self.performance_history.append(metrics)
                self.stats["total_requests"] += 1
                self.stats["endpoints_tracked"].add(endpoint)
                
                if metrics.is_slow:
                    self.stats["slow_requests"] += 1
                
                if response.status_code >= 400:
                    self.stats["failed_requests"] += 1
            
            # Log slow responses
            if metrics.is_slow:
                severity = SeverityLevel.WARNING if duration_ms < 5000 else SeverityLevel.ERROR
                self._create_event(
                    event_type=EventType.PERFORMANCE,
                    severity=severity,
                    message=f"Slow response on {endpoint}: {duration_ms:.2f}ms",
                    endpoint=endpoint,
                    duration_ms=duration_ms,
                    status_code=response.status_code
                )
                self.logger.warning(f"SLOW: {endpoint} took {duration_ms:.2f}ms")
            
            return metrics
            
        except Timeout:
            self.logger.error(f"Timeout on {endpoint}")
            self._create_event(
                event_type=EventType.NETWORK,
                severity=SeverityLevel.ERROR,
                message=f"Request timeout on {endpoint}",
                endpoint=endpoint
            )
            with self._lock:
                self.stats["failed_requests"] += 1
            return None
            
        except ConnectionError:
            self.logger.error(f"Connection error on {endpoint}")
            self._create_event(
                event_type=EventType.NETWORK,
                severity=SeverityLevel.CRITICAL,
                message=f"Cannot connect to {endpoint}",
                endpoint=endpoint
            )
            with self._lock:
                self.stats["failed_requests"] += 1
            return None
            
        except Exception as e:
            self.logger.error(f"Error monitoring {endpoint}: {str(e)}")
            self._create_event(
                event_type=EventType.ERROR,
                severity=SeverityLevel.ERROR,
                message=f"Monitoring error on {endpoint}: {str(e)}",
                endpoint=endpoint,
                error_details=traceback.format_exc()
            )
            return None
    
    def monitor_resources(self) -> ResourceMetrics:
        """Monitor system resource usage"""
        try:
            process = psutil.Process()
            
            metrics = ResourceMetrics(
                timestamp=datetime.now().isoformat(),
                cpu_percent=process.cpu_percent(interval=0.1),
                memory_percent=process.memory_percent(),
                memory_mb=process.memory_info().rss / 1024 / 1024,
                disk_percent=psutil.disk_usage('/').percent,
                open_files=len(process.open_files())
            )
            
            with self._lock:
                self.resource_history.append(metrics)
            
            # Alert on high resource usage
            if metrics.cpu_percent > 80:
                self._create_event(
                    event_type=EventType.RESOURCE,
                    severity=SeverityLevel.WARNING,
                    message=f"High CPU usage: {metrics.cpu_percent:.1f}%",
                    cpu_percent=metrics.cpu_percent
                )
                self.logger.warning(f"HIGH CPU: {metrics.cpu_percent:.1f}%")
            
            if metrics.memory_percent > 85:
                self._create_event(
                    event_type=EventType.RESOURCE,
                    severity=SeverityLevel.WARNING,
                    message=f"High memory usage: {metrics.memory_percent:.1f}% ({metrics.memory_mb:.1f}MB)",
                    memory_percent=metrics.memory_percent
                )
                self.logger.warning(f"HIGH MEMORY: {metrics.memory_percent:.1f}%")
            
            return metrics
            
        except Exception as e:
            self.logger.error(f"Resource monitoring error: {str(e)}")
            return None
    
    # ========================================================================
    # EVENT MANAGEMENT
    # ========================================================================
    
    def _create_event(
        self,
        event_type: EventType,
        severity: SeverityLevel,
        message: str,
        **kwargs
    ) -> WatcherEvent:
        """Create and store a monitoring event"""
        event = WatcherEvent(
            event_id=f"{datetime.now().timestamp()}_{len(self.events)}",
            timestamp=datetime.now().isoformat(),
            event_type=event_type.value,
            severity=severity.value,
            message=message,
            **kwargs
        )
        
        with self._lock:
            self.events.append(event)
            
            if event_type == EventType.ERROR:
                self.stats["total_errors"] += 1
                self.stats["error_distribution"][message] += 1
        
        return event
    
    def log_custom_event(self, message: str, severity: str = "info", **context):
        """Log a custom event"""
        try:
            severity_enum = SeverityLevel[severity.upper()]
        except KeyError:
            severity_enum = SeverityLevel.INFO
        
        self._create_event(
            event_type=EventType.CUSTOM,
            severity=severity_enum,
            message=message,
            context=context
        )
    
    # ========================================================================
    # ERROR DETECTION & SUGGESTIONS
    # ========================================================================
    
    def detect_error_patterns(self) -> Dict[str, Any]:
        """Analyze errors and suggest corrections"""
        patterns = {
            "timeout_errors": [],
            "connection_errors": [],
            "slow_endpoints": [],
            "high_error_rate_endpoints": defaultdict(list),
            "suggestions": []
        }
        
        with self._lock:
            # Analyze recent events
            recent_errors = [e for e in self.events[-100:] if e.severity in ["error", "critical"]]
            
            for event in recent_errors:
                if "timeout" in event.message.lower():
                    patterns["timeout_errors"].append(event)
                elif "connection" in event.message.lower():
                    patterns["connection_errors"].append(event)
            
            # Analyze slow endpoints
            slow_endpoints = defaultdict(list)
            for metrics in list(self.performance_history)[-100:]:
                if metrics.is_slow:
                    slow_endpoints[metrics.endpoint].append(metrics)
            
            for endpoint, metrics_list in slow_endpoints.items():
                patterns["slow_endpoints"].append({
                    "endpoint": endpoint,
                    "occurrences": len(metrics_list),
                    "avg_response_time": sum(m.response_time_ms for m in metrics_list) / len(metrics_list)
                })
        
        # Generate suggestions
        patterns["suggestions"] = self._generate_suggestions(patterns)
        
        return patterns
    
    def _generate_suggestions(self, patterns: Dict[str, Any]) -> List[str]:
        """Generate debugging suggestions based on patterns"""
        suggestions = []
        
        # Timeout suggestions
        if patterns["timeout_errors"]:
            count = len(patterns["timeout_errors"])
            suggestions.append(
                f"🔴 {count} timeout(s) detected: Check server response times, "
                "database queries, or increase request timeout"
            )
        
        # Connection suggestions
        if patterns["connection_errors"]:
            suggestions.append(
                "🔴 Connection errors detected: Verify server is running and accessible, "
                "check firewall/network settings"
            )
        
        # Slow endpoint suggestions
        if patterns["slow_endpoints"]:
            for slow in patterns["slow_endpoints"][:3]:
                avg_time = slow["avg_response_time"]
                endpoint = slow["endpoint"]
                suggestions.append(
                    f"🟡 {endpoint} averaging {avg_time:.0f}ms (slow): "
                    "Check database indices, n+1 queries, large payloads, or caching"
                )
        
        # High error rate
        if len(self.events) > 20:
            error_rate = self.stats["total_errors"] / self.stats["total_requests"] if self.stats["total_requests"] > 0 else 0
            if error_rate > 0.1:
                suggestions.append(
                    f"🔴 High error rate: {error_rate*100:.1f}% of requests failed. "
                    "Review recent code changes and application logs"
                )
        
        if not suggestions:
            suggestions.append("✅ No issues detected - Application is performing well")
        
        return suggestions
    
    # ========================================================================
    # REPORTING
    # ========================================================================
    
    def generate_csv_report(self) -> Path:
        """Generate comprehensive CSV report"""
        report_dir = self.watcher_dir / "reports"
        report_dir.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # Events CSV
        events_csv = report_dir / f"events_{timestamp}.csv"
        self._write_events_csv(events_csv)
        
        # Performance CSV
        perf_csv = report_dir / f"performance_{timestamp}.csv"
        self._write_performance_csv(perf_csv)
        
        # Resources CSV
        resource_csv = report_dir / f"resources_{timestamp}.csv"
        self._write_resources_csv(resource_csv)
        
        # Summary CSV
        summary_csv = report_dir / f"summary_{timestamp}.csv"
        self._write_summary_csv(summary_csv)
        
        # Error analysis JSON
        error_analysis = report_dir / f"error_analysis_{timestamp}.json"
        self._write_error_analysis(error_analysis)
        
        self.logger.info(f"Reports generated in {report_dir}")
        return report_dir
    
    def _write_events_csv(self, filepath: Path):
        """Write all events to CSV"""
        with self._lock:
            events = self.events.copy()
        
        if not events:
            self.logger.warning("No events to write")
            return
        
        fieldnames = [
            "event_id", "timestamp", "event_type", "severity", "message",
            "duration_ms", "endpoint", "status_code", "cpu_percent",
            "memory_percent", "error_details"
        ]
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for event in events:
                writer.writerow(asdict(event))
        
        self.logger.info(f"Events CSV written: {filepath} ({len(events)} events)")
    
    def _write_performance_csv(self, filepath: Path):
        """Write performance metrics to CSV"""
        with self._lock:
            metrics = list(self.performance_history)
        
        if not metrics:
            return
        
        fieldnames = ["timestamp", "endpoint", "response_time_ms", "status_code", "size_bytes", "is_slow"]
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for metric in metrics:
                writer.writerow(asdict(metric))
        
        self.logger.info(f"Performance CSV written: {filepath} ({len(metrics)} metrics)")
    
    def _write_resources_csv(self, filepath: Path):
        """Write resource metrics to CSV"""
        with self._lock:
            metrics = list(self.resource_history)
        
        if not metrics:
            return
        
        fieldnames = ["timestamp", "cpu_percent", "memory_percent", "memory_mb", "disk_percent", "open_files"]
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for metric in metrics:
                writer.writerow(asdict(metric))
        
        self.logger.info(f"Resources CSV written: {filepath} ({len(metrics)} metrics)")
    
    def _write_summary_csv(self, filepath: Path):
        """Write summary statistics to CSV"""
        with self._lock:
            stats = {
                "metric": [
                    "Total Requests",
                    "Failed Requests",
                    "Slow Requests",
                    "Total Errors",
                    "Average Response Time (ms)",
                    "Endpoints Tracked",
                    "Session Start",
                    "Session End",
                    "Session Duration (minutes)"
                ],
                "value": [
                    self.stats["total_requests"],
                    self.stats["failed_requests"],
                    self.stats["slow_requests"],
                    self.stats["total_errors"],
                    self._calculate_avg_response_time(),
                    len(self.stats["endpoints_tracked"]),
                    self.start_time.isoformat() if hasattr(self, 'start_time') else "N/A",
                    datetime.now().isoformat(),
                    f"{(datetime.now() - self.start_time).total_seconds() / 60:.1f}" if hasattr(self, 'start_time') else "N/A"
                ]
            }
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=["metric", "value"])
            writer.writeheader()
            writer.writerows([{"metric": m, "value": v} for m, v in zip(stats["metric"], stats["value"])])
        
        self.logger.info(f"Summary CSV written: {filepath}")
    
    def _write_error_analysis(self, filepath: Path):
        """Write error analysis and suggestions to JSON"""
        patterns = self.detect_error_patterns()
        
        report = {
            "analysis_timestamp": datetime.now().isoformat(),
            "error_patterns": {
                "timeout_count": len(patterns["timeout_errors"]),
                "connection_count": len(patterns["connection_errors"]),
                "slow_endpoints": patterns["slow_endpoints"]
            },
            "debugging_suggestions": patterns["suggestions"],
            "top_errors": dict(sorted(
                self.stats["error_distribution"].items(),
                key=lambda x: x[1],
                reverse=True
            )[:10])
        }
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)
        
        self.logger.info(f"Error analysis written: {filepath}")
    
    def print_summary(self):
        """Print monitoring summary to console"""
        print("\n" + "="*80)
        print("APPLICATION WATCHER - SESSION SUMMARY")
        print("="*80)
        
        with self._lock:
            duration = (datetime.now() - self.start_time).total_seconds() / 60
            
            print(f"\n📊 REQUEST STATISTICS:")
            print(f"  Total Requests:     {self.stats['total_requests']}")
            print(f"  Failed Requests:    {self.stats['failed_requests']}")
            print(f"  Slow Requests:      {self.stats['slow_requests']}")
            print(f"  Success Rate:       {((self.stats['total_requests'] - self.stats['failed_requests']) / max(1, self.stats['total_requests']) * 100):.1f}%")
            
            print(f"\n⚠️  ERROR STATISTICS:")
            print(f"  Total Errors:       {self.stats['total_errors']}")
            print(f"  Session Duration:   {duration:.1f} minutes")
            
            if self.stats['total_errors'] > 0:
                print(f"\n  Top Errors:")
                for error_msg, count in sorted(self.stats['error_distribution'].items(), key=lambda x: x[1], reverse=True)[:5]:
                    print(f"    - {error_msg}: {count}x")
            
            print(f"\n🔍 DEBUGGING SUGGESTIONS:")
            patterns = self.detect_error_patterns()
            for i, suggestion in enumerate(patterns["suggestions"][:10], 1):
                print(f"  {i}. {suggestion}")
        
        print("\n" + "="*80 + "\n")
    
    def _calculate_avg_response_time(self) -> float:
        """Calculate average response time"""
        if not self.performance_history:
            return 0
        return sum(m.response_time_ms for m in self.performance_history) / len(self.performance_history)
    
    # ========================================================================
    # LIFECYCLE
    # ========================================================================
    
    def start(self):
        """Start the watcher"""
        if self.is_running:
            self.logger.warning("Watcher is already running")
            return
        
        self.is_running = True
        self.start_time = datetime.now()
        self._stop_event.clear()
        
        self.logger.info(f"Starting watcher for {self.base_url}")
        
        if not self.health_check():
            self.logger.error(f"Application at {self.base_url} is not accessible!")
            return
        
        # Start monitoring threads
        perf_thread = threading.Thread(target=self._monitor_performance_loop, daemon=True)
        resource_thread = threading.Thread(target=self._monitor_resources_loop, daemon=True)
        
        perf_thread.start()
        resource_thread.start()
        
        self.logger.info("Watcher monitoring started. Press Ctrl+C to stop.")
    
    def _monitor_performance_loop(self):
        """Continuous performance monitoring loop"""
        while self.is_running and not self._stop_event.is_set():
            try:
                self.monitor_performance("/")
                time.sleep(self.check_interval_seconds)
            except Exception as e:
                self.logger.error(f"Performance monitoring error: {str(e)}")
    
    def _monitor_resources_loop(self):
        """Continuous resource monitoring loop"""
        while self.is_running and not self._stop_event.is_set():
            try:
                self.monitor_resources()
                time.sleep(self.resource_check_interval_seconds)
            except Exception as e:
                self.logger.error(f"Resource monitoring error: {str(e)}")
    
    def stop(self):
        """Stop the watcher and generate reports"""
        if not self.is_running:
            return
        
        self.logger.info("Stopping watcher...")
        self.is_running = False
        self._stop_event.set()
        
        # Give threads time to stop
        time.sleep(1)
        
        # Generate reports
        self.generate_csv_report()
        self.print_summary()
        
        self.logger.info("Watcher stopped.")


# ============================================================================
# CLI & MAIN
# ============================================================================

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Application Watcher - Real-time Performance & Error Monitoring",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python app_watcher.py --host localhost --port 3000
  python app_watcher.py --host 127.0.0.1 --port 8080 --watcher-dir ./.watcher
  python app_watcher.py --help
        """
    )
    
    parser.add_argument('--host', default='localhost', help='Application host (default: localhost)')
    parser.add_argument('--port', type=int, default=3000, help='Application port (default: 3000)')
    parser.add_argument(
        '--watcher-dir',
        type=Path,
        default=Path('.watcher'),
        help='Watcher data directory (default: .watcher)'
    )
    parser.add_argument(
        '--check-interval',
        type=int,
        default=2,
        help='Performance check interval in seconds (default: 2)'
    )
    parser.add_argument(
        '--response-threshold',
        type=int,
        default=1000,
        help='Response time threshold for "slow" alert in ms (default: 1000)'
    )
    
    args = parser.parse_args()
    
    # Setup
    watcher_dir = args.watcher_dir
    watcher_dir.mkdir(parents=True, exist_ok=True)
    
    logger = setup_logging(watcher_dir)
    
    # Create watcher
    watcher = ApplicationWatcher(
        host=args.host,
        port=args.port,
        watcher_dir=watcher_dir,
        logger=logger
    )
    
    watcher.response_time_threshold_ms = args.response_threshold
    watcher.check_interval_seconds = args.check_interval
    
    # Start monitoring
    try:
        watcher.start()
        while watcher.is_running:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n")
        watcher.stop()
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}\n{traceback.format_exc()}")
        sys.exit(1)


if __name__ == "__main__":
    main()
