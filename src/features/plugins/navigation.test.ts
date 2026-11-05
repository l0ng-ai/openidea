import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useProject } from "@/platform/project";
import { usePlugins } from "./store";
import { useEditorRegistry } from "@/editor/api";
import { lspDoc } from "@/editor/lsp/lsp";

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  index: vi.fn(),
  invalidate: vi.fn(),
  cancel: vi.fn(),
  events: new Map<string, (e: any) => void>(),
  pluginEvent: null as null | ((e: any) => void),
}));
vi.mock("./backend", () => ({
  pluginsBackend: () => ({
    onEvent: (callback: (e: any) => void) => {
      mocks.pluginEvent = callback;
      return () => {
        mocks.pluginEvent = null;
      };
    },
  }),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    onIdeEvent: (type: string, callback: (e: any) => void) => {
      mocks.events.set(type, callback);
      return () => mocks.events.delete(type);
    },
    commands: {
      ...real.commands,
      pluginNavigationFiles: mocks.files,
      pluginNavigationIndex: mocks.index,
      pluginNavigationInvalidate: mocks.invalidate,
      cancelRequest: mocks.cancel,
    },
  };
});
const { startPluginNavigation } = await import("./navigation");
let off: () => void;
let view: EditorView | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.files.mockResolvedValue({
    status: "ok",
    data: { paths: ["/project/A.java", "/project/A.xml"], indexing: false, extensions: ["xml", "java"] },
  });
  mocks.index.mockResolvedValue({ status: "ok", data: null });
  mocks.invalidate.mockResolvedValue({ status: "ok", data: null });
  mocks.cancel.mockResolvedValue(undefined);
  useProject.setState({ project: { root: "/project", trusted: true } as never });
  usePlugins.setState({
    plugins: [
      {
        id: "test",
        version: "1",
        status: "active",
        contributions: [{ point: "documentIndexers", label: "xml, java" }],
      } as never,
    ],
  });
});
afterEach(() => {
  off?.();
  view?.destroy();
  view = null;
  vi.useRealTimers();
  usePlugins.setState({ plugins: [] });
  useProject.setState({ project: null });
});

it("prewarms once and indexes only changed paths after file events", async () => {
  off = startPluginNavigation();
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.files).toHaveBeenCalledTimes(1);
  expect(mocks.index.mock.calls[0]?.[0]).toEqual(["/project/A.java", "/project/A.xml"]);
  mocks.index.mockClear();
  mocks.events.get("fsChanged")?.({ created: [], modified: ["/project/A.xml"], removed: [] });
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.index.mock.calls[0]?.[0]).toEqual(["/project/A.xml"]);
  mocks.events.get("indexState")?.({ indexing: false, extensions: ["xml", "java"] });
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.files).toHaveBeenCalledTimes(1);
});

it("indexes unsaved editor changes and refreshes after same-version plugin reload", async () => {
  off = startPluginNavigation();
  await vi.advanceTimersByTimeAsync(250);
  const ctx = { doc: 1, path: "/project/A.xml", language: "xml", uiMode: "XML", readOnly: false };
  const extension = useEditorRegistry.getState().contributions.get("plugins.navigation")!;
  view = new EditorView({
    state: EditorState.create({ doc: "<mapper/>", extensions: [lspDoc.of(ctx), extension.extensions(ctx)] }),
  });
  await vi.advanceTimersByTimeAsync(250);
  mocks.index.mockClear();
  view.dispatch({ changes: { from: 7, insert: " " } });
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.index.mock.calls[0]?.[0]).toEqual(["/project/A.xml"]);
  mocks.pluginEvent?.({ type: "documentIndexesChanged" });
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.invalidate).toHaveBeenCalledWith(null);
  expect(mocks.files).toHaveBeenCalledTimes(2);
});

it("cancels outstanding work when project context changes", async () => {
  mocks.index.mockImplementation(() => new Promise(() => {}));
  off = startPluginNavigation();
  await vi.advanceTimersByTimeAsync(250);
  useProject.setState({ project: null });
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
});

it("keeps warm indexes when API 1.0 reclaims an idle Wasm instance", async () => {
  off = startPluginNavigation();
  await vi.advanceTimersByTimeAsync(250);
  mocks.index.mockClear();
  mocks.pluginEvent?.({ type: "commandsChanged" });
  usePlugins.setState({ plugins: usePlugins.getState().plugins.map((p) => ({ ...p, status: "inactive" })) });
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.files).toHaveBeenCalledTimes(1);
  expect(mocks.index).not.toHaveBeenCalled();
});
