import { describe, expect, it } from "vitest";
import { parseAll } from "./index";
import { TestResults, nodeStatus } from "./results";
import { unittestParser } from "./unittest";

// Captured from `manage.py test` (Django 4.2 on Python 3.10, Django 6.1 on Python 3.12) as the Run
// console splits it into lines: stdout and stderr on two pipes, never sharing a line.
const PY312 = `System check identified no issues (0 silenced).
test_documented (polls.tests.QuestionModelTests.test_documented)
Explains what is checked. ... ok
test_errors (polls.tests.QuestionModelTests.test_errors) ... ERROR
test_expected_failure (polls.tests.QuestionModelTests.test_expected_failure) ... expected failure
test_fails (polls.tests.QuestionModelTests.test_fails) ... FAIL
test_passes (polls.tests.QuestionModelTests.test_passes) ... ok
test_prints (polls.tests.QuestionModelTests.test_prints) ... hello from stderr
ok
hello from stdout
test_skipped (polls.tests.QuestionModelTests.test_skipped) ... skipped 'not ready'
test_subtests (polls.tests.QuestionModelTests.test_subtests) ... 
  test_subtests (polls.tests.QuestionModelTests.test_subtests) (i=1) ... FAIL
test_unexpected_success (polls.tests.QuestionModelTests.test_unexpected_success) ... unexpected success
test_ok (polls.more.test_views.ViewTests.test_ok) ... ok
setUpClass (polls.tests.BrokenSetupTests) ... ERROR

======================================================================
ERROR: test_errors (polls.tests.QuestionModelTests.test_errors)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 15, in test_errors
    raise ValueError("boom")
ValueError: boom

======================================================================
ERROR: setUpClass (polls.tests.BrokenSetupTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 50, in setUpClass
    raise RuntimeError("setup broke")
RuntimeError: setup broke

======================================================================
FAIL: test_fails (polls.tests.QuestionModelTests.test_fails)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 12, in test_fails
    self.assertEqual("left", "right")
AssertionError: 'left' != 'right'
- left
+ right


======================================================================
FAIL: test_subtests (polls.tests.QuestionModelTests.test_subtests) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 43, in test_subtests
    self.assertNotEqual(i, 1)
AssertionError: 1 == 1

======================================================================
UNEXPECTED SUCCESS: test_unexpected_success (polls.tests.QuestionModelTests.test_unexpected_success)
----------------------------------------------------------------------
Ran 10 tests in 0.001s

FAILED (failures=2, errors=2, skipped=1, expected failures=1, unexpected successes=1)
Destroying test database for alias 'default' ('file:memorydb_default?mode=memory&cache=shared')...`;

const PY310 = `System check identified no issues (0 silenced).
test_documented (polls.tests.QuestionModelTests)
Explains what is checked. ... ok
test_errors (polls.tests.QuestionModelTests) ... ERROR
test_expected_failure (polls.tests.QuestionModelTests) ... expected failure
test_fails (polls.tests.QuestionModelTests) ... FAIL
test_passes (polls.tests.QuestionModelTests) ... ok
test_prints (polls.tests.QuestionModelTests) ... hello from stderr
ok
test_skipped (polls.tests.QuestionModelTests) ... skipped 'not ready'
test_subtests (polls.tests.QuestionModelTests) ... test_unexpected_success (polls.tests.QuestionModelTests) ... unexpected success
test_ok (polls.more.test_views.ViewTests) ... ok
ERROR

======================================================================
ERROR: test_errors (polls.tests.QuestionModelTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 15, in test_errors
    raise ValueError("boom")
ValueError: boom

======================================================================
ERROR: setUpClass (polls.tests.BrokenSetupTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 50, in setUpClass
    raise RuntimeError("setup broke")
RuntimeError: setup broke

======================================================================
FAIL: test_fails (polls.tests.QuestionModelTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 12, in test_fails
    self.assertEqual("left", "right")
AssertionError: 'left' != 'right'
- left
+ right


======================================================================
FAIL: test_subtests (polls.tests.QuestionModelTests) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 43, in test_subtests
    self.assertNotEqual(i, 1)
AssertionError: 1 == 1

----------------------------------------------------------------------
Ran 10 tests in 0.001s

FAILED (failures=2, errors=2, skipped=1, expected failures=1, unexpected successes=1)
Destroying test database for alias 'default' ('file:memorydb_default?mode=memory&cache=shared')...
hello from stdout`;

