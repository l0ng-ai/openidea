import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type {
  BlockHistorySummary,
  BlockRevision,
  BlockRevisionSpot,
  BlockRevisionSummary,
  BlockSpotRange,
} from "@/bindings";

const vcsBlockHistory = vi.fn();
const vcsBlockHistorySummary = vi.fn();
const vcsBlockHistoryRevisions = vi.fn();
const vcsBlockHistoryRevisionsAt = vi.fn();
const remoteSession = vi.fn<() => { commands: string[] } | null>(() => null);
const cancelRequest = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsBlockHistorySummary: (...args: unknown[]) => vcsBlockHistorySummary(...args),
      vcsBlockHistoryRevisions: (...args: unknown[]) => vcsBlockHistoryRevisions(...args),
      vcsBlockHistoryRevisionsAt: (...args: unknown[]) => vcsBlockHistoryRevisionsAt(...args),
      vcsBlockHistory: (...args: unknown[]) => vcsBlockHistory(...args),
      cancelRequest: (id: number) => cancelRequest(id),
    },
  };
});
vi.mock("@/platform/remote", () => ({ useRemote: { getState: () => ({ session: remoteSession() }) } }));
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

const defaultRanges: BlockSpotRange[] = [{ path: "src/a.txt", start: 2, end: 3 }];

const summaryOf = (
  { id, shortId, author, email, timeMs, summary }: BlockRevision,
  ranges: BlockSpotRange[] | null = defaultRanges,
): BlockRevisionSummary => ({
  id,
  shortId,
  author,
  email,
  timeMs,
  summary,
  ranges,
});

const spotOf = (r: BlockRevision, ranges: BlockSpotRange[] | null = defaultRanges): BlockRevisionSpot => ({
  id: r.id,
  ranges,
});

const TEXT = "one\nTWO\nTHREE\nfour\n";
const first = revision("a", "Shout three", "TWO\nthree\n", "TWO\nTHREE\n");
const second = revision("b", "Shout two", "two\nthree\n", "TWO\nthree\n");
const anchor = { commit: "a".repeat(40), lines: [1, 2] as [number, number] };
const history: BlockHistorySummary = {
  anchor,
  head: "TWO\nTHREE\n",
  diffs: [first],
  rest: [summaryOf(second)],
};
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });

function open(data: SelectionHistoryData) {
  return render(<SelectionHistoryEditor input={selectionHistoryInput(data)} />);
}

beforeEach(() => {
  vcsBlockHistory.mockReset();
  vcsBlockHistorySummary.mockReset();
  vcsBlockHistoryRevisions.mockReset();
  vcsBlockHistoryRevisionsAt.mockReset();
  remoteSession.mockReset().mockReturnValue(null);
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
    expect(historyRows({ anchor: null, head: null, diffs: [], rest: [] }, "new\n")).toEqual([]);
  });

  it("compares with HEAD's block, not the newest row, when that row is a merge without a diff", () => {
    // `git log -L` prints no patch for a merge, so its row has empty sides.
    const merge = revision("m", "Merge branch 'side'", "", "");
    const merged: BlockHistorySummary = {
      anchor,
      head: "TWO\nTHREE\n",
      diffs: [merge, first],
      rest: history.rest,
    };
    expect(historyRows(merged, "TWO\nTHREE\n").map((r) => r.kind)).toEqual(["revision", "revision", "revision"]);
    expect(historyRows(merged, "TWO\nTHREE!\n")[0]).toEqual({
      kind: "local",
      head: "TWO\nTHREE\n",
      current: "TWO\nTHREE!\n",
    });
  });
});

