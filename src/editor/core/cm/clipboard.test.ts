import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { clipboardDocumentPath, clipboardFilesExtension, pasteEditorClipboard, pasteEditorText } from "./clipboard";
import { markdownImages } from "./markdownImages";

vi.mock("@/platform/remote", () => ({ isRemoteWindow: vi.fn(() => false) }));

const views: EditorView[] = [];
beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(document, "queryCommandSupported", { configurable: true, value: vi.fn(() => false) });
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const route of ["event", "menu", "menu unsupported", "menu rejected"]) {
  it.each([
    { name: "file", paths: ["/p/docs/file.txt"], expected: "[](file.txt)" },
    { name: "folder", paths: ["/p/docs/folder"], expected: "[](folder)" },
    { name: "several", paths: ["/p/docs/a.txt", "/p/folder"], expected: "[](a.txt)\n[](../folder)" },
    {
      name: "spaces, Chinese, and delimiters",
      paths: ["/p/docs/中文/a (1)#!'*.txt"],
      expected: "[](%E4%B8%AD%E6%96%87/a%20%281%29%23%21%27%2A.txt)",
    },
    { name: "parent relative", paths: ["/p/file.txt"], expected: "[](../file.txt)" },
    {
      name: "Windows separators",
      path: "C:\\p\\docs\\a.md",
      paths: ["C:\\p\\folder\\a b.txt"],
      expected: "[](../folder/a%20b.txt)",
    },
    { name: "no document path", path: "", paths: ["/p/file.txt"], expected: "/p/file.txt" },
    { name: "non-Markdown", path: "/p/a.ts", paths: ["/p/file.txt"], expected: "/p/file.txt" },
    {
      name: "remote window with client file paths",
      remote: true,
      path: "/home/dev/a.md",
      paths: ["/Users/me/file.txt", "/Users/me/中文 文件夹"],
      expected: "/Users/me/file.txt\n/Users/me/中文 文件夹",
    },
    {
      name: "remote window with matching text flavor",
      remote: true,
      path: "/home/dev/a.md",
      text: "C:\\Users\\me\\file.txt",
      paths: ["C:/Users/me/file.txt"],
      expected: "C:\\Users\\me\\file.txt",
    },
    { name: "alternate extension", path: "/p/docs/a.MDX", paths: ["/p/docs/file"], expected: "[](file)" },
    { name: "empty list", paths: [], expected: "" },
    { name: "text path", text: "/p/file.txt", paths: ["/stale"], expected: "/p/file.txt" },
    { name: "plain text", text: "plain text 你好", paths: [], expected: "plain text 你好" },
    {
      name: "file list with matching text flavor",
      text: "C:\\p\\a.txt\r\nC:\\p\\folder",
      path: "C:/p/docs/a.md",
      paths: ["C:/p/a.txt", "C:/p/folder"],
      expected: "[](../a.txt)\n[](../folder)",
    },
  ])(`${route}: Markdown $name`, async ({ path = "/p/docs/a.md", paths, text = "", expected, remote = false }) => {
    vi.mocked(isRemoteWindow).mockReturnValue(remote);
    const list = vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: paths });
    const view = new EditorView({
      extensions: [clipboardDocumentPath.of(path), clipboardFilesExtension],
      parent: document.body,
    });
    views.push(view);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text, files: [], types: ["Files"] },
    });
    if (route === "event") {
      view.contentDOM.dispatchEvent(event);
    } else {
      if (route === "menu") {
        vi.mocked(document.queryCommandSupported).mockReturnValue(true);
        vi.mocked(document.execCommand).mockImplementation(() => {
          view.contentDOM.dispatchEvent(event);
          return true;
        });
      }
      if (route === "menu rejected") vi.mocked(document.queryCommandSupported).mockReturnValue(true);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
      await pasteEditorClipboard(view);
    }
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(expected));
    expect(list).toHaveBeenCalledTimes(remote && text ? 0 : 1);
    if (route === "menu rejected" && /\.(md|mdx)$/i.test(path)) {
      expect(document.execCommand).toHaveBeenCalledExactlyOnceWith("paste");
    }
  });

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
      if (route === "menu rejected") vi.mocked(document.queryCommandSupported).mockReturnValue(true);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
      await pasteEditorClipboard(view);
    }
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(expected));
    expect(list).toHaveBeenCalledTimes(calls);
  });
}

