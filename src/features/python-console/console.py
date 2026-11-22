# The Python Console's driver. Reads one JSON request per stdin line ({"code": ...}),
# runs it in IPython when installed, else in a plain namespace, and after each run writes
# a record-separator line (\x1e + JSON) with the console's variables.
import json
import reprlib
import sys
import textwrap
import types

RS = "\x1e"
_out = sys.stdout
_repr = reprlib.Repr()
_repr.maxstring = _repr.maxother = 200
_hidden = set()


def _send(message):
    sys.stdout.flush()
    sys.stderr.flush()
    _out.write(RS + json.dumps(message) + "\n")
    _out.flush()


def _variables(namespace):
    rows = []
    for name, value in list(namespace.items()):
        if name.startswith("_") or name in _hidden or isinstance(value, types.ModuleType):
            continue
        try:
            text = _repr.repr(value)
        except Exception as error:  # a broken __repr__ must not break the console
            text = "<repr failed: %s>" % type(error).__name__
        rows.append({"name": name, "type": type(value).__name__, "value": text})
    rows.sort(key=lambda row: row["name"])
    return rows


try:
    from IPython.core.interactiveshell import InteractiveShell
    import IPython

    _shell = InteractiveShell.instance(colors="Neutral")  # readable on light and dark themes
    namespace = _shell.user_ns
    _hidden = set(_shell.user_ns_hidden)  # what IPython put there itself (%who hides it too)
    flavour = "IPython " + IPython.__version__
    # exit() / quit() ask the shell to end, which only the terminal shell implements.
    _shell.ask_exit = lambda: setattr(_shell, "exit_now", True)

    def run(code):
        _shell.run_cell(code, store_history=True)
        return _shell.exit_now

except ImportError:
    import ast
    import code as _code

    # The console's own __main__, so its classes pickle and `import __main__` sees its names.
    _main = types.ModuleType("__main__")
    sys.modules["__main__"] = _main
    namespace = _main.__dict__
    _console = _code.InteractiveInterpreter(namespace)
    flavour = None

    def run(code):
        # Like a notebook cell: a trailing expression prints its value, as at the >>> prompt.
        try:
            tree = ast.parse(code, "<console>")
        except (SyntaxError, ValueError, OverflowError):
            _console.showsyntaxerror("<console>")
            return
        last = tree.body[-1:] if tree.body and isinstance(tree.body[-1], ast.Expr) else []
        body = tree.body[: len(tree.body) - len(last)]
        try:
            exec(compile(ast.Module(body=body, type_ignores=[]), "<console>", "exec"), namespace)
            if last:
                exec(compile(ast.Interactive(body=last), "<console>", "single"), namespace)
        except SystemExit:
            raise
        except BaseException:
            _console.showtraceback()


_send({"ready": {"version": sys.version.split()[0], "ipython": flavour}})
while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        request = json.loads(line)
    except ValueError:
        request = None
    if not isinstance(request, dict) or not isinstance(request.get("code"), str):
        continue  # input typed while code ran that nothing read
    try:
        if run(textwrap.dedent(request["code"])):
            break
    except SystemExit:
        raise  # the console ends with the code's exit status
    except BaseException:
        import traceback

        traceback.print_exc()
    _send({"done": {"variables": _variables(namespace)}})
