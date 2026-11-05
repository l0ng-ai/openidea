import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { offsetsToRange } from "@/editor/lsp/positions";
import { usePluginPresentations } from "@/platform/pluginPresentation";
import { sqlInput, embeddedOffsets, editorPresentation } from "./presentation";
import type { FilePresentation } from "@/platform/ipc";
const calls = vi.hoisted(() => ({ navigate: vi.fn(), popup: vi.fn() }));
vi.mock("@/editor/lsp/navigation", () => ({ navigateTo: calls.navigate, locationItems: async () => [] }));
vi.mock("@/editor/lsp/popupStore", () => ({ openPopup: calls.popup }));
let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  usePluginPresentations.setState({ entries: new Map() });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const source = '<mapper><select id="find">SELECT * FROM users WHERE id = #{item.id}</select></mapper>';
function setup() {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      extensions: [
        editorPresentation("/p/Query.xml"),
        syntaxHighlighting(HighlightStyle.define([{ tag: tags.keyword, class: "sql-keyword" }])),
      ],
    }),
  });
  const range = (from: number, to: number) => offsetsToRange(view!.state.doc, from, to);
  const target = { path: "/p/Query.code", range: range(0, 4) };
  const entry: FilePresentation = {
    path: "/p/Query.xml",
    version: 1,
    icon: "arrow-right",
    markers: [{ range: range(20, 24), targets: [target] }],
    regions: [{ language: "sql", range: range(source.indexOf("SELECT"), source.indexOf("</select>")) }],
  };
  usePluginPresentations.setState({ entries: new Map([[entry.path, entry]]) });
  return { entry, target };
}
it("masks XML, expressions and encoded operators without moving UTF-16 offsets", () => {
  const text = "<select>😀 SELECT #{item.id} FROM t WHERE n &lt; 4</select>";
  const from = text.indexOf("😀"),
    to = text.indexOf("</select>");
  const sql = sqlInput(text, [{ from, to }]);
  expect(sql.length).toBe(text.length);
  expect(sql.indexOf("SELECT")).toBe(text.indexOf("SELECT"));
  expect(sql).not.toContain("item.id");
  expect(sql).not.toContain("select>");
  expect(sql).toContain("<    4");
});
it("merges overlapping regions and ignores unsupported embedded languages", () => {
  const doc = EditorState.create({ doc: "0123456789" }).doc;
  const r = (from: number, to: number) => ({ language: "sql", range: offsetsToRange(doc, from, to) });
  expect(embeddedOffsets(doc, [r(3, 7), r(1, 5), { ...r(8, 9), language: "javascript" }])).toEqual([
    { from: 1, to: 7 },
  ]);
});
it("renders a normal-click gutter button and SQL backgrounds/highlighting", async () => {
  const { target } = setup();
  await vi.waitFor(() => expect(view!.dom.querySelector(".sql-keyword")?.textContent).toBe("SELECT"));
  expect(view!.dom.querySelector(".cm-plugin-sql-region")?.textContent).not.toContain("<select");
  const button = view!.dom.querySelector<HTMLButtonElement>(".cm-plugin-mapping-button")!;
  expect(button.title).toContain("Query.code:1");
  button.click();
  expect(calls.navigate).toHaveBeenCalledWith(target);
  view!.dispatch({ changes: { from: 0, insert: "\n" } });
  expect(view!.dom.querySelector(".cm-plugin-mapping-button")).toBeNull();
  expect(view!.dom.querySelector(".cm-plugin-sql-region")).toBeNull();
});
it("offers multiple targets and reuses SQL parses on unchanged text and regions", async () => {
  const support = await LanguageDescription.matchLanguageName(languages, "SQL")!.load();
  const parse = vi.spyOn(support.language.parser, "startParse");
  const { entry, target } = setup();
  await vi.waitFor(() => expect(view!.dom.querySelector(".sql-keyword")).not.toBeNull());
  const count = parse.mock.calls.length;
  usePluginPresentations.setState({
    entries: new Map([
      [
        entry.path,
        { ...entry, markers: [{ ...entry.markers[0]!, targets: [target, { ...target, path: "/p/Other.java" }] }] },
      ],
    ]),
  });
  await vi.waitFor(() =>
    expect(view!.dom.querySelector<HTMLButtonElement>(".cm-plugin-mapping-button")!.title).toContain("Other.java"),
  );
  view!.dom.querySelector<HTMLButtonElement>(".cm-plugin-mapping-button")!.click();
  await vi.waitFor(() => expect(calls.popup).toHaveBeenCalled());
  expect(parse.mock.calls.length).toBe(count);
  usePluginPresentations.setState({ entries: new Map() });
  await vi.waitFor(() => expect(view!.dom.querySelector(".cm-plugin-mapping-button")).toBeNull());
  expect(view!.dom.querySelector(".cm-plugin-sql-region")).toBeNull();
});
it("SQL highlighting nests inside XML CDATA highlighting, with full-line backgrounds", async () => {
  const xml = await LanguageDescription.matchLanguageName(languages, "XML")!.load();
  const text = "<mapper><select><![CDATA[SELECT id FROM users]]></select></mapper>";
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        xml,
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.special(tags.string), class: "xml-cdata" },
            { tag: tags.keyword, class: "sql-keyword" },
          ]),
        ),
        editorPresentation("/p/Cdata.xml"),
      ],
    }),
  });
  const from = text.indexOf("SELECT"),
    to = text.indexOf("]]>");
  usePluginPresentations.setState({
    entries: new Map([
      [
        "/p/Cdata.xml",
        {
          path: "/p/Cdata.xml",
          version: 1,
          icon: "arrow-right",
          markers: [],
          regions: [{ language: "sql", range: offsetsToRange(view.state.doc, from, to) }],
        },
      ],
    ]),
  });
  await vi.waitFor(() => expect(view!.dom.querySelector(".xml-cdata .sql-keyword")?.textContent).toBe("SELECT"));
  expect(view!.dom.querySelector(".sql-keyword .xml-cdata")).toBeNull();
  expect(view!.dom.querySelector(".cm-plugin-sql-line")).not.toBeNull();
  expect(view!.dom.querySelector(".cm-plugin-sql-xml")?.textContent).toContain("<mapper>");
});
