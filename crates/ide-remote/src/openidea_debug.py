"""Debugs a run configuration on an OpenIDEA run target: in a Docker or Compose container, or on an SSH host.

    openidea_debug.py PORT PROJECT_FOLDER (SCRIPT | -m MODULE | -c CODE) [ARGS...]

debugpy listens on PORT and the IDE attaches once the line below is printed. In a
container, PORT is published on the host's loopback interface; on an SSH host,
debugpy listens on its loopback interface (OPENIDEA_DEBUG_HOST) and the IDE connects
through an SSH port forward. The interpreter's debugpy is used when it has one, else
the IDE's copy: mounted read-only in a container, uploaded to OPENIDEA_DEBUGPY_LIB on an SSH host.
"""

import os
import runpy
import sys

def main():
    del sys.path[0]  # This script's folder, not the program's.
    # Popped: the program and its children don't see them.
    ide_copy = os.environ.pop("OPENIDEA_DEBUGPY_LIB", "/opt/openidea/debugpy-lib")
    host = os.environ.pop("OPENIDEA_DEBUG_HOST", "0.0.0.0")
    port, folder, argv = int(sys.argv[1]), sys.argv[2], sys.argv[3:]
    # Uploads are over: the IDE waits a limited time for the line below from here on.
    print("debugpy is starting", file=sys.stderr, flush=True)
    try:
        import debugpy
    except ImportError:
        sys.path.append(ide_copy)
        try:
            import debugpy
        except ImportError:
            sys.exit(
                "debugpy is not installed for %s. Install OpenIDEA's copy (Settings > Tools) "
                "or install debugpy for this interpreter." % sys.executable
            )
    try:
        debugpy.listen((host, port))
    except RuntimeError as e:  # The port is taken (on an SSH host, the IDE picked a port free on its machine).
        sys.exit("debugpy cannot listen on port %d: %s. Start debugging again to use another port." % (port, e))
    print(
        "debugpy is waiting for the debugger on port %d, project folder %s" % (port, folder),
        file=sys.stderr,
        flush=True,
    )
    debugpy.wait_for_client()
    if argv[0] == "-m":
        sys.argv = argv[1:]
        sys.path.insert(0, os.getcwd())
        runpy.run_module(argv[1], run_name="__main__", alter_sys=True)
    elif argv[0] == "-c":
        sys.argv = ["-c"] + argv[2:]
        sys.path.insert(0, "")
        exec(compile(argv[1], "<string>", "exec"), {"__name__": "__main__"})
    else:
        sys.argv = argv
        sys.path.insert(0, os.path.dirname(os.path.abspath(argv[0])))
        runpy.run_path(argv[0], run_name="__main__")


main()
