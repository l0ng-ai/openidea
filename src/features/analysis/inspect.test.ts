import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Diagnostic, InspectEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  installInspectionProfileSync,
  rerunInspection,
  resetInspection,
  runInspection,
  useInspection,
} from "./inspect";

const mock = vi.hoisted(() => ({
  channel: null as null | { onmessage: (event: InspectEvent) => void },
  activeEditor: vi.fn(),
  inspect: vi.fn(),
  vcsStatus: vi.fn(),
}));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  activeEditor: mock.activeEditor,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<object>()),
  isTauri: () => true,
  call: (value: unknown) => value,
  commands: {
    inspectCode: (_id: unknown, scope: unknown, channel: typeof mock.channel) => {
      mock.channel = channel;
      return mock.inspect(scope);
    },
    cancelRequest: () => Promise.resolve(),
    vcsStatus: () => mock.vcsStatus(),
  },
}));
vi.mock("@/workbench/contributions", () => ({
  toolWindowService: () => ({ show: () => {} }),
  notifications: () => ({ notify: () => {} }),
}));

const diagnostic: Diagnostic = {
  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
  severity: "error",
  source: "ts",
  server: "typescript-language-server",
  code: "2322",
  message: "Wrong type",
  unnecessary: false,
  deprecated: false,
};
function profile(override: object) {
  useProject.setState({ settings: { inspections: { default: { "lsp:typescript-language-server": override } } } });
}
function file(path = "/p/a.ts") {
  mock.channel!.onmessage({ type: "file", done: 1, file: { path, relPath: path.slice(3), diagnostics: [diagnostic] } });
}
function done() {
  mock.channel!.onmessage({ type: "done", summary: { problems: 1 } } as InspectEvent);
}
beforeEach(() => {
  mock.channel = null;
  mock.activeEditor.mockReset();
  mock.inspect.mockReset().mockResolvedValue(undefined);
  mock.vcsStatus.mockReset();
  useProject.setState({ project: { root: "/p", name: "p", trusted: true, isGit: true, settings: {} }, settings: {} });
});
afterEach(() => {
  resetInspection();
  useProject.setState({ project: null, settings: null });
  vi.useRealTimers();
});

it("reruns the inspected file and profile while a fresh inspection follows the editor", async () => {
  const choice = { kind: "file", directory: "/p" } as const;
  mock.activeEditor.mockReturnValue({ ctx: { path: "/p/a.ts" } });
  await runInspection(choice, "project");
  file();
  done();
  mock.activeEditor.mockReturnValue({ ctx: { path: "/p/b.ts" } });

  rerunInspection();
  await vi.waitFor(() => expect(mock.inspect).toHaveBeenCalledTimes(2));
  expect(mock.inspect).toHaveBeenNthCalledWith(2, { kind: "files", paths: ["/p/a.ts"] });
  expect(useInspection.getState()).toMatchObject({ scopeLabel: "File a.ts", profile: "project" });
  done();
  mock.activeEditor.mockReturnValue(null);
  rerunInspection();
  await vi.waitFor(() => expect(mock.inspect).toHaveBeenCalledTimes(3));
  expect(mock.inspect).toHaveBeenNthCalledWith(3, { kind: "files", paths: ["/p/a.ts"] });

  mock.activeEditor.mockReturnValue({ ctx: { path: "/p/b.ts" } });
  await runInspection(choice);
  expect(mock.inspect).toHaveBeenNthCalledWith(4, { kind: "files", paths: ["/p/b.ts"] });
  expect(useInspection.getState()).toMatchObject({ scopeLabel: "File b.ts", profile: "default" });
});

it("keeps the initial file list and label when rerunning an uncommitted-files inspection", async () => {
  mock.vcsStatus.mockResolvedValue([{ path: "/p/a.ts" }, { path: "/p/b.ts" }]);
  await runInspection({ kind: "changed", directory: "/p" });
  done();
  mock.vcsStatus.mockResolvedValue([{ path: "/p/c.ts" }]);

  rerunInspection();
  await vi.waitFor(() => expect(mock.inspect).toHaveBeenCalledTimes(2));
  expect(mock.inspect).toHaveBeenNthCalledWith(2, { kind: "files", paths: ["/p/a.ts", "/p/b.ts"] });
  expect(mock.vcsStatus).toHaveBeenCalledTimes(1);
  expect(useInspection.getState().scopeLabel).toBe("2 uncommitted files");
});

it("keeps the prior target when it disappears and reports the inspection failure", async () => {
  mock.activeEditor.mockReturnValue({ ctx: { path: "/p/a.ts" } });
  await runInspection({ kind: "file", directory: "/p" });
  done();
  mock.activeEditor.mockReturnValue({ ctx: { path: "/p/b.ts" } });
  mock.inspect.mockRejectedValueOnce(new Error("File a.ts does not exist"));

  rerunInspection();
  await vi.waitFor(() => expect(useInspection.getState().error).toBe("File a.ts does not exist"));
  expect(mock.inspect).toHaveBeenNthCalledWith(2, { kind: "files", paths: ["/p/a.ts"] });
  expect(useInspection.getState().scopeLabel).toBe("File a.ts");
});

it("ignores scopes resolved after their project closed and never reruns across projects", async () => {
  await runInspection({ kind: "project", directory: "/p" });
  done();
  let finishStatus!: (files: { path: string }[]) => void;
  mock.vcsStatus.mockReturnValue(new Promise((resolve) => (finishStatus = resolve)));
  const pending = runInspection({ kind: "changed", directory: "/p" });
  useProject.setState({ project: { root: "/other", name: "other", trusted: true, isGit: true, settings: {} } });
  rerunInspection();
  finishStatus([{ path: "/p/a.ts" }]);
  await pending;
  expect(mock.inspect).toHaveBeenCalledTimes(1);
});

it("reprojects completed results, counts and original severities without rerunning", async () => {
  const dispose = installInspectionProfileSync();
  try {
    profile({});
    await runInspection({ kind: "project", directory: "" }, "default");
    file();
    done();
    const excluded = new Set(["excluded"]);
    useInspection.setState({ excluded });
    profile({ severity: "warning" });
    expect(useInspection.getState().files.get("/p/a.ts")!.diagnostics[0]!.severity).toBe("warning");
    profile({ enabled: false });
    expect(useInspection.getState().files.size).toBe(0);
    expect(useInspection.getState().summary!.problems).toBe(0);
    profile({});
    expect(useInspection.getState().files.get("/p/a.ts")!.diagnostics[0]!.severity).toBe("error");
    expect(useInspection.getState().summary!.problems).toBe(1);
    expect(useInspection.getState().excluded).toBe(excluded);
    resetInspection();
    expect(useInspection.getState().rawFiles.size).toBe(0);
  } finally {
    dispose();
  }
});

it("retains initially disabled diagnostics and uses edits made during streaming", async () => {
  vi.useFakeTimers();
  const dispose = installInspectionProfileSync();
  try {
    profile({ enabled: false });
    await runInspection({ kind: "project", directory: "" }, "default");
    file();
    vi.advanceTimersByTime(150);
    expect(useInspection.getState().files.size).toBe(0);
    profile({ severity: "warning" });
    expect(useInspection.getState().files.size).toBe(1);
    file("/p/b.ts");
    done();
    expect([...useInspection.getState().files.values()].map((f) => f.diagnostics[0]!.severity)).toEqual([
      "warning",
      "warning",
    ]);
    expect(useInspection.getState().summary!.problems).toBe(2);
  } finally {
    dispose();
  }
});
