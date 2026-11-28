import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { contributedIntentions, editorContributions } from "@/editor/api";
import { lspDoc } from "@/editor/lsp/lsp";
import { getAction } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { IDEA_ACTIONS } from "@/platform/ideaActions";
import { bindingsFor } from "@/platform/keymap";
import { useRemote } from "@/platform/remote";
import { notificationServiceImpl } from "@/workbench/notificationStore";
import { provideNotificationService, useProjectViewRoots, type NotificationService } from "@/workbench/contributions";
import {
  chooserRows,
  pushRecent,
  scratchContent,
  scratchFileName,
  scratchLanguageForSelection,
  scratchLanguages,
  type ScratchLanguage,
} from "../model";
import {
  createScratch,
  createScratchFromSelection,
  setScratchBackend,
  tauriScratchBackend,
  type ScratchBackend,
} from "../scratches";
import { useScratch } from "../store";
import { ScratchChooserHost } from "../ScratchChooser";
import { activate, newScratchBuffer, scratchFromSelectionIntentions } from "..";

const LANGS: ScratchLanguage[] = scratchLanguages([
  {
    id: "java",
    name: "Java",
    extensions: ["java"],
    scratchTemplate: "class Scratch {\n    public static void main(String[] args) {\n        $END$\n    }\n}\n",
  },
  { id: "python", name: "Python", extensions: ["py", "pyi"] },
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs"] },
  { id: "plaintext", name: "Plain Text", extensions: ["txt"] },
  { id: "dockerfile", name: "Dockerfile", extensions: [] },
]);

const SELECTION_LANGS = scratchLanguages([
  { id: "plaintext", name: "Plain Text", extensions: ["txt"] },
  { id: "markdown", name: "Markdown", extensions: ["md", "markdown"] },
  { id: "json", name: "JSON", extensions: ["json", "jsonl", "json.map"] },
  { id: "sql", name: "SQL", extensions: ["sql"] },
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs"] },
  { id: "java", name: "Java", extensions: ["java"] },
  {
    id: "python",
    name: "Python",
    extensions: ["py", "pyi", "pyw"],
    firstLine: "^#!.*\\bpython[0-9.]*\\b",
  },
]);

describe("scratch naming", () => {
  it("uses scratch.<ext>, then scratch_1, scratch_2… (case-insensitive)", () => {
    expect(scratchFileName([], "java")).toBe("scratch.java");
    expect(scratchFileName(["scratch.java"], "java")).toBe("scratch_1.java");
    expect(scratchFileName(["Scratch.java", "scratch_1.java", "scratch.py"], "java")).toBe("scratch_2.java");
    expect(scratchFileName(["scratch.java"], "py")).toBe("scratch.py");
  });
});

describe("scratch content", () => {
  it("starts from the language's template with the caret at $END$", () => {
    const cases: [string | undefined, string, { line: number; col: number } | null][] = [
      [undefined, "", null],
      ["", "", null],
      ["fn main() {\n    $END$\n}\n", "fn main() {\n    \n}\n", { line: 1, col: 4 }],
      ["package main\n\nfunc main() {\n\t$END$\n}\n", "package main\n\nfunc main() {\n\t\n}\n", { line: 3, col: 1 }],
      ["$END$x", "x", { line: 0, col: 0 }],
      ["// é\n$END$ $END$", "// é\n ", { line: 1, col: 0 }],
      ["no caret\n", "no caret\n", null],
    ];
    for (const [template, text, caret] of cases)
      expect(scratchContent(template), String(template)).toEqual({ text, caret });
  });
});

describe("language chooser rows", () => {
  it("keeps languages with an extension, sorted by name, first extension wins", () => {
    expect(LANGS.map((l) => `${l.name}:${l.ext}`)).toEqual([
      "Java:java",
      "JavaScript:js",
      "Plain Text:txt",
      "Python:py",
    ]);
  });

  it("puts recently used languages first when not filtering", () => {
    expect(chooserRows(LANGS, ["python", "gone"], "").map((r) => r.lang.id)).toEqual([
      "python",
      "java",
      "javascript",
      "plaintext",
    ]);
  });

  it("filters by name prefix, then fuzzy, then extension", () => {
    expect(chooserRows(LANGS, [], "ja").map((r) => r.lang.id)).toEqual(["java", "javascript"]);
    expect(chooserRows(LANGS, [], "script").map((r) => r.lang.id)).toEqual(["javascript"]);
    expect(chooserRows(LANGS, [], "txt").map((r) => r.lang.id)).toEqual(["plaintext"]);
    expect(chooserRows(LANGS, ["python"], "zzz")).toEqual([]);
  });

  it("remembers at most five recent languages, most recent first", () => {
    let r: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "c"]) r = pushRecent(r, id);
    expect(r).toEqual(["c", "f", "e", "d", "b"]);
  });
});

