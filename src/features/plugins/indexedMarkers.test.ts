import { afterEach, expect, it, vi } from "vitest";
import { EditorState, type RangeSet, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { offsetsToRange } from "@/editor/lsp/positions";
import type { FileMarkers } from "@/platform/ipc";
import { indexedMarkers } from "./indexedMarkers";
import { projectMarkerIcon } from "./markerIcons";
import { usePluginMarkers } from "./markerStore";

const calls = vi.hoisted(() => ({ navigate: vi.fn(), popup: vi.fn(), assets: vi.fn() }));
vi.mock("@/editor/lsp/navigation", () => ({ navigateTo: calls.navigate, locationItems: async () => [] }));
vi.mock("@/editor/lsp/popupStore", () => ({ openPopup: calls.popup }));
vi.mock("./backend", () => ({ pluginsBackend: () => ({ assets: calls.assets }) }));

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  usePluginMarkers.setState({ entries: new Map() });
  vi.useRealTimers();
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
    markers: [{ range: range(at, at + 4), targets: [target], pluginId: "p", icon: null }],
  };
  usePluginMarkers.setState({ entries: new Map([[entry.path, entry]]) });
  return { entry, target };
}
const button = () => view!.dom.querySelector<HTMLButtonElement>(".cm-plugin-mapping-button");
function pendingAssets() {
  let resolve!: (assets: [string, string][]) => void;
  const promise = new Promise<[string, string][]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

it("draws the declared icon and tooltip of the marker's key prefix", async () => {
  calls.assets.mockResolvedValue([
    ["markerIcon/usages/light", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'],
  ]);
  const remove = projectMarkerIcon("p", { id: "usages", icon: "icons/usages.svg", tooltip: "Usages of this class" });
  try {
    const { entry } = setup();
    await vi.waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.querySelector("circle")).toBeNull();
    expect(button()!.title).toBe("Query.java:1");
    const plain = entry.markers[0]!;
    usePluginMarkers.setState({
      entries: new Map([
        [entry.path, { ...entry, markers: [plain, { ...plain, icon: "unknown" }, { ...plain, icon: "usages" }] }],
      ]),
    });
    await vi.waitFor(() => expect(button()!.querySelector("circle")).not.toBeNull());
    expect(button()!.title).toBe("Usages of this class\nQuery.java:1");
    expect(button()!.getAttribute("aria-label")).toContain("Usages of this class");
    usePluginMarkers.setState({
      entries: new Map([[entry.path, { ...entry, markers: [{ ...plain, icon: "unknown" }] }]]),
    });
    await vi.waitFor(() => expect(button()!.querySelector("circle")).toBeNull());
    expect(button()!.title).toBe("Query.java:1");
  } finally {
    remove();
  }
});

it("redraws when a marker icon declaration goes away", async () => {
  calls.assets.mockResolvedValue([
    ["markerIcon/usages/light", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'],
  ]);
  const remove = projectMarkerIcon("p", { id: "usages", icon: "icons/usages.svg", tooltip: "Usages" });
  const { entry } = setup();
  usePluginMarkers.setState({
    entries: new Map([[entry.path, { ...entry, markers: [{ ...entry.markers[0]!, icon: "usages" }] }]]),
  });
  await vi.waitFor(() => expect(button()!.querySelector("circle")).not.toBeNull());
  remove();
  await vi.waitFor(() => expect(button()!.querySelector("circle")).toBeNull());
  expect(button()!.title).toBe("Query.java:1");
});

it.each(["edit", "remove", "replace", "dispose"])("drops pending icons after %s", async (change) => {
  vi.useFakeTimers();
  const pending = pendingAssets();
  calls.assets.mockReturnValue(pending.promise);
  const remove = projectMarkerIcon("p", { id: "slow", icon: "icons/slow.svg", tooltip: "Old marker" });
  try {
    const { entry } = setup();
    usePluginMarkers.setState({
      entries: new Map([[entry.path, { ...entry, markers: [{ ...entry.markers[0]!, icon: "slow" }] }]]),
    });
    await vi.advanceTimersByTimeAsync(0);
    if (change === "edit") view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: "short" } });
    if (change === "remove") usePluginMarkers.setState({ entries: new Map() });
    if (change === "replace") usePluginMarkers.setState({ entries: new Map([[entry.path, entry]]) });
    if (change === "dispose") view!.destroy();
    await vi.advanceTimersByTimeAsync(0);
    const dispatch = vi.spyOn(view!, "dispatch");
    pending.resolve([["markerIcon/slow/light", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>']]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(button()?.querySelector("circle")).toBeFalsy();
    if (change === "replace") expect(button()!.title).toBe("Query.java:1");
    else expect(button()).toBeNull();
    if (change === "dispose") view = undefined;
  } finally {
    remove();
  }
});

it("positions a new indexed result against the edited document while icons load", async () => {
  vi.useFakeTimers();
  const pending = pendingAssets();
  calls.assets.mockReturnValue(pending.promise);
  const remove = projectMarkerIcon("p", { id: "slow", icon: "icons/slow.svg" });
  try {
    const { entry } = setup();
    const marker = { ...entry.markers[0]!, icon: "slow" };
    usePluginMarkers.setState({ entries: new Map([[entry.path, { ...entry, markers: [marker] }]]) });
    await vi.advanceTimersByTimeAsync(0);
    view!.dispatch({ changes: { from: 0, insert: "a longer first line\n" } });
    const range = {
      start: { ...marker.range.start, line: marker.range.start.line + 1 },
      end: { ...marker.range.end, line: marker.range.end.line + 1 },
    };
    usePluginMarkers.setState({
      entries: new Map([[entry.path, { ...entry, version: 2, markers: [{ ...marker, range }] }]]),
    });
    await vi.advanceTimersByTimeAsync(0);
    const dispatch = vi.spyOn(view!, "dispatch");
    pending.resolve([["markerIcon/slow/light", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>']]);
    await vi.advanceTimersByTimeAsync(0);
    expect(button()!.querySelector("circle")).not.toBeNull();
    const transaction = dispatch.mock.calls[0]![0] as { effects: StateEffect<RangeSet<never>> };
    expect(transaction.effects.value.iter().from).toBe(view!.state.doc.line(3).from);
  } finally {
    remove();
  }
});

it("merges two plugins on one line and uses the first declared icon with a plain-text tooltip", async () => {
  calls.assets.mockImplementation((pluginId: string) =>
    Promise.resolve([
      [
        "markerIcon/shared/light",
        pluginId === "first"
          ? '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'
          : '<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>',
      ],
    ]),
  );
  const tooltip = '<img src="invalid" onerror="alert(1)"> & usages';
  const removers = ["first", "second"].map((id) =>
    projectMarkerIcon(id, { id: "shared", icon: "icons/shared.svg", tooltip: id === "first" ? tooltip : "Second" }),
  );
  try {
    const { entry, target } = setup();
    const other = { ...target, path: "/p/Other.java" };
    usePluginMarkers.setState({
      entries: new Map([
        [
          entry.path,
          {
            ...entry,
            markers: [
              { ...entry.markers[0]!, pluginId: "first", icon: "shared" },
              { ...entry.markers[0]!, pluginId: "second", icon: "shared", targets: [target, other] },
            ],
          },
        ],
      ]),
    });
    await vi.waitFor(() => expect(button()!.querySelector("circle")).not.toBeNull());
    expect(view!.dom.querySelectorAll(".cm-plugin-mapping-button")).toHaveLength(1);
    expect(button()!.querySelector("rect, img")).toBeNull();
    expect(button()!.title).toBe(`${tooltip}\nQuery.java:1\nOther.java:1`);
    button()!.click();
    await vi.waitFor(() => expect(calls.popup).toHaveBeenCalledOnce());
    removers[0]!();
    await vi.waitFor(() => expect(button()!.querySelector("rect")).not.toBeNull());
    expect(button()!.title).toBe("Second\nQuery.java:1\nOther.java:1");
  } finally {
    removers.forEach((remove) => remove());
  }
});
