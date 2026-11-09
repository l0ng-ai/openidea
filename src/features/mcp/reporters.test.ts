import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  paths: ["/p/a.txt"],
  remote: false,
  root: "/p",
  registryChanged: () => {},
  editorChanged: () => {},
  projectChanged: () => {},
  remoteChanged: () => {},
  reportOpen: vi.fn(async () => undefined),
  reportFocused: vi.fn(async () => undefined),
}));
vi.mock("@/editor/api", () => ({
  openEditorPaths: () => state.paths,
  activeEditor: () => ({
    ctx: { path: "/p/a.txt" },
    view: {
      state: {
        selection: { main: { from: 3, to: 5 } },
        doc: {
          lineAt: () => ({ number: 1, from: 0 }),
          sliceString: () => "hi",
        },
      },
    },
  }),
  useEditorRegistry: {
    subscribe: (fn: () => void) => {
      state.registryChanged = fn;
      return () => {};
    },
  },
  onEditorEvent: (fn: () => void) => {
    state.editorChanged = fn;
    return () => {};
  },
}));
vi.mock("@/platform/project", () => ({
  useProject: {
    getState: () => ({ project: { root: state.root } }),
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      state.projectChanged = () => fn({ project: { root: state.root } }, { project: null });
      return () => {};
    },
  },
}));
vi.mock("@/platform/remote", () => ({
  isRemoteWindow: () => state.remote,
  useRemote: {
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      state.remoteChanged = () => fn({ session: {} }, { session: {} });
      return () => {};
    },
  },
}));
vi.mock("@/platform/ipc", () => ({
  call: (promise: Promise<unknown>) => promise,
  onIdeEvent: () => () => {},
  ideEventsReady: async () => {},
  commands: {
    mcpUiReady: vi.fn(async () => {}),
    mcpSetOpenEditors: state.reportOpen,
    mcpSetFocusedEditor: state.reportFocused,
  },
}));
vi.mock("@/workbench/contributions", () => ({ registerOverlay: () => () => {}, editorService: vi.fn() }));
vi.mock("./ConfirmDialog", () => ({ McpConfirmHost: () => null }));
const { activate } = await import("./index");

describe("MCP editor reports", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.paths = ["/p/a.txt"];
    state.remote = false;
    state.root = "/p";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    stop = activate();
  });
  afterEach(() => {
    stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("debounces editor tabs and sends only changes", async () => {
    await vi.advanceTimersByTimeAsync(200);
    state.paths = ["/p/a.txt", "/p/b.txt"];
    state.registryChanged();
    await vi.advanceTimersByTimeAsync(299);
    expect(state.reportOpen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.reportOpen).toHaveBeenCalledWith(["/p/a.txt", "/p/b.txt"]);
    expect(state.reportFocused).toHaveBeenCalledWith(
      {
        path: "/p/a.txt",
        selection: {
          start: { line: 0, col: 3 },
          end: { line: 0, col: 5 },
        },
        selectedText: "hi",
      },
      true,
    );
    state.editorChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).toHaveBeenCalledTimes(1);
    expect(state.reportFocused).toHaveBeenCalledTimes(1);
  });
  it("reports again after reopening the same project", async () => {
    await vi.advanceTimersByTimeAsync(300);
    state.projectChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).toHaveBeenCalledTimes(2);
    expect(state.reportFocused).toHaveBeenCalledTimes(2);
  });
  it("resends unchanged editors after reconnecting at the same root", async () => {
    state.remote = true;
    await vi.advanceTimersByTimeAsync(300);
    state.remoteChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).toHaveBeenCalledTimes(2);
    expect(state.reportFocused).toHaveBeenCalledTimes(2);
  });
  it("forwards remote editor reports and stops after disposal", async () => {
    state.remote = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).toHaveBeenCalledWith(["/p/a.txt"]);
    state.reportOpen.mockClear();
    state.remote = false;
    state.registryChanged();
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).not.toHaveBeenCalled();
  });
});
