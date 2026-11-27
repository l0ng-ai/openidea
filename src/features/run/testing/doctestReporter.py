# The IDE's doctest reporter: `python -c <bootstrap> [-v] [-o FLAG]... [-f] FILE[::Name.qualname]...`
# runs the docstring examples of each module (or of one class or function in it) and prints one
# record per example (`records.ts`), next to doctest's own report of failures. Python 3.8+.
import doctest
import importlib
import importlib.util
import json
import os
import sys
import traceback

MARK = "@@openidea:test@@"


def _emit(record):
    sys.stdout.flush()
    sys.stdout.write(MARK + json.dumps(record) + "\n")
    sys.stdout.flush()


def _module(path):
    """The module of a file: by its dotted name from the deepest folder of `sys.path` that holds it
    (the working directory, PYTHONPATH and source roots; packages and their relative imports work),
    else loaded from the file itself."""
    file = os.path.normcase(os.path.realpath(path))
    roots = [os.path.normcase(os.path.realpath(p or os.curdir)) for p in sys.path]
    inside = [r for r in roots if file.startswith(r.rstrip(os.sep) + os.sep)]
    parts = []
    if inside and file.endswith(".py"):
        parts = os.path.relpath(file, max(inside, key=len))[:-3].split(os.sep)
    if parts and parts[-1] == "__init__":
        parts.pop()
    if parts and all(p.isidentifier() for p in parts):
        try:
            module = importlib.import_module(".".join(parts))
            # Not another module of that name (the standard library's `test` for a `test/` folder).
            if os.path.normcase(os.path.realpath(getattr(module, "__file__", None) or "")) == file:
                return module
        except ImportError:
            pass
    name = os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _Runner(doctest.DocTestRunner):
    """doctest's runner, keeping the outcome of each example it runs. REPORT_ONLY_FIRST_FAILURE is
    applied here, so the later examples still reach the report methods and only doctest's text is
    left out for them."""

    def __init__(self, file, **kwargs):
        super().__init__(**kwargs)
        self._file = file
        self._outcomes = {}

    def run(self, test, *args, **kwargs):
        self._first_only = self.optionflags & doctest.REPORT_ONLY_FIRST_FAILURE
        self.optionflags &= ~doctest.REPORT_ONLY_FIRST_FAILURE
        self._failed = False
        try:
            return super().run(test, *args, **kwargs)
        finally:
            self.optionflags |= self._first_only

    def _quiet(self):
        return self._first_only and self._failed

    def report_start(self, out, test, example):
        self._outcomes[id(example)] = None
        if not self._quiet():
            super().report_start(out, test, example)

    def report_success(self, out, test, example, got):
        if not self._quiet():
            super().report_success(out, test, example, got)

    def report_failure(self, out, test, example, got):
        self._outcomes[id(example)] = "Expected:\n" + _block(example.want) + "Got:\n" + _block(got)
        if not self._quiet():
            super().report_failure(out, test, example, got)
        self._failed = True

    def report_unexpected_exception(self, out, test, example, exc_info):
        self._outcomes[id(example)] = "Exception raised:\n" + _block(doctest._exception_traceback(exc_info))
        if not self._quiet():
            super().report_unexpected_exception(out, test, example, exc_info)
        self._failed = True

    def _flags(self, example):
        """The option flags of `example`: the run's, with its own `# doctest:` directives."""
        flags = self.optionflags
        for flag, on in example.options.items():
            flags = flags | flag if on else flags & ~flag
        return flags

    def report(self, test, module):
        """A record per example of `test` that ran or was skipped, up to a failure under FAIL_FAST,
        named by its source; examples of the same source by line too."""
        owner = test.name[len(module) + 1 :] if test.name.startswith(module + ".") else test.name
        names = [e.source.strip().split("\n")[0] for e in test.examples]
        for i, example in enumerate(test.examples):
            flags = self._flags(example)
            if id(example) in self._outcomes:
                failure = self._outcomes[id(example)]
                status = "passed" if failure is None else "failed"
            elif flags & doctest.SKIP:
                status = "skipped"
            else:
                continue
            line = test.lineno + example.lineno + 1 if test.lineno is not None else None
            name = names[i] if names.count(names[i]) == 1 or line is None else f"{names[i]} (line {line})"
            record = {"path": [self._file, owner, name], "status": status}
            if line is not None:
                record["line"] = line
            if status == "failed":
                record["error"] = "Failed example:\n" + _block(example.source) + failure.rstrip("\n")
            _emit(record)
            if status == "failed" and flags & doctest.FAIL_FAST:
                break


def _block(text):
    return "".join("    " + line + "\n" for line in text.rstrip("\n").split("\n")) if text else "    Nothing\n"


def main(argv):
    flags = 0
    verbose = False
    targets = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-o" and i + 1 < len(argv):
            flags |= doctest.OPTIONFLAGS_BY_NAME[argv[i + 1]]
            i += 1
        elif a.startswith("-o") and len(a) > 2:
            flags |= doctest.OPTIONFLAGS_BY_NAME[a[2:]]
        elif a == "-f":
            flags |= doctest.FAIL_FAST
        elif a in ("-v", "--verbose"):
            verbose = True
        else:
            targets.append(a)
        i += 1
    failed = 0
    for target in targets:
        path, _, name = target.partition("::")
        file = os.path.relpath(path).replace(os.sep, "/")
        try:
            module = _module(path)
        except Exception:
            failed += 1
            _emit({"path": [file], "status": "failed", "error": traceback.format_exc().rstrip("\n")})
            continue
        runner = _Runner(file, optionflags=flags, verbose=verbose)
        prefix = module.__name__ + ("." + name if name else "")
        for test in sorted(doctest.DocTestFinder().find(module), key=lambda t: t.lineno or 0):
            if not test.examples or (name and test.name != prefix and not test.name.startswith(prefix + ".")):
                continue
            runner.run(test)
            runner.report(test, module.__name__)
        result = runner.summarize(verbose=False)
        failed += result.failed
        print(f"{result.attempted} examples, {result.failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