describe("History for Selection tab", () => {
  it("asks for the selected lines of the editor's text and diffs each commit's block", async () => {
    vcsBlockHistorySummary.mockReturnValue(ok(history));
    vcsBlockHistoryRevisionsAt.mockReturnValue(ok([second]));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: "one\nTWO\nTHREE!\nfour\n" });
    await screen.findByText("Shout three");
    const [request, path, text, lines] = vcsBlockHistorySummary.mock.calls[0]!;
    expect([typeof request, path, text, lines]).toEqual(["number", "/p/src/a.txt", "one\nTWO\nTHREE!\nfour\n", [1, 2]]);
    expect(screen.getByText("a.txt:2-3")).toBeTruthy();
    // The unsaved edit comes first, against HEAD's block.
    expect(screen.getByTestId("diff").textContent).toBe("HEAD: TWO\nTHREE\n| Local Changes: TWO\nTHREE!\n");
    fireEvent.click(screen.getByText("Shout two"));
    await waitFor(() =>
      expect(screen.getByTestId("diff").textContent).toBe("bbbbbbb^: two\nthree\n| bbbbbbb: TWO\nthree\n"),
    );
    const row = screen.getByRole("row", { name: /bbbbbbb.*Ada.*Shout two/ });
    expect(
      within(row)
        .getAllByRole("gridcell")
        .map((cell) => cell.textContent),
    ).toEqual(["bbbbbbb", expect.any(String), "Ada", "Shout two"]);
    expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", [spotOf(second)]);
    fireEvent.click(screen.getByText("Shout three"));
    fireEvent.click(screen.getByText("Shout two"));
    expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(1);
  });

  it("ignores an older response after the user changes revision", async () => {
    const deep = ["c", "d", "e", "f"].map((id, i) => revision(id, `Edit ${i}`, `${id}\n`, `${id}!\n`));
    const long: BlockHistorySummary = {
      anchor,
      head: "TWO\nTHREE\n",
      diffs: [first, second, ...deep.slice(0, 2)],
      rest: deep.slice(2).map((r) => summaryOf(r)),
    };
    vcsBlockHistorySummary.mockReturnValue(ok(long));
    let complete!: (result: { status: string; data: BlockRevision[] }) => void;
    vcsBlockHistoryRevisionsAt.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    await screen.findByText("Edit 3");
    fireEvent.click(screen.getByText("Edit 3"));
    await waitFor(() => expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Shout three"));
    expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistoryRevisionsAt.mock.calls[0]![0]);
    await act(async () => complete({ status: "ok", data: [deep[3]!] }));
    expect(screen.getByTestId("diff").textContent).toBe("aaaaaaa^: TWO\nthree\n| aaaaaaa: TWO\nTHREE\n");
  });

  it("still shows revisions from a released remote server", async () => {
    remoteSession.mockImplementation(() => ({ commands: ["vcs_block_history"] }));
    vcsBlockHistory.mockReturnValue(ok({ headLines: [1, 2], head: "TWO\nTHREE\n", revisions: [first, second] }));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    fireEvent.click(await screen.findByText("Shout two"));
    expect(screen.getByTestId("diff").textContent).toContain("bbbbbbb: TWO");
    expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
    expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();
  });

  it("says why there is nothing to show", async () => {
    vcsBlockHistorySummary.mockReturnValue(ok({ anchor: null, head: null, diffs: [], rest: [] }));
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "new\n" });
    await screen.findByText("These lines are not committed yet");
    unmount();
    vcsBlockHistorySummary.mockReturnValue(ok({ anchor, head: "old\n", diffs: [], rest: [] }));
    open({ path: "/p/a.txt", lines: [0, 0], text: "old\n" });
    await screen.findByText("No commits changed these lines");
  });

  it("shows Git's error and cancels a request still running when closed", async () => {
    vcsBlockHistorySummary.mockReturnValueOnce(
      Promise.resolve({ status: "error", error: { kind: "internal", message: "fatal: bad range" } }),
    );
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "x\n" });
    await screen.findByText(/fatal: bad range/);
    unmount();
    expect(cancelRequest).not.toHaveBeenCalled();
    vcsBlockHistorySummary.mockReturnValue(new Promise(() => {}));
    const pending = open({ path: "/p/a.txt", lines: [0, 0], text: "x\n" });
    await waitFor(() => expect(vcsBlockHistorySummary).toHaveBeenCalledTimes(2));
    pending.unmount();
    expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistorySummary.mock.calls.at(-1)![0]);
  });

  describe("deep rows and prefetching", () => {
    const deep = ["c", "d", "e", "f"].map((id, i) => revision(id, `Edit ${i}`, `${id}\n`, `${id}!\n`));
    const all = [first, second, ...deep];
    const long: BlockHistorySummary = {
      anchor,
      head: "TWO\nTHREE\n",
      diffs: [first, second, ...deep.slice(0, 2)],
      rest: deep.slice(2).map((r) => summaryOf(r)),
    };

    it("reads a deep row's diff immediately from its spot in the summary", async () => {
      vcsBlockHistorySummary.mockReturnValue(ok(long));
      vcsBlockHistoryRevisionsAt.mockReturnValue(ok(deep.slice(2)));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      await screen.findByText("Edit 3");
      fireEvent.click(screen.getByText("Edit 3"));
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toBe("fffffff^: f\n| fffffff: f!\n"));
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", [
        spotOf(deep[2]!),
        spotOf(deep[3]!),
      ]);
      expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
    });

    it("falls back to --skip for rows whose spot is unusable", async () => {
      const unusable: BlockHistorySummary = {
        ...long,
        rest: [summaryOf(deep[2]!), summaryOf(deep[3]!, null)],
      };
      vcsBlockHistorySummary.mockReturnValue(ok(unusable));
      vcsBlockHistoryRevisions.mockReturnValue(ok(deep.slice(2)));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      await screen.findByText("Edit 3");
      fireEvent.click(screen.getByText("Edit 3"));
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toBe("fffffff^: f\n| fffffff: f!\n"));
      expect(vcsBlockHistoryRevisions).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", anchor, 4, [
        deep[2]!.id,
        deep[3]!.id,
      ]);
      expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();
    });

    it("falls back to --skip when a remote server lacks vcs_block_history_revisions_at", async () => {
      remoteSession.mockImplementation(() => ({
        commands: ["vcs_block_history", "vcs_block_history_summary", "vcs_block_history_revisions"],
      }));
      vcsBlockHistorySummary.mockReturnValue(ok(long));
      vcsBlockHistoryRevisions.mockReturnValue(ok(deep.slice(3)));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      fireEvent.click(await screen.findByText("Edit 3"));
      await waitFor(() => expect(vcsBlockHistoryRevisions).toHaveBeenCalled());
      expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();
    });

    it("does not fetch when all diffs arrived with the summary", async () => {
      vcsBlockHistorySummary.mockReturnValue(ok({ anchor, head: "TWO\nTHREE\n", diffs: all, rest: [] }));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      fireEvent.click(await screen.findByText("Edit 3"));
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toBe("fffffff^: f\n| fffffff: f!\n"));
      expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
      expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();
    });

    it("prefetches ahead while stepping down so no spinner appears, and keeps visited rows cached", async () => {
      const makeRev = (i: number): BlockRevision => ({
        id: i.toString(16).padStart(40, "0"),
        shortId: i.toString(16).padStart(7, "0"),
        author: "Ada",
        email: "ada@example.com",
        timeMs: 1_700_000_000_000 - i * 1000,
        summary: `Commit ${i}`,
        path: "src/a.txt",
        before: `before ${i}\n`,
        after: `after ${i}\n`,
        beforeLine: 1,
        afterLine: 1,
      });
      const revs = Array.from({ length: 20 }, (_, i) => makeRev(i));
      const byId = new Map(revs.map((r) => [r.id, r]));
      const paged: BlockHistorySummary = {
        anchor,
        head: "after 0\n",
        diffs: revs.slice(0, 4),
        rest: revs.slice(4).map((r) => summaryOf(r)),
      };
      vcsBlockHistorySummary.mockReturnValue(ok(paged));
      vcsBlockHistoryRevisionsAt.mockImplementation((_req, _path, spots: BlockRevisionSpot[]) =>
        ok(spots.map((s) => byId.get(s.id)!)),
      );

      open({ path: "/p/src/a.txt", lines: [0, 0], text: "after 0\n" });
      await screen.findByText("Commit 0");
      expect(screen.getByTestId("diff").textContent).toContain("after 0");
      expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();

      // Step row-by-row through all 20 rows: prefetching fills each next batch before we land on it,
      // so the diff is immediately visible on every step without ever showing a spinner.
      const stepTo = async (i: number): Promise<void> => {
        if (i >= revs.length) return;
        fireEvent.click(screen.getByText(`Commit ${i}`));
        expect(screen.getByTestId("diff").textContent).toContain(`after ${i}`);
        // Let any background prefetch triggered by landing on row `i` settle before the next step.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        return stepTo(i + 1);
      };
      await stepTo(1);
      const callsAfterForward = vcsBlockHistoryRevisionsAt.mock.calls.length;
      expect(callsAfterForward).toBe(4); // batches [4..8], [8..12], [12..16], [16..20]

      // Stepping back across all 20 rows hits the cache with zero refetches.
      for (let i = revs.length - 2; i >= 0; i--) {
        fireEvent.click(screen.getByText(`Commit ${i}`));
        expect(screen.getByTestId("diff").textContent).toContain(`after ${i}`);
      }
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(callsAfterForward);
    });

    it("prefetches backward while stepping up from the last row with at most one spinner and no refetches", async () => {
      const makeRev = (i: number): BlockRevision => ({
        id: i.toString(16).padStart(40, "0"),
        shortId: i.toString(16).padStart(7, "0"),
        author: "Ada",
        email: "ada@example.com",
        timeMs: 1_700_000_000_000 - i * 1000,
        summary: `Commit ${i}`,
        path: "src/a.txt",
        before: `before ${i}\n`,
        after: `after ${i}\n`,
        beforeLine: 1,
        afterLine: 1,
      });
      const revs = Array.from({ length: 20 }, (_, i) => makeRev(i));
      const byId = new Map(revs.map((r) => [r.id, r]));
      const paged: BlockHistorySummary = {
        anchor,
        head: "after 0\n",
        diffs: revs.slice(0, 4),
        rest: revs.slice(4).map((r) => summaryOf(r)),
      };
      vcsBlockHistorySummary.mockReturnValue(ok(paged));
      const fetchedIds: string[] = [];
      vcsBlockHistoryRevisionsAt.mockImplementation((_req, _path, spots: BlockRevisionSpot[]) => {
        fetchedIds.push(...spots.map((s) => s.id));
        return ok(spots.map((s) => byId.get(s.id)!));
      });

      open({ path: "/p/src/a.txt", lines: [0, 0], text: "after 0\n" });
      await screen.findByText("Commit 0");
      const list = screen.getByRole("rowgroup");

      // Jump to the last row with End (at most one spinner on this initial uncached jump).
      let spinners = 0;
      fireEvent.keyDown(list, { key: "End" });
      if (!screen.queryByTestId("diff")) spinners++;
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toContain("after 19"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Step up through >= 10 rows (18 down to 4) with ArrowUp: never shows a spinner again.
      const stepUp = async (i: number): Promise<void> => {
        if (i < 4) return;
        fireEvent.keyDown(list, { key: "ArrowUp" });
        if (!screen.queryByTestId("diff")) spinners++;
        expect(screen.getByTestId("diff").textContent).toContain(`after ${i}`);
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        return stepUp(i - 1);
      };
      await stepUp(18);
      expect(spinners).toBeLessThanOrEqual(1);
      // Every lazy row was fetched at most once (no refetch of cached rows).
      expect(new Set(fetchedIds).size).toBe(fetchedIds.length);
      const callsAfterUp = vcsBlockHistoryRevisionsAt.mock.calls.length;

      // Stepping back down across cached rows makes zero additional calls.
      for (let i = 5; i < revs.length; i++) {
        fireEvent.keyDown(list, { key: "ArrowDown" });
        expect(screen.getByTestId("diff").textContent).toContain(`after ${i}`);
      }
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(callsAfterUp);
    });

    it("reuses an in-flight batch, hands over urgentRow, and handles jumping away and back", async () => {
      const makeRev = (i: number): BlockRevision => ({
        id: i.toString(16).padStart(40, "0"),
        shortId: i.toString(16).padStart(7, "0"),
        author: "Ada",
        email: "ada@example.com",
        timeMs: 1_700_000_000_000 - i * 1000,
        summary: `Commit ${i}`,
        path: "src/a.txt",
        before: `before ${i}\n`,
        after: `after ${i}\n`,
        beforeLine: 1,
        afterLine: 1,
      });
      const revs = Array.from({ length: 16 }, (_, i) => makeRev(i));
      const paged: BlockHistorySummary = {
        anchor,
        head: "after 0\n",
        diffs: revs.slice(0, 4),
        rest: revs.slice(4).map((r) => summaryOf(r)),
      };
      vcsBlockHistorySummary.mockReturnValue(ok(paged));

      type Reply =
        | { status: "ok"; data: BlockRevision[] }
        | { status: "error"; error: { kind: string; message: string } };
      const pending: Array<(reply: Reply) => void> = [];
      vcsBlockHistoryRevisionsAt.mockImplementation(
        () =>
          new Promise<Reply>((resolve) => {
            pending.push(resolve);
          }),
      );

      open({ path: "/p/src/a.txt", lines: [0, 0], text: "after 0\n" });
      await screen.findByText("Commit 0");

      // Step to Commit 2: triggers background prefetch for [4..8) without resolving it yet.
      fireEvent.click(screen.getByText("Commit 2"));
      await waitFor(() => expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(1));

      // Step onto Commit 4 (inside the in-flight batch): reuses the request (no second call) and shows spinner.
      fireEvent.click(screen.getByText("Commit 4"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(1);
      expect(cancelRequest).not.toHaveBeenCalled();
      expect(screen.queryByTestId("diff")).toBeNull();

      // Jump to Commit 3 (adjacent; still lookahead for [4..8)) and back to Commit 5 (inside [4..8)):
      // still reuses the same in-flight request with no cancel and no second call.
      fireEvent.click(screen.getByText("Commit 3"));
      expect(screen.getByTestId("diff").textContent).toContain("after 3");
      fireEvent.click(screen.getByText("Commit 5"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(1);
      expect(cancelRequest).not.toHaveBeenCalled();

      // Resolve the in-flight request: Commit 5's diff shows immediately.
      await act(async () => pending[0]!({ status: "ok", data: revs.slice(4, 8) }));
      expect(screen.getByTestId("diff").textContent).toContain("after 5");

      // Trigger background prefetch for [8..12) by stepping to Commit 6, then land on Commit 8 so
      // urgentRow is handed over to Commit 8 without a second call; failing that prefetch shows the error.
      fireEvent.click(screen.getByText("Commit 6"));
      await waitFor(() => expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByText("Commit 8"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(2);
      await act(async () => pending[1]!({ status: "error", error: { kind: "internal", message: "git log failed" } }));
      expect(screen.getByText("git log failed")).toBeTruthy();

      // Jump away to unrelated Commit 0 and back to Commit 9 while [8..12) is in flight:
      // jumping away cancels the in-flight request; jumping back starts a fresh one and ignores the cancelled reply.
      fireEvent.click(screen.getByText("Commit 6"));
      await waitFor(() => expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(3));
      fireEvent.click(screen.getByText("Commit 0"));
      expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistoryRevisionsAt.mock.calls[2]![0]);
      fireEvent.click(screen.getByText("Commit 9"));
      await waitFor(() => expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledTimes(4));
      await act(async () => pending[2]!({ status: "ok", data: revs.slice(8, 12) }));
      expect(screen.queryByTestId("diff")).toBeNull();
      await act(async () => pending[3]!({ status: "ok", data: revs.slice(8, 12) }));
      expect(screen.getByTestId("diff").textContent).toContain("after 9");
    });

    it("never evicts the currently displayed row when the cache is full", async () => {
      const makeRev = (i: number): BlockRevision => ({
        id: i.toString(16).padStart(40, "0"),
        shortId: i.toString(16).padStart(7, "0"),
        author: "Ada",
        email: "ada@example.com",
        timeMs: 1_700_000_000_000 - i * 1000,
        summary: `Commit ${i}`,
        path: "src/a.txt",
        before: `before ${i}\n`,
        after: `after ${i}\n`,
        beforeLine: 1,
        afterLine: 1,
      });
      // 72 rows: 4 inline diffs (0..3) + 68 lazy rest rows (4..71). Cache holds 64 lazy rows.
      const revs = Array.from({ length: 72 }, (_, i) => makeRev(i));
      const byId = new Map(revs.map((r) => [r.id, r]));
      const paged: BlockHistorySummary = {
        anchor,
        head: "after 0\n",
        diffs: revs.slice(0, 4),
        rest: revs.slice(4).map((r) => summaryOf(r)),
      };
      vcsBlockHistorySummary.mockReturnValue(ok(paged));
      const fetchedIds: string[] = [];
      vcsBlockHistoryRevisionsAt.mockImplementation((_req, _path, spots: BlockRevisionSpot[]) => {
        fetchedIds.push(...spots.map((s) => s.id));
        return ok(spots.map((s) => byId.get(s.id)!));
      });

      open({ path: "/p/src/a.txt", lines: [0, 0], text: "after 0\n" });
      await screen.findByText("Commit 0");
      const list = screen.getByRole("rowgroup");

      // Load [68..71] first so 68..71 are the 4 oldest entries in the cache.
      fireEvent.keyDown(list, { key: "End" });
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toContain("after 71"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Step down from 0 to 61 to fill the remaining 60 cache slots with [4..63] (total 64 entries;
      // 68..71 are the 4 oldest, and 64..67 are still uncached).
      fireEvent.keyDown(list, { key: "Home" });
      expect(screen.getByTestId("diff").textContent).toContain("after 0");
      const stepDownTo = async (i: number): Promise<void> => {
        if (i > 61) return;
        fireEvent.keyDown(list, { key: "ArrowDown" });
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        return stepDownTo(i + 1);
      };
      await stepDownTo(1);
      expect(screen.getByTestId("diff").textContent).toContain("after 61");

      // Jump back to Commit 71 and step up to Commit 69 (one of the 4 oldest cached entries).
      // Lookahead from 69 prefetches [64..67]; eviction must NOT evict Commit 69 while it is displayed.
      fireEvent.keyDown(list, { key: "End" });
      expect(screen.getByTestId("diff").textContent).toContain("after 71");
      fireEvent.keyDown(list, { key: "ArrowUp" });
      expect(screen.getByTestId("diff").textContent).toContain("after 70");
      const callsBefore = vcsBlockHistoryRevisionsAt.mock.calls.length;
      fireEvent.keyDown(list, { key: "ArrowUp" });
      expect(screen.getByTestId("diff").textContent).toContain("after 69");
      await waitFor(() => expect(vcsBlockHistoryRevisionsAt.mock.calls.length).toBeGreaterThan(callsBefore));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId("diff").textContent).toContain("after 69");
      expect(fetchedIds.filter((id) => id === revs[69]!.id)).toHaveLength(1);
    });
  });
});
