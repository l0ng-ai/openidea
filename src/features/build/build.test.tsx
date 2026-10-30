import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { bindingsFor } from "@/platform/keymap";
import { IpcError, type BuildEvent, type BuildMessage, type BuildResult } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  menuGroupItems,
  provideEditorService,
  provideNotificationService,
  provideToolWindowService,
  useContributions,
  type EditorService,
  type NotificationService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { useTasks } from "@/workbench/tasks";
import { BuildView } from "./BuildView";
import { activate } from "./index";
import {
  appendOutput,
  findNode,
  finishSummary,
  firstError,
  formatDuration,
  messageFiles,
  rootChildren,
  rootNode,
  MAX_CONSOLE_LINES,
} from "./model";
import { BUILD_TASK_ID, setBuildBackend, startBuild, stopBuild, useBuildRun, type BuildBackend } from "./store";

const err = (path: string | null, line: number, text = "cannot find symbol"): BuildMessage => ({
  severity: "error",
  text,
  path,
  range: path ? { start: { line, col: 4 }, end: { line, col: 4 } } : null,
  code: null,
});
const warn = (path: string, line: number): BuildMessage => ({ ...err(path, line, "deprecated"), severity: "warning" });

describe("build model", () => {
  it("groups messages by file, errors first, build messages last", () => {
    const messages = [warn("/p/B.java", 3), err(null, 0, "BUILD FAILURE"), err("/p/A.java", 9), warn("/p/A.java", 2)];
    const children = rootChildren(messages);
    expect(children.map((c) => (c.kind === "file" ? c.path : c.kind))).toEqual(["/p/A.java", "/p/B.java", "message"]);
    const a = children[0]!;
    expect(a.kind === "file" && a.messages.map((m) => m.range?.start.line)).toEqual([2, 9]);
    expect(rootNode("demo", "failed", messages)).toMatchObject({ errors: 2, warnings: 2 });
    expect(messageFiles(messages)).toEqual(["/p/B.java", "/p/A.java"]);
    const first = firstError(messages)!;
    expect(first.message.range?.start.line).toBe(9);
    expect(findNode(messages, first.key)).toEqual(first);
    expect(firstError([warn("/p/B.java", 3)])).toBeUndefined();
  });

  it("formats IDEA's finish summaries", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(3000)).toBe("3 s");
    expect(formatDuration(3120)).toBe("3 s 120 ms");
    expect(formatDuration(65_000)).toBe("1 m 5 s");
    expect(finishSummary({ success: true, errors: 0, warnings: 0, durationMs: 3000 })).toBe(
      "Build completed successfully in 3 s",
    );
    expect(finishSummary({ success: true, errors: 0, warnings: 1, durationMs: 500 })).toBe(
      "Build completed successfully with 1 warning in 500 ms",
    );
    expect(finishSummary({ success: false, errors: 2, warnings: 0, durationMs: 1 })).toBe("Build failed: 2 errors");
    expect(finishSummary({ success: false, errors: 1, warnings: 2, durationMs: 1 })).toBe(
      "Build failed: 1 error, 2 warnings",
    );
    expect(finishSummary({ success: false, errors: 0, warnings: 0, durationMs: 1 })).toBe("Build failed");
  });

  it("splits console output into capped lines", () => {
    expect(appendOutput([], "a\nb\r\n", "out")).toEqual([
      { text: "a", kind: "out" },
      { text: "b", kind: "out" },
    ]);
    const many = appendOutput([], "x\n".repeat(MAX_CONSOLE_LINES + 5), "out");
    expect(many).toHaveLength(MAX_CONSOLE_LINES);
  });
});

type Note = Parameters<NotificationService["notify"]>[0];

