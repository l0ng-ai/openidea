import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAction } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { useProjectViewRoots } from "@/workbench/contributions";
import { chooserRows, pushRecent, scratchFileName, scratchLanguages, type ScratchLanguage } from "../model";
import { createScratch, setScratchBackend, tauriScratchBackend, type ScratchBackend } from "../scratches";
import { useScratch } from "../store";
import { ScratchChooserHost } from "../ScratchChooser";
import { activate } from "..";

const LANGS: ScratchLanguage[] = scratchLanguages([
  { id: "java", name: "Java", extensions: ["java"] },
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
  let opened: string[];
  let backend: ScratchBackend;
  beforeEach(() => {
    localStorage.clear();
    useScratch.setState({ languages: null, recent: [] });
    files = new Set(["/data/scratches/scratch.java"]);
    opened = [];
    backend = {
      dataDir: async () => "/data/",
      listNames: async (dir) => [...files].filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1)),
      createDir: async () => {},
      createFile: async (p) => void files.add(p),
      languages: async () => LANGS,
      open: async (p) => void opened.push(p),
    };
    setScratchBackend(backend);
  });
  afterEach(() => setScratchBackend(tauriScratchBackend));

  it("creates the next free name in <appData>/scratches, tells the project view and opens it", async () => {
    const events: string[][] = [];
    const off = onIdeEvent("fsChanged", (e) => void events.push(e.created));
    expect(await createScratch(LANGS[0]!)).toBe("/data/scratches/scratch_1.java");
    off();
    expect(files.has("/data/scratches/scratch_1.java")).toBe(true);
    expect(events).toEqual([["/data/scratches/scratch_1.java"]]);
    expect(opened).toEqual(["/data/scratches/scratch_1.java"]);
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

describe("deleting scratch files", () => {
  afterEach(() => setScratchBackend(tauriScratchBackend));

  it("reports deletions inside the scratches folder as file system changes", async () => {
    setScratchBackend({
      dataDir: async () => "/data",
      listNames: async () => [],
      createDir: async () => {},
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
