import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { copySourceOf, noteCopySource } from "@/platform/clipboardSource";
import { EditorView } from "@codemirror/view";
import { trackEditorCopies } from "./references";
import userEvent from "@testing-library/user-event";
import { caretOf, setCaret, textOf, typeChars, typeIn } from "./composerTesting";
import chipStyles from "./ReferenceChip.module.css";
import { FILES_DRAG, dragSession } from "@/ui";

const findFiles = vi.fn();
const findDirs = vi.fn();
const pathCompletions = vi.fn();
const fsProbe = vi.fn();
const fsEntryKind = vi.fn();
const findSymbols = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: vi.fn(() => false),
    commands: {
      ...real.commands,
      findFiles: (query: string, limit: number) => findFiles(query, limit),
      findDirs: (query: string, limit: number) => findDirs(query, limit),
      pathCompletions: (base: string, typed: string) => pathCompletions(base, typed),
      fsProbe: (path: string) => fsProbe(path),
      fsEntryKind: (path: string) => fsEntryKind(path),
      findSymbols: (query: string, filter: string, limit: number) => findSymbols(query, filter, limit),
    },
  };
});

import { Composer } from "./Composer";
import { registerAgentContextSource } from "@/workbench/contributions";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { composerDraft, updateComposer } from "./store";
import { emptyDraft, toPrompt } from "./composerModel";

const ID = "folders-test";
const ok = <T,>(data: T) => Promise.resolve({ status: "ok", data });

function renderComposer(root = "/p") {
  render(
    <Composer
      id={ID}
      placeholder="Ask"
      root={root}
      projectRoot="/p"
      commands={[]}
      history={[]}
      config={[]}
      onSubmit={() => {}}
    />,
  );
  return screen.getByRole("textbox", { name: "Message" });
}

beforeEach(() => {
  updateComposer(ID, emptyDraft());
  const match = (path: string, relPath: string, score: number) => ({
    path,
    relPath,
    score,
    indices: [],
  });
  findFiles.mockReset().mockReturnValue(ok([match("/p/src/agents.ts", "src/agents.ts", 40)]));
  findDirs.mockReset().mockReturnValue(ok([match("/p/src/agents", "src/agents/", 90)]));
  pathCompletions.mockReset().mockReturnValue(ok([{ name: "lib", dir: true }]));
  fsEntryKind
    .mockReset()
    .mockImplementation((path: string) =>
      path.startsWith("/p/")
        ? ok(path.endsWith(".ts") ? "file" : "dir")
        : Promise.resolve({ status: "error", error: { kind: "notFound", message: "" } }),
    );
  fsProbe.mockReset().mockReturnValue(
    Promise.resolve({
      status: "error",
      error: { kind: "notFound", message: "" },
    }),
  );
});

describe("Composer dropped paths", () => {
  function drop(box: HTMLElement, payload: string) {
    const restore = document.elementFromPoint;
    document.elementFromPoint = () => box;
    try {
      act(() => {
        const drag = dragSession({ type: FILES_DRAG, payload });
        expect(drag.drop(0, 0)).toBe(true);
      });
    } finally {
      document.elementFromPoint = restore;
    }
  }

  it("references files and folders dragged from the Project view", () => {
    const box = renderComposer();
    const restore = document.elementFromPoint;
    document.elementFromPoint = () => box;
    try {
      act(() => {
        // Folders carry a trailing slash, as the Project view marks them.
        const drag = dragSession({
          type: FILES_DRAG,
          payload: "/p/src/a.ts\n/p/src/dir/",
        });
        expect(drag.drop(0, 0)).toBe(true);
      });
    } finally {
      document.elementFromPoint = restore;
    }
    expect(composerDraft(ID).files).toEqual([
      { path: "/p/src/a.ts", rel: "src/a.ts" },
      { path: "/p/src/dir", rel: "src/dir" },
    ]);
    expect(textOf(box)).toBe("@src/a.ts @src/dir ");
  });

  it("deduplicates live references and allows a deleted reference to be dropped again", () => {
    const box = renderComposer();
    drop(box, "/p/src/a.ts\n/p/src/a.ts\n/p/src/dir/");
    drop(box, "/p/src/a.ts\n/p/src/dir/");
    expect(textOf(box)).toBe("@src/a.ts @src/dir ");
    typeIn(box, "@src/dir ");
    drop(box, "/p/src/a.ts");
    expect(textOf(box)).toBe("@src/dir @src/a.ts ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/dir", "/p/src/a.ts"]);
  });

  it("maps project files and folders into the task worktree, rejecting external paths", () => {
    const box = renderComposer("/worktree");
    drop(box, "/p/src/a.ts\n/p/src/dir/\n/external/a.ts\n/p-other/a.ts\n/p/../external/b.ts\nrelative.ts");
    expect(textOf(box)).toBe("@src/a.ts @src/dir ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/worktree/src/a.ts", "/worktree/src/dir"]);
  });
});