it("does not fall back while a successful native paste is still pending", async () => {
  const readText = vi.fn(async () => "fallback");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
  vi.mocked(document.queryCommandSupported).mockReturnValue(true);
  vi.mocked(document.execCommand).mockReturnValue(true);
  const view = new EditorView({
    extensions: [clipboardDocumentPath.of("/p/a.md"), clipboardFilesExtension],
    parent: document.body,
  });
  views.push(view);

  await pasteEditorClipboard(view);
  expect(view.state.doc.toString()).toBe("");
  expect(readText).not.toHaveBeenCalled();

  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "native text", files: [], types: ["text/plain"] },
  });
  view.contentDOM.dispatchEvent(event);
  expect(view.state.doc.toString()).toBe("native text");
});

it.each([
  ["event", true],
  ["event", false],
  ["menu", true],
  ["menu", false],
])("%s: keeps copied PNG and screenshot Markdown image handling (file: %s)", async (route, hasFile) => {
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
      clipboardDocumentPath.of("/p/a.md"),
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
  if (route === "menu") {
    vi.mocked(document.queryCommandSupported).mockReturnValue(true);
    vi.mocked(document.execCommand).mockImplementation(() => {
      view.contentDOM.dispatchEvent(event);
      return true;
    });
    await pasteEditorClipboard(view);
    expect(document.execCommand).toHaveBeenCalledWith("paste");
  } else view.contentDOM.dispatchEvent(event);
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

describe("multi-caret paste", () => {
  const view = (doc: string, ranges: Array<[number, number]>) => {
    const v = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(
          ranges.length > 1
            ? ranges.map(([from, to]) => EditorSelection.range(from, to))
            : [EditorSelection.cursor(ranges[0]![0])],
        ),
        extensions: EditorState.allowMultipleSelections.of(true),
      }),
      parent: document.body,
    });
    views.push(v);
    return v;
  };

  it("pastes one line per caret when the counts match", () => {
    const line = 'icjsdiocjosid "" cdscsd';
    // A caret inside each pair of quotes (index 15), as in the issue.
    const v = view(
      Array(7).fill(line).join("\n"),
      Array.from({ length: 7 }, (_, i) => {
        const from = i * (line.length + 1) + 15;
        return [from, from] as [number, number];
      }),
    );
    pasteEditorText(v, "s\nd\nd\ns\nd\nd\ne");
    expect(v.state.doc.toString()).toBe(
      Array.from({ length: 7 }, (_, i) => `icjsdiocjosid "${"sddsdde"[i]}" cdscsd`).join("\n"),
    );
  });

  it("keeps a trailing newline as the last caret's empty line (issue #1828)", () => {
    const line = 'icjsdiocjosid "" cdscsd';
    // Seven carets, six copied lines with a trailing newline: split keeps the
    // empty seventh segment, so the last caret gets "" as the issue expects.
    const v = view(
      Array(7).fill(line).join("\n"),
      Array.from({ length: 7 }, (_, i) => {
        const from = i * (line.length + 1) + 15;
        return [from, from] as [number, number];
      }),
    );
    pasteEditorText(v, "s\nd\nd\ns\nd\nd\n");
    expect(v.state.doc.toString()).toBe(
      Array.from({ length: 7 }, (_, i) => `icjsdiocjosid "${"sddsdd"[i] ?? ""}" cdscsd`).join("\n"),
    );
  });

  it("pastes the whole text at every caret when the counts differ", () => {
    const v = view("a b", [
      [1, 1],
      [3, 3],
    ]);
    pasteEditorText(v, "x\ny\nz");
    expect(v.state.doc.toString()).toBe("ax\ny\nz bx\ny\nz");
  });

  it("pastes the whole text at a single caret", () => {
    const v = view("a", [[1, 1]]);
    pasteEditorText(v, "x\ny");
    expect(v.state.doc.toString()).toBe("ax\ny");
  });
});