describe("scratch language from a selection", () => {
  const source = (language: string, path: string) => ({ language, path });

  it("recognises a fragment before falling back to the source language", () => {
    expect(scratchLanguageForSelection(source("markdown", "/p/README.md"), '{"answer": 42}', SELECTION_LANGS)?.id).toBe(
      "json",
    );
    expect(
      scratchLanguageForSelection(
        source("markdown", "/p/README.md"),
        "#!/usr/bin/env python3\nprint(42)",
        SELECTION_LANGS,
      )?.id,
    ).toBe("python");
    expect(
      scratchLanguageForSelection(source("plaintext", "/p/notes.txt"), "SELECT id FROM users", SELECTION_LANGS)?.id,
    ).toBe("sql");
  });

  it("uses the source language before its extension for ambiguous text", () => {
    expect(scratchLanguageForSelection(source("python", "/p/misnamed.js"), "print(42)", SELECTION_LANGS)?.id).toBe(
      "python",
    );
  });

  it("matches every source extension, including compound and upper-case extensions", () => {
    expect(scratchLanguageForSelection(source("unknown", "/p/types.PYI"), "value = 42", SELECTION_LANGS)?.id).toBe(
      "python",
    );
    expect(
      scratchLanguageForSelection(source("unknown", "/p/data.JSON.MAP"), "ambiguous text", SELECTION_LANGS)?.id,
    ).toBe("json");
  });

  it("falls back to plain text, or the source language when the inferred one cannot be a scratch", () => {
    expect(scratchLanguageForSelection(source("unknown", "/p/file.unknown"), "some notes", SELECTION_LANGS)?.id).toBe(
      "plaintext",
    );
    expect(scratchLanguageForSelection(source("java", "/p/A.java"), '{"answer": 42}', LANGS)?.id).toBe("java");
    expect(
      scratchLanguageForSelection(source("unknown", "/p/file.unknown"), "some notes", [
        SELECTION_LANGS.find((lang) => lang.id === "json")!,
      ]),
    ).toBeNull();
  });
});

