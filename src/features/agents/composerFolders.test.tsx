import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FILES_DRAG, dragSession } from "@/ui";

const findFiles = vi.fn();
const findDirs = vi.fn();
const pathCompletions = vi.fn();

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
    },
  };
});

import { Composer } from "./Composer";
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
  return screen.getByPlaceholderText("Ask") as HTMLTextAreaElement;
}

beforeEach(() => {
  updateComposer(ID, emptyDraft());
  const match = (path: string, relPath: string, score: number) => ({ path, relPath, score, indices: [] });
  findFiles.mockReset().mockReturnValue(ok([match("/p/src/agents.ts", "src/agents.ts", 40)]));
  findDirs.mockReset().mockReturnValue(ok([match("/p/src/agents", "src/agents/", 90)]));
  pathCompletions.mockReset().mockReturnValue(ok([{ name: "lib", dir: true }]));
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
        const drag = dragSession({ type: FILES_DRAG, payload: "/p/src/a.ts\n/p/src/dir/" });
        expect(drag.drop(0, 0)).toBe(true);
      });
    } finally {
      document.elementFromPoint = restore;
    }
    expect(composerDraft(ID).files).toEqual([
      { path: "/p/src/a.ts", rel: "src/a.ts" },
      { path: "/p/src/dir", rel: "src/dir" },
    ]);
    expect(box.value).toBe("@src/a.ts @src/dir ");
  });

  it("deduplicates live references and allows a deleted reference to be dropped again", () => {
    const box = renderComposer();
    drop(box, "/p/src/a.ts\n/p/src/a.ts\n/p/src/dir/");
    drop(box, "/p/src/a.ts\n/p/src/dir/");
    expect(box.value).toBe("@src/a.ts @src/dir ");
    fireEvent.change(box, { target: { value: "@src/dir " } });
    drop(box, "/p/src/a.ts");
    expect(box.value).toBe("@src/dir @src/a.ts ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/dir", "/p/src/a.ts"]);
  });

  it("maps project files and folders into the task worktree, rejecting external paths", () => {
    const box = renderComposer("/worktree");
    drop(box, "/p/src/a.ts\n/p/src/dir/\n/external/a.ts\n/p-other/a.ts\n/p/../external/b.ts\nrelative.ts");
    expect(box.value).toBe("@src/a.ts @src/dir ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/worktree/src/a.ts", "/worktree/src/dir"]);
  });
});

describe("Composer @ folders", () => {
  it("lists the root for a bare @ when the index has no results", async () => {
    findFiles.mockReturnValue(ok([]));
    findDirs.mockReturnValue(ok([]));
    const box = renderComposer();
    await userEvent.type(box, "@");
    expect(await screen.findByRole("option")).toHaveTextContent("lib/");
    expect(pathCompletions).toHaveBeenCalledWith("/p/_", "");
    await userEvent.keyboard("{Enter}");
    expect(box.value).toBe("@lib/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/lib"]);
  });

  it("lists index folders among files and references one on Enter", async () => {
    const box = renderComposer();
    await userEvent.type(box, "see @agen");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["agents/src/agents", "agents.tssrc/agents.ts"]);
    await userEvent.keyboard("{Enter}");
    expect(box.value).toBe("see @src/agents/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/agents"]);
  });

  it("keeps completing inside a folder on Tab, which drops the folder once a file is picked", async () => {
    const box = renderComposer();
    await userEvent.type(box, "@agen");
    await screen.findAllByRole("option");
    await userEvent.keyboard("{Tab}");
    expect(box.value).toBe("@src/agents/");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/src/agents"]);
    await userEvent.type(box, "x.ts ");
    expect(toPrompt(composerDraft(ID)).files).toEqual([]);
  });

  it("references a folder of a typed path", async () => {
    const box = renderComposer();
    await userEvent.type(box, "@./");
    await screen.findByRole("option");
    await userEvent.keyboard("{Enter}");
    expect(box.value).toBe("@./lib/ ");
    expect(toPrompt(composerDraft(ID)).files).toEqual(["/p/lib"]);
  });
});

describe("Composer tag editing", () => {
  it.each(["@src/ag", "/rev"])("deletes %s character by character while it is typed", async (tag) => {
    const box = renderComposer();
    const user = userEvent.setup();
    await user.type(box, `see ${tag}`);
    await user.keyboard("{Backspace}");
    expect(box.value).toBe(`see ${tag.slice(0, -1)}`);
    await user.keyboard("{Backspace}");
    expect(box.value).toBe(`see ${tag.slice(0, -2)}`);
  });

  it("deletes inside a folder entered with Tab character by character", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    await user.type(box, "@agen");
    await screen.findAllByRole("option");
    await user.keyboard("{Tab}");
    expect(box.value).toBe("@src/agents/");
    await user.keyboard("{Backspace}");
    expect(box.value).toBe("@src/agents");
  });

  it("edits a completed reference character by character after its space", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    await user.type(box, "see @agen");
    await screen.findAllByRole("option");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("see @src/agents/ ");
    await user.keyboard("{Backspace}{Backspace}");
    expect(box.value).toBe("see @src/agents");
  });

  it.each(["@src/a.ts", "/review"])("edits %s after moving away and returning", async (tag) => {
    const box = renderComposer();
    const user = userEvent.setup();
    fireEvent.change(box, { target: { value: `see ${tag} next` } });
    box.focus();
    box.setSelectionRange(0, 0);
    fireEvent.select(box);
    box.blur();
    box.focus();
    box.setSelectionRange(4 + tag.length, 4 + tag.length);
    fireEvent.select(box);
    await user.keyboard("{Backspace}");
    expect(box.value).toBe(`see ${tag.slice(0, -1)} next`);
    expect(box.selectionStart).toBe(3 + tag.length);
  });

  it.each(["@src/a.ts", "/review"])("moves within %s with the arrow keys", async (tag) => {
    const box = renderComposer();
    const user = userEvent.setup();
    fireEvent.change(box, { target: { value: `see ${tag} next` } });
    box.focus();
    box.setSelectionRange(4, 4);
    await user.keyboard("{ArrowRight}");
    expect(box.selectionStart).toBe(5);
    await user.keyboard("{ArrowLeft}");
    expect(box.selectionStart).toBe(4);
    await user.keyboard("{Delete}");
    expect(box.value).toBe(`see ${tag.slice(1)} next`);
  });

  it.each(["@src/a.ts", "/review"])("selects and deletes only part of %s", async (tag) => {
    const box = renderComposer();
    const user = userEvent.setup();
    fireEvent.change(box, { target: { value: `see ${tag} next` } });
    box.focus();
    box.setSelectionRange(5, 7);
    fireEvent.select(box);
    await user.keyboard("{Backspace}");
    expect(box.value).toBe(`see ${tag.slice(0, 1)}${tag.slice(3)} next`);
  });

  it("leaves IME keys and composition text to the input method", () => {
    const box = renderComposer();
    fireEvent.change(box, { target: { value: "@src/a.ts" } });
    const before = box.value;
    box.setSelectionRange(before.length, before.length);
    expect(fireEvent.keyDown(box, { key: "Backspace", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Backspace", keyCode: 229 })).toBe(true);
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "@中文" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
    fireEvent.compositionEnd(box);
    expect(box.value).toBe("@中文");
  });

  it("pastes plain text through the native textarea", async () => {
    const box = renderComposer();
    const user = userEvent.setup();
    box.focus();
    await user.paste("look @src/a.ts\nthen /review please");
    expect(box.value).toBe("look @src/a.ts\nthen /review please");
  });
});
