import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  scratchLanguages,
  type ScratchLanguage,
} from "../model";
import { createScratch, setScratchBackend, tauriScratchBackend, type ScratchBackend } from "../scratches";
import { useScratch } from "../store";
import { ScratchChooserHost } from "../ScratchChooser";
import { activate, newScratchBuffer } from "..";

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

describe("creating scratch files", () => {
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
