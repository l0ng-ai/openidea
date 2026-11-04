import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Location } from "@/platform/ipc";

/** The lazy index answers, and where a click goes. */
const index = vi.hoisted(() => ({ xmlFor: vi.fn(), interfaceFor: vi.fn() }));
vi.mock("./mapperStore", async (orig) => {
  const actual = await orig<typeof import("./mapperStore")>();
  return {
    ...actual,
    mapperXmlFor: index.xmlFor,
    mapperInterfaceFor: index.interfaceFor,
    onMapperIndexCleared: () => () => {},
  };
});

const nav = vi.hoisted(() => ({
  navigateTo: vi.fn<(loc: Location) => Promise<void>>(async () => {}),
  openPopup: vi.fn(),
  statement: vi.fn(async () => {}),
  params: vi.fn(async () => {}),
}));
vi.mock("@/editor/lsp/navigation", async (orig) => ({
  ...(await orig<typeof import("@/editor/lsp/navigation")>()),
  navigateTo: nav.navigateTo,
  locationItems: async (locs: Location[]) => locs.map((l, i) => ({ id: `${i}`, label: l.path, run: () => {} })),
}));
vi.mock("@/editor/lsp/popupStore", async (orig) => ({
  ...(await orig<typeof import("@/editor/lsp/popupStore")>()),
  openPopup: nav.openPopup,
}));
vi.mock("./generateActions", () => ({ generateStatement: nav.statement, generateParams: nav.params }));

const { mybatisEditor } = await import("./mapperGutter");
const { contributedIntentions } = await import("@/editor/api");
const { GUTTER_ICON_GROUPS } = await import("@/editor/core/cm/prefs");
const { lspDoc } = await import("@/editor/lsp/lsp");
const { parseJavaMapper } = await import("./java");
const { parseMapperXml } = await import("./xml");
const { useProject } = await import("@/platform/project");

const JAVA_PATH = "/p/demo/src/main/java/com/example/mapper/UserMapper.java";
const XML_PATH = "/p/demo/src/main/resources/mapper/UserMapper.xml";

const JAVA = [
  "package com.example.mapper;",
  "",
  "public interface UserMapper {",
  "    User findById(Long id);",
  "    int insertUser(String name, Long deptId);",
  "    int countUser(String dept);",
  "}",
].join("\n");

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<mapper namespace="com.example.mapper.UserMapper">',
  '    <select id="findById" resultType="User">',
  "        SELECT * FROM sys_user WHERE id = #{id}",
  "    </select>",
  '    <select id="countUser" databaseId="mysql" resultType="int">',
  "        SELECT COUNT(*) FROM sys_user",
  "    </select>",
  '    <select id="countUser" databaseId="oracle" resultType="int">',
  "        SELECT COUNT(*) FROM users",
  "    </select>",
  "</mapper>",
].join("\n");

const halfOf = <T>(path: string, text: string, parsed: T) => ({ path, text, parsed });
const xmlHalf = () => halfOf(XML_PATH, XML, parseMapperXml(XML)!);
const javaHalf = () => halfOf(JAVA_PATH, JAVA, parseJavaMapper(JAVA)!);

const views: EditorView[] = [];

function editor(path: string, language: "java" | "xml", doc: string): EditorView {
  const ctx = { doc: 1, path, language, uiMode: null, readOnly: false };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [lspDoc.of(ctx), mybatisEditor(ctx)] }),
  });
  views.push(view);
  return view;
}

const javaEditor = (doc = JAVA) => editor(JAVA_PATH, "java", doc);
const xmlEditor = (doc = XML) => editor(XML_PATH, "xml", doc);

/** The mapper icons the editor shows, in document order. */
const icons = (view: EditorView) =>
  [...view.dom.querySelectorAll(".cm-openidea-mapperMarker")].map((el) => (el as HTMLElement).dataset.name);

async function settle() {
  await vi.advanceTimersByTimeAsync(400);
}

/** A click on the icon of `name`, as the gutter DOM delivers it. */
async function clickIcon(view: EditorView, name: string) {
  const el = [...view.dom.querySelectorAll(".cm-openidea-mapperMarker")].find(
    (x) => (x as HTMLElement).dataset.name === name,
  )!;
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await settle();
}

/** The location a jump was asked for. */
const jumpedTo = () => nav.navigateTo.mock.calls[0]![0];

/** The text a location highlights, which shows the jump lands on a name. */
const span = (text: string, loc: Location) =>
  text.split("\n")[loc.range.start.line]!.slice(loc.range.start.col, loc.range.end.col);

/** The context actions listed with the caret on the line carrying `token`. */
async function intentionsOf(view: EditorView, token: string) {
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(token) } });
  await settle();
  return contributedIntentions(view).map((i) => i.label);
}

