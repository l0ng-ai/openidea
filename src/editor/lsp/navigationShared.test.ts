import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { resetNavigationModifier } from "@/platform/navigationModifier";

type GotoResult = Awaited<ReturnType<typeof commands.lspGoto>>;
const { lspGoto, lspHover, lspDocumentLinks } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  lspHover: vi.fn<typeof commands.lspHover>(async () => ({ status: "ok", data: null })),
  lspDocumentLinks: vi.fn<typeof commands.lspDocumentLinks>(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto, lspHover, lspDocumentLinks } };
});

const { gotoTargets, navigationExtension } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { quickDefinition } = await import("./hover");
const { invalidateConfigurationNavigation } = await import("./configurationNavigation");
const { closePopup } = await import("./popupStore");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async (_path: string, _opts: unknown) => {});
provideEditorService({ openFile } as never);

const loc = (path: string): Location => ({
  path,
  uri: null,
  range: { start: { line: 1, col: 2 }, end: { line: 1, col: 5 } },
});
const ok = (data: Location[]): GotoResult => ({ status: "ok", data });

/** A request the test answers when it wants to, in any order. */
function deferred() {
  let resolve!: (r: GotoResult) => void;
  lspGoto.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (r: GotoResult) => resolve(r);
}

// `word` is where the hover probe asks (the word's start), `inside` another position in that word.
const cases = [
  { language: "java", path: "/p/Main.java", text: "service.run(); other.call();", word: 8, inside: 10, other: 21 },
  { language: "typescript", path: "/p/main.ts", text: "service.run(); other.call();", word: 8, inside: 10, other: 21 },
  {
    language: "yaml",
    path: "/p/app.yaml",
    text: "server:\n  port: 8080\n  host: x\n",
    word: 10,
    inside: 12,
    other: 23,
  },
];

let view: EditorView;
function editor(c: (typeof cases)[number]) {
  view = new EditorView({
    state: EditorState.create({
      doc: c.text,
      extensions: [
        lspDoc.of({ doc: 1, path: c.path, language: c.language, uiMode: c.language, readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
  return view;
}

function hover(pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
}

function click(pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }));
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  resetNavigationModifier();
  invalidateConfigurationNavigation();
  lspGoto.mockReset().mockResolvedValue(ok([loc("/p/Target.java")]));
  lspHover.mockClear();
  openFile.mockClear();
});
afterEach(() => {
  view.destroy();
  closePopup();
  document.body.replaceChildren();
  resetNavigationModifier();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(cases)("shared definition requests in $language", (c) => {
  it("lets a click reuse the hover probe's request for the same word", async () => {
    editor(c);
    hover(c.word);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")).not.toBeNull());
    click(c.inside);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it("lets a click share a hover probe that is still running", async () => {
    editor(c);
    const finish = deferred();
    hover(c.word);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    click(c.inside);
    await settle();
    finish(ok([loc("/p/Target.java")]));
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it("sends one request for rapid clicks on one word and navigates once", async () => {
    editor(c);
    const finish = deferred();
    const clicks = [
      gotoTargets(view, "definition", c.inside),
      gotoTargets(view, "definition", c.word),
      gotoTargets(view, "definition", c.inside),
    ];
    await settle();
    finish(ok([loc("/p/Target.java")]));
    await Promise.all(clicks);
    expect(lspGoto).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("navigates for the latest click even when an earlier one answers later", async () => {
    editor(c);
    const first = deferred();
    const second = deferred();
    const earlier = gotoTargets(view, "definition", c.inside);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    const later = gotoTargets(view, "definition", c.other);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledTimes(2));
    second(ok([loc("/p/Later.java")]));
    await later;
    first(ok([loc("/p/Earlier.java")]));
    await earlier;
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/Later.java"]);
  });

  it("does not show an older click's hint after a newer one", async () => {
    editor(c);
    const first = deferred();
    const earlier = gotoTargets(view, "definition", c.inside);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    await gotoTargets(view, "definition", c.other);
    first(ok([]));
    await earlier;
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
  });

  it("does not show progress for an older request after the newer gesture finishes", async () => {
    editor(c);
    const finish = deferred();
    vi.useFakeTimers();
    const earlier = gotoTargets(view, "definition", c.inside);
    await vi.advanceTimersByTimeAsync(0);
    await gotoTargets(view, "definition", c.other);
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
    finish(ok([loc("/p/Stale.java")]));
    await earlier;
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("asks again after an edit between hover and click", async () => {
    editor(c);
    hover(c.word);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")).not.toBeNull());
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
    await gotoTargets(view, "definition", c.inside);
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("does not navigate when the document changes while a request is running", async () => {
    editor(c);
    const finish = deferred();
    const pending = gotoTargets(view, "definition", c.inside);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
    finish(ok([loc("/p/Stale.java")]));
    await pending;
    expect(openFile).not.toHaveBeenCalled();
  });

  it("does not retry an older gesture superseded during its edit backoff", async () => {
    editor(c);
    vi.useFakeTimers();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
    lspGoto.mockResolvedValueOnce(ok([]));
    const earlier = gotoTargets(view, "definition", c.inside);
    await vi.advanceTimersByTimeAsync(0);
    await gotoTargets(view, "definition", c.other);
    await vi.advanceTimersByTimeAsync(250);
    await earlier;
    expect(lspGoto).toHaveBeenCalledTimes(2);
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("does not keep an empty answer", async () => {
    editor(c);
    lspGoto.mockResolvedValueOnce(ok([]));
    await gotoTargets(view, "definition", c.inside);
    await gotoTargets(view, "definition", c.inside);
    expect(lspGoto).toHaveBeenCalledTimes(2);
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("does not keep a failed request", async () => {
    editor(c);
    lspGoto.mockResolvedValueOnce({ status: "error", error: { kind: "protocol", message: "boom" } });
    await gotoTargets(view, "definition", c.inside);
    await gotoTargets(view, "definition", c.inside);
    expect(lspGoto).toHaveBeenCalledTimes(2);
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("re-probes a slow word through the running request", async () => {
    editor(c);
    const finish = deferred();
    vi.useFakeTimers();
    hover(c.word);
    await vi.advanceTimersByTimeAsync(3001);
    hover(c.word);
    await vi.advanceTimersByTimeAsync(0);
    expect(lspGoto).toHaveBeenCalledOnce();
    vi.useRealTimers();
    finish(ok([loc("/p/Target.java")]));
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")).not.toBeNull());
    expect(lspGoto).toHaveBeenCalledOnce();
  });
});

describe("shared request keys", () => {
  const java = cases[0]!;

  it("lets Quick Definition reuse the hover probe's request", async () => {
    editor(java);
    hover(java.word);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-link")).not.toBeNull());
    view.dispatch({ selection: { anchor: java.inside } });
    await quickDefinition(view);
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it("keeps navigation kinds apart", async () => {
    editor(java);
    await gotoTargets(view, "definition", java.inside);
    await gotoTargets(view, "typeDefinition", java.inside);
    await gotoTargets(view, "typeDefinition", java.word);
    expect(lspGoto.mock.calls.map(([, , kind]) => kind)).toEqual(["definition", "typeDefinition"]);
  });

  it("asks a click right after a word's last character from inside the word", async () => {
    editor(java);
    await gotoTargets(view, "definition", java.word + 3);
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: java.word + 2 }, "definition");
  });

  it("asks positions outside any word directly", async () => {
    editor(java);
    await gotoTargets(view, "definition", 14);
    await gotoTargets(view, "definition", 14);
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });
});
