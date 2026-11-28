// The manage.py lookup and `manage.py help` with IPC mocked: nothing failed is cached, a line
// runs without waiting for the command list, and a reset drops what an earlier project read.
import { beforeEach, expect, it, vi } from "vitest";
import type { OutputChunk } from "@/platform/ipc";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({
  files: [] as string[],
  helps: [] as Array<{ channel: { onmessage?: (c: OutputChunk) => void }; exit: () => void }>,
  exited: (_e: { run: number }) => {},
  notify: vi.fn(),
  active: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/workbench/contributions", () => ({
  maybeEditorService: () => ({ activePath: () => ipc.active }),
  notifications: () => ({ notify: ipc.notify }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  let id = 0;
  return {
    ...real,
    ideEventsReady: () => Promise.resolve(),
    onIdeEvent: (_type: string, handler: typeof ipc.exited) => {
      ipc.exited = handler;
      return () => {};
    },
    commands: {
      findFilesNamed: () => ok(ipc.files),
      sdkPythonEffective: (dir: string) => ok(`${dir}/.venv/bin/python`),
      runStop: () => ok(null),
      runStart: (_config: unknown, channel: (typeof ipc.helps)[number]["channel"]) => {
        const run = ++id;
        ipc.helps.push({ channel, exit: () => ipc.exited({ run }) });
        return ok({ id: run });
      },
    },
  };
});

const { loadCommands, locateManage, manageRunAnything, resetManage, runManageLine, useManage } =
  await import("./manage");

const HELP = "Available subcommands:\n\n[django]\n    check\n    migrate\n";
const answer = async (text: string, kind: "stdout" | "stderr" = "stdout") => {
  await vi.waitFor(() => expect(ipc.helps.length).toBeGreaterThan(0));
  const help = ipc.helps.shift()!;
  help.channel.onmessage?.({ kind, text });
  help.exit();
};

beforeEach(() => {
  resetManage();
  ipc.files = ["/p/manage.py"];
  ipc.helps = [];
  ipc.active = null;
  ipc.notify.mockClear();
});

it("looks manage.py up again when the index had none yet", async () => {
  ipc.files = [];
  expect(await runManageLine("manage.py migrate", () => {})).toBe(false);
  ipc.files = ["/p/manage.py"];
  const run = vi.fn();
  expect(await runManageLine("manage.py migrate", run)).toBe(true);
  expect(run.mock.calls[0]![0]).toMatchObject({ args: ["manage.py", "migrate"], cwd: "/p" });
});

it("runs a line while the command list is still being read", async () => {
  const at = await locateManage();
  void loadCommands(at.manage!, at.python!);
  const run = vi.fn();
  expect(await runManageLine("manage.py check", run)).toBe(true);
  expect(run).toHaveBeenCalledOnce();
  await answer(HELP);
  await vi.waitFor(() => expect(useManage.getState().commands["/p/manage.py"]).toHaveLength(2));
});

it("uses the manage.py of the active file's project", async () => {
  ipc.files = ["/p/a/manage.py", "/p/b/manage.py"];
  ipc.active = "/p/b/shop/views.py";
  expect((await locateManage()).manage).toBe("/p/b/manage.py");
});

it("looks manage.py up again in Run Anything when another project's file is active", async () => {
  ipc.files = ["/p/a/manage.py", "/p/b/manage.py"];
  ipc.active = "/p/a/x.py";
  expect((await locateManage()).manage).toBe("/p/a/manage.py");
  ipc.active = "/p/b/x.py";
  manageRunAnything(() => {}).items("manage.py ");
  await vi.waitFor(() => expect(useManage.getState().manage).toBe("/p/b/manage.py"));
});

it("reports a failed help and reads it again only when asked", async () => {
  const read = loadCommands("/p/manage.py", "/py");
  await answer("Traceback…\nModuleNotFoundError: No module named 'django'\n", "stderr");
  await read;
  expect(ipc.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Cannot list the manage.py commands", body: expect.stringContaining("django") }),
  );
  await loadCommands("/p/manage.py", "/py");
  expect(ipc.helps).toHaveLength(0);
  const again = loadCommands("/p/manage.py", "/py", true);
  await answer(HELP);
  await again;
  expect(useManage.getState().commands["/p/manage.py"]).toHaveLength(2);
  expect(useManage.getState().failed).toEqual({});
});

it("drops what a load for the previous project read", async () => {
  const read = loadCommands("/old/manage.py", "/py");
  resetManage();
  await answer(HELP);
  await read;
  expect(useManage.getState().commands).toEqual({});
});
