import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, _setActiveEditor, type TextEditorHandle } from "@/editor/api";
import { commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { canExtractImages, embeddedImages, extractImages } from "./extractImages";

vi.mock("@/workbench/messages", () => ({ confirm: vi.fn() }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: vi.fn(() => ({ notify: vi.fn() })),
}));

const base64 = { png: "iVBORw0KGgoA/w==", jpeg: "/9j/AAEC/9k=" };
const markdown = `[![alt](<data:image/png;base64,${base64.png}> "caption")](https://example.com)`;
const html = `<img width="40%" alt="literal src=x" data-src="other" SRC='data:image/jpeg;base64,${base64.jpeg}' />`;
const source = [markdown, html].join("\n\n");
const path = "/p/my paper.md";
let editor: TextEditorHandle | undefined;

function open(text = source) {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.mocked(confirm).mockResolvedValue(true);
  const notify = vi.fn();
  vi.mocked(notifications).mockReturnValue({ notify });
  const view = new EditorView({ doc: text, extensions: history(), parent: document.body });
  editor = { view, tabId: "t", ctx: { doc: 1, path, language: "markdown", uiMode: null, readOnly: false } };
  _addEditor(editor);
  _setActiveEditor(editor);
  const absent = { status: "error" as const, error: { kind: "notFound" as const, message: "Missing" } };
  const exists = vi.spyOn(commands, "fsEntryKind").mockResolvedValue(absent);
  const createDir = vi.spyOn(commands, "fsCreateDir").mockResolvedValue({ status: "ok", data: null });
  const create = vi.spyOn(commands, "fsCreateFileBytes").mockResolvedValue({ status: "ok", data: null });
  return { view, exists, absent, create, createDir, notify };
}

afterEach(() => {
  if (editor) {
    _removeEditor(editor);
    editor.view.destroy();
    editor = undefined;
  }
  _setActiveEditor(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(confirm).mockClear();
});

describe("Extract Embedded Images", () => {
  it("finds only inline Markdown and real quoted HTML image destinations", async () => {
    const examples = [
      source,
      `\`${markdown}\``,
      "```md\n" + html + "\n" + markdown + "\n```",
      "<!-- " + html + " -->",
      "<pre>" + html + "</pre>",
      "before <textarea>" + html + "</textarea> after",
      "before <textarea>" + html + "\n\n</textarea> after",
      "<code-block>" + html + "</code-block>",
      "<script>var example = '<img src=\"data:image/png;base64,AP8=\">'</script>",
      '<img data-src="data:image/png;base64,AP8=" alt=\'src="data:image/png;base64,AP8="\'>',
      '<img src="https://example.com/img.png" src="data:image/png;base64,AP8=">',
      "![](data:image/png;base64,abcde)",
      "![](data:image/html;base64,PHNjcmlwdD4=)",
      "![](data:image/svg+xml;base64,PHN2Zz4=)",
      `![](data:image/png;base64,${base64.jpeg})`,
      "![](https://example.com/image.png)",
      "[ordinary link](data:image/png;base64,AA==)",
    ].join("\n\n");
    const result = await embeddedImages(examples);
    expect(result.invalid).toBe(4);
    expect(
      result.images.map(({ from, to, mime, base64 }) => [
        examples.slice(from, to),
        mime,
        [...atob(base64)].map((c) => c.charCodeAt(0)),
      ]),
    ).toEqual([
      [`data:image/png;base64,${base64.png}`, "image/png", [137, 80, 78, 71, 13, 10, 26, 10, 0, 255]],
      [`data:image/jpeg;base64,${base64.jpeg}`, "image/jpeg", [255, 216, 255, 0, 1, 2, 255, 217]],
      [`data:image/jpeg;base64,${base64.jpeg}`, "image/jpeg", [255, 216, 255, 0, 1, 2, 255, 217]],
    ]);
  });

  it("previews a fresh folder, writes original bytes and replaces only destinations in one undo", async () => {
    const { view, exists, createDir, create, notify } = open();
    exists.mockResolvedValueOnce({ status: "ok", data: "dir" });
    vi.mocked(confirm).mockImplementation(async () => {
      expect(createDir).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(source);
      return true;
    });
    await extractImages();

    expect(exists.mock.calls).toEqual([["/p/my paper-images"], ["/p/my paper-images-2"]]);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      title: "Extract Embedded Images…",
      message: "Extract 2 embedded images to my paper-images-2/ and replace their links in this document?",
      ok: "Extract",
    });
    expect(createDir).toHaveBeenCalledExactlyOnceWith("/p/my paper-images-2");
    expect(create.mock.calls).toEqual([
      ["/p/my paper-images-2/image-001.png", base64.png],
      ["/p/my paper-images-2/image-002.jpg", base64.jpeg],
    ]);
    expect(view.state.doc.toString()).toBe(
      '[![alt](<my%20paper-images-2/image-001.png> "caption")](https://example.com)\n\n' +
        '<img width="40%" alt="literal src=x" data-src="other" SRC=\'my%20paper-images-2/image-002.jpg\' />',
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Extracted 2 embedded images" }));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    expect(undo(view)).toBe(false);
  });

  it("leaves a nested image in alt text and unsupported types unchanged", async () => {
    const mixed = `![nested ![alt](data:image/png;base64,${base64.png})](data:image/jpeg;base64,${base64.jpeg})

![](data:image/html;base64,PHNjcmlwdD4=)`;
    const { view, create } = open(mixed);
    await extractImages();
    expect(create.mock.calls).toEqual([["/p/my paper-images/image-001.jpg", base64.jpeg]]);
    expect(view.state.doc.toString()).toBe(
      mixed.replace(`data:image/jpeg;base64,${base64.jpeg}`, "my%20paper-images/image-001.jpg"),
    );
  });

  it("avoids writes when confirmation is declined", async () => {
    const { view, createDir, create } = open();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await extractImages();
    expect(createDir).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps links intact on a failed write and reports acknowledged output", async () => {
    const { view, create, notify } = open();
    create
      .mockResolvedValueOnce({ status: "ok", data: null })
      .mockResolvedValueOnce({ status: "error", error: { kind: "io", message: "Out of disk space" } });
    await extractImages();
    expect(create).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe(source);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        body: "Out of disk space No image links were changed. 1 image files were written to my paper-images/ before the operation stopped.",
      }),
    );
  });

  it.each(["edited", "closed"] as const)("leaves the document untouched if it is %s during a write", async (event) => {
    const { view, create, notify } = open();
    create.mockImplementationOnce(async () => {
      if (event === "edited") view.dispatch({ changes: { from: 0, insert: "edit " } });
      else _removeEditor(editor!);
      return { status: "ok", data: null };
    });
    await extractImages();
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe((event === "edited" ? "edit " : "") + source);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not extract embedded images" }));
  });

  it("disables extraction for a read-only editor", () => {
    const { view } = open();
    view.setState(EditorState.create({ doc: source, extensions: EditorState.readOnly.of(true) }));
    expect(canExtractImages()).toBe(false);
  });
});
