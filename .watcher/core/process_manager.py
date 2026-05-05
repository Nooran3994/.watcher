import psutil
import subprocess
import threading
import logging
from typing import Optional, List, Tuple

class ProcessManager:
    """Handles finding, attaching, or running target applications."""
    
    def __init__(self, logger: logging.Logger):
        self.logger = logger
        self.target_process: Optional[psutil.Process] = None
        self.runner_process: Optional[subprocess.Popen] = None
        
    def find_by_pid(self, pid: int) -> bool:
        """Attach safely to a PID."""
        try:
            p = psutil.Process(pid)
            self.target_process = p
            self.logger.info(f"Attached to PID {pid} ({p.name()})")
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            self.logger.error(f"Failed to attach to PID {pid}")
            return False

    def find_by_port(self, port: int) -> bool:
        """Find the process listening on a specific port."""
        try:
            for conn in psutil.net_connections():
                if conn.laddr and conn.laddr.port == port and conn.status == 'LISTEN':
                    if conn.pid:
                        return self.find_by_pid(conn.pid)
            self.logger.warning(f"No process found listening on port {port}")
        except psutil.AccessDenied:
            self.logger.warning("Access denied when scanning network connections. Run as administrator/root.")
        return False
        
    def find_by_name(self, name: str) -> bool:
        """Find process by name."""
        for proc in psutil.process_iter(['name']):
            try:
                if name.lower() in proc.info['name'].lower():
                    self.target_process = proc
                    self.logger.info(f"Attached to Process '{name}' (PID {proc.pid})")
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
        self.logger.warning(f"Process name '{name}' not found")
        return False

    def auto_detect_process(self, project_dir: str) -> bool:
        """Find an application process running from the specified project directory."""
        import os
        from pathlib import Path
        
        project_dir_str = str(Path(project_dir).resolve()).lower()
        ignored_names = {'cmd.exe', 'powershell.exe', 'bash', 'sh', 'zsh', 'code.exe', 'cursor.exe', 'windsurf.exe', 'conhost.exe'}
        candidate = None
        
        for proc in psutil.process_iter(['name', 'cwd', 'cmdline']):
            try:
                info = proc.info
                name = (info.get('name') or '').lower()
                cwd = info.get('cwd')
                
                # Ignore system shells, IDEs, and the python process running this watcher
                if name in ignored_names:
                    continue
                if name.startswith('python') and info.get('cmdline') and 'app_watcher.py' in ' '.join(info['cmdline']).lower():
                    continue
                    
                if cwd and str(os.path.abspath(cwd)).lower().startswith(project_dir_str):
                    candidate = proc
                    # Prefer long-running standard server processes if multiple match
                    if name in {'node.exe', 'node', 'npm.cmd', 'npm', 'electron.exe', 'electron', 'python.exe', 'python', 'java.exe', 'java', 'ruby.exe', 'ruby'}:
                        break # Found a highly likely candidate
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
                
        if candidate:
            self.target_process = candidate
            self.logger.info(f"Auto-detected running application: '{candidate.name()}' (PID {candidate.pid}) in codebase")
            return True
            
        self.logger.warning("No running application detected natively in the codebase.")
        return False

    def run_command(self, cmd: str) -> subprocess.Popen:
        """Run a command as a child process and attach to it."""
        import shlex
        self.logger.info(f"Running command: {cmd}")
        
        # On Windows shell=True is sometimes needed to resolve npm or .bat files, 
        # but to trace the exact process we avoid shell=True if possible, or accept 
        # it and find the child process.
        try:
            args = shlex.split(cmd)
            # Use shell=True for windows if it is a built in command or script wrapper
            import os
            is_windows = os.name == 'nt'
            self.runner_process = subprocess.Popen(
                cmd if is_windows else args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                shell=is_windows
            )
            
            # Allow time for subprocess to initialize
            import time
            time.sleep(0.5)
            
            self.find_by_pid(self.runner_process.pid)
            return self.runner_process
            
        except Exception as e:
            self.logger.error(f"Failed to run command: {str(e)}")
            raise e

    def is_running(self) -> bool:
        """Check if the attached target process is still running."""
        if self.runner_process:
            return self.runner_process.poll() is None
        if self.target_process:
            return self.target_process.is_running()
        return False

    def cleanup(self):
        """Terminate child runner process if we launched it."""
        if self.runner_process and self.runner_process.poll() is None:
            try:
                self.logger.info("Terminating wrapped process...")
                self.runner_process.terminate()
                self.runner_process.wait(timeout=5)
            except Exception:
                self.runner_process.kill()
