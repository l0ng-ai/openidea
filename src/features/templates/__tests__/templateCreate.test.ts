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
  rollback: vi.fn(),
}));

const view = vi.hoisted(() => ({
  state: { doc: { length: 0, toString: () => "" }, selection: { main: { head: 0 } } },
  dispatch: vi.fn(),
  focus: vi.fn(),
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

vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  editorsFor: (path: string) => (/\.py$/.test(path) ? [{ view }] : []),
  activeEditor: () => null,
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
    return Promise.resolve(
      /\.ipynb$/.test(path)
        ? { input: { kind: "notebook", key: `notebook:${path}` }, admit: () => {}, rollback: calls.rollback }
        : null,
    );
  },
}));

const NOTEBOOK_BODY = `{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": ["# $NAME$"]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`;

const notebook: FileTemplate = {
  id: "user.jupyter",
  name: "Jupyter Notebook",
  icon: "file-jupyter",
  extension: "ipynb",
  nameStyle: "asis",
  kinds: [{ id: "notebook", label: "Notebook", body: NOTEBOOK_BODY }],
};

afterEach(() => {
  files.clear();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

describe("createFromTemplate", () => {
  it("writes the rendered body before a notebook editor takes the file", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    const path = await createFromTemplate(notebook, notebook.kinds[0]!, "/p", "analysis");

    expect(path).toBe("/p/analysis.ipynb");
    expect(files.get(path)).toBe(NOTEBOOK_BODY.replace("$NAME$", "analysis"));
    expect(JSON.parse(files.get(path)!)).toMatchObject({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["# analysis"] }],
    });
    expect(calls.empty).not.toHaveBeenCalled();
    // The kind owns the document, so there is no "could not insert" warning.
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.resolve).toHaveBeenCalledWith(path);
    // The probe's acquisitions (the notebook backend session) are released.
    expect(calls.rollback).toHaveBeenCalledTimes(1);
    expect(calls.openFile).toHaveBeenCalledWith(path);
    // The body is on disk before the editor reads it.
    expect(calls.bytes.mock.invocationCallOrder[0]!).toBeLessThan(calls.openFile.mock.invocationCallOrder[0]!);
  });

  it("inserts a text template into the editor view, caret at $END$", async () => {
    const py: FileTemplate = {
      ...notebook,
      id: "user.py",
      extension: "py",
      kinds: [{ id: "script", label: "Script", body: "print(1)\n$END$" }],
    };
    const path = await createFromTemplate(py, py.kinds[0]!, "/p", "main");

    expect(calls.bytes).not.toHaveBeenCalled();
    expect(calls.empty).toHaveBeenCalledWith(path);
    expect(view.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { from: 0, insert: "print(1)\n" }, userEvent: "input" }),
    );
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("creates an empty file when the template renders nothing", async () => {
    const empty: FileTemplate = { ...notebook, kinds: [{ id: "blank", label: "Empty", body: "" }] };
    const path = await createFromTemplate(empty, empty.kinds[0]!, "/p", "blank");

    expect(calls.empty).toHaveBeenCalledWith(path);
    expect(files.get(path)).toBe("");
    expect(calls.bytes).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("renders the notebook body a text template would have got", () => {
    const { text } = renderFileTemplate(NOTEBOOK_BODY, { name: "report", fileName: "report.ipynb" });
    expect(JSON.parse(text)).toMatchObject({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["# report"] }],
    });
  });
});

describe("built-in Jupyter Notebook", () => {
  const builtin = BUILTIN_FILE_TEMPLATES.find((t) => t.id === "jupyter")!;

  it("writes the titled notebook body before the notebook editor takes the file", async () => {
    const titled = builtin.kinds.find((k) => k.id === "titled")!;
    const path = await createFromTemplate(builtin, titled, "/p", "analysis");

    expect(path).toBe("/p/analysis.ipynb");
    expect(JSON.parse(files.get(path)!)).toMatchObject({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["# analysis"] }],
    });
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("is listed in the New menu with its icon, without duplicating entries", () => {
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
