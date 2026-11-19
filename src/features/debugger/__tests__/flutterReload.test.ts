import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "@/bindings";

const ipc = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  debugHotReload: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

import { _emitEditorEvent } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import type { DebugSessionId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { installFlutterHotReloadOnSave, packageRoots } from "../flutterReload";
import { useDebug, type DebugSession } from "../state";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const failed = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });

const CONFIG = "/repo/apps/shop/.dart_tool/package_config.json";
const PACKAGES = JSON.stringify({
  packages: [
    { name: "shop", rootUri: "../" },
    { name: "shared", rootUri: "../../../packages/shared" },
    { name: "http", rootUri: "file:///home/me/.pub-cache/http-1.0.0/" },
  ],
});

function session(id: number, patch: Partial<DebugSession> = {}): DebugSession {
  return {
    id: id as DebugSessionId,
    name: "shop",
    adapter: "dart",
    parent: null,
    launch: {
      name: "shop",
      adapter: "dart",
      request: "launch",
      program: "/repo/apps/shop/lib/main.dart",
      args: [],
      cwd: "/repo/apps/shop",
      env: {},
      extraJson: null,
    },
    process: null,
    status: "running",
    stoppedThread: null,
    stopReason: null,
    stopDescription: null,
    threads: [],
    selectedThread: null,
    frames: [],
    selectedFrame: null,
    hits: 0,
    stops: 0,
    exitCode: null,
    caps: null,
    flutterAppStarted: true,
    ...patch,
  };
}

const withSessions = (...sessions: DebugSession[]) =>
  useDebug.setState({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), console: {} });

const save = (...paths: string[]) => paths.forEach((path) => _emitEditorEvent({ type: "docSaved", doc: 1, path }));

const diagnostic = (severity: Diagnostic["severity"], source = "dart"): Diagnostic => ({
  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
  severity,
  message: "problem",
  source,
  code: null,
});

const settle = () => vi.advanceTimersByTimeAsync(1000);
const reloaded = () => ipc.debugHotReload.mock.calls.map(([id, reason]) => [id, reason]);

const MAIN = "/repo/apps/shop/lib/main.dart";
const HOME = "/repo/apps/shop/lib/home.dart";
const SHARED = "/repo/packages/shared/lib/shared.dart";
const OTHER_APP = "/repo/apps/admin/lib/main.dart";

