import type { Commit } from "@/bindings";
import { ContextMenuHost, hideContextMenu } from "@/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ commits: [] as Commit[], details: vi.fn(), diff: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => ok(api.commits),
      vcsLogRefs: () => ok({}),
      vcsBranches: () => ok([]),
      vcsTags: () => ok([]),
      vcsBranchInfo: () => ok({ upstream: null }),
      vcsConfigGet: () => ok(null),
      vcsCommitFiles: () => ok([{ path: "src/a.ts", kind: "modified", oldPath: null }]),
      vcsLogDetails: () => api.details(),
      vcsInvalidateLogSignatures: (...args: unknown[]) => api.invalidate(...args),
      vcsLogDetailsBatch: async (_repo: string, ids: string[]) => ({
        status: "ok",
        data: await Promise.all(ids.map(async (id) => (await api.details(id)).data)),
      }),
      vcsDiffRevisions: (...args: unknown[]) => api.diff(...args),
    },
  };
});

import { LogView } from "../GitLog";
import { LogScope } from "../LogScope";
import { CommitDetails } from "../log/CommitDetails";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, openLogTab, reloadLog, selectGitTab, useGitLog } from "../logStore";
import { commitKey } from "../multiRoot";
import { useVcs } from "../store";

const c = (id: string, parents: string[] = [], refs: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs,
  author: "Author",
  email: "a@example.com",
  summary: id,
  message: id,
  timeMs: 0,
});

beforeEach(() => {
  api.invalidate.mockReset().mockResolvedValue({ status: "ok", data: null });
  api.commits = [c("tip", ["middle"], ["HEAD"]), c("middle", ["base"]), c("base")];
  api.details.mockReset().mockResolvedValue({
    status: "ok",
    data: {
      message: "tip\n\nFull body loaded on demand",
      containingBranches: ["main"],
      signature: "G",
      signer: "Author",
      key: "key",
      fingerprint: "fingerprint",
    },
  });
  api.diff.mockReset().mockResolvedValue({
    status: "ok",
    data: [
      { path: "src/a.ts", kind: "modified", oldPath: null, before: "p1", after: "merge" },
      { path: "elsewhere/b.ts", kind: "renamed", oldPath: "src/b.ts", before: "p1", after: "merge" },
      { path: "unrelated/c.ts", kind: "added", oldPath: null, before: null, after: "merge" },
    ],
  });
  useVcs.setState({
    root: "/repo",
    repo: "/repo",
    roots: ["/repo"],
    available: true,
    branchesLoaded: true,
    branches: [],
    branch: { head: "main", headCommit: "tip", upstream: null, ahead: 0, behind: 0, operation: null },
  });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    commits: [],
    filters: emptyFilters(),
    selection: [],
    selected: null,
    done: false,
    branchScope: "/repo",
    generation: useGitLog.getState().generation + 1,
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS, showBranches: false, showDetails: false });
});

afterEach(async () => {
  hideContextMenu();
  api.commits = [];
  await reloadLog();
});

