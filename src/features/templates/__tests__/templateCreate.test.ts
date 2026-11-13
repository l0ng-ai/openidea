import { afterEach, describe, expect, it, vi } from "vitest";
import { createFromTemplate } from "../files/create";
import { renderFileTemplate, type FileTemplate } from "../files/model";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";
import { activate as activateTemplates } from "../index";
import { menuGroupItems } from "@/workbench/contributions";
import { useProject } from "@/platform/project";

const files = vi.hoisted(() => new Map<string, string>());
const calls = vi.hoisted(() => ({
  bytes: vi.fn(),
  empty: vi.fn(),
  openFile: vi.fn(),
  notify: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  call: (result: unknown) => result,
  commands: {
    fsCreateFileBytes: (path: string, data: number[]) => {
      calls.bytes(path);
      files.set(path, new TextDecoder().decode(new Uint8Array(data)));
      return Promise.resolve(null);
    },
    fsCreateFile: (path: string) => {
      calls.empty(path);
      files.set(path, "");
      return Promise.resolve(null);
    },
    fsReadDir: () => Promise.resolve([]),
  },
}));

vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => true),
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openFile: async (path: string) => void calls.openFile(path),
    saveAll: async () => {},
  }),
  maybeEditorService: () => ({ activePath: () => null }),
  notifications: () => ({ notify: calls.notify }),
  resolveFileEditor: (path: string) => {
    calls.resolve(path);
    // A notebook: its own editor kind, no CodeMirror view.
    return Promise.resolve(/\.ipynb$/.test(path) ? { input: { kind: "notebook", key: `notebook:${path}` } } : null);
  },
}));

const notebook: FileTemplate = BUILTIN_FILE_TEMPLATES.find((t) => t.id === "jupyter")!;

afterEach(() => {
  files.clear();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

describe("createFromTemplate", () => {
  it("writes the built-in notebook body before the notebook editor takes the file", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    const titled = notebook.kinds.find((k) => k.id === "titled")!;
    const path = await createFromTemplate(notebook, titled, "/p", "analysis");

    expect(path).toBe("/p/analysis.ipynb");
    const { text } = renderFileTemplate(titled.body, { name: "analysis", fileName: "analysis.ipynb" });
    expect(files.get(path)).toBe(text);
    expect(JSON.parse(files.get(path)!)).toMatchObject({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["# analysis"] }],
    });
    expect(calls.empty).not.toHaveBeenCalled();
    // The kind owns the document, so there is no "could not insert" warning.
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.resolve).toHaveBeenCalledWith(path);
    expect(calls.openFile).toHaveBeenCalledWith(path);
    // Resolution happens before opening, so the body is in place when it reads.
    expect(calls.resolve.mock.invocationCallOrder[0]!).toBeLessThan(calls.openFile.mock.invocationCallOrder[0]!);
  });

  it("creates an empty file when the template renders nothing", async () => {
    const empty: FileTemplate = { ...notebook, kinds: [{ id: "blank", label: "Empty", body: "" }] };
    const path = await createFromTemplate(empty, empty.kinds[0]!, "/p", "blank");

    expect(calls.empty).toHaveBeenCalledWith(path);
    expect(files.get(path)).toBe("");
    expect(calls.bytes).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("renders the built-in notebook body a text template would have got", () => {
    const titled = notebook.kinds.find((k) => k.id === "titled")!;
    const { text } = renderFileTemplate(titled.body, { name: "report", fileName: "report.ipynb" });
    expect(JSON.parse(text)).toMatchObject({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["# report"] }],
    });
  });
});

describe("New menu", () => {
  it("lists Jupyter Notebook with its icon, without duplicating entries", () => {
    const dispose = activateTemplates();
    try {
      const items = menuGroupItems("new", { paths: ["/p"] });
      const actions = items.filter((i) => i.kind === "action");
      const row = actions.find((i) => i.kind === "action" && i.action === "templates.new.jupyter");
      expect(row).toMatchObject({ label: "Jupyter Notebook", icon: "file-jupyter" });
      const ids = actions.map((i) => i.action);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      dispose();
    }
  });
});
