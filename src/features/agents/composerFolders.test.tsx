import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

function renderComposer() {
  render(
    <Composer
      id={ID}
      placeholder="Ask"
      root="/p"
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
});

describe("Composer @ folders", () => {
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