describe("Flutter hot reload on save", () => {
  let uninstall: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    ipc.debugHotReload.mockReset().mockImplementation(() => ok(null));
    ipc.fsReadText
      .mockReset()
      .mockImplementation((path: string) => (path === CONFIG ? ok(PACKAGES) : failed("not found")));
    useProject.setState({ settings: null });
    withSessions(session(1));
    uninstall = installFlutterHotReloadOnSave();
  });

  afterEach(() => {
    uninstall();
    for (const path of [MAIN, HOME, SHARED]) setFileDiagnostics(path, "dart", []);
    vi.useRealTimers();
  });

  it("reloads the session with reason save", async () => {
    save(MAIN);
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
  });

  it("merges a Save All and repeated autosaves into one reload", async () => {
    save(MAIN, HOME);
    await vi.advanceTimersByTimeAsync(200);
    save(MAIN);
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
  });

  it("waits for a paused session to resume", async () => {
    withSessions(session(1, { status: "paused" }));
    save(MAIN);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
    withSessions(session(1));
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
  });

  it("does not reload on resume when nothing was saved", async () => {
    withSessions(session(1, { status: "paused" }));
    withSessions(session(1));
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("still reloads a running session while another one is paused", async () => {
    withSessions(session(1, { status: "paused" }), session(2));
    save(MAIN);
    await settle();
    expect(reloaded()).toEqual([[2, "save"]]);
  });

  it.each([
    ["a plain Dart session or an app still starting", { flutterAppStarted: undefined }],
    ["a session being stopped", { status: "stopping" as const }],
    ["a finished session", { status: "terminated" as const }],
  ])("skips %s", async (_name, patch) => {
    withSessions(session(1, patch));
    save(MAIN);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("skips a session that ends before the reload goes out", async () => {
    save(MAIN);
    withSessions(session(1, { status: "terminated" }));
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("ignores other file types", async () => {
    save("/repo/apps/shop/pubspec.yaml");
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("does nothing when the setting is off", async () => {
    useProject.setState({ settings: { debugger: { flutterHotReloadOnSave: false } } as never });
    save(MAIN);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  describe("when the setting is turned off with a reload pending", () => {
    const setEnabled = (flutterHotReloadOnSave: boolean) =>
      useProject.setState({ settings: { debugger: { flutterHotReloadOnSave } } as never });

    it("drops a save waiting for a paused session", async () => {
      withSessions(session(1, { status: "paused" }));
      save(MAIN);
      await settle();
      setEnabled(false);
      withSessions(session(1));
      await settle();
      expect(ipc.debugHotReload).not.toHaveBeenCalled();
    });

    it("does not replay that save after the setting comes back", async () => {
      withSessions(session(1, { status: "paused" }));
      save(MAIN);
      await settle();
      setEnabled(false);
      setEnabled(true);
      withSessions(session(1));
      await settle();
      expect(ipc.debugHotReload).not.toHaveBeenCalled();
    });

    it("drops a save still in the debounce window", async () => {
      save(MAIN);
      setEnabled(false);
      setEnabled(true);
      await settle();
      expect(ipc.debugHotReload).not.toHaveBeenCalled();
    });

    it("does not send a reload whose package list was still being read", async () => {
      let finishRead = (_: unknown) => {};
      ipc.fsReadText.mockImplementation(() => new Promise((resolve) => (finishRead = resolve)));
      save(MAIN);
      await settle();
      setEnabled(false);
      finishRead(await ok(PACKAGES));
      await settle();
      expect(ipc.debugHotReload).not.toHaveBeenCalled();
    });

    it("reloads for saves made after it comes back", async () => {
      save(MAIN);
      setEnabled(false);
      setEnabled(true);
      save(HOME);
      await settle();
      expect(reloaded()).toEqual([[1, "save"]]);
    });
  });

  it("reloads for a package the app depends on, not for another app of the monorepo", async () => {
    save(SHARED);
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
    ipc.debugHotReload.mockClear();
    save(OTHER_APP);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("uses the working directory of an attach session without a package config", async () => {
    const launch = { ...session(1).launch!, request: "attach", program: null, cwd: "/repo/module" };
    withSessions(session(1, { launch }));
    save("/repo/module/lib/a.dart", MAIN);
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
    ipc.debugHotReload.mockClear();
    save(MAIN);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();
  });

  it("reloads only the sessions whose project holds the file", async () => {
    const launch = { ...session(2).launch!, program: "/repo/apps/admin/lib/main.dart", cwd: "/repo/apps/admin" };
    withSessions(session(1), session(2, { launch }));
    save(OTHER_APP);
    await settle();
    expect(reloaded()).toEqual([[2, "save"]]);
  });

  it("skips a file with errors until it is fixed, including an error published after the save", async () => {
    save(MAIN);
    await vi.advanceTimersByTimeAsync(100);
    setFileDiagnostics(MAIN, "dart", [diagnostic("error")]);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();

    save(HOME);
    await settle();
    expect(ipc.debugHotReload).not.toHaveBeenCalled();

    setFileDiagnostics(MAIN, "dart", []);
    save(MAIN);
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
  });

  it("is not blocked by warnings or by errors of other tools", async () => {
    setFileDiagnostics(MAIN, "dart", [diagnostic("warning")]);
    setFileDiagnostics(HOME, "dart", [diagnostic("error", "custom-lint")]);
    save(MAIN, HOME);
    await settle();
    expect(reloaded()).toEqual([[1, "save"]]);
    setFileDiagnostics(HOME, "dart", []);
  });

  it("reports a failed request in the Debug console only", async () => {
    ipc.debugHotReload.mockImplementation(() => failed("timed out"));
    save(MAIN);
    await settle();
    const lines = useDebug.getState().console[1]!;
    expect(lines.map((l) => l.text).join("\n")).toContain("Hot reload on save failed: timed out");
  });
});

describe("packageRoots", () => {
  it("resolves relative and absolute package roots against the config file", () => {
    expect(packageRoots(PACKAGES, CONFIG)).toEqual([
      "/repo/apps/shop",
      "/repo/packages/shared",
      "/home/me/.pub-cache/http-1.0.0",
    ]);
  });

  it("decodes escapes and keeps Windows drives", () => {
    const text = JSON.stringify({ packages: [{ rootUri: "../" }, { rootUri: "file:///D:/pub%20cache/a/" }] });
    expect(packageRoots(text, "C:/my app/.dart_tool/package_config.json")).toEqual(["C:/my app", "D:/pub cache/a"]);
  });
});