describe("Composer @ folders", () => {
  it("lists the root for a bare @ when the index has no results", async () => {
    findFiles.mockReturnValue(ok([]));
    findDirs.mockReturnValue(ok([]));
    const box = renderComposer();
    typeChars(box, "@");
    expect(await screen.findByRole("option")).toHaveTextContent("lib/");
    expect(pathCompletions).toHaveBeenCalledWith("/p/_", "");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("@lib/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/lib"]);
  });

  it("lists index folders among files and references one on Enter", async () => {
    const box = renderComposer();
    typeChars(box, "see @agen");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["agents/src", "agents.tssrc"]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("see @src/agents/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/agents"]);
  });

  it("highlights the matched characters of a file name", async () => {
    findFiles.mockReturnValue(
      ok([
        {
          path: "/p/src/agents.ts",
          relPath: "src/agents.ts",
          score: 40,
          indices: [4, 5, 6],
        },
      ]),
    );
    findDirs.mockReturnValue(ok([]));
    const box = renderComposer();
    typeChars(box, "@age");
    const option = await screen.findByRole("option");
    expect([...option.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["age"]);
  });

  it("keeps completing inside a folder on Tab, which drops the folder once a file is picked", async () => {
    const box = renderComposer();
    typeChars(box, "@agen");
    await screen.findAllByRole("option");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(textOf(box)).toBe("@src/agents/");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/agents"]);
    typeChars(box, "x.ts ");
    expect(toPrompt(composerDraft(ID)).files).toEqual([]);
  });

  it("references a folder of a typed path", async () => {
    const box = renderComposer();
    typeChars(box, "@./");
    await screen.findByRole("option");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("@./lib/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/lib"]);
  });
});

describe("Composer reference chips", () => {
  const chips = () => [...document.querySelectorAll<HTMLElement>("[data-ref-path]")];

  it("shows a referenced file as a chip with its name and lines, and leaves the text as written", () => {
    const box = renderComposer();
    act(() => updateComposer(ID, { files: [{ path: "/p/src/a.ts", rel: "src/a.ts" }] }));
    typeIn(box, "see @src/a.ts:10-20 and @other.ts ");
    expect(chips().map((c) => [c.dataset.refPath, c.textContent])).toEqual([["/p/src/a.ts", "a.ts10–20"]]);
    expect(chips()[0]).toHaveAccessibleName("File reference a.ts, lines 10–20");
    // Not referenced: marked as typed.
    expect(screen.getByText("@other.ts")).toHaveClass(chipStyles.pending!);
    expect(textOf(box)).toBe("see @src/a.ts:10-20 and @other.ts ");
  });

  it("turns a chip back into its text on Backspace, and folds it again when the caret leaves", async () => {
    const box = renderComposer();
    typeChars(box, "see @agen");
    await screen.findAllByRole("option");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("see @src/agents/ ");
    expect(chips()).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(textOf(box)).toBe("see @src/agents/");
    expect(chips()).toHaveLength(1);
    // Right after the chip: it opens as text, and the completion offers it again.
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(textOf(box)).toBe("see @src/agents/");
    expect(chips()).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(textOf(box)).toBe("see @src/agents");
    expect(chips()).toHaveLength(0);
    typeChars(box, "/");
    setCaret(box, 0);
    expect(chips()).toHaveLength(1);
  });

  it("moves over and deletes a chip as one piece", () => {
    const box = renderComposer();
    act(() => updateComposer(ID, { files: [{ path: "/p/src/a.ts", rel: "src/a.ts" }] }));
    typeIn(box, "see @src/a.ts next", 4);
    fireEvent.keyDown(box, { key: "Delete" });
    expect(textOf(box)).toBe("see  next");
  });

  it("deletes a reference that names no file character by character", () => {
    const box = renderComposer();
    typeIn(box, "see @src/a.ts next", 13);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(textOf(box)).toBe("see @src/a.t next");
    expect(caretOf(box)).toBe(12);
  });
});

describe("Composer quotes", () => {
  it("draws quote lines as a block without their marker", () => {
    const box = renderComposer();
    typeIn(box, "> first\n> second\n\nreply");
    const lines = [...box.querySelectorAll(".cm-line")];
    expect(lines.map((l) => l.textContent)).toEqual(["first", "second", "", "reply"]);
    expect(lines.map((l) => l.classList.contains(chipStyles.quoteLine!))).toEqual([true, true, false, false]);
    expect(textOf(box)).toBe("> first\n> second\n\nreply");
  });
});

