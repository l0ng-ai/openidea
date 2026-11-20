import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineItem, SymbolKind } from "@/platform/ipc";
import { isWidgetBuild, keyOutline, onlyWidgets, sortOutline, widgetLetter } from "./outline";

const ipc = vi.hoisted(() => ({
  docOutline: vi.fn(),
  docFlutterOutline: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: (value: unknown) => value,
  commands: { docOutline: ipc.docOutline, docFlutterOutline: ipc.docFlutterOutline, lspTypeHierarchy: vi.fn() },
}));

const item = (name: string, kind: SymbolKind, line: number, children: OutlineItem[] = []): OutlineItem => {
  const range = { start: { line, col: 2 }, end: { line: line + 1, col: 4 } };
  return { name, kind, detail: null, range, selection_range: range, children };
};

const build = item("build(BuildContext context)", "method", 2, [
  item("Column", "widget", 3, [item("Text", "widget", 4), item("Icon", "widget", 6)]),
]);
const tree = keyOutline([item("App", "class", 0, [item("title", "field", 1), build]), item("helper()", "function", 9)]);

describe("Flutter outline nodes", () => {
  it("keeps widgets and the declarations leading to them", () => {
    const names = (nodes: ReturnType<typeof onlyWidgets>): unknown[] =>
      nodes.map((n) => (n.children.length ? [n.item.name, names(n.children)] : n.item.name));
    expect(names(onlyWidgets(tree))).toEqual([
      ["App", [["build(BuildContext context)", [["Column", ["Text", "Icon"]]]]]],
    ]);
  });

  it("keeps widgets in source order when symbols are sorted", () => {
    const sorted = sortOutline(tree, true);
    expect(sorted.map((n) => n.item.name)).toEqual(["App", "helper()"]);
    expect(sorted[0]!.children.map((n) => n.item.name)).toEqual(["build(BuildContext context)", "title"]);
    expect(sorted[0]!.children[0]!.children[0]!.children.map((n) => n.item.name)).toEqual(["Text", "Icon"]);
  });

  it("labels widgets like the Flutter plugin", () => {
    expect(widgetLetter("Scaffold")).toBe("S");
    expect(widgetLetter("_badge")).toBe("B");
    expect(widgetLetter("_")).toBe("");
    expect(isWidgetBuild(build)).toBe(true);
    expect(isWidgetBuild(item("build()", "method", 0))).toBe(false);
    expect(isWidgetBuild(item("builder()", "method", 0, [item("Text", "widget", 1)]))).toBe(false);
  });
});

describe("outline store", () => {
  beforeEach(() => {
    vi.resetModules();
    ipc.docOutline.mockReset().mockResolvedValue([item("Plain", "class", 0)]);
    ipc.docFlutterOutline.mockReset().mockResolvedValue(null);
  });

  async function open(language: string) {
    const { useEditorRegistry } = await import("@/editor/api");
    const { useLiveOutline, useOutline } = await import("./store");
    const { createElement } = await import("react");
    const { render, waitFor } = await import("@testing-library/react");
    useEditorRegistry.setState({ active: { ctx: { doc: 7, path: "/p/a.dart", language } } } as never);
    render(createElement(() => (useLiveOutline(), null)));
    await waitFor(() => expect(useOutline.getState().items).not.toBeNull());
    await Promise.resolve();
    return useOutline;
  }

  it("falls back to the ordinary outline without a widget tree", async () => {
    const outline = await open("dart");
    expect(ipc.docFlutterOutline).toHaveBeenCalledWith(7);
    expect(outline.getState().flutter).toBeNull();
    expect(outline.getState().items?.[0]?.name).toBe("Plain");
  });

  it("keeps the ordinary outline next to a published widget tree", async () => {
    ipc.docFlutterOutline.mockResolvedValue([build]);
    const outline = await open("dart");
    await vi.waitFor(() => expect(outline.getState().flutter).toEqual([build]));
    expect(outline.getState().items?.[0]?.name).toBe("Plain");
  });

  it("does not ask for a widget tree outside Dart", async () => {
    await open("rust");
    expect(ipc.docFlutterOutline).not.toHaveBeenCalled();
  });
});