/** Default verbosity: progress characters only, failures in the sections. */
const PY310_DOTS = `System check identified no issues (0 silenced).
.ExF.
hello from stdout
hello from stderr
.su.E
======================================================================
ERROR: test_errors (polls.tests.QuestionModelTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 15, in test_errors
    raise ValueError("boom")
ValueError: boom

======================================================================
ERROR: setUpClass (polls.tests.BrokenSetupTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 50, in setUpClass
    raise RuntimeError("setup broke")
RuntimeError: setup broke

======================================================================
FAIL: test_fails (polls.tests.QuestionModelTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 12, in test_fails
    self.assertEqual("left", "right")
AssertionError: 'left' != 'right'
- left
+ right


======================================================================
FAIL: test_subtests (polls.tests.QuestionModelTests) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/tests.py", line 43, in test_subtests
    self.assertNotEqual(i, 1)
AssertionError: 1 == 1

----------------------------------------------------------------------
Ran 10 tests in 0.001s

FAILED (failures=2, errors=2, skipped=1, expected failures=1, unexpected successes=1)
Destroying test database for alias 'default'...`;

/** `--parallel`: tracebacks rebuilt by tblib start in unittest's own frames. */
const PARALLEL = `======================================================================
FAIL: test_fails (polls.tests.QuestionModelTests.test_fails)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 58, in testPartExecutor
    yield
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 634, in run
    self._callTestMethod(testMethod)
    ^^^^^^^^^^^^^^^^^
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 589, in _callTestMethod
    if method() is not None:
    ^^^^^^^^^^^^^^^^^
  File "/e2e/proj/polls/tests.py", line 12, in test_fails
    self.assertEqual("left", "right")
    ^^^^^^^^^^^^^^^^^
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 885, in assertEqual
    assertion_func(first, second, msg=msg)
    ^^^^^^^^^^^^^^^^^
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 1251, in assertMultiLineEqual
    self.fail(self._formatMessage(msg, standardMsg))
    ^^^^^^^^^^^^^^^^^
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/case.py", line 715, in fail
    raise self.failureException(msg)
    ^^^^^^^^^^^^^^^^^
AssertionError: 'left' != 'right'
- left
+ right`;

/** Django 4.2 / Python 3.10: `setUpTestData` fails inside Django's own `setUpClass`; a non-ASCII test name. */
const SETUP_TEST_DATA = `System check identified no issues (0 silenced).
ERROR
test_città (polls.test_extra.UnicodeTests) ... FAIL

======================================================================
ERROR: setUpClass (polls.test_extra.DataTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/venvs/py310/lib/python3.10/site-packages/django/test/testcases.py", line 1466, in setUpClass
    cls.setUpTestData()
  File "/e2e/proj/polls/test_extra.py", line 7, in setUpTestData
    raise ValueError("bad data")
ValueError: bad data

======================================================================
FAIL: test_città (polls.test_extra.UnicodeTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/e2e/proj/polls/test_extra.py", line 15, in test_città
    self.assertEqual(1, 2)
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 1 test in 0.001s

FAILED (failures=1, errors=1)
Destroying test database for alias 'default' ('file:memorydb_default?mode=memory&cache=shared')...`;

/** Python 3.12: no test matched (`-k nomatch`). */
const NO_TESTS = `System check identified no issues (0 silenced).

----------------------------------------------------------------------
Ran 0 tests in 0.000s

NO TESTS RAN`;

const IMPORT_ERROR = `broken.tests (unittest.loader._FailedTest.broken.tests) ... ERROR
test_ok (polls.more.test_views.ViewTests.test_ok) ... ok

======================================================================
ERROR: broken.tests (unittest.loader._FailedTest.broken.tests)
----------------------------------------------------------------------
ImportError: Failed to import test module: broken.tests
Traceback (most recent call last):
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/loader.py", line 396, in _find_test_path
    module = self._get_module_from_name(name)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/venvs/pythons/cpython-3.12.16-linux-aarch64-gnu/lib/python3.12/unittest/loader.py", line 339, in _get_module_from_name
    __import__(name)
  File "/e2e/proj/broken/tests.py", line 1, in <module>
    import does_not_exist
ModuleNotFoundError: No module named 'does_not_exist'


----------------------------------------------------------------------
Ran 2 tests in 0.000s

FAILED (errors=1)`;

function tree(text: string) {
  const results = new TestResults();
  results.apply(parseAll(unittestParser(), text));
  results.finish(1);
  const status = (...path: string[]) => {
    const node = results.get(path.join("\0"));
    return node ? nodeStatus(node) : undefined;
  };
  return { results, status };
}

const Q = ["polls.tests", "QuestionModelTests"];

