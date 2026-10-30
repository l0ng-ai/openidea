import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ContextMenuHost } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "error", error: "none" }),
      vcsFileAt: (_path: string, rev: string) =>
        Promise.resolve({ status: "ok", data: rev === "A" ? "one\ntwo\nthree\n" : "one\nTWO\nthree\nfour\n" }),
    },
  };
});

import { DiffEditor } from "../DiffEditor";
import { registerDiffViewerProvider, type DiffViewerHost } from "../diffViewerProviders";
import { lineInlays, setLineInlays } from "../lineInlays";
import {
  EMPTY_REVIEW_GUTTER,
  canCreateComment,
  clampToCommentable,
  reviewGutter,
  setReviewGutterState,
  type ReviewGutterState,
} from "../reviewGutter";

const input = (context?: { kind: string }) =>
  ({
    kind: "diff",
    key: "diff:x",
    data: { path: "/p/a.txt", left: { type: "rev", rev: "A" }, right: { type: "rev", rev: "B" }, context },
  }) as unknown as EditorInput;

afterEach(cleanup);

describe("diff viewer providers", () => {
  it("contribute pane extensions, the toolbar, settings and menu items to the diffs they apply to", async () => {
    let host: DiffViewerHost | null = null;
    const detach = vi.fn();
    const dispose = vi.fn();
    const off = registerDiffViewerProvider({
      id: "test",
      create: (data) =>
        data.context?.kind === "test"
          ? {
              extensions: (pane) => EditorView.editorAttributes.of({ "data-pane": `${pane.side}:${pane.unified}` }),
              attach(h) {
                host = h;
                return detach;
              },
              Toolbar: () => <button type="button">Review</button>,
              settingsItems: () => [{ id: "t", label: "Show Review Threads" }],
              contextMenuItems: ({ side, line }) => [{ id: "c", label: `Comment ${side} ${line}` }],
              dispose,
            }
          : null,
    });
    const { unmount } = render(
      <>
        <DiffEditor input={input({ kind: "test" })} />
        <ContextMenuHost />
      </>,
    );
    await screen.findByRole("button", { name: "Review" });
    await waitFor(() => expect(host).not.toBeNull());
    expect([...document.querySelectorAll("[data-pane]")].map((e) => e.getAttribute("data-pane"))).toEqual([
      "left:false",
      "right:false",
    ]);
    const h = host as unknown as DiffViewerHost;
    expect(h.panes().map((p) => p.side)).toEqual(["left", "right"]);
    expect(h.doc("left").toString()).toBe("one\ntwo\nthree\n");
    expect(h.mapLine("left", 2)).toBe(2);
    expect(h.mapLine("right", 2)).toBe(2);
    expect(h.locate("left", 1)).toMatchObject({ pane: { side: "left" }, line: 1 });
    h.reveal("left", 1);
    expect(h.focusedPane().side).toBe("left");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("menuitem", { name: "Show Review Threads" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    const line = [...document.querySelectorAll(".cm-merge-b .cm-line")].find((l) => l.textContent === "three")!;
    fireEvent.contextMenu(line, { clientX: 1, clientY: 1 });
    expect(await screen.findByRole("menuitem", { name: /^Comment right \d$/ })).toBeTruthy();

    unmount();
    expect(detach).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    off();
  });

  it("leave other diffs alone", async () => {
    const create = vi.fn(() => null);
    const off = registerDiffViewerProvider({ id: "none", create });
    render(<DiffEditor input={input()} />);
    await waitFor(() => expect(document.querySelectorAll(".cm-merge-b .cm-line").length).toBeGreaterThan(0));
    expect(create).toHaveBeenCalled();
    expect(document.querySelector("[data-pane]")).toBeNull();
    off();
  });
});

describe("line inlays", () => {
  it("render React content under lines and keep it across updates with the same key", async () => {
    function Counter({ label }: { label: string }) {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {label} {n}
        </button>
      );
    }
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "a\nb\nc", extensions: lineInlays() }),
      parent,
    });
    act(() => view.dispatch({ effects: setLineInlays.of([{ key: "k", line: 1, content: <Counter label="x" /> }]) }));
    const btn = await screen.findByRole("button", { name: "x 0" });
    expect(btn.closest(".cm-lineInlay")!.previousElementSibling?.textContent).toBe("b");
    fireEvent.click(btn);
    act(() => view.dispatch({ effects: setLineInlays.of([{ key: "k", line: 1, content: <Counter label="y" /> }]) }));
    // Same key: the state (1 click) survives the new content.
    expect(await screen.findByRole("button", { name: "y 1" })).toBeTruthy();
    act(() => view.dispatch({ effects: setLineInlays.of([]) }));
    expect(document.querySelector(".cm-lineInlay")).toBeNull();
    view.destroy();
    parent.remove();
  });
});

describe("review gutter", () => {
  const state = (over: Partial<ReviewGutterState> = {}): ReviewGutterState => ({
    ...EMPTY_REVIEW_GUTTER,
    commentable: [
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ],
    ...over,
  });

  it("allows ranges within commentable lines only", () => {
    expect(canCreateComment(state(), { start: 0, end: 2 })).toBe(true);
    expect(canCreateComment(state(), { start: 2, end: 5 })).toBe(true);
    expect(canCreateComment(state(), { start: 2, end: 4 })).toBe(false);
    // A drag stops at the end of the commentable range it started in.
    expect(clampToCommentable(state(), 1, 7)).toBe(2);
    expect(clampToCommentable(state(), 6, 0)).toBe(5);
    expect(clampToCommentable(state(), 5, 7)).toBe(7);
  });

  it("shows comment icons and outlines, and passes the clicks on", () => {
    const toggleComments = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "0\n1\n2\n3\n4\n5\n6\n7\n8",
        extensions: reviewGutter({ requestNewComment: vi.fn(), cancelNewComment: vi.fn(), toggleComments }),
      }),
      parent,
    });
    view.dispatch({
      effects: setReviewGutterState.of(
        state({
          linesWithComments: new Set([1]),
          outlines: [{ key: "n", range: { start: 5, end: 7 }, adjustable: false, tooltip: "fixed" }],
        }),
      ),
    });
    const toggle = view.dom.querySelector<HTMLElement>(".cm-reviewControl-toggle")!;
    expect(toggle).not.toBeNull();
    fireEvent.mouseDown(toggle, { button: 0 });
    expect(toggleComments).toHaveBeenCalledWith(1);
    expect(view.dom.querySelectorAll(".cm-reviewRange")).toHaveLength(3);
    const handles = [...view.dom.querySelectorAll<HTMLElement>(".cm-reviewHandle")];
    expect(handles.map((h) => [h.title, h.dataset.disabled])).toEqual([
      ["fixed", "true"],
      ["fixed", "true"],
    ]);
    view.destroy();
    parent.remove();
  });
});
