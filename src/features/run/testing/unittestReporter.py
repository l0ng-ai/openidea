# The IDE's unittest reporter: `python -c <this> [python -m unittest arguments]` runs unittest's
# own main program and text runner, with a result class that also prints one record per finished
# test and subtest (`records.ts`), with what the test printed. Standard library only, Python 3.8+.
import inspect
import json
import os
import re
import sys
import time
import traceback
import unittest

MARK = "@@openidea:test@@"
_out = sys.stdout
# Whether the last text written to stdout left its line open.
_open_line = False


class _Tee:
    """A test's stdout or stderr: written through, and kept for its record."""

    def __init__(self, stream, kept, stdout):
        self._stream = stream
        self._kept = kept
        self._stdout = stdout

    def write(self, text):
        global _open_line
        self._kept.append(text)
        if self._stdout and text:
            _open_line = not text.endswith("\n")
        return self._stream.write(text)

    def __getattr__(self, name):
        return getattr(self._stream, name)


def _emit(record):
    global _open_line
    sys.stderr.flush()
    # A record starts its own line, after output that didn't end one.
    _out.write(("\n" if _open_line else "") + MARK + json.dumps(record) + "\n")
    _out.flush()
    _open_line = False


def _path(test):
    """The tree path: module, class (its qualified name) and method; fixtures and failed imports shorter."""
    if isinstance(test, unittest.case._SubTest):
        return _path(test.test_case) + [test._subDescription()]
    name = type(test).__name__
    if name in ("_FailedTest", "ModuleImportFailure"):
        return [test._testMethodName]
    if name == "_ErrorHolder":
        # `setUpClass (pkg.mod.Class)`, `setUpModule (pkg.mod)`.
        m = re.match(r"^(\w+) \((.+)\)$", test.description)
        target = m.group(2) if m else test.description
        if m and m.group(1) in ("setUpClass", "tearDownClass"):
            module, _, cls = target.rpartition(".")
            return [module, cls] if module else [target]
        return [target]
    cls = type(test)
    return [cls.__module__, cls.__qualname__, getattr(test, "_testMethodName", str(test))]


def _source(test):
    """File and 1-based line of a test method, else of its class; (None, None) when unknown."""
    if isinstance(test, unittest.case._SubTest):
        test = test.test_case
    if type(test).__name__ in ("_ErrorHolder", "_FailedTest", "ModuleImportFailure"):
        return None, None
    method = getattr(test, getattr(test, "_testMethodName", ""), None)
    # `@skip` and other decorators wrap the method: its own code is the test's.
    code = getattr(inspect.unwrap(getattr(method, "__func__", method)), "__code__", None)
    if code is not None:
        return code.co_filename, code.co_firstlineno
    return None, None


def _relative(file):
    try:
        return os.path.relpath(file).replace(os.sep, "/")
    except ValueError:
        return file.replace(os.sep, "/")


def _failure(err, file):
    """File and line of the error: its innermost frame in `file`, else in a file of the project."""
    here = os.getcwd()
    frames = [(f.filename, f.lineno) for f in traceback.extract_tb(err[2])]
    # A module that failed to import carries its traceback as text (`_FailedTest`).
    frames += [(m.group(1), int(m.group(2))) for m in re.finditer(r'File "([^"]+)", line (\d+)', str(err[1]))]
    inside = None
    for name, line in frames:
        path = os.path.abspath(name)
        if file and os.path.normcase(path) == os.path.normcase(os.path.abspath(file)):
            inside = (name, line)
        elif not file and path.startswith(here + os.sep) and "site-packages" not in path:
            inside = (name, line)
    return inside


class _Result(unittest.TextTestResult):
    def startTest(self, test):
        self._started = time.perf_counter()
        self._kept = []
        self._status = "passed"
        self._notes = []
        self._at = None
        self._streams = sys.stdout, sys.stderr
        sys.stdout = _Tee(sys.stdout, self._kept, True)
        sys.stderr = _Tee(sys.stderr, self._kept, False)
        super().startTest(test)

    def stopTest(self, test):
        super().stopTest(test)
        if hasattr(self, "_streams"):
            sys.stdout, sys.stderr = self._streams
            del self._streams
        ms = (time.perf_counter() - self._started) * 1000
        self._record(test, self._status, "".join(self._kept), self._notes, self._at, ms)

    def _record(self, test, status, out, notes, at=None, ms=None):
        file, line = _source(test)
        if at:
            file, line = at
        record = {"path": _path(test), "status": status}
        if ms is not None:
            record["ms"] = round(ms, 3)
        if file:
            record["file"] = _relative(file)
            record["line"] = line
        text = "\n".join(t for t in [out.rstrip("\n")] + notes if t)
        if text:
            record["error"] = text
        _emit(record)

    def _trace(self, test, err):
        return self._exc_info_to_string(err, test).rstrip("\n")

    def _failed(self, test, err):
        if not hasattr(self, "_streams"):
            # A class or module fixture, or a module that failed to import: outside startTest / stopTest.
            self._record(test, "failed", "", [self._trace(test, err)], _failure(err, None))
            return
        self._status = "failed"
        self._notes.append(self._trace(test, err))
        self._at = self._at or _failure(err, _source(test)[0])

    def addError(self, test, err):
        super().addError(test, err)
        self._failed(test, err)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._failed(test, err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if not hasattr(self, "_streams"):
            # A skipped class (`@skip` on it, or `SkipTest` in `setUpClass`).
            self._record(test, "skipped", "", ["Skipped: " + reason])
            return
        self._status = "skipped"
        self._notes.append("Skipped: " + reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._notes.append("Expected failure:\n" + self._trace(test, err))

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._status = "failed"
        self._notes.append("Unexpected success: the test is marked @expectedFailure but passed")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is None:
            self._record(subtest, "passed", "", [])
            return
        at = _failure(err, _source(test)[0])
        self._status = "failed"
        self._at = self._at or at
        self._record(subtest, "failed", "", [self._trace(test, err)], at)


class _Runner(unittest.TextTestRunner):
    resultclass = _Result

    def __init__(self, *args, **kwargs):
        # What a test prints reaches the console and its record anyway.
        kwargs["buffer"] = False
        super().__init__(*args, **kwargs)


def _top_level(args):
    """`discover -s <dir>` inside a package: import its modules from above the outermost package."""
    if not args or args[0] != "discover" or "-t" in args or "--top-level-directory" in args:
        return args
    start = None
    for i, a in enumerate(args):
        if a in ("-s", "--start-directory") and i + 1 < len(args):
            start = args[i + 1]
    if not start or not os.path.isfile(os.path.join(start, "__init__.py")):
        return args
    top = os.path.abspath(start)
    while os.path.isfile(os.path.join(top, "__init__.py")):
        top = os.path.dirname(top)
    return args + ["-t", top]


if __name__ == "__main__":
    sys.argv[0] = "python -m unittest"
    unittest.main(module=None, argv=[sys.argv[0]] + _top_level(sys.argv[1:]), testRunner=_Runner)
