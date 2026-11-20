#!/usr/bin/env python3
"""PID 1 for the disposable Boat guest: reap detached runners, not just the test.

Guest commands intentionally detach runnerd. Making Vitest PID 1 leaves those
exited orphans as zombies, so the real physical-retirement guard correctly sees
an existing PID/process group forever. Keep that guard unchanged and provide the
init/reaping behavior a real guest has.
"""
import os
import signal
import subprocess
import sys

child = subprocess.Popen(sys.argv[1:])


def forward(signum, _frame):
    try:
        os.kill(child.pid, signum)
    except ProcessLookupError:
        pass


for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, forward)

while True:
    try:
        pid, status = os.waitpid(-1, 0)
    except InterruptedError:
        continue
    if pid == child.pid:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)