beforeEach(() => {
  vi.useFakeTimers();
  useProject.setState({ project: { root: "/p/demo" } as never, settings: {} as never });
  index.xmlFor.mockResolvedValue(xmlHalf());
  index.interfaceFor.mockResolvedValue(javaHalf());
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("mapper gutter", () => {
  it("marks the methods whose statement exists, and only those", async () => {
    const view = javaEditor();
    await settle();
    expect(icons(view)).toEqual(["findById", "countUser"]);
    expect(index.xmlFor).toHaveBeenCalledWith("com.example.mapper.UserMapper");
  });

  it("jumps from a method to the one statement that binds it", async () => {
    // One line, so the click resolves to the same line in any layout.
    const view = javaEditor("public interface UserMapper { User findById(Long id); }");
    await settle();
    expect(icons(view)).toEqual(["findById"]);
    await clickIcon(view, "findById");
    expect(nav.openPopup).not.toHaveBeenCalled();
    expect(nav.navigateTo).toHaveBeenCalledTimes(1);
    expect(jumpedTo().path).toBe(XML_PATH);
    expect(span(XML, jumpedTo())).toBe("select");
  });

  it("chooses between the statements of an id declared twice", async () => {
    const view = javaEditor("public interface UserMapper { User findById(Long id); int countUser(String dept); }");
    await settle();
    expect(icons(view)).toEqual(["findById", "countUser"]);
    await clickIcon(view, "countUser");
    expect(nav.navigateTo).not.toHaveBeenCalled();
    expect(nav.openPopup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "list", title: "Choose Statement of countUser (2 found)" }),
    );
  });

  it("marks the XML statements whose method exists", async () => {
    const view = xmlEditor();
    await settle();
    expect(icons(view)).toEqual(["findById", "countUser", "countUser"]);
    expect(index.interfaceFor).toHaveBeenCalledWith("com.example.mapper.UserMapper");
  });

  it("jumps from a statement to the method it binds", async () => {
    const view = xmlEditor(
      '<mapper namespace="com.example.mapper.UserMapper"><select id="findById" resultType="User">SELECT 1</select></mapper>',
    );
    await settle();
    await clickIcon(view, "findById");
    expect(jumpedTo().path).toBe(JAVA_PATH);
    expect(span(JAVA, jumpedTo())).toBe("findById");
  });

  it("is one gutter icon group, which is the column the setting hides", async () => {
    const view = javaEditor();
    await settle();
    const group = GUTTER_ICON_GROUPS.find((g) => g.id === "mybatis");
    expect(group).toBeDefined();
    // The gutter the icons live in carries the class the registry names, so
    // Settings › Editor › General › Gutter Icons reaches it.
    expect(view.dom.querySelector(`.${group!.gutterClass} .cm-openidea-mapperMarker`)).not.toBeNull();
  });

  it("draws the icon in the gutter's own monochrome", async () => {
    const view = javaEditor();
    await settle();
    // A single grey tone is what makes the shared pipeline swap it for currentColor;
    // hard-coding a colour instead would need a `_dark` asset and stay wrong in dark themes.
    const markup = view.dom.querySelector(".cm-openidea-mapperMarker")!.innerHTML;
    expect(markup).toContain("currentColor");
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("stays quiet on an interface that is no mapper", async () => {
    index.xmlFor.mockResolvedValue(null);
    const view = javaEditor("package p;\n\npublic interface Registry {\n    Object lookup(String key);\n}\n");
    await settle();
    expect(icons(view)).toEqual([]);
    expect(await intentionsOf(view, "lookup")).toEqual([]);
  });

  it("offers nothing in a mapper XML", async () => {
    const view = xmlEditor();
    await settle();
    expect(await intentionsOf(view, "findById")).toEqual([]);
  });
});

describe("generation offers", () => {
  it("offers the statement and the annotations one method is missing", async () => {
    const view = javaEditor();
    await settle();
    expect(await intentionsOf(view, "insertUser")).toEqual([
      "Generate Statement for insertUser",
      "Generate @Param Annotations",
    ]);
  });

  it("offers nothing on a method that is already bound", async () => {
    const view = javaEditor();
    await settle();
    expect(await intentionsOf(view, "findById")).toEqual([]);
  });

  it("still offers a statement when the interface has no XML", async () => {
    index.xmlFor.mockResolvedValue(null);
    const view = javaEditor();
    await settle();
    expect(await intentionsOf(view, "findById")).toEqual(["Generate Statement for findById"]);
  });

  it("runs the action on the document the caret is in", async () => {
    const view = javaEditor();
    await settle();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("insertUser") } });
    await settle();
    const [statement, params] = contributedIntentions(view);
    await statement!.run();
    await params!.run();
    expect(nav.statement).toHaveBeenCalledWith(view, JAVA_PATH, "insertUser");
    expect(nav.params).toHaveBeenCalledWith(view, JAVA_PATH, "insertUser");
  });
});
