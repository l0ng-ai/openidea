// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { request, stdoutParser, type ConsoleMessage } from "./protocol";

const DRIVER = fileURLToPath(new URL("./console.py", import.meta.url));
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

// An interpreter with IPython, for the IPython path (OPENIDEA_TEST_IPYTHON, else none: skipped).
const IPYTHON = process.env.OPENIDEA_TEST_IPYTHON;
// An interpreter with Django 5.2+, for the Django console (OPENIDEA_TEST_DJANGO, else none: skipped).
const DJANGO = process.env.OPENIDEA_TEST_DJANGO;

function run(codes: string[], input = "", python = PYTHON!) {
  const stdin = codes.map(request).join("") + input;
  // -I -S: no site-packages, so the plain-Python path even where IPython is installed.
  const flags = python === PYTHON ? ["-I", "-S", "-u"] : ["-u"];
  const result = spawnSync(python, [...flags, DRIVER], { input: stdin, encoding: "utf8" });
  return { ...stdoutParser()(result.stdout), stderr: result.stderr, status: result.status };
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

it.skipIf(!PYTHON)("gives console code its own __main__, so its classes pickle", () => {
  const { text, messages } = run(
    [
      "class Point:\n    pass\nimport pickle\ntype(pickle.loads(pickle.dumps(Point()))).__name__",
      "import __main__\nsorted(n for n in ('Point', '_send') if hasattr(__main__, n))",
    ],
    // A JSON value without code, typed while nothing read it, is not a request either.
    "{}\n",
  );
  expect(text).toBe("'Point'\n['Point']\n");
  expect(messages.filter((m) => "done" in m)).toHaveLength(2);
});

it.skipIf(!PYTHON)("ends at sys.exit() with its code", () => {
  const { text, status } = run(["import sys\nsys.exit(3)", "1 + 1"]);
  expect([text, status]).toEqual(["", 3]);
});

it.skipIf(!IPYTHON)("ends at exit() under IPython", () => {
  const { text, messages, status } = run(["x = 1", "exit()", "1 + 1"], "", IPYTHON);
  expect(messages[0]).toEqual({ ready: { version: expect.any(String), ipython: expect.stringMatching(/^IPython /) } });
  expect([text, messages.length, status]).toEqual(["", 2, 0]);
});

it.skipIf(!DJANGO)(
  "sets Django up and imports the models like manage.py shell",
  () => {
    const site = mkdtempSync(join(tmpdir(), "console-django-"));
    writeFileSync(
      join(site, "site_settings.py"),
      'SECRET_KEY = "x"\nINSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth"]\n' +
        'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n',
    );
    // As the IDE runs it: `-c`, in the project root, with manage.py's folder given apart.
    const result = spawnSync(DJANGO!, ["-u", "-c", readFileSync(DRIVER, "utf8")], {
      cwd: tmpdir(),
      input: [
        "User._meta.label",
        "import django\ndjango.VERSION >= (6,) and settings.SECRET_KEY",
        "x = 1",
        "User = 'mine'",
      ]
        .map(request)
        .join(""),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENIDEA_DJANGO_DIR: site,
        OPENIDEA_DJANGO_SETTINGS: "site_settings",
        DJANGO_SETTINGS_MODULE: "",
      },
    });
    const { text, messages } = stdoutParser()(result.stdout);
    expect(result.stderr).toBe("");
    expect(messages[0]).toMatchObject({ ready: { django: expect.stringMatching(/^\d/) } });
    // 5.2+ imports the models; 6.0+ also `settings` (False on 5.2).
    expect(text).toMatch(/^'auth\.User'\n('x'|False)\n/);
    // The imports are the console's own, not the user's variables, until the user assigns one.
    expect(variables(messages)[2]).toEqual(["x: int = 1"]);
    expect(variables(messages)[3]).toEqual(["User: str = 'mine'", "x: int = 1"]);
  },
  30_000,
);

it.skipIf(!DJANGO)(
  "uses DJANGO_SETTINGS_MODULE from the environment when manage.py names none",
  () => {
    const site = mkdtempSync(join(tmpdir(), "console-django-"));
    writeFileSync(join(site, "env_settings.py"), 'SECRET_KEY = "x"\nINSTALLED_APPS = []\n');
    const ready = (env: Record<string, string>) => {
      const result = spawnSync(DJANGO!, ["-u", "-c", readFileSync(DRIVER, "utf8")], {
        cwd: tmpdir(),
        input: "",
        encoding: "utf8",
        env: { ...process.env, OPENIDEA_DJANGO_DIR: site, ...env },
      });
      return stdoutParser()(result.stdout).messages[0];
    };
    expect(ready({ DJANGO_SETTINGS_MODULE: "env_settings" })).toMatchObject({ ready: { django: expect.any(String) } });
    expect(ready({ DJANGO_SETTINGS_MODULE: "" })).not.toHaveProperty("ready.django");
  },
  30_000,
);
it.skipIf(!PYTHON)("exits on SIGTERM itself, also as a container's PID 1, which ignores it without a handler", () => {
  const result = spawnSync(PYTHON!, ["-I", "-S", "-u", DRIVER], {
    input: request("import os, signal, time\nos.kill(os.getpid(), signal.SIGTERM)\ntime.sleep(5)"),
    encoding: "utf8",
    timeout: 4000,
  });
  expect(result.signal).toBeNull();
  expect(result.status).toBe(143);
});