describe("log controls", () => {
  it("keeps a pending text edit with its original view when focus changes before the debounce", async () => {
    const other = openLogTab("log", "Other");
    selectGitTab("log");
    render(
      <>
        <LogScope id="log">
          <LogView />
        </LogScope>
        <LogScope id={other}>
          <LogView />
        </LogScope>
      </>,
    );
    const [main, second] = screen.getAllByRole("textbox", { name: "Filter by message" });
    fireEvent.change(main!, { target: { value: "pending" } });
    fireEvent.pointerDown(second!);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(useGitLog.getState().shownLog).toBe(other);
    expect(useGitLog.getState().filters.text).toBe("");
    fireEvent.pointerDown(main!);
    await waitFor(() => expect(useGitLog.getState().filters.text).toBe("pending"));
  });

  it("expands a single collapsed fragment from its node without changing the global option", async () => {
    useLogOptions.setState({ collapseLinear: true });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    const tip = within(list).getAllByRole("option")[0]!;
    fireEvent.click(within(tip).getByRole("button", { name: "Collapse or expand this branch" }));
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    expect(useLogOptions.getState().collapseLinear).toBe(true);
  });

  it("keeps the selected middle commit visible under collapse and supports speed search", async () => {
    useLogOptions.setState({ collapseLinear: true });
    useGitLog.setState({ selected: "/repo\0middle", selection: ["/repo\0middle"] });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    fireEvent.keyDown(list, { key: "b" });
    expect(useGitLog.getState().selected).toBe("/repo\0base");
    expect(screen.getByRole("status")).toHaveTextContent("b");
  });

  it("hides the column headers unless View Options shows them", async () => {
    render(<LogView />);
    await screen.findByRole("listbox", { name: "Commits" });
    expect(screen.queryByRole("separator", { name: "Resize Author column" })).toBeNull();
  });

  it("resizes and reorders columns using the keyboard", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(<LogView />);
    const author = await screen.findByRole("separator", { name: "Resize Author column" });
    fireEvent.keyDown(author, { key: "ArrowLeft" });
    expect(useLogOptions.getState().columnWidths.author).toBe(140);
    fireEvent.keyDown(author, { key: "ArrowRight", altKey: true });
    expect(useLogOptions.getState().columnOrder).toEqual(["subject", "date", "author", "hash"]);
  });

  it.each([{ order: [] }, { order: ["date"] }, { order: ["unknown", "date", "author", "date"] }])(
    "restores an older column order safely: $order",
    async ({ order }) => {
      useLogOptions.setState({ showColumnHeaders: true, columnOrder: order });
      render(<LogView />);
      await screen.findByRole("separator", { name: "Resize Author column" });
      const expected = order.includes("date") ? ["subject", "date", "author"] : ["subject", "author", "date"];
      expect(
        [...document.querySelectorAll<HTMLElement>("[data-log-column]")].map((el) => el.dataset.logColumn),
      ).toEqual(expected);
      const author = screen.getByRole("separator", { name: "Resize Author column" });
      fireEvent.keyDown(author, { key: "ArrowLeft", altKey: true });
      expect(useLogOptions.getState().columnOrder).not.toContain(undefined);
    },
  );

  it("Commit's left divider is header-only, resizes its left neighbour, and is inert when first", async () => {
    // Commit leads by default: its left divider exists but cannot be dragged.
    useLogOptions.setState({ showColumnHeaders: true, columnOrder: ["author", "date"] });
    render(<LogView />);
    const commitBorder = await screen.findByRole("separator", { name: "Commit column border" });
    expect(commitBorder.tabIndex).toBe(-1);
    expect(useLogOptions.getState().columnWidths.author).toBeUndefined();

    // Data rows have no Commit divider.
    expect(document.querySelector('[role="option"] [class*="colSubject"] [class*="columnResize"]')).toBeNull();
  });

  it("dragging Commit's divider grows the column to its left and shrinks Commit", async () => {
    // Put Hash before Commit so the divider has a left neighbour to resize.
    // subject must be listed explicitly after hash, else columnSequence puts it first.
    useLogOptions.setState({
      showColumnHeaders: true,
      showHash: true,
      columnOrder: ["hash", "subject", "author", "date"],
    });
    render(<LogView />);
    const handle = await screen.findByRole("separator", { name: "Resize Commit column" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    // Drag left: the divider follows the pointer, so the left neighbour (Hash)
    // shrinks and Commit (flex) grows. Default Hash width is 72 -> 42.
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 70 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 70 });
    expect(useLogOptions.getState().columnWidths.hash).toBe(42); // 72 - 30
  });

  it("hides column dividers by default and shows them via the option", async () => {
    useLogOptions.setState({ showColumnHeaders: true, showColumnDividers: false });
    const { rerender } = render(<LogView />);
    await screen.findByRole("separator", { name: "Resize Author column" });
    const sep = screen.getByRole("separator", { name: "Resize Author column" });
    // Hit strip and cursor stay active, but no rule is painted by default.
    expect(sep.className).toMatch(/columnResize/);
    expect(sep.closest('[class*="showDividers"]')).toBeNull();
    act(() => useLogOptions.setState({ showColumnDividers: true }));
    rerender(<LogView />);
    expect(
      screen.getByRole("separator", { name: "Resize Author column" }).closest('[class*="showDividers"]'),
    ).not.toBeNull();
  });

  it("hides a column from the header context menu", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(
      <>
        <LogView />
        <ContextMenuHost />
      </>,
    );
    const author = document.querySelector<HTMLElement>('[data-log-column="author"]')!;
    fireEvent.contextMenu(author, { bubbles: true, clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide Column" }));
    expect(useLogOptions.getState().showAuthor).toBe(false);
  });

  it("exposes a full-height column divider on data rows", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(<LogView />);
    await screen.findByRole("separator", { name: "Resize Author column" });
    const header = screen.getByRole("separator", { name: "Resize Author column" });
    expect(header.className).toMatch(/columnResize/);
    // Data rows carry the same strips so the divider — and its visible rule —
    // spans the whole table height, not just the header.
    const rowStrips = [...document.querySelectorAll<HTMLElement>('[role="option"] [class*="columnResize"]')];
    expect(rowStrips.length).toBeGreaterThan(0);
    for (const strip of rowStrips) {
      expect(strip.getAttribute("aria-hidden")).toBe("true");
      expect(strip.className).toMatch(/columnResize/);
    }
  });

  it("resizes from a data-row strip and auto-fits on double-click", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(<LogView />);
    await screen.findByRole("separator", { name: "Resize Author column" });
    const rows = within(screen.getByRole("listbox", { name: "Commits" })).getAllByRole("option");
    const rowStrip = rows[0]!.querySelector<HTMLElement>('[class*="columnResize"]')!;
    const release = vi.fn();
    rowStrip.setPointerCapture = vi.fn();
    rowStrip.hasPointerCapture = () => true;
    rowStrip.releasePointerCapture = release;
    // The strip is on the column's left edge: drag left -> wider.
    fireEvent.pointerDown(rowStrip, { button: 0, pointerId: 5, clientX: 40 });
    fireEvent.pointerMove(rowStrip, { pointerId: 5, clientX: 10 });
    fireEvent.pointerUp(rowStrip, { pointerId: 5, clientX: 10 });
    const resized = useLogOptions.getState().columnWidths.author;
    expect(resized).toBe(160);
    expect(release).toHaveBeenCalledWith(5);

    // Double-clicking the header divider drops the custom width so the column auto-fits.
    const header = screen.getByRole("separator", { name: "Resize Author column" });
    fireEvent.doubleClick(header);
    expect(useLogOptions.getState().columnWidths.author).toBeUndefined();
  });

  it("a divider resizes only the two adjacent columns, not the whole table", async () => {
    // Signature sits between Author and Date. Dragging the Date divider must
    // widen Date and narrow Signature only — Author and Commit stay put.
    useLogOptions.setState({
      showColumnHeaders: true,
      showSignature: true,
      showDate: true,
      columnOrder: ["author", "signature", "date"],
    });
    render(<LogView />);
    const date = await screen.findByRole("separator", { name: "Resize Date column" });
    date.setPointerCapture = vi.fn();
    date.hasPointerCapture = () => true;
    date.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(date, { button: 0, pointerId: 6, clientX: 100 });
    fireEvent.pointerMove(date, { pointerId: 6, clientX: 60 });
    fireEvent.pointerUp(date, { pointerId: 6, clientX: 60 });
    const widths = useLogOptions.getState().columnWidths;
    expect(widths.date).toBe(180); // 140 + 40
    expect(widths.signature).toBe(60); // 100 - 40
    expect(widths.author).toBeUndefined(); // untouched
    expect(widths.subject).toBeUndefined(); // flexible column untouched
  });

  it("keeps pointer resizing separate from reordering and releases its capture on blur", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(<LogView />);
    const author = await screen.findByRole("separator", { name: "Resize Author column" });
    const release = vi.fn();
    author.setPointerCapture = vi.fn();
    author.hasPointerCapture = () => true;
    author.releasePointerCapture = release;
    fireEvent.pointerDown(author, { button: 0, pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(author, { pointerId: 1, clientX: 10 });
    expect(useLogOptions.getState().columnWidths.author).toBe(160);
    fireEvent.blur(window);
    expect(release).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(author, { pointerId: 1, clientX: 100 });
    expect(useLogOptions.getState().columnWidths.author).toBe(160);
    expect(useLogOptions.getState().columnOrder).toEqual(DEFAULT_LOG_OPTIONS.columnOrder);
  });

  it.each(["Escape", "outside", "blur", "pointercancel", "lostpointercapture"])(
    "cancels header dragging on %s",
    async (reason) => {
      useLogOptions.setState({ showColumnHeaders: true, columnOrder: ["subject", "author", "date"] });
      render(<LogView />);
      await screen.findByRole("separator", { name: "Resize Author column" });
      const author = document.querySelector<HTMLElement>('[data-log-column="author"]')!;
      const date = document.querySelector<HTMLElement>('[data-log-column="date"]')!;
      const hit = vi.fn((): Element | null => date);
      const original = document.elementFromPoint;
      document.elementFromPoint = hit;
      const release = vi.fn();
      author.setPointerCapture = vi.fn();
      author.hasPointerCapture = () => true;
      author.releasePointerCapture = release;
      try {
        fireEvent.pointerDown(author, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(author, { pointerId: 1, clientX: 100, clientY: 10 });
        fireEvent.pointerMove(author, { pointerId: 1, clientX: 110, clientY: 10 });
        if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
        else if (reason === "blur") fireEvent.blur(window);
        else if (reason === "outside") hit.mockReturnValue(null);
        else fireEvent(author, new PointerEvent(reason, { bubbles: true, pointerId: 1 }));
        fireEvent.pointerUp(author, { pointerId: 1, clientX: 110, clientY: 10 });
        expect(useLogOptions.getState().columnOrder).toEqual(["subject", "author", "date"]);
        if (reason !== "lostpointercapture") expect(release).toHaveBeenCalledWith(1);
      } finally {
        document.elementFromPoint = original;
      }
    },
  );

  it("moves the commit cell and graph together, persists order, and keeps hidden columns", async () => {
    useLogOptions.setState({ showColumnHeaders: true, columnOrder: ["subject", "hash", "author", "unknown", "date"] });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    const subject = document.querySelector<HTMLElement>('[data-log-column="subject"]')!;
    const date = document.querySelector<HTMLElement>('[data-log-column="date"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => date;
    try {
      fireEvent.pointerDown(subject, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(subject, { pointerId: 1, clientX: 12, clientY: 10 });
      fireEvent.pointerUp(subject, { pointerId: 1, clientX: 12, clientY: 10 });
      expect(useLogOptions.getState().columnOrder[0]).toBe("subject");
      fireEvent.pointerDown(subject, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(subject, { pointerId: 1, clientX: 100, clientY: 10 });
      fireEvent.pointerUp(subject, { pointerId: 1, clientX: 100, clientY: 10 });
    } finally {
      document.elementFromPoint = original;
    }
    expect(useLogOptions.getState().columnOrder).toEqual(["hash", "author", "unknown", "date", "subject"]);
    expect(JSON.parse(localStorage.getItem("openidea.vcs.logOptions")!).columnOrder).toEqual(
      useLogOptions.getState().columnOrder,
    );
    const row = within(list).getAllByRole("option")[0]!;
    expect(row.lastElementChild).toContainElement(within(row).getByLabelText("Commit graph"));
    expect(row.firstElementChild).toHaveTextContent("Author");
    act(() => useLogOptions.setState({ showHash: true }));
    expect([...document.querySelectorAll<HTMLElement>("[data-log-column]")].map((el) => el.dataset.logColumn)).toEqual([
      "hash",
      "author",
      "date",
      "subject",
    ]);
    const hash = screen.getByRole("separator", { name: "Resize Hash column" });
    fireEvent.keyDown(hash, { key: "ArrowLeft", altKey: true });
    expect(useLogOptions.getState().columnOrder).toEqual(["hash", "author", "unknown", "date", "subject"]);
    fireEvent.keyDown(list, { key: "b" });
    expect(useGitLog.getState().selected).toBe("/repo\0base");
  });
});

describe("commit details", () => {
  it("checks visible signatures again when the log is refreshed", async () => {
    api.commits = [c("refresh-signature")];
    let signature = "E";
    api.details.mockImplementation(async () => ({
      status: "ok",
      data: { signature, signer: "", fingerprint: "" },
    }));
    api.invalidate.mockImplementation(async () => {
      signature = "G";
      return { status: "ok", data: null };
    });
    useLogOptions.setState({ showSignature: true });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    expect(await within(list).findByRole("img", { name: "Could not verify" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await within(list).findByRole("img", { name: "Verified" })).toBeVisible();
    expect(api.invalidate).toHaveBeenCalledExactlyOnceWith("/repo");
  });

  it("shows verification icons with signer details and leaves unsigned rows empty", async () => {
    api.commits = [c("verified-tip", ["unsigned-parent"]), c("unsigned-parent")];
    api.details.mockImplementation(async (id: string) => ({
      status: "ok",
      data: {
        signature: id === "verified-tip" ? "G" : "N",
        signer: id === "verified-tip" ? "Test Signer" : "",
        fingerprint: id === "verified-tip" ? "test-fingerprint" : "",
      },
    }));
    useLogOptions.setState({ showSignature: true });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    const verified = await within(list).findByRole("img", { name: "Verified" });
    expect(verified.parentElement).toHaveAttribute(
      "title",
      "Verified\nSigned by Test Signer\nKey fingerprint test-fingerprint",
    );
    expect(within(list).queryByText("Unsigned")).not.toBeInTheDocument();
  });

  it("loads a full body, containing branches, and signature only when details are visible", async () => {
    useGitLog.setState({ selected: "/repo\0tip", selection: ["/repo\0tip"] });
    render(<LogView />);
    await screen.findByRole("listbox", { name: "Commits" });
    expect(api.details).not.toHaveBeenCalled();
    await act(async () => {
      useLogOptions.setState({ showDetails: true });
    });
    expect(await screen.findByText("Full body loaded on demand")).toBeInTheDocument();
    expect(screen.getByText(/Signature.*Verified/)).toBeInTheDocument();
  });

  it("compares real merge parents and retains renamed files under affected-path filtering", async () => {
    const merge = { ...c("merge", ["p1", "p2"]), repo: "/repo", graphParents: ["filtered-base"] };
    useGitLog.setState({
      commits: [merge],
      selected: commitKey(merge),
      selection: [commitKey(merge)],
      filters: { ...emptyFilters(), paths: ["/repo/src"] },
    });
    useLogOptions.setState({ changesFromParents: true, showOnlyAffected: true });
    render(
      <>
        <CommitDetails commits={[merge]} />
        <ContextMenuHost />
      </>,
    );
    expect(await screen.findByText("4 files")).toBeInTheDocument();
    expect(api.diff).toHaveBeenCalledWith("/repo", "p1", "merge");
    expect(screen.queryByText("c.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All Parents" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Parent 2: p2" }));
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith("/repo", "p2", "merge"));
  });
});
