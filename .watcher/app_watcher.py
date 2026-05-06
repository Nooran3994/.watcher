#!/usr/bin/env python3
"""
Application Watcher - Real-time Performance & Error Monitoring System
================================================================================
Monitors applications running locally or in Docker. Fully language agnostic.
Tracks performance metrics, detects errors via logs and HTTP, and generates CSV reports.

Usage: 
  # Wait for port (Attach)
  python app_watcher.py --target-port 3000
  
  # Wrapper Mode (Run & Stream)
  python app_watcher.py --run "npm run dev"
  
  # Standard Attach (PID or Process Name)
  python app_watcher.py --process-name electron --no-http
"""

import os
import sys
import json
import time
import argparse
import csv
import threading
import logging
from datetime import datetime
from pathlib import Path
from collections import defaultdict, deque
from typing import Dict, List, Optional, Any
from dataclasses import asdict
import traceback

import requests
from requests.exceptions import Timeout, ConnectionError

# Import core modules
from core import (
    EventType, SeverityLevel, PerformanceMetrics, ResourceMetrics, 
    WatcherEvent, ProcessManager, ResourceMonitor, StreamAnalyzer
)

# ============================================================================
# LOGGER SETUP
# ============================================================================

def setup_logging(watcher_dir: Path) -> logging.Logger:
    log_dir = watcher_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    
    log_file = log_dir / f"watcher_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    
    logger = logging.getLogger("AppWatcher")
    logger.setLevel(logging.DEBUG)
    
    fh = logging.FileHandler(log_file)
    fh.setLevel(logging.DEBUG)
    
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    
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
    """Universal Application Watcher"""
    
    def __init__(
        self, host: str, port: int, watcher_dir: Path, logger: logging.Logger, 
        process_name: str = None, enable_http: bool = True, target_pid: int = None,
        run_cmd: str = None
    ):
        self.host = host
        self.port = port
        self.watcher_dir = watcher_dir
        self.logger = logger
        self.is_running = False
        self.enable_http = enable_http
        
        # Initialization logic
        self.process_manager = ProcessManager(logger)
        self.stream_analyzer = None
        
        self.process_name = process_name
        self.target_pid = target_pid
        self.run_cmd = run_cmd

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
        
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        
    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"
    
    # ========================================================================
    # EVENT MANAGEMENT
    # ========================================================================
    
    def _create_event(self, event_type: EventType, severity: SeverityLevel, message: str, **kwargs) -> WatcherEvent:
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

    def on_app_log_error(self, source: str, line: str):
        self._create_event(
            event_type=EventType.APP_LOG,
            severity=SeverityLevel.ERROR,
            message=f"[{source}] {line[:100]}"
        )

    # ========================================================================
    # HEALTH CHECK & MONITORING
    # ========================================================================
    
    def health_check(self) -> bool:
        if self.process_manager.target_process or self.process_manager.runner_process:
            if not self.process_manager.is_running():
                self.logger.warning("Target process died.")
                return False
                
        if self.enable_http:
            try:
                response = requests.get(f"{self.base_url}/", timeout=self.request_timeout_seconds)
                return response.status_code < 500
            except Exception as e:
                self.logger.warning(f"HTTP Health check failed: {str(e)}")
                return False
        return True
    
    def monitor_performance(self, endpoint: str = "/") -> Optional[PerformanceMetrics]:
        try:
            start_time = time.time()
            response = requests.get(f"{self.base_url}{endpoint}", timeout=self.request_timeout_seconds)
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
            self._create_event(EventType.NETWORK, SeverityLevel.ERROR, f"Request timeout on {endpoint}", endpoint=endpoint)
            with self._lock: self.stats["failed_requests"] += 1
            return None
        except Exception as e:
            self._create_event(EventType.ERROR, SeverityLevel.ERROR, f"Monitoring error on {endpoint}: {str(e)}", endpoint=endpoint)
            return None
            
    def monitor_resources(self):
        metrics = ResourceMonitor.capture(self.process_manager.target_process)
        if metrics:
            with self._lock:
                self.resource_history.append(metrics)
            if metrics.cpu_percent > 80:
                self._create_event(EventType.RESOURCE, SeverityLevel.WARNING, f"High CPU: {metrics.cpu_percent:.1f}%")
            if metrics.memory_percent > 85:
                self._create_event(EventType.RESOURCE, SeverityLevel.WARNING, f"High RAM: {metrics.memory_mb:.1f}MB")

    # ========================================================================
    # REPORTING
    # ========================================================================
    
    def generate_csv_report(self) -> Path:
        report_dir = self.watcher_dir / "reports"
        report_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        events_csv = report_dir / f"events_{timestamp}.csv"
        with self._lock: events = self.events.copy()
        if events:
            fieldnames = ["event_id", "timestamp", "event_type", "severity", "message", "duration_ms", "endpoint", "status_code", "cpu_percent", "memory_percent", "error_details"]
            with open(events_csv, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for e in events:
                    # Filter out purely dict/list fields that don't belong strictly in CSV or convert them
                    d = asdict(e)
                    d.pop("context", None)
                    writer.writerow(d)
        
        perf_csv = report_dir / f"performance_{timestamp}.csv"
        with self._lock: metrics = list(self.performance_history)
        if metrics:
            with open(perf_csv, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=["timestamp", "endpoint", "response_time_ms", "status_code", "size_bytes", "is_slow", "threshold_ms"])
                writer.writeheader()
                for m in metrics: writer.writerow(asdict(m))
        
        res_csv = report_dir / f"resources_{timestamp}.csv"
        with self._lock: r_metrics = list(self.resource_history)
        if r_metrics:
            with open(res_csv, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=["timestamp", "cpu_percent", "memory_percent", "memory_mb", "disk_percent", "open_files"])
                writer.writeheader()
                for rm in r_metrics: writer.writerow(asdict(rm))
                
        return report_dir
    
    # ========================================================================
    # LIFECYCLE
    # ========================================================================
    
    def start(self):
        if self.is_running: return
        self.is_running = True
        self.start_time = datetime.now()
        self._stop_event.clear()
        
        # Process attachment logic
        if self.process_manager.target_process:
            pass # Already attached via target-port in main
        elif self.run_cmd:
            proc = self.process_manager.run_command(self.run_cmd)
            self.stream_analyzer = StreamAnalyzer(proc, self.logger, self.on_app_log_error)
        elif self.target_pid:
            self.process_manager.find_by_pid(self.target_pid)
        elif self.process_name:
            self.process_manager.find_by_name(self.process_name)
        else:
            # Auto-detect process from the parent project directory
            project_dir = self.watcher_dir.parent
            if not self.process_manager.auto_detect_process(str(project_dir)):
                if self.enable_http:
                    # Just wait and poll
                    pass
        
        if not self.health_check():
            self.logger.warning("Initial health check failed but continuing monitoring.")
            
        threading.Thread(target=self._monitor_performance_loop, daemon=True).start()
        threading.Thread(target=self._monitor_resources_loop, daemon=True).start()
        self.logger.info("Watcher started. Press Ctrl+C to stop.")
    
    def _monitor_performance_loop(self):
        if not self.enable_http: return
        while self.is_running and not self._stop_event.is_set():
            try:
                self.monitor_performance("/")
                time.sleep(self.check_interval_seconds)
            except Exception as e:
                self.logger.error(str(e))
                
    def _monitor_resources_loop(self):
        while self.is_running and not self._stop_event.is_set():
            try:
                self.monitor_resources()
                time.sleep(self.resource_check_interval_seconds)
            except Exception as e:
                self.logger.error(str(e))
                
    def stop(self):
        if not self.is_running: return
        self.is_running = False
        self._stop_event.set()
        if self.stream_analyzer: self.stream_analyzer.stop()
        self.process_manager.cleanup()
        time.sleep(1)
        self.generate_csv_report()
        self.logger.info("Watcher stopped.")

# ============================================================================
# CLI & MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="Universal Application Watcher")
    parser.add_argument('--host', default='localhost')
    parser.add_argument('--port', type=int, default=3000)
    parser.add_argument('--process-name', type=str, default=None)
    parser.add_argument('--pid', type=int, default=None)
    parser.add_argument('--target-port', type=int, default=None, help='Auto-resolve PID by port')
    parser.add_argument('--run', type=str, default=None, help='Command to run and wrap')
    parser.add_argument('--no-http', action='store_true')
    parser.add_argument('--watcher-dir', type=Path, default=Path('.watcher'))
    parser.add_argument('--check-interval', type=int, default=2)
    parser.add_argument('--response-threshold', type=int, default=1000)
    args = parser.parse_args()
    
    args.watcher_dir.mkdir(parents=True, exist_ok=True)
    logger = setup_logging(args.watcher_dir)
    
    watcher = ApplicationWatcher(
        host=args.host, port=args.port, watcher_dir=args.watcher_dir, logger=logger,
        process_name=args.process_name, enable_http=not args.no_http, 
        target_pid=args.pid, run_cmd=args.run
    )

    watcher.check_interval_seconds = args.check_interval
    watcher.response_time_threshold_ms = args.response_threshold
    
    if args.target_port:
        watcher.process_manager.find_by_port(args.target_port)

    try:
        watcher.start()
        while watcher.is_running: time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping...")
        watcher.stop()
    except Exception as e:
        logger.error(f"Fatal error: {traceback.format_exc()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
