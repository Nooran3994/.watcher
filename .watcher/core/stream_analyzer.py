import os
import threading
import logging
from collections import deque
from subprocess import Popen
from typing import Callable, Any

class StreamAnalyzer:
    """Pipelines stdout/stderr from a child process to detect errors and warnings."""
    
    def __init__(self, process: Popen, logger: logging.Logger, on_error_callback: Callable[[str, str], Any]):
        self.process = process
        self.logger = logger
        self.on_error_callback = on_error_callback
        self.log_history = deque(maxlen=1000)
        self._stop_event = threading.Event()
        
        # Start reading threads
        if process.stdout:
            self.t_out = threading.Thread(target=self._stream_reader, args=(process.stdout, "stdout"), daemon=True)
            self.t_out.start()
        if process.stderr:
            self.t_err = threading.Thread(target=self._stream_reader, args=(process.stderr, "stderr"), daemon=True)
            self.t_err.start()

    def _stream_reader(self, pipe, source):
        for line in iter(pipe.readline, ''):
            if not line:
                if self._stop_event.is_set():
                    break
                continue
            
            line = line.strip()
            if not line:
                continue
                
            self.log_history.append((source, line))
            
            # Simple keyword anomaly detection across languages
            lower_line = line.lower()
            if "error" in lower_line or "exception" in lower_line or "traceback" in lower_line or "fatal" in lower_line:
                self.on_error_callback(source, line)
                
            # Mirror to watcher's stdout if configured
            if source == "stderr":
                self.logger.error(f"[APP] {line}")
            else:
                self.logger.debug(f"[APP] {line}")
                
    def get_logs(self) -> str:
        return "\n".join(f"[{src}] {line}" for src, line in self.log_history)

    def stop(self):
        self._stop_event.set()