class FakeBackend implements BuildBackend {
  calls: Array<{ kind: string; file: string | null; clear: string[] }> = [];
  cancelled: number[] = [];
  private finish?: (r: BuildResult) => void;
  private fail?: (e: unknown) => void;
  emit?: (e: BuildEvent) => void;
  run(kind: string, file: string | null, _request: number, clear: string[], onEvent: (e: BuildEvent) => void) {
    this.calls.push({ kind, file, clear });
    this.emit = onEvent;
    return new Promise<BuildResult>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
  }
  cancel(request: number) {
    this.cancelled.push(request);
  }
  resolve(r: BuildResult) {
    this.finish?.(r);
  }
  reject(e: unknown) {
    this.fail?.(e);
  }
}

const result = (messages: BuildMessage[], success: boolean): BuildResult => ({
  system: "maven",
  title: "demo",
  success,
  errors: messages.filter((m) => m.severity === "error").length,
  warnings: messages.filter((m) => m.severity === "warning").length,
  durationMs: 3000,
  messages,
});

describe("build feature", () => {
  let dispose: () => void;
  let notes: Note[];
  let fake: FakeBackend;
  let openFile: ReturnType<typeof vi.fn>;
  let show: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    notes = [];
    openFile = vi.fn(() => Promise.resolve());
    show = vi.fn();
    provideEditorService({
      openFile,
      saveAll: () => Promise.resolve(),
      activePath: () => null,
    } as unknown as EditorService);
    provideToolWindowService({ show } as unknown as ToolWindowService);
    provideNotificationService({ notify: (n) => void notes.push(n) });
    fake = new FakeBackend();
    setBuildBackend(fake);
    useProject.setState({ project: { root: "/p", name: "demo" } as never });
    setContext("projectOpen", true);
    dispose = activate();
  });

  afterEach(() => {
    dispose();
    setBuildBackend(null);
    useProject.setState({ project: null });
    setContext("projectOpen", false);
  });

  it("registers the Build menu actions, shortcuts and an on-use bottom tool window", () => {
    for (const id of ["build.buildProject", "build.buildModule", "build.rebuildProject", "build.buildArtifacts"]) {
      expect(getAction(id), id).toBeDefined();
      expect(isActionEnabled(getAction(id)!)).toBe(true);
    }
    expect(bindingsFor("build.buildProject")).toContain("Meta+F9");
    expect(bindingsFor("build.buildModule")).toContain("Meta+Shift+F9");
    const tw = useContributions.getState().toolWindows.get("build");
    expect(tw).toMatchObject({ anchor: "bottom", stripe: "onUse", icon: "toolwindow-build" });
    expect(menuGroupItems("projectView", { paths: ["/p/core"] })).toContainEqual({
      kind: "action",
      action: "build.buildModule",
      arg: "/p/core",
    });
  });

  it("streams a failing build into the tree and console, then notifies and clears next time", async () => {
    const run = startBuild("build");
    await act(async () => {});
    expect(getContext()["build.running"]).toBe(true);
    expect(isActionEnabled(getAction("build.buildProject")!)).toBe(false);
    expect(show).toHaveBeenCalledWith("build", false);
    expect(useTasks.getState().tasks.some((t) => t.id === BUILD_TASK_ID && !t.done)).toBe(true);
    const messages = [err("/p/src/A.java", 11), warn("/p/src/B.java", 2)];
    await act(async () => {
      fake.emit!({ kind: "started", system: "maven", title: "demo" });
      fake.emit!({ kind: "step", command: "mvnw -B test-compile", cwd: "/p" });
      fake.emit!({ kind: "output", text: "[ERROR] /p/src/A.java:[12,5] cannot find symbol\n", stderr: false });
      fake.emit!({ kind: "message", message: messages[0]! });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(useBuildRun.getState().lines.map((l) => l.kind)).toEqual(["system", "out"]);
    render(<BuildView />);
    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("A.java")).toBeInTheDocument();
    await act(async () => {
      fake.resolve(result(messages, false));
      await run;
    });
    expect(useBuildRun.getState().status).toBe("failed");
    expect(screen.getByText("deprecated")).toBeInTheDocument();
    expect(screen.getByText(":12:5")).toBeInTheDocument();
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Build failed: 1 error, 1 warning" });
    // A failure shows the tool window (unfocused), selects the first error and opens it.
    expect(show).toHaveBeenCalledWith("build", false);
    expect(useBuildRun.getState().selected).toBe(firstError(messages)!.key);
    expect(openFile).toHaveBeenCalledWith(
      "/p/src/A.java",
      expect.objectContaining({ focus: true, selection: { line: 11, col: 4 } }),
    );
    expect(screen.getByRole("document", { name: "Build message" })).toHaveTextContent("cannot find symbol");
    expect(getContext()["build.running"]).toBe(false);

    const second = startBuild("rebuild");
    await act(async () => {});
    expect(fake.calls.at(-1)).toEqual({ kind: "rebuild", file: null, clear: ["/p/src/A.java", "/p/src/B.java"] });
    await act(async () => {
      fake.resolve(result([], true));
      await second;
    });
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Build completed successfully in 3 s" });
    expect(show).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["build.buildProject", undefined],
    ["build.buildModule", "/p/core/src/A.java"],
    ["build.rebuildProject", undefined],
  ])("opens the Build window without focus when %s starts", async (id, arg) => {
    const run = executeAction(id!, arg);
    await act(async () => {});
    expect(useBuildRun.getState().status).toBe("running");
    expect(show).toHaveBeenCalledExactlyOnceWith("build", false);
    expect(openFile).not.toHaveBeenCalled();
    await act(async () => {
      fake.resolve(result([], true));
      await run;
    });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("keeps before-launch builds hidden until a failure", async () => {
    const run = executeAction("build.buildProject", { activate: false });
    await act(async () => {});
    expect(useBuildRun.getState().status).toBe("running");
    expect(show).not.toHaveBeenCalled();
    await act(async () => {
      fake.resolve(result([], true));
      await run;
    });
    expect(show).not.toHaveBeenCalled();

    const failed = executeAction("build.buildProject", { activate: false });
    await act(async () => {});
    expect(show).not.toHaveBeenCalled();
    const messages = [err("/p/src/A.java", 11)];
    await act(async () => {
      fake.resolve(result(messages, false));
      await failed;
    });
    expect(show).toHaveBeenCalledExactlyOnceWith("build", false);
    expect(useBuildRun.getState().selected).toBe(firstError(messages)!.key);
    expect(openFile).toHaveBeenCalledWith(
      "/p/src/A.java",
      expect.objectContaining({ focus: true, selection: { line: 11, col: 4 } }),
    );
  });

  it("starts a build without a workbench", async () => {
    show.mockImplementation(() => {
      throw new Error("No workbench");
    });
    const run = startBuild("build");
    await act(async () => {});
    expect(fake.calls).toHaveLength(1);
    await act(async () => {
      fake.resolve(result([], true));
      await run;
    });
    expect(useBuildRun.getState().status).toBe("success");
  });

  it("shows a message on single click and navigates on F4", async () => {
    const messages = [err("/p/src/A.java", 11, "first problem"), warn("/p/src/B.java", 2)];
    const run = startBuild("build");
    await act(async () => {});
    await act(async () => {
      fake.resolve(result(messages, true));
      await run;
    });
    render(<BuildView />);
    expect(screen.getByRole("log", { name: "Build output" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("deprecated"));
    expect(openFile).not.toHaveBeenCalled();
    expect(screen.getByRole("document", { name: "Build message" })).toHaveTextContent("deprecated");
    fireEvent.keyDown(screen.getByRole("tree"), { key: "F4" });
    expect(openFile).toHaveBeenCalledWith("/p/src/B.java", expect.objectContaining({ focus: true }));
  });

  it("builds the module of the given file and can be stopped", async () => {
    const run = startBuild("build", "/p/core/src/A.java");
    await act(async () => {});
    expect(fake.calls.at(-1)?.file).toBe("/p/core/src/A.java");
    stopBuild();
    expect(fake.cancelled).toHaveLength(1);
    await act(async () => {
      fake.reject(new IpcError({ kind: "cancelled", message: "cancelled" }));
      await run;
    });
    expect(useBuildRun.getState().status).toBe("cancelled");
    expect(notes).toHaveLength(0);
  });
});
