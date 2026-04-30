import psutil
from datetime import datetime
from typing import Optional
from .events import ResourceMetrics

class ResourceMonitor:
    """Extracts CPU and Memory metrics from a given psutil Process."""
    
    @staticmethod
    def capture(target_process: Optional[psutil.Process]) -> Optional[ResourceMetrics]:
        if not target_process:
            # Fallback to system-wide or self if no target process
            target_process = psutil.Process()
            
        try:
            open_files = 0
            try:
                open_files = len(target_process.open_files())
            except (psutil.AccessDenied, getattr(psutil, 'ZombieProcess', Exception), NotImplementedError):
                pass
                
            return ResourceMetrics(
                timestamp=datetime.now().isoformat(),
                cpu_percent=target_process.cpu_percent(interval=0.1),
                memory_percent=target_process.memory_percent(),
                memory_mb=target_process.memory_info().rss / 1024 / 1024,
                disk_percent=psutil.disk_usage('/').percent,
                open_files=open_files
            )
        except Exception:
            return None
