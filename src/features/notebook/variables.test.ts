// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The script the Jupyter Variables window runs on the kernel (crates/ide-host), run here with a
// stand-in for IPython's shell and the same user expression.
const SCRIPT = fileURLToPath(new URL("../../../crates/ide-host/src/notebook_variables.py", import.meta.url));
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

const HARNESS = `
import base64, builtins, collections, json, sys, time
class Shell: pass
shell = Shell()
builtins.get_ipython = lambda: shell
ns = {"get_ipython": builtins.get_ipython}
class Proxy:
    @property
    def __class__(self): raise RuntimeError("no class")
class Loud:
    def __repr__(self): raise ValueError("no repr")
shell.user_ns = ns
shell.user_ns_hidden = {"In": 1, "get_ipython": 1}
ns.update(In=[], tasks=["a", "b"], _private=1, json=json, proxy=Proxy(), loud=Loud(),
          blob=b"x" * 300_000_000, counts=collections.Counter(range(1_000_000)))
exec(open(sys.argv[1]).read(), ns)
start = time.perf_counter()
rows = json.loads(base64.b64decode(eval('globals().pop("_openidea_variables")()', ns)))
print(json.dumps({"rows": rows, "seconds": time.perf_counter() - start, "left": "_openidea_variables" in ns}))
`;

it.skipIf(!PYTHON)("lists user variables cheaply and survives broken objects", () => {
  const result = spawnSync(PYTHON!, ["-I", "-S", "-c", HARNESS, SCRIPT], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  const { rows, seconds, left } = JSON.parse(result.stdout);
  const byName = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
  // Hidden: IPython's own names, `_` names and modules.
  expect(Object.keys(byName)).toEqual(["blob", "counts", "loud", "proxy", "tasks"]);
  expect(byName.tasks).toEqual({ name: "tasks", type: "list", value: "['a', 'b']" });
  expect(byName.blob.value).toMatch(/^b'x{200}'\.\.\.$/);
  expect(byName.counts.value).toMatch(/^Counter\(\{0: 1, .*\.\.\.\}\)$/);
  // reprlib catches a failing __repr__ itself.
  expect(byName.loud).toMatchObject({ type: "Loud", value: expect.stringMatching(/^<Loud instance at 0x[0-9a-f]+>$/) });
  expect(byName.proxy).toEqual({ name: "proxy", type: "?", value: "<unavailable: RuntimeError>" });
  // A full repr() of the 300 MB bytes and the 1M-entry Counter would take seconds.
  expect(seconds).toBeLessThan(1);
  expect(left).toBe(false);
});
