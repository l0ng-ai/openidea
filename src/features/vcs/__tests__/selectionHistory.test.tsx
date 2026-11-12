import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type { BlockHistory, BlockRevision } from "@/bindings";

const vcsBlockHistory = vi.fn();
const cancelRequest = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsBlockHistory: (...args: unknown[]) => vcsBlockHistory(...args),
      cancelRequest: (id: number) => cancelRequest(id),
    },
  };
});
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({
    input,
  }: {
    input: { data: { left: { label: string; text: string }; right: { label: string; text: string } } };
  }) => (
    <div data-testid="diff">
      {`${input.data.left.label}: ${input.data.left.text}| ${input.data.right.label}: ${input.data.right.text}`}
    </div>
  ),
}));

import { SelectionHistoryEditor, blockOf, historyRows } from "../SelectionHistory";
import { selectedLines, selectionHistoryInput, type SelectionHistoryData } from "../selectionHistoryKind";

const revision = (id: string, summary: string, before: string, after: string): BlockRevision => ({
  id: id.repeat(40),
  shortId: id.repeat(7),
  author: "Ada",
  email: "ada@example.com",
  timeMs: 1_700_000_000_000,
  summary,
  path: "src/a.txt",
  before,
  after,
  beforeLine: 1,
  afterLine: 1,
});

const TEXT = "one\nTWO\nTHREE\nfour\n";
const history: BlockHistory = {
  headLines: [1, 2],
  revisions: [
    revision("a", "Shout three", "TWO\nthree\n", "TWO\nTHREE\n"),
    revision("b", "Shout two", "two\nthree\n", "TWO\nthree\n"),
  ],
};
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });

function open(data: SelectionHistoryData) {
  return render(<SelectionHistoryEditor input={selectionHistoryInput(data)} />);
}

beforeEach(() => {
  vcsBlockHistory.mockReset();
  cancelRequest.mockReset().mockReturnValue(ok(null));
});

describe("selected lines", () => {
  const doc = EditorState.create({ doc: "zero\none\ntwo\nthree\n" }).doc;
  it.each([
    ["the caret line without a selection", 6, 6, [1, 1]],
    ["every line the selection touches", 7, 11, [1, 2]],
    ["a selection backwards", 11, 7, [1, 2]],
    ["not the line a selection ends at the start of", 5, 13, [1, 2]],
    ["the line itself when selecting just its start", 9, 9, [2, 2]],
  ])("%s", (_, from, to, expected) => {
    expect(selectedLines(doc, Math.min(from, to), Math.max(from, to))).toEqual(expected);
  });
});

describe("rows", () => {
  it("cuts the block out of the text as Git prints it", () => {
    expect(blockOf(TEXT, [1, 2])).toBe("TWO\nTHREE\n");
    expect(blockOf("a\r\nb\r\n", [0, 1])).toBe("a\nb\n");
  });

  it("lists Local Changes only when the block differs from HEAD", () => {
    expect(historyRows(history, "TWO\nTHREE\n").map((r) => r.kind)).toEqual(["revision", "revision"]);
    const edited = historyRows(history, "TWO\nTHREE!\n");
    expect(edited[0]).toEqual({ kind: "local", head: "TWO\nTHREE\n", current: "TWO\nTHREE!\n" });
    expect(edited).toHaveLength(3);
    expect(historyRows({ headLines: null, revisions: [] }, "new\n")).toEqual([]);
  });
});

describe("History for Selection tab", () => {
  it("asks for the selected lines of the editor's text and diffs each commit's block", async () => {
    vcsBlockHistory.mockReturnValue(ok(history));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: "one\nTWO\nTHREE!\nfour\n" });
    await screen.findByText("Shout three");
    const [request, path, text, lines] = vcsBlockHistory.mock.calls[0]!;
    expect([typeof request, path, text, lines]).toEqual(["number", "/p/src/a.txt", "one\nTWO\nTHREE!\nfour\n", [1, 2]]);
    expect(screen.getByText("a.txt:2-3")).toBeTruthy();
    // The unsaved edit comes first, against HEAD's block.
    expect(screen.getByTestId("diff").textContent).toBe("HEAD: TWO\nTHREE\n| Local Changes: TWO\nTHREE!\n");
    fireEvent.click(screen.getByText("Shout two"));
    await waitFor(() =>
      expect(screen.getByTestId("diff").textContent).toBe("bbbbbbb^: two\nthree\n| bbbbbbb: TWO\nthree\n"),
    );
    expect(screen.getByText(/^bbbbbbb · Ada · /)).toBeTruthy();
  });

  it("says why there is nothing to show", async () => {
    vcsBlockHistory.mockReturnValue(ok({ headLines: null, revisions: [] }));
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "new\n" });
    await screen.findByText("These lines are not committed yet");
    unmount();
    vcsBlockHistory.mockReturnValue(ok({ headLines: [0, 0], revisions: [] }));
    open({ path: "/p/a.txt", lines: [0, 0], text: "old\n" });
    await screen.findByText("No commits changed these lines");
  });

  it("shows Git's error and cancels a request still running when closed", async () => {
    vcsBlockHistory.mockReturnValueOnce(
      Promise.resolve({ status: "error", error: { kind: "internal", message: "fatal: bad range" } }),
    );
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "x\n" });
    await screen.findByText(/fatal: bad range/);
    unmount();
    expect(cancelRequest).not.toHaveBeenCalled();
    vcsBlockHistory.mockReturnValue(new Promise(() => {}));
    open({ path: "/p/a.txt", lines: [0, 0], text: "x\n" }).unmount();
    expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistory.mock.calls.at(-1)![0]);
  });
});
