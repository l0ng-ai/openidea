// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { request, stdoutParser, type ConsoleMessage } from "./protocol";

const DRIVER = fileURLToPath(new URL("./console.py", import.meta.url));
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

function run(codes: string[], input = "") {
  const stdin = codes.map(request).join("") + input;
  // -I -S: no site-packages, so the plain-Python path even where IPython is installed.
  const result = spawnSync(PYTHON!, ["-I", "-S", "-u", DRIVER], { input: stdin, encoding: "utf8" });
  return { ...stdoutParser()(result.stdout), stderr: result.stderr };
}

const variables = (messages: ConsoleMessage[]) =>
  messages.flatMap((m) => ("done" in m ? [m.done.variables.map((v) => `${v.name}: ${v.type} = ${v.value}`)] : []));

it.skipIf(!PYTHON)("runs code like the >>> prompt and reports the globals after each run", () => {
  const { text, messages, stderr } = run(
    [
      "import os\nx = 1\nx + 1",
      "    def double(a):\n        return a * 2\n    print(double(x))",
      "1/0",
      "name = input()\nname",
    ],
    // Lines typed while code ran that nothing read are not requests.
    `Ada\n"stray"\n42\nstray\n${request("name * 2")}`,
  );
  expect(messages[0]).toEqual({ ready: { version: expect.any(String), ipython: null } });
  expect(text).toBe("2\n2\n'Ada'\n'AdaAda'\n");
  expect(stderr).toContain("ZeroDivisionError: division by zero");
  expect(stderr.match(/Traceback/g)).toHaveLength(1);
  const after = variables(messages);
  expect(after[0]).toEqual(["x: int = 1"]);
  expect(after[1]).toEqual([expect.stringMatching(/^double: function = <function double/), "x: int = 1"]);
  expect(after[3]).toContain("name: str = 'Ada'");
});
