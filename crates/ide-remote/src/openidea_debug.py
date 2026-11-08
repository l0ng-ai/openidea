"""Debugs a run configuration in a container, for OpenIDEA's Docker and Compose run targets.

    openidea_debug.py PORT PROJECT_FOLDER (SCRIPT | -m MODULE | -c CODE) [ARGS...]

debugpy listens on PORT (published on the host's loopback interface) and the IDE
attaches once the line below is printed. The image's debugpy is used when it has
one, else the IDE's copy mounted read-only next to this script.
"""

import os
import runpy
import sys

IDE_COPY = "/opt/openidea/debugpy-lib"


def main():
    del sys.path[0]  # This script's folder, not the program's.
    port, folder, argv = int(sys.argv[1]), sys.argv[2], sys.argv[3:]
    try:
        import debugpy
    except ImportError:
        sys.path.append(IDE_COPY)
        try:
            import debugpy
        except ImportError:
            sys.exit(
                "debugpy is not installed in the image. Install OpenIDEA's copy (Settings > Tools) "
                "or add debugpy to the image."
            )
    debugpy.listen(("0.0.0.0", port))
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
