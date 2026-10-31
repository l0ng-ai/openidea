import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { IpcError, commands } from "@/platform/ipc";
import { imageName, imageTarget, markdownImages, relativeImagePath, saveImage } from "./markdownImages";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function view(path = "/project/docs/readme.md") {
  const editor = new EditorView({
    state: EditorState.create({
      doc: "before after",
      selection: { anchor: 7 },
      extensions: [history(), markdownImages({ path, folder: "assets", pattern: "image-{timestamp}" })],
    }),
    parent: document.body,
  });
  views.push(editor);
  return editor;
}
function paste(editor: EditorView, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, getData: () => "plain text" } });
  editor.contentDOM.dispatchEvent(event);
  return event;
}

describe("Markdown images", () => {
  it("retries exclusive name collisions without overwriting", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new IpcError({ kind: "alreadyExists", message: "exists" }))
      .mockRejectedValueOnce(new IpcError({ kind: "alreadyExists", message: "exists" }))
      .mockResolvedValue(null);
    expect(await saveImage("/p/docs/readme.md", "assets", "photo.png", [0, 255], create)).toBe(
      "![](assets/photo-2.png)",
    );
    expect(create.mock.calls.map(([path]) => path)).toEqual([
      "/p/docs/assets/photo.png",
      "/p/docs/assets/photo-1.png",
      "/p/docs/assets/photo-2.png",
    ]);
  });
  it("does not retry permission failures", async () => {
    const create = vi.fn().mockRejectedValue(new IpcError({ kind: "permissionDenied", message: "denied" }));
    await expect(saveImage("/p/a.md", "assets", "a.png", [], create)).rejects.toThrow("denied");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("computes nested paths and encodes spaces and Markdown delimiters", () => {
    const target = imageTarget("/p/docs/nested/read me.md", "../../my assets", "a (1)#图.png");
    expect(target).toBe("/p/my assets/a (1)#图.png");
    expect(relativeImagePath("/p/docs/nested/read me.md", target)).toBe(
      "../../my%20assets/a%20%281%29%23%E5%9B%BE.png",
    );
    expect(relativeImagePath("C:\\p\\docs\\readme.md", "C:\\p\\docs\\assets\\a b.png")).toBe("assets/a%20b.png");
    expect(imageTarget("/p/a.md", "assets", "a.png")).toBe("/p/assets/a.png");
    expect(() => imageTarget("/p/a.md", "/absolute", "a.png")).toThrow();
  });
  it("uses timestamps for clipboard images and preserves source names", () => {
    expect(imageName("", "image/png", "image-{timestamp}", new Date(2026, 9, 31, 0, 15))).toBe(
      "image-20261031-001500.png",
    );
    expect(imageName("photo.jpg", "image/jpeg", "anything")).toBe("photo.jpg");
  });
  it("leaves non-Markdown image paste and text paste untouched", () => {
    expect(markdownImages({ path: "/p/code.ts", folder: "assets", pattern: "image" })).toEqual([]);
    const editor = view();
    const create = vi.spyOn(commands, "fsCreateFileBytes");
    paste(editor, []);
    expect(editor.state.doc.toString()).toBe("before plain textafter");
    paste(view("/p/code.ts"), [new File(["png"], "a.png", { type: "image/png" })]);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([true, false])("distinguishes a source image.png from raw clipboard data (file: %s)", async (hasFile) => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (e: { data: { data: number[] } }) => void;
        terminate() {}
        postMessage() {
          queueMicrotask(() => this.onmessage?.({ data: { data: [137, 80, 78, 71] } }));
        }
      },
    );
    vi.spyOn(commands, "clipboardFileList").mockResolvedValue({
      status: "ok",
      data: hasFile ? ["/source/image.png"] : [],
    });
    const create = vi.spyOn(commands, "fsCreateFileBytes").mockResolvedValue({ status: "ok", data: null });
    const editor = view();
    paste(editor, [new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatch(hasFile ? /assets\/image\.png$/ : /assets\/image-\d{8}-\d{6}\.png$/);
  });

  it("inserts a paste as one isolated undo step and tracks edits during saving", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (e: { data: { data: number[] } }) => void;
        terminate() {}
        postMessage() {
          queueMicrotask(() => this.onmessage?.({ data: { data: [137, 80, 78, 71] } }));
        }
      },
    );
    let finish!: (value: { status: "ok"; data: null }) => void;
    vi.spyOn(commands, "fsCreateFileBytes").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const editor = view();
    expect(paste(editor, [new File(["png"], "a b.png", { type: "image/png" })]).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    editor.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
    finish({ status: "ok", data: null });
    await vi.waitFor(() => expect(editor.state.doc.toString()).toBe("Xbefore ![](assets/a%20b.png)after"));
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("Xbefore after");
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("before after");
  });
});
