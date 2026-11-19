import { afterEach, expect, it, vi } from "vitest";
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
  scopes: [] as unknown[],
  active: "/p/a.ts",
}));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<object>()),
  activeEditor: () => ({ ctx: { path: mock.active, virtual: false } }),
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
      mock.scopes.push(scope);
      mock.channel = channel;
      return Promise.resolve();
    },
    cancelRequest: () => Promise.resolve(),
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
afterEach(() => {
  resetInspection();
  vi.useRealTimers();
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

it("reruns the file the results are for, not the file now active", async () => {
  mock.scopes = [];
  mock.active = "/p/a.ts";
  await runInspection({ kind: "file", directory: "" }, "default");
  mock.active = "/p/b.ts";
  rerunInspection();
  await vi.waitFor(() => expect(mock.scopes).toHaveLength(2));
  expect(mock.scopes).toEqual([
    { kind: "files", paths: ["/p/a.ts"] },
    { kind: "files", paths: ["/p/a.ts"] },
  ]);
  expect(useInspection.getState().scopeLabel).toBe("File /p/a.ts");
});
