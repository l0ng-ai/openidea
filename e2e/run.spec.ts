/**
 * Running a configuration: output streams into the Run tool window, the exit shows, and Stop ends
 * the process. Processes are stubbed at the IPC layer; `crates/ide-run` covers spawning them.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const RUN_ID = 7;

/** One saved `npm run dev` configuration; `run_start` prints `output` and exits with `exit` unless null. */
async function stubRun(page: Page, output: { kind: string; text: string }[], exit: number | null) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ output, exit, runId }) => {
      const config = {
        id: "npm:dev",
        name: "dev",
        kind: "npm",
        command: "npm",
        args: ["run", "dev"],
        cwd: "/dev/acme-api",
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: null,
      };
      const h = window.__ipc.handlers;
      h.run_configs = () => [config];
      h.run_apply_settings = (args) => args.configs;
      h.run_start = (args) => {
        setTimeout(() => {
          for (const chunk of output) window.__ipc.send(args.onOutput, chunk);
          if (exit !== null) setTimeout(() => window.__ipc.emit({ type: "runExited", run: runId, code: exit }), 50);
        }, 50);
        return { id: runId, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
      };
      h.run_stop = () => {
        setTimeout(() => window.__ipc.emit({ type: "runExited", run: runId, code: 143 }), 50);
        return null;
      };
      const runModule = "/src/features/run/store.ts";
      const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
      await loadConfigs();
      selectConfig(config.id);
    },
    { output, exit, runId: RUN_ID },
  );
}

test("⌃R runs the selected configuration and shows its output and exit", async ({ workbench: page }) => {
  await stubRun(
    page,
    [
      { kind: "stdout", text: "> acme-api@1.0.0 dev\n" },
      { kind: "stdout", text: "Server listening on http://localhost:8080\n" },
      { kind: "stderr", text: "warning: config/dev.json not found, using defaults\n" },
    ],
    0,
  );
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run).toBeVisible();
  await expect(run.getByText("Server listening on http://localhost:8080")).toBeVisible();
  await expect(run.getByText("warning: config/dev.json not found, using defaults")).toBeVisible();
  // Once the process exits, Stop is off and the session's tab tells the exit code.
  await expect(run.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(run.getByRole("tab", { name: "dev" })).toHaveAttribute("data-tooltip", /exit code 0$/);
  const [started] = await ipcCalls(page, "run_start");
  expect(started).toMatchObject({ config: { id: "npm:dev", command: "npm", args: ["run", "dev"] } });
});

test("⌘F2 stops a running process", async ({ workbench: page }) => {
  await stubRun(page, [{ kind: "stdout", text: "Watching for changes…\n" }], null);
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByText("Watching for changes…")).toBeVisible();
  await expect(run.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.keyboard.press("Meta+F2");
  await expect.poll(() => ipcCalls(page, "run_stop")).toEqual([{ id: RUN_ID }]);
  await expect(run.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(run.getByRole("tab", { name: "dev" })).toHaveAttribute("data-tooltip", /exit code 143$/);
});

test("Go reruns keep each package's exact failures and the original configuration", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const config = {
      id: "go:test",
      name: "All tests",
      kind: "go",
      command: "go",
      args: ["test", "-json", "./..."],
      cwd: "/dev/acme-api",
      env: {},
      detected: false,
      isTest: true,
      debugAdapter: "delve",
    };
    const h = window.__ipc.handlers;
    h.run_configs = () => [config];
    h.run_apply_settings = (args) => args.configs;
    let id = 20;
    h.run_start = (args) => {
      const run = id++;
      setTimeout(() => {
        for (const [pkg, name] of [
          ["example.com/a", "TestA/one"],
          ["example.com/b", "TestB/two/leaf"],
        ]) {
          for (const event of [
            { Action: "run", Package: pkg, Test: name },
            { Action: "fail", Package: pkg, Test: name },
            { Action: "fail", Package: pkg },
          ])
            window.__ipc.send(args.onOutput, { kind: "stdout", text: JSON.stringify(event) + "\n" });
        }
        window.__ipc.emit({ type: "runExited", run, code: 1 });
      }, 50);
      return { id: run, configId: config.id, name: config.name, pid: 4242, running: true, pty: false };
    };
    const module = "/src/features/run/store.ts";
    const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ module);
    await loadConfigs();
    selectConfig(config.id);
  });
  await page.keyboard.press("Control+r");
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await run.getByRole("button", { name: "Rerun Failed Tests", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(3);
  const calls = await ipcCalls(page, "run_start");
  expect(calls.slice(1).map((call) => (call.config as { args: string[] }).args)).toEqual([
    ["test", "-json", "-run", "^TestA$/^one$", "example.com/a"],
    ["test", "-json", "-run", "^TestB$/^two$/^leaf$", "example.com/b"],
  ]);
  const originals = await page.evaluate(async () => {
    const module = "/src/features/run/store.ts";
    const { useRun } = await import(/* @vite-ignore */ module);
    return useRun.getState().sessions.map((session: { baseConfig?: { args: string[] } }) => session.baseConfig?.args);
  });
  expect(originals).toEqual([
    ["test", "-json", "./..."],
    ["test", "-json", "./..."],
  ]);
});

test("CMake builds the selected target in Build before starting only the application in Run", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const build = {
      id: "cmake:release:hello:build",
      name: "Build hello",
      kind: "cmake",
      command: "cmake",
      args: ["--build", "release", "--target", "hello", "--config", "Release"],
      cwd: null,
      env: {},
      detected: true,
      isTest: false,
      debugAdapter: null,
    };
    const app = {
      ...build,
      id: "cmake:release:hello",
      name: "hello [Release, release]",
      kind: "cmake-application",
      command: "/dev/acme-api/release/hello",
      args: [],
      debugAdapter: "lldb-dap",
      beforeLaunch: [{ kind: "build", target: build.id }],
    };
    const h = window.__ipc.handlers;
    h.run_configs = () => [build, app];
    h.run_apply_settings = (args) => args.configs;
    h.build_run = (args) => {
      window.__ipc.send(args.onEvent, { kind: "started", system: "cmake", title: "Build hello" });
      window.__ipc.send(args.onEvent, { kind: "output", text: "COMPILER_OUTPUT\n", stderr: false });
      return {
        system: "cmake",
        title: "Build hello",
        success: true,
        errors: 0,
        warnings: 0,
        durationMs: 1,
        messages: [],
      };
    };
    h.run_start = () => {
      setTimeout(() => window.__ipc.emit({ type: "runExited", run: 7, code: 0 }), 100);
      return { id: 7, configId: app.id, name: app.name, pid: 4242, running: true, pty: false };
    };
    const runModule = "/src/features/run/store.ts";
    const { loadConfigs, selectConfig } = await import(/* @vite-ignore */ runModule);
    await loadConfigs();
    selectConfig(app.id);
  });
  await page.getByRole("button", { name: "Build Project", exact: true }).click();
  const build = page.getByRole("region", { name: "Build", exact: true });
  await expect(build.getByText("COMPILER_OUTPUT", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "run_start")).toHaveLength(0);
  expect(await ipcCalls(page, "build_run")).toEqual([expect.objectContaining({ cmake: "cmake:release:hello:build" })]);
  await page.keyboard.press("Control+r");
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(1);
  expect(await ipcCalls(page, "build_run")).toHaveLength(2);
  const run = page.getByRole("region", { name: "Run", exact: true });
  await expect(run.getByRole("tab", { name: "hello [Release, release]" })).toBeVisible();
  await expect(run.getByText("COMPILER_OUTPUT", { exact: true })).toHaveCount(0);
});
