// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withDoctestReporter } from "./pythonDoctest";

const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);
const project = mkdtempSync(join(tmpdir(), "doctest-reporter-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

function write(files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
}

/** `python -m doctest args` the way the IDE runs it: each record's path and status. */
function run(args: string[], env: Record<string, string> = {}) {
  const launch = withDoctestReporter({ args: ["-m", "doctest", ...args], env });
  const result = spawnSync(PYTHON!, launch.args, {
    cwd: project,
    env: { ...process.env, ...launch.env },
    encoding: "utf8",
  });
  const records = result.stdout
    .split("\n")
    .filter((l) => l.startsWith("@@openidea:test@@"))
    .map((l) => JSON.parse(l.slice("@@openidea:test@@".length)) as { path: string[]; status: string });
  return { records: records.map((r) => `${r.path.slice(1).join(" › ")}: ${r.status}`), stdout: result.stdout };
}

describe.skipIf(!PYTHON)("the doctest reporter", () => {
  write({
    "calc.py": [
      "def f():",
      '    """',
      "    >>> 1",
      "    2",
      "    >>> 2",
      "    3",
      "    >>> 3  # doctest: +SKIP",
      "    4",
      "    >>> 4",
      "    4",
      '    """',
      "",
    ].join("\n"),
  });

  it("records the examples doctest ran, and the skipped ones", () => {
    expect(run(["calc.py"]).records).toEqual([
      "f › 1: failed",
      "f › 2: failed",
      "f › 3  # doctest: +SKIP: skipped",
      "f › 4: passed",
    ]);
    // Only the first failure is reported in doctest's text, but each example keeps its outcome.
    const first = run(["-o", "REPORT_ONLY_FIRST_FAILURE", "calc.py"]);
    expect(first.records).toEqual(run(["calc.py"]).records);
    expect(first.stdout.match(/^Failed example:/gm)).toHaveLength(1);
    // Nothing for the examples after a failure that stopped the run.
    expect(run(["-f", "calc.py"]).records).toEqual(["f › 1: failed"]);
  });

  it("imports a module from the source root that holds it, else from its file", () => {
    write({
      "src/shop/__init__.py": "",
      "src/shop/money.py": [
        "class Err(Exception):",
        "    pass",
        "",
        "def pay():",
        '    """',
        "    >>> pay()",
        "    Traceback (most recent call last):",
        "    shop.money.Err: no money",
        '    """',
        '    raise Err("no money")',
        "",
      ].join("\n"),
      // No `__init__.py`: `test` is the standard library's package.
      "test/helpers.py": 'def one():\n    """\n    >>> one()\n    1\n    """\n    return 1\n',
    });
    expect(run(["src/shop/money.py"], { PYTHONPATH: join(project, "src") }).records).toEqual(["pay › pay(): passed"]);
    expect(run(["test/helpers.py"]).records).toEqual(["one › one(): passed"]);
  });
});
