import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import type { PluginEvent } from "@/bindings";
import { pluginLineMarkerGutter } from "./lineMarkerGutter";
const mock = vi.hoisted(() => ({
  markers: vi.fn(),
  event: undefined as ((event: PluginEvent) => void) | undefined,
  off: vi.fn(),
}));
vi.mock(import("@/platform/ipc"), async (original) => {
  const actual = await original();
  return { ...actual, commands: { ...actual.commands, pluginLineMarkers: mock.markers } };
});
vi.mock("./backend", () => ({
  pluginsBackend: () => ({
    onEvent: (fn: (event: PluginEvent) => void) => {
      mock.event = fn;
      return mock.off;
    },
  }),
}));
vi.mock("./navigationButton", () => ({ navigationButton: () => document.createElement("button") }));
let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("withdraws old interactive markers on reload and does not refresh on idle status changes", async () => {
  vi.useFakeTimers();
  mock.markers.mockResolvedValue({
    status: "ok",
    data: [{ pluginId: "test", line: 0, icon: "navigate", tooltip: "old", target: null }],
  });
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "select", extensions: pluginLineMarkerGutter({ doc: 1 } as EditorDocContext) }),
  });
  await vi.advanceTimersByTimeAsync(450);
  expect(view.dom.querySelector(".cm-openidea-gutter-pluginMarkers")).not.toBeNull();
  const calls = mock.markers.mock.calls.length;
  mock.event!({ type: "commandsChanged" });
  await vi.advanceTimersByTimeAsync(450);
  expect(mock.markers).toHaveBeenCalledTimes(calls);
  mock.markers.mockResolvedValue({ status: "ok", data: [] });
  mock.event!({ type: "documentIndexesChanged" });
  expect(view.dom.querySelector(".cm-openidea-gutter-pluginMarkers")).toBeNull();
  await vi.advanceTimersByTimeAsync(450);
  expect(view.dom.querySelector(".cm-openidea-gutter-pluginMarkers")).toBeNull();
  view.destroy();
  view = undefined;
  expect(mock.off).toHaveBeenCalledOnce();
});