describe("creating scratch files", () => {
  let files: Set<string>;
  let contents: Map<string, string>;
  let opened: string[];
  let carets: ({ line: number; col: number } | null)[];
  let backend: ScratchBackend;
  let notify: ReturnType<typeof vi.fn<NotificationService["notify"]>>;
  const views: EditorView[] = [];
  const editor = (doc: string, from: number, to: number, path = "/p/README.md", language = "markdown") => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: from, head: to },
        extensions: [lspDoc.of({ doc: 7, path, language, uiMode: null, readOnly: false })],
      }),
    });
    views.push(view);
    return view;
  };
  beforeEach(() => {
    localStorage.clear();
    useScratch.setState({ languages: null, recent: [] });
    notify = vi.fn<NotificationService["notify"]>();
    provideNotificationService({ notify });
    files = new Set(["/data/scratches/scratch.java"]);
    contents = new Map();
    opened = [];
    carets = [];
    backend = {
      scratchesDir: async () => "/data/scratches/",
      listNames: async (dir) => [...files].filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1)),
      createFile: async (p, text) => {
        files.add(p);
        contents.set(p, text);
      },
      languages: async () => LANGS,
      open: async (p, caret) => {
        opened.push(p);
        carets.push(caret);
      },
    };
    setScratchBackend(backend);
  });
  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy());
    setScratchBackend(tauriScratchBackend);
    provideNotificationService(notificationServiceImpl);
  });

  it("creates the next free name in <appData>/scratches, tells the project view and opens it", async () => {
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    expect(await createScratch(LANGS[0]!)).toBe("/data/scratches/scratch_1.java");
    off();
    expect(files.has("/data/scratches/scratch_1.java")).toBe(true);
    expect(events).toEqual([["/data/scratches/scratch_1.java"]]);
    expect(opened).toEqual(["/data/scratches/scratch_1.java"]);
  });

  it("fills a new scratch from its language's template, caret in the body; others start empty", async () => {
    await createScratch(LANGS.find((l) => l.id === "java")!);
    await createScratch(LANGS.find((l) => l.id === "python")!);
    expect(contents.get("/data/scratches/scratch_1.java")).toBe(
      "class Scratch {\n    public static void main(String[] args) {\n        \n    }\n}\n",
    );
    expect(contents.get("/data/scratches/scratch.py")).toBe("");
    expect(carets).toEqual([{ line: 2, col: 8 }, null]);
  });

  it("uses initial text verbatim instead of a template, including $END$ and line endings", async () => {
    const selected = "const value = '$END$';\r\n  // 中文 😀\r\n";
    expect(
      await createScratch(
        LANGS.find((lang) => lang.id === "java")!,
        selected,
      ),
    ).toBe("/data/scratches/scratch_1.java");
    expect(contents.get("/data/scratches/scratch_1.java")).toBe(selected);
    expect(carets).toEqual([null]);
  });

  it("registers a selection intention that creates and opens a numbered scratch outside the project", async () => {
    backend.languages = async () => SELECTION_LANGS;
    files.add("/data/scratches/scratch.json");
    const selected = '\n  { "snippet": "$END$ 中文 😀" }\n';
    const doc = `before\n${selected}after`;
    const from = doc.indexOf(selected);
    const dispose = activate();
    try {
      const contribution = editorContributions().find((entry) => entry.id === "scratch.fromSelection")!;
      const ctx = { doc: 7, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };
      const view = new EditorView({
        state: EditorState.create({
          doc,
          selection: { anchor: from, head: from + selected.length },
          extensions: [lspDoc.of(ctx), contribution.extensions(ctx)],
        }),
      });
      views.push(view);
      const selectedText = view.state.doc.sliceString(from, from + selected.length);
      expect(selectedText).toBe(selected);
      expect(scratchLanguageForSelection(ctx, selectedText, SELECTION_LANGS)?.id).toBe("json");
      const [intention] = contributedIntentions(view);
      expect(intention).toMatchObject({
        id: "scratch.createFromSelection",
        label: "Create new scratch file from selection",
        icon: "scratches",
      });
      await intention!.run();
      expect(opened).toEqual(["/data/scratches/scratch_1.json"]);
      expect(contents.get("/data/scratches/scratch_1.json")).toBe(selectedText);
      expect(carets).toEqual([null]);
      expect([...files].every((path) => path.startsWith("/data/scratches/"))).toBe(true);
      expect(useScratch.getState().languages).toBeNull();
      expect(useScratch.getState().recent).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("uses the source language or extension when the selection is ambiguous", async () => {
    backend.languages = async () => SELECTION_LANGS;
    const dispose = activate();
    try {
      const byLanguage = editor("print(42)", 0, "print(42)".length, "/p/misnamed.js", "python");
      await scratchFromSelectionIntentions(byLanguage)[0]!.run();
      const byExtension = editor("value = 42", 0, 10, "/p/types.PYI", "unknown");
      await scratchFromSelectionIntentions(byExtension)[0]!.run();
      expect(opened).toEqual(["/data/scratches/scratch.py", "/data/scratches/scratch_1.py"]);
      expect(contents.get("/data/scratches/scratch.py")).toBe("print(42)");
      expect(contents.get("/data/scratches/scratch_1.py")).toBe("value = 42");
      expect(useScratch.getState().languages).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("offers nothing and does no work for an empty selection", async () => {
    const languages = vi.spyOn(backend, "languages");
    const createFile = vi.spyOn(backend, "createFile");
    const open = vi.spyOn(backend, "open");
    const view = editor("some text", 2, 2);
    expect(scratchFromSelectionIntentions(view)).toEqual([]);
    expect(await createScratchFromSelection({ language: "markdown", path: "/p/README.md" }, "")).toBeNull();
    expect(languages).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("registers the action and the Scratches root; the chooser creates the picked language", async () => {
    const dispose = activate();
    try {
      await vi.waitFor(() =>
        expect(useProjectViewRoots.getState().roots.get("scratches")?.path).toBe("/data/scratches"),
      );
      expect(useProjectViewRoots.getState().roots.get("scratches")?.label).toBe("Scratches");
      const action = getAction("file.newScratchFile")!;
      expect(action.title).toBe("New Scratch File…");
      await act(async () => {
        await action.run({ ctx: {} as never, arg: undefined });
      });
      render(<ScratchChooserHost />);
      const user = userEvent.setup();
      const input = screen.getByRole("textbox", { name: "Filter languages" });
      expect(input).toHaveFocus();
      await user.paste("java");
      expect(input).toHaveValue("java");
      expect(screen.queryByText("Python")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(input).toHaveFocus();
      expect(input).toHaveValue("");
      await user.type(input, "pyton");
      await user.keyboard("{ArrowLeft}{ArrowLeft}h");
      expect(input).toHaveValue("python");
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await vi.waitFor(() => expect(opened).toEqual(["/data/scratches/scratch.py"]));
      expect(useScratch.getState().languages).toBeNull();
      expect(useScratch.getState().recent[0]).toBe("python");
    } finally {
      dispose();
    }
    expect(useProjectViewRoots.getState().roots.has("scratches")).toBe(false);
  });
});

describe("new scratch buffer", () => {
  let files: Set<string>;
  let contents: Map<string, string>;
  let opened: string[];
  let carets: ({ line: number; col: number } | null)[];
  let backend: ScratchBackend;
  let notify: ReturnType<typeof vi.fn<NotificationService["notify"]>>;
  beforeEach(() => {
    localStorage.clear();
    useScratch.setState({ languages: null, recent: [] });
    notify = vi.fn<NotificationService["notify"]>();
    provideNotificationService({ notify });
    files = new Set();
    contents = new Map();
    opened = [];
    carets = [];
    backend = {
      scratchesDir: async () => "/data/scratches/",
      listNames: async (dir) => [...files].filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1)),
      createFile: async (p, text) => {
        files.add(p);
        contents.set(p, text);
      },
      languages: async () => LANGS,
      open: async (p, caret) => {
        opened.push(p);
        carets.push(caret);
      },
    };
    setScratchBackend(backend);
  });
  afterEach(() => {
    setScratchBackend(tauriScratchBackend);
    provideNotificationService(notificationServiceImpl);
  });

  it("exports a flow that creates and opens an empty buffer1.txt without a language chooser", async () => {
    const languages = vi.spyOn(backend, "languages");
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    try {
      expect(await newScratchBuffer()).toBe("/data/scratches/buffer1.txt");
    } finally {
      off();
    }
    expect(files).toEqual(new Set(["/data/scratches/buffer1.txt"]));
    expect(contents.get("/data/scratches/buffer1.txt")).toBe("");
    expect(events).toEqual([["/data/scratches/buffer1.txt"]]);
    expect(opened).toEqual(["/data/scratches/buffer1.txt"]);
    expect(carets).toEqual([null]);
    expect(languages).not.toHaveBeenCalled();
    expect(useScratch.getState().languages).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reopens an existing buffer case-insensitively without recreating or announcing it", async () => {
    const path = "/data/scratches/BuFfEr1.TxT";
    files.add(path);
    contents.set(path, "keep these notes");
    const createFile = vi.spyOn(backend, "createFile");
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    try {
      expect(await newScratchBuffer()).toBe(path);
    } finally {
      off();
    }
    expect(createFile).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(contents.get(path)).toBe("keep these notes");
    expect(opened).toEqual([path]);
    expect(carets).toEqual([null]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("is visible in Find Action, resolves the IDEA id, has no default shortcut, and cycles 1..5..1", async () => {
    const createFile = vi.spyOn(backend, "createFile");
    const languages = vi.spyOn(backend, "languages");
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    const dispose = activate();
    try {
      const action = getAction("file.newScratchBuffer")!;
      expect(action.title).toBe("New Scratch Buffer");
      expect(action.hidden).not.toBe(true);
      expect(IDEA_ACTIONS.NewScratchBuffer).toBe("file.newScratchBuffer");
      expect(bindingsFor("file.newScratchBuffer")).toEqual([]);
      const paths: string[] = [];
      for (let i = 0; i < 6; i++) {
        // oxlint-disable-next-line no-await-in-loop -- buffer cycle order is the behavior under test
        await act(async () => {
          await action.run({ ctx: {} as never, arg: undefined });
        });
        paths.push(opened.at(-1)!);
      }
      expect(paths).toEqual([
        "/data/scratches/buffer1.txt",
        "/data/scratches/buffer2.txt",
        "/data/scratches/buffer3.txt",
        "/data/scratches/buffer4.txt",
        "/data/scratches/buffer5.txt",
        "/data/scratches/buffer1.txt",
      ]);
      expect(createFile).toHaveBeenCalledTimes(5);
      expect(events).toEqual(Array.from({ length: 5 }, (_, i) => [`/data/scratches/buffer${i + 1}.txt`]));
      expect(languages).not.toHaveBeenCalled();
      expect(useScratch.getState().languages).toBeNull();
      expect([...files].every((path) => path.startsWith("/data/scratches/"))).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      off();
      dispose();
    }
  });

  it("reports a missing backend and does not create or open a buffer", async () => {
    backend.scratchesDir = async () => {
      throw new Error("scratch backend unavailable");
    };
    const listNames = vi.spyOn(backend, "listNames");
    const createFile = vi.spyOn(backend, "createFile");
    const open = vi.spyOn(backend, "open");
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    try {
      expect(await newScratchBuffer()).toBeNull();
    } finally {
      off();
    }
    expect(listNames).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(notify).toHaveBeenCalledWith({
      level: "error",
      title: "Cannot create scratch buffer",
      body: "scratch backend unavailable",
    });
  });

  it("reports creation failures without opening the buffer or announcing a file", async () => {
    vi.spyOn(backend, "createFile").mockRejectedValue(new Error("read-only scratches directory"));
    const open = vi.spyOn(backend, "open");
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    try {
      expect(await newScratchBuffer()).toBeNull();
    } finally {
      off();
    }
    expect(files.size).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(notify).toHaveBeenCalledWith({
      level: "error",
      title: "Cannot create scratch buffer",
      body: "read-only scratches directory",
    });
  });
});

describe("scratches of a remote window", () => {
  afterEach(() => {
    useRemote.setState({ session: null });
    setScratchBackend(tauriScratchBackend);
  });

  it("moves the Scratches root to the server's folder when the window attaches to it in place", async () => {
    const remote = () => useRemote.getState().session !== null;
    setScratchBackend({
      scratchesDir: async () => (remote() ? "/home/me/.openidea/data/scratches" : "C:/Users/me/AppData/scratches"),
      listNames: async () => [],
      createFile: async () => {},
      languages: async () => [],
      open: async () => {},
    });
    const root = () => useProjectViewRoots.getState().roots.get("scratches")?.path;
    const dispose = activate();
    try {
      await vi.waitFor(() => expect(root()).toBe("C:/Users/me/AppData/scratches"));
      useRemote.setState({ session: { root: "/home/me/project" } as never });
      await vi.waitFor(() => expect(root()).toBe("/home/me/.openidea/data/scratches"));
      useRemote.setState({ session: null });
      await vi.waitFor(() => expect(root()).toBe("C:/Users/me/AppData/scratches"));
    } finally {
      dispose();
    }
    expect(root()).toBeUndefined();
  });
});

describe("deleting scratch files", () => {
  afterEach(() => setScratchBackend(tauriScratchBackend));

  it("reports deletions inside the scratches folder as file system changes", async () => {
    setScratchBackend({
      scratchesDir: async () => "/data/scratches",
      listNames: async () => [],
      createFile: async () => {},
      languages: async () => [],
      open: async () => {},
    });
    const { notifyFileOperation } = await import("@/platform/fileOps");
    const dispose = activate();
    const removed: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void removed.push(e.removed));
    try {
      await vi.waitFor(() => expect(useProjectViewRoots.getState().roots.has("scratches")).toBe(true));
      notifyFileOperation({ kind: "deleted", paths: ["/data/scratches/a.py", "/p/b.py"] });
      expect(removed).toEqual([["/data/scratches/a.py"]]);
    } finally {
      off();
      dispose();
    }
  });
});
