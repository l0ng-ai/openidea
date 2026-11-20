import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  paths: ["/p/a.txt"],
  selection: { from: 3, to: 5 },
  remote: false,
  root: "/p",
  trusted: true as boolean | undefined,
  registryChanged: () => {},
  editorChanged: () => {},
  projectChanged: () => {},
  trustChanged: () => {},
  remoteChanged: () => {},
  uiReady: vi.fn(async () => undefined),
  reportOpen: vi.fn(async () => undefined),
  reportFocused: vi.fn(async () => undefined),
}));
vi.mock("@/editor/api", () => ({
  openEditorPaths: () => state.paths,
  activeEditor: () => ({
    ctx: { path: "/p/a.txt" },
    view: {
      state: {
        selection: { main: state.selection },
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
    getState: () => ({ project: { root: state.root, trusted: state.trusted } }),
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      state.projectChanged = () => fn({ project: { root: state.root, trusted: state.trusted } }, { project: null });
      state.trustChanged = () =>
        fn(
          { project: { root: state.root, trusted: state.trusted } },
          { project: { root: state.root, trusted: false } },
        );
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
    mcpUiReady: state.uiReady,
    mcpSetOpenEditors: state.reportOpen,
    mcpSetFocusedEditor: state.reportFocused,
  },
}));
vi.mock("@/workbench/contributions", () => ({
  registerOverlay: () => () => {},
  registerStatusItem: () => () => {},
  editorService: vi.fn(),
}));
vi.mock("./ConfirmDialog", () => ({ McpConfirmHost: () => null }));
vi.mock("./BackgroundStatus", () => ({ BackgroundStatus: () => null }));
const { activate } = await import("./index");

describe("MCP editor reports", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.paths = ["/p/a.txt"];
    state.selection = { from: 3, to: 5 };
    state.remote = false;
    state.root = "/p";
    state.trusted = true;
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
  it.each([true, false])("reports window focus %s immediately during continuous editing", async (focused) => {
    vi.mocked(document.hasFocus).mockReturnValue(!focused);
    await vi.advanceTimersByTimeAsync(300);
    state.reportFocused.mockClear();
    state.editorChanged();
    await vi.advanceTimersByTimeAsync(100);

    vi.mocked(document.hasFocus).mockReturnValue(focused);
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
    expect(state.reportFocused).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "/p/a.txt" }), focused);

    for (let from = 4; from < 9; from++) {
      state.selection = { from, to: from + 2 };
      state.editorChanged();
      await vi.advanceTimersByTimeAsync(100);
      expect(state.reportFocused).toHaveBeenCalledTimes(1);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(state.reportFocused).toHaveBeenCalledTimes(2);
    expect(state.reportFocused).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selection: { start: { line: 0, col: 8 }, end: { line: 0, col: 10 } },
      }),
      focused,
    );
    expect(state.reportOpen).toHaveBeenCalledTimes(1);
  });
  it("reports again after reopening the same project", async () => {
    await vi.advanceTimersByTimeAsync(300);
    state.projectChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.reportOpen).toHaveBeenCalledTimes(2);
    expect(state.reportFocused).toHaveBeenCalledTimes(2);
  });
  it("resends unchanged editors and marks UI ready after reconnecting at the same root", async () => {
    state.remote = true;
    await vi.advanceTimersByTimeAsync(300);
    state.uiReady.mockClear();
    state.remoteChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.uiReady).toHaveBeenCalledWith(true);
    expect(state.reportOpen).toHaveBeenCalledTimes(2);
    expect(state.reportFocused).toHaveBeenCalledTimes(2);
  });
  it("registers UI readiness once a restricted project is trusted", async () => {
    stop();
    state.trusted = false;
    state.uiReady.mockClear();
    stop = activate();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.uiReady).not.toHaveBeenCalled();
    state.trusted = true;
    state.trustChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(state.uiReady).toHaveBeenCalledWith(true);
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
