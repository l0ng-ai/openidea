"""Runs a script, module (-m) or code (-c) under a profiler for the IDE's Profile action.

Usage: python python_profile.py cprofile <out dir> [--stop <file>] (<script> | -m <module> | -c <code>) [args...]

Runs the target as `python <target>` would (it is `__main__`, its exit code is kept) and
writes <out>/profile.pstats when it ends, also when Stop interrupts it (KeyboardInterrupt).
`--stop`: Stop creates that file where it cannot interrupt the process itself (Windows);
the run is then interrupted and its profile saved before Stop ends the process.
"""

import _thread
import os
import runpy
import sys
import threading
import time
import types


def run(target):
    isolated = sys.flags.isolated or getattr(sys.flags, "safe_path", False)
    if target[0] == "-m":
        sys.argv = target[1:]
        if not isolated:
            sys.path[0] = os.getcwd()
        runpy.run_module(target[1], run_name="__main__", alter_sys=True)
    elif target[0] == "-c":
        sys.argv = ["-c"] + target[2:]
        if not isolated:
            sys.path[0] = ""
        main = types.ModuleType("__main__")
        sys.modules["__main__"] = main
        exec(compile(target[1], "<string>", "exec"), main.__dict__)
    else:
        sys.argv = target
        if not isolated:
            sys.path[0] = os.path.dirname(os.path.abspath(target[0]))
        runpy.run_path(target[0], run_name="__main__")


class Once:
    """Saves the profile once: when the run ends, or from the stop watcher if it doesn't."""

    def __init__(self, save):
        self.save, self.lock, self.done = save, threading.Lock(), False

    def __call__(self):
        with self.lock:
            if not self.done:
                self.done = True
                self.save()


def watch(stop_file, save):
    while not os.path.exists(stop_file):
        time.sleep(0.1)
    _thread.interrupt_main()
    # The run saves its profile as it unwinds; one blocked in a call that the interrupt
    # does not wake is saved from here before Stop ends the process.
    time.sleep(1.5)
    save()
    os._exit(130)


def cprofile(out):
    import cProfile

    profiler = cProfile.Profile()

    def save():
        profiler.disable()
        profiler.dump_stats(os.path.join(out, "profile.pstats"))

    return profiler.enable, save


def main():
    args = sys.argv[1:]
    profiler, out, target = args[0], args[1], args[2:]
    stop_file = None
    if target[:1] == ["--stop"]:
        stop_file, target = target[1], target[2:]
    start, save = {"cprofile": cprofile}[profiler](out)
    save = Once(save)
    if stop_file:
        threading.Thread(target=watch, args=(stop_file, save), daemon=True).start()
    start()
    try:
        run(target)
    finally:
        save()


main()
