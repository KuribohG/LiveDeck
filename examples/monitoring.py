"""A real, interruptible process for exercising metadata binding; not a benchmark."""
from pathlib import Path
import os
import socket
import subprocess
import sys
import time

helper = Path(__file__).resolve().parents[1] / 'backend/run_context.py'
subprocess.run([sys.executable, str(helper), 'publish', '--event', 'ready',
                '--set', f'instance={socket.gethostname()}', '--set', f'task_id=demo-{os.getpid()}',
                '--monitoring-start-now'], check=True)
print(f'演示进程 PID={os.getpid()}，主机={socket.gethostname()}。按 Ctrl+C 结束。', flush=True)
try:
    for tick in range(300):
        print(f'{time.strftime("%H:%M:%S")}  tick={tick:03d}  elapsed={tick}s', flush=True)
        time.sleep(1)
except KeyboardInterrupt:
    print('演示进程已结束。', flush=True)
    sys.exit(130)