describe("unittest (Django) output", () => {
  it.each([
    ["Python 3.12", PY312],
    ["Python 3.10", PY310],
  ])("reports every test of a verbose run under its module and class (%s)", (_, text) => {
    const { results, status } = tree(text);
    expect(results.roots.map((n) => n.name)).toEqual(["polls.tests", "polls.more.test_views"]);
    expect(status(...Q, "test_documented")).toBe("passed");
    expect(status(...Q, "test_errors")).toBe("failed");
    expect(status(...Q, "test_expected_failure")).toBe("passed");
    expect(status(...Q, "test_fails")).toBe("failed");
    expect(status(...Q, "test_passes")).toBe("passed");
    // Its output split the result line in two.
    expect(status(...Q, "test_prints")).toBe("passed");
    expect(status(...Q, "test_skipped")).toBe("skipped");
    expect(status(...Q, "test_subtests")).toBe("failed");
    expect(status(...Q, "test_unexpected_success")).toBe("failed");
    expect(status("polls.more.test_views", "ViewTests", "test_ok")).toBe("passed");
    // `setUpClass` failed: the class itself.
    expect(status("polls.tests", "BrokenSetupTests")).toBe("failed");
    expect(results.counts()).toMatchObject({ passed: 5, failed: 5, skipped: 1, running: 0, total: 11 });
    expect(results.summary).toMatchObject({ failed: 5, skipped: 1, durationMs: 1 });

    const fails = results.get([...Q, "test_fails"].join("\0"))!;
    expect(fails.location).toEqual({ path: "/e2e/proj/polls/tests.py", line: 12, resolve: "path" });
    expect(fails.output).toContain("AssertionError: 'left' != 'right'");
    expect(results.get(["polls.tests", "BrokenSetupTests"].join("\0"))!.location).toMatchObject({ line: 50 });
    expect(results.get([...Q, "test_subtests"].join("\0"))!.output).toContain("AssertionError: 1 == 1");
  });

  it("reports failures of a run without -v 2 from their sections", () => {
    const { results, status } = tree(PY310_DOTS);
    expect(status(...Q, "test_fails")).toBe("failed");
    expect(status(...Q, "test_errors")).toBe("failed");
    expect(status(...Q, "test_subtests")).toBe("failed");
    expect(status("polls.tests", "BrokenSetupTests")).toBe("failed");
    // The summary line counts the unexpected success, which has no section in Python 3.10.
    expect(results.counts()).toMatchObject({ passed: 4, failed: 5, skipped: 1 });
  });

  it("locates a failure at the test's own frame, past unittest's frames", () => {
    const { results } = tree(PARALLEL);
    expect(results.get([...Q, "test_fails"].join("\0"))!.location).toMatchObject({
      path: "/e2e/proj/polls/tests.py",
      line: 12,
    });
  });

  it("locates fixture failures in the project, past Django's frames, and reads non-ASCII names", () => {
    const { results, status } = tree(SETUP_TEST_DATA);
    expect(status("polls.test_extra", "DataTests")).toBe("failed");
    expect(results.get(["polls.test_extra", "DataTests"].join("\0"))!.location).toEqual({
      path: "/e2e/proj/polls/test_extra.py",
      line: 7,
      resolve: "path",
    });
    expect(status("polls.test_extra", "UnicodeTests", "test_città")).toBe("failed");
    expect(results.get(["polls.test_extra", "UnicodeTests", "test_città"].join("\0"))!.location).toMatchObject({
      line: 15,
    });
  });

  it("keeps a project's own unittest/ folder as a location", () => {
    const { results } = tree(
      [
        "=".repeat(70),
        "FAIL: test_a (tests.unittest.test_x.C.test_a)",
        "-".repeat(70),
        "Traceback (most recent call last):",
        '  File "/e2e/proj/tests/unittest/test_x.py", line 9, in test_a',
        "    self.assertTrue(False)",
        "AssertionError: False is not true",
        "",
      ].join("\n"),
    );
    expect(results.get(["tests.unittest.test_x", "C", "test_a"].join("\0"))!.location).toMatchObject({
      path: "/e2e/proj/tests/unittest/test_x.py",
      line: 9,
    });
  });

  it("reports a run where no test matched", () => {
    const { results } = tree(NO_TESTS);
    expect(results.isEmpty).toBe(true);
    expect(results.summary).toMatchObject({ passed: 0, failed: 0, skipped: 0 });
  });

  it("ignores other tools' lines that look like a name and a dotted word", () => {
    const { results } = tree("Finished (0.5s)\ncompile (gcc.exe)\nbuilding (app.main) ... done");
    expect(results.isEmpty).toBe(true);
  });

  it("reports a test module that fails to import as the module", () => {
    const { results, status } = tree(IMPORT_ERROR);
    expect(status("broken.tests")).toBe("failed");
    expect(results.get("broken.tests")!.location).toMatchObject({ path: "/e2e/proj/broken/tests.py", line: 1 });
    expect(status("polls.more.test_views", "ViewTests", "test_ok")).toBe("passed");
  });
});
