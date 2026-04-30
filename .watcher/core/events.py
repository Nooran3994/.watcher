# core/events.py
from datetime import datetime
from typing import Dict, Optional, Any
from dataclasses import dataclass, field
from enum import Enum

class EventType(Enum):
    PERFORMANCE = "performance"
    ERROR = "error"
    NETWORK = "network"
    UI_INTERACTION = "ui_interaction"
    RESOURCE = "resource"
    CUSTOM = "custom"
    APP_LOG = "app_log"

class SeverityLevel(Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"

@dataclass
class PerformanceMetrics:
    endpoint: str
    response_time_ms: float
    status_code: int
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    size_bytes: int = 0
    is_slow: bool = False
    threshold_ms: int = 1000

@dataclass
class ResourceMetrics:
    timestamp: str
    cpu_percent: float
    memory_percent: float
    memory_mb: float
    disk_percent: float
    open_files: int

@dataclass
class WatcherEvent:
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