describe("Composer editing", () => {
  it("offers no completion while the input method composes", () => {
    const box = renderComposer();
    fireEvent.compositionStart(box);
    typeIn(box, "@中文");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.compositionEnd(box);
    expect(textOf(box)).toBe("@中文");
  });

  it("pastes plain text as text", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    act(() => box.focus());
    await user.paste("look @src/a.ts\nthen /review please");
    expect(textOf(box)).toBe("look @src/a.ts\nthen /review please");
  });

  it("references a pasted path of a project file, with its lines", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    act(() => box.focus());
    await user.paste("/p/src/a.ts:3-5");
    await vi.waitFor(() => expect(textOf(box)).toBe("@src/a.ts:3-5 "));
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/a.ts"]);
    await user.paste("/elsewhere/b.ts");
    expect(textOf(box)).toBe("@src/a.ts:3-5 /elsewhere/b.ts");
  });

  it("references pasted folders, several paths and file URLs", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    act(() => box.focus());
    await user.paste("/p/src/dir\n'/p/src/b.ts'\nfile:///p/src/c.ts");
    await vi.waitFor(() => expect(textOf(box)).toBe("@src/dir/ @src/b.ts @src/c.ts "));
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/dir", "/p/src/b.ts", "/p/src/c.ts"]);
  });

  it("pastes a path that is gone, or holds a space, as text", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    act(() => box.focus());
    await user.paste("/p/my dir/a.ts");
    expect(textOf(box)).toBe("/p/my dir/a.ts");
    fsEntryKind.mockReturnValue(Promise.resolve({ status: "error", error: { kind: "notFound", message: "" } }));
    await user.paste(" /p/gone.ts");
    await vi.waitFor(() => expect(textOf(box)).toBe("/p/my dir/a.ts /p/gone.ts"));
  });
});

describe("Composer current file", () => {
  it("offers the focused editor's file until the draft references it", () => {
    const view = {} as TextEditorHandle["view"];
    act(() =>
      useEditorRegistry.setState({ active: { view, ctx: { path: "/p/src/main.ts" } as TextEditorHandle["ctx"] } }),
    );
    try {
      renderComposer();
      const offer = screen.getByRole("button", { name: /main\.ts/ });
      expect(offer).toHaveTextContent("Current File");
      fireEvent.click(offer);
      expect(composerDraft(ID).text).toBe("@src/main.ts ");
      expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/main.ts"]);
      expect(screen.queryByRole("button", { name: /main\.ts/ })).toBeNull();
      expect(document.querySelector("[data-ref-path]")).toHaveAttribute("data-ref-path", "/p/src/main.ts");
    } finally {
      act(() => useEditorRegistry.setState({ active: null }));
    }
  });
});

describe("Composer pasted code and terminal output", () => {
  const paste = (box: HTMLElement, text: string) =>
    act(() => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: { files: [], types: ["text/plain"], getData: () => text },
      });
      box.dispatchEvent(event);
    });

  it("turns terminal output into a terminal card, and opens it as text when the caret enters it", () => {
    const box = renderComposer();
    typeIn(box, "why does this fail?");
    noteCopySource("$ pnpm test\nFAIL a.test.ts\n  expected 1", { kind: "terminal", title: "zsh" });
    paste(box, "$ pnpm test\nFAIL a.test.ts\n  expected 1\n");
    expect(textOf(box)).toBe("why does this fail?\n```terminal zsh\n$ pnpm test\nFAIL a.test.ts\n  expected 1\n```\n");
    const card = screen.getByRole("group", { name: "Terminal · zsh" });
    expect(card).toHaveTextContent("3 lines");
    expect(card.querySelector("pre")).toHaveTextContent("$ pnpm test");
    fireEvent.click(card);
    expect(screen.queryByRole("group")).toBeNull();
    expect(box.querySelectorAll(`.${chipStyles.codeLine}`)).toHaveLength(5);
  });

  it("removes a card with its button", () => {
    const box = renderComposer();
    typeIn(box, "```ts\nconst a = 1;\n```\nnext");
    fireEvent.click(within(screen.getByRole("group", { name: "TypeScript" })).getByRole("button", { name: "Remove" }));
    expect(textOf(box)).toBe("next");
  });

  it("references the lines copied from an editor, and pastes a copied single line as text", () => {
    const box = renderComposer();
    noteCopySource("fn a() {\n}", { kind: "file", path: "/p/src/a.rs", from: 3, to: 4 });
    paste(box, "fn a() {\n}");
    expect(textOf(box)).toBe("@src/a.rs:3-4 ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/a.rs"]);
    noteCopySource("fn a()", { kind: "file", path: "/p/src/a.rs", from: 3, to: 3 });
    paste(box, "fn a()");
    expect(textOf(box)).toBe("@src/a.rs:3-4 fn a()");
  });

  it("pastes a stack trace as a card, its project lines as references after it", async () => {
    const box = renderComposer();
    const trace = "TypeError: boom\n    at run (/p/src/a.ts:12:5)\n    at main (/elsewhere/x.ts:3:1)";
    paste(box, trace);
    expect(screen.getByRole("group", { name: "Stack Trace" })).toHaveTextContent("3 lines");
    await vi.waitFor(() => expect(textOf(box)).toBe(`\`\`\`trace\n${trace}\n\`\`\`\n@src/a.ts:12 `));
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/a.ts"]);
  });

  it("folds long pasted text into a card", () => {
    const box = renderComposer();
    const long = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    paste(box, long);
    expect(screen.getByRole("group", { name: "Pasted Text" })).toHaveTextContent("40 lines");
    expect(textOf(box)).toBe(`\`\`\`text\n${long}\n\`\`\`\n`);
  });

  it("pastes other text as written", () => {
    const box = renderComposer();
    noteCopySource("something else", { kind: "terminal", title: "zsh" });
    paste(box, "line one\nline two");
    expect(textOf(box)).toBe("line one\nline two");
  });
});

