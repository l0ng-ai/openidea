import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import { clipboardFilesExtension, pasteEditorClipboard } from "./clipboard";
import { markdownImages } from "./markdownImages";

const views: EditorView[] = [];
beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const route of ["event", "menu"]) {
  it.each([
    { name: "text present", text: "plain", paths: ["/stale"], expected: "plain", calls: 0 },
    { name: "files plus list", text: "", paths: ["/a b", "/中文"], expected: "/a b\n/中文", calls: 1 },
    { name: "files without list", text: "", paths: [], expected: "", calls: 1 },
    { name: "backend error", text: "", paths: null, expected: "", calls: 1 },
  ])(`${route}: $name`, async ({ text, paths, expected, calls }) => {
    const list = vi.spyOn(commands, "clipboardFileList");
    if (paths) list.mockResolvedValue({ status: "ok", data: paths });
    else list.mockRejectedValue(new Error("busy"));
    const view = new EditorView({ extensions: [clipboardFilesExtension], parent: document.body });
    views.push(view);
    if (route === "event") {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { getData: () => text, files: [], types: ["Files"] },
      });
      view.contentDOM.dispatchEvent(event);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
      await pasteEditorClipboard(view);
    }
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(expected));
    expect(list).toHaveBeenCalledTimes(calls);
  });
}

it.each([true, false])("keeps copied PNG and screenshot Markdown image handling (file: %s)", async (hasFile) => {
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
  const view = new EditorView({
    extensions: [
      clipboardFilesExtension,
      markdownImages({ path: "/p/a.md", folder: "assets", pattern: "image-{timestamp}" }),
    ],
    parent: document.body,
  });
  views.push(view);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "", files: [new File(["png"], "image.png", { type: "image/png" })], types: ["Files"] },
  });
  view.contentDOM.dispatchEvent(event);
  await vi.waitFor(() => expect(view.state.doc.toString()).toMatch(/^!\[\]\(assets\/image.*\.png\)$/));
  expect(create.mock.calls[0]![0]).toMatch(hasFile ? /assets\/image\.png$/ : /assets\/image-\d{8}-\d{6}\.png$/);
});

it("does not insert into a read-only editor", async () => {
  const list = vi.spyOn(commands, "clipboardFileList");
  const view = new EditorView({ extensions: [clipboardFilesExtension, EditorState.readOnly.of(true)] });
  views.push(view);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "text" } });
  await pasteEditorClipboard(view);
  expect(view.state.doc.toString()).toBe("");
  expect(list).not.toHaveBeenCalled();
});
