"""Runs a script, module (-m) or code (-c) under a profiler for the IDE's Profile action.

Usage: python python_profile.py cprofile <out dir> [--stop <pipe>] (<script> | -m <module> | -c <code>) [args...]

Runs the target as `python <target>` would (it is `__main__` until the process exits, its
exit code is kept) and writes <out>/profile.pstats when it ends, also when Stop interrupts
it (KeyboardInterrupt).
`--stop`: where Stop cannot interrupt the process itself (Windows), its stop command opens
this named pipe (a FIFO elsewhere); the profile is then saved and the run interrupted.
"""

import _thread
import io
import os
import runpy
import sys
import threading
import time
import types


def as_main(**names):
    """A fresh `__main__` module that stays in `sys.modules` until the process exits, as
    Python's own is: threads, atexit callbacks and pickling still find the target there."""
    main = types.ModuleType("__main__")
    main.__dict__.update(names)
    sys.modules["__main__"] = main
    return main.__dict__


def run(target):
    isolated = sys.flags.isolated or getattr(sys.flags, "safe_path", False)
    if target[0] == "-m":
        if not isolated:
            sys.path[0] = os.getcwd()
        # What `python -m` and runpy use to find a module or a package's __main__.
        _, spec, code = runpy._get_module_details(target[1])
        sys.argv = [spec.origin] + target[2:]
        names = as_main(
            __file__=spec.origin, __cached__=spec.cached, __loader__=spec.loader, __package__=spec.parent, __spec__=spec
        )
        exec(code, names)
    elif target[0] == "-c":
        sys.argv = ["-c"] + target[2:]
        if not isolated:
            sys.path[0] = ""
        exec(compile(target[1], "<string>", "exec"), as_main())
    else:
        sys.argv = target
        if not isolated:
            sys.path[0] = os.path.dirname(os.path.abspath(target[0]))
        if os.path.isdir(target[0]) or target[0].endswith((".zip", ".pyz")):
            # Its __main__.py; runpy puts the launcher back as __main__ when it returns.
            runpy.run_path(target[0], run_name="__main__")
            return
        with io.open_code(target[0]) as source:
            code = compile(source.read(), target[0], "exec")
        exec(code, as_main(__file__=target[0], __cached__=None))


class Once:
    """Saves the profile once: when the run ends, or from the stop watcher if it doesn't."""

    def __init__(self, save):
        self.save, self.lock, self.done = save, threading.Lock(), False

    def __call__(self):
        with self.lock:
            if not self.done:
                self.done = True
                self.save()


def stop_waiter(name):
    """Opens `name` and returns a call that blocks, in C, until Stop connects to it. Since 3.12
    cProfile records every thread on one call stack, so a watcher that polled would show up
    in the profile, charged to the program's own functions."""
    if os.name == "nt":
        import _winapi

        pipe = _winapi.CreateNamedPipe(
            name, _winapi.PIPE_ACCESS_INBOUND, _winapi.PIPE_TYPE_BYTE | _winapi.PIPE_WAIT, 1, 0, 0, 0, _winapi.NULL
        )

        def wait():
            try:
                _winapi.ConnectNamedPipe(pipe, False)
            except OSError as e:
                if e.winerror != 535:  # ERROR_PIPE_CONNECTED: Stop connected first
                    raise

        return wait
    os.mkfifo(name)
    return lambda: os.open(name, os.O_RDONLY)


def watch(wait, ready, save):
    ready.set()
    wait()
    # Saved first: Stop ends the process after its termination timeout, which can be short.
    save()
    _thread.interrupt_main()
    # A run blocked in a call that the interrupt does not wake is ended here.
    time.sleep(1.5)
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
        # The watcher blocks before profiling starts, so it stays out of the profile.
        ready = threading.Event()
        threading.Thread(target=watch, args=(stop_waiter(stop_file), ready, save), daemon=True).start()
        ready.wait()
    start()
    try:
        run(target)
    finally:
        save()


if __name__ == "__main__":
    main()