describe("editor copies", () => {
  it("notes the copied lines of a file editor, or the caret's line when nothing is selected", () => {
    const view = new EditorView({
      doc: "one\ntwo\nthree\nfour",
      parent: document.body,
      selection: { anchor: 4, head: 14 },
    });
    const handle = { view, ctx: { path: "/p/src/a.ts" } } as TextEditorHandle;
    act(() => useEditorRegistry.setState({ editors: new Set([handle]) }));
    const stop = trackEditorCopies();
    try {
      view.contentDOM.dispatchEvent(new Event("copy", { bubbles: true }));
      expect(copySourceOf("two\nthree\n")).toEqual({ kind: "file", path: "/p/src/a.ts", from: 2, to: 3 });
      view.dispatch({ selection: { anchor: 15 } });
      view.contentDOM.dispatchEvent(new Event("copy", { bubbles: true }));
      expect(copySourceOf("four")).toEqual({ kind: "file", path: "/p/src/a.ts", from: 4, to: 4 });
    } finally {
      stop();
      view.destroy();
      act(() => useEditorRegistry.setState({ editors: new Set() }));
    }
  });
});

describe("Composer @ context and symbols", () => {
  it("offers what features contribute above the files and inserts it", async () => {
    const off = [
      registerAgentContextSource({
        id: "problems",
        title: "Problems",
        description: "The project's errors and warnings",
        icon: "problems",
        resolve: async () => ({ kind: "block", info: "problems", text: "src/a.ts:3:1: error: nope" }),
      }),
      registerAgentContextSource({
        id: "changes",
        title: "Changes",
        description: "Files with uncommitted changes",
        icon: "diff",
        resolve: async () => ({ kind: "files", paths: ["/p/src/a.ts", "/p/src/b.ts", "/elsewhere/c.ts"] }),
      }),
    ];
    try {
      const box = renderComposer();
      typeChars(box, "fix @pro");
      const options = await screen.findAllByRole("option");
      expect(options[0]).toHaveTextContent("@problems");
      fireEvent.keyDown(box, { key: "Enter" });
      await vi.waitFor(() =>
        expect(textOf(box)).toBe("fix\n```problems\nsrc/a.ts:3:1: error: nope\n```\n@src/a.ts:3 "),
      );
      expect(screen.getByRole("group", { name: "Problems" })).toBeInTheDocument();
      typeChars(box, "@chan");
      await screen.findAllByRole("option");
      fireEvent.keyDown(box, { key: "Enter" });
      await vi.waitFor(() => expect(textOf(box)).toMatch(/@src\/a\.ts:3 @src\/a\.ts @src\/b\.ts $/));
      expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/a.ts", "/p/src/b.ts"]);
    } finally {
      off.forEach((d) => d());
    }
  });

  it("references a symbol's file and line with @#", async () => {
    findSymbols.mockReturnValue(
      ok([
        {
          name: "fetchUser",
          kind: "function",
          container: "client",
          path: "/p/src/api/client.ts",
          relPath: "src/api/client.ts",
          range: { start: { line: 11, col: 0 }, end: { line: 11, col: 9 } },
          score: 10,
          indices: [0, 1, 2],
        },
      ]),
    );
    const box = renderComposer();
    typeChars(box, "@#fet");
    const option = await screen.findByRole("option");
    expect(option).toHaveTextContent("fetchUserclient · src/api/client.ts:12");
    expect(findSymbols).toHaveBeenCalledWith("fet", "all", 12);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("@src/api/client.ts:12 ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/api/client.ts"]);
  });
});
