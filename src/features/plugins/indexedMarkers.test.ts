import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { offsetsToRange } from "@/editor/lsp/positions";
import type { FileMarkers } from "@/platform/ipc";
import { indexedMarkers } from "./indexedMarkers";
import { usePluginMarkers } from "./markerStore";

const calls = vi.hoisted(() => ({ navigate: vi.fn(), popup: vi.fn() }));
vi.mock("@/editor/lsp/navigation", () => ({ navigateTo: calls.navigate, locationItems: async () => [] }));
vi.mock("@/editor/lsp/popupStore", () => ({ openPopup: calls.popup }));

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  usePluginMarkers.setState({ entries: new Map() });
  vi.clearAllMocks();
});

const source = '<mapper>\n<select id="find">SELECT 1</select>\n</mapper>';
function setup() {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: source, extensions: [indexedMarkers("/p/Query.xml")] }),
  });
  const range = (from: number, to: number) => offsetsToRange(view!.state.doc, from, to);
  const target = { path: "/p/Query.java", range: range(0, 4) };
  const at = source.indexOf("find");
  const entry: FileMarkers = {
    path: "/p/Query.xml",
    version: 1,
    markers: [{ range: range(at, at + 4), targets: [target] }],
  };
  usePluginMarkers.setState({ entries: new Map([[entry.path, entry]]) });
  return { entry, target };
}
const button = () => view!.dom.querySelector<HTMLButtonElement>(".cm-plugin-mapping-button");

it("puts a button on the marker's line that goes to its target", async () => {
  const { target } = setup();
  await vi.waitFor(() => expect(button()).not.toBeNull());
  expect(button()!.title).toContain("Query.java:1");
  expect(button()!.getAttribute("aria-label")).toContain("Query.java:1");
  button()!.click();
  expect(calls.navigate).toHaveBeenCalledWith(target);
});

it("hides markers on edit and when the entry goes away", async () => {
  setup();
  await vi.waitFor(() => expect(button()).not.toBeNull());
  view!.dispatch({ changes: { from: 0, insert: "\n" } });
  expect(button()).toBeNull();
  usePluginMarkers.setState({ entries: new Map() });
  await vi.waitFor(() => expect(button()).toBeNull());
});

it("merges a line's targets and offers a chooser for several", async () => {
  const { entry, target } = setup();
  const other = { ...target, path: "/p/Other.java" };
  usePluginMarkers.setState({
    entries: new Map([
      [entry.path, { ...entry, markers: [...entry.markers, { ...entry.markers[0]!, targets: [target, other] }] }],
    ]),
  });
  await vi.waitFor(() => expect(button()!.title).toContain("Other.java"));
  expect(view!.dom.querySelectorAll(".cm-plugin-mapping-button")).toHaveLength(1);
  button()!.click();
  await vi.waitFor(() => expect(calls.popup).toHaveBeenCalled());
});
