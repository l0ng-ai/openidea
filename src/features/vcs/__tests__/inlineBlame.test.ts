import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  activateHover,
  closeHoverTooltips,
  hasHoverTooltips,
} from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlameLine, Settings } from "@/bindings";
import { HEAVY_LIMIT, _emitEditorEvent } from "@/editor/api";
import { useProject } from "@/platform/project";
import { useI18n } from "@/platform/i18n";
import {
  formatInlineBlame,
  inlineBlame,
  inlineBlameSegments,
  inlineBlameTheme,
  relativeBlameDate,
} from "../inlineBlame";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ blame: vi.fn(), file: vi.fn(), log: vi.fn(), action: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.action,
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, vcsBlame: mocks.blame, vcsFileAt: mocks.file, vcsLog: mocks.log },
  };
});

const now = Date.UTC(2026, 10, 2, 12);
const alice: BlameLine = {
  commit: "a".repeat(40),
  author: "Alice Smith",
  timeMs: now - 86400_000,
  summary: "First line",
};
const bob: BlameLine = { commit: "b".repeat(40), author: "Bob Jones", timeMs: now - 3600_000, summary: "Second line" };
const uncommitted: BlameLine = { commit: "0".repeat(40), author: "Not Committed Yet", timeMs: now, summary: "" };
const ctx = { doc: 1, path: "/repo/file.ts", language: "typescript", uiMode: null, readOnly: false };
let view: EditorView | undefined;

function settings(enabled: boolean, clickable = true) {
  useProject.setState({
    settings: { vcs: { git: { inlineBlame: enabled, inlineBlameClickable: clickable } } } as Settings,
  });
}

/** Presses the primary button on the label; jsdom has no layout, so the click resolves to `pos`
    the way a browser resolves a point past the line end. */
function pressLabel(v: EditorView, pos: number) {
  vi.spyOn(v, "posAndSideAtCoords").mockReturnValue({ pos, assoc: -1 });
  label()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
}

function editor(doc = "one\ntwo\nthree", context = ctx) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [inlineBlame(context)] }),
  });
  return view;
}

const hint = () => view?.dom.querySelector<HTMLElement>(".cm-vcs-inline-blame");
/** The out-of-flow, absolutely positioned label; the anchor itself is zero-width. */
const label = () => hint()?.firstElementChild as HTMLElement | null;
const tick = () => vi.advanceTimersByTimeAsync(300);
/** The hover belongs to the label: put the pointer on the inner box (the anchor is zero-width). */
const hoverLabel = (v: EditorView, pos: number) => {
  label()!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  activateHover(v, pos, 1);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  useI18n.setState({ locale: "en", texts: {} });
  settings(true);
  useVcs.setState({ available: true, roots: ["/repo"], statusLoaded: true, byPath: new Map(), version: 0 });
  mocks.file.mockResolvedValue({ status: "ok", data: "one\ntwo\nthree" });
  mocks.blame.mockResolvedValue({ status: "ok", data: [alice, bob, uncommitted] });
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  useProject.setState({ settings: null });
  vi.useRealTimers();
});

describe("inline blame formatting", () => {
  it("formats authors, relative dates, summaries and missing dates", () => {
    expect(formatInlineBlame(alice, now)).toBe("Alice Smith, 1 day ago · First line");
    expect(formatInlineBlame({ ...bob, timeMs: null, summary: "Long\nmessage" }, now)).toBe("Bob Jones · Long message");
    expect(formatInlineBlame(uncommitted, now)).toBe("You, now · Uncommitted changes");
    expect(relativeBlameDate(now + 1000, now)).toBe("now");
    expect(relativeBlameDate(now - 120_000, now)).toBe("2 minutes ago");
    expect(relativeBlameDate(now - 400 * 86400_000, now)).toBe("1 year ago");
  });

  it("splits into colourable segments that join back into the original text", () => {
    const joined = (line: Parameters<typeof inlineBlameSegments>[0]) =>
      inlineBlameSegments(line, now)
        .map((s) => s.text)
        .join("");
    expect(joined(alice)).toBe(formatInlineBlame(alice, now));
    expect(joined({ ...bob, timeMs: null, summary: "Long\nmessage" })).toBe("Bob Jones · Long message");
    expect(joined(uncommitted)).toBe("You, now · Uncommitted changes");
    expect(inlineBlameSegments(alice, now)).toEqual([
      { text: "Alice Smith, ", key: "author" },
      { text: "1 day ago · ", key: "date" },
      { text: "First line", key: "subject" },
    ]);
    expect(inlineBlameSegments({ ...bob, summary: "Change subject (#feature-12)" }, now)).toEqual([
      { text: "Bob Jones, ", key: "author" },
      { text: "1 hour ago · ", key: "date" },
      { text: "Change subject", key: "subject" },
      { text: " (#feature-12)", key: "issue" },
    ]);
  });
});

describe("current line decoration", () => {
  it("debounces caret moves and reuses blame for the same document version", async () => {
    const v = editor();
    await vi.advanceTimersByTimeAsync(299);
    expect(mocks.blame).not.toHaveBeenCalled();
    v.dispatch({ selection: { anchor: 4 } });
    await vi.advanceTimersByTimeAsync(299);
    expect(mocks.blame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hint()?.textContent).toContain("Bob Jones");
    v.dispatch({ selection: { anchor: 0 } });
    expect(hint()).toBeNull();
    // The document's blame is already loaded, so the new line shows without the
    // 300 ms debounce that protects a git call (#3396).
    await vi.advanceTimersByTimeAsync(0);
    expect(hint()?.textContent).toContain("Alice Smith");
    expect(mocks.blame).toHaveBeenCalledTimes(1);
    expect(mocks.file).toHaveBeenCalledTimes(1);
    expect(hint()?.contentEditable).toBe("false");
    expect(label()?.className).toBe("cm-vcs-inline-blame-inner");
    expect([...label()!.querySelectorAll("span")].map((s) => s.className)).toEqual([
      "cm-vcs-inline-blame-author",
      "cm-vcs-inline-blame-date",
      "cm-vcs-inline-blame-subject",
    ]);
    // The inner box is the pointer-hit region; the zero-width anchor is not interactive.
    expect(label()?.getAttribute("role")).toBe("button");
    label()!.click();
    expect(mocks.action).toHaveBeenCalledWith("vcs.showCommit", alice.commit);
  });

  it("still debounces the git call after an edit (#3396)", async () => {
    const v = editor();
    await tick();
    mocks.blame.mockClear();
    v.dispatch({ changes: { from: 0, insert: "x" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(mocks.blame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.blame).toHaveBeenCalledTimes(1);
  });

  it("uses only the primary selection and hides multiline selections", async () => {
    const v = editor();
    v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)], 1) });
    await tick();
    expect(hint()?.textContent).toContain("Bob Jones");
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    await tick();
    expect(hint()).toBeNull();
    v.dispatch({ selection: { anchor: 4, head: 6 } });
    await tick();
    expect(hint()?.textContent).toContain("Bob Jones");
  });

  it("loads and caches the full commit message on hover and closes it on caret movement", async () => {
    const message = "First line\n\nThe complete commit body.";
    mocks.log.mockResolvedValue({ status: "ok", data: [{ message }] });
    const v = editor();
    await tick();
    hoverLabel(v, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(true);
    const tooltip = v.dom.querySelector(".cm-vcs-inline-blame-tooltip");
    expect(tooltip?.textContent).toContain(message);
    expect(tooltip?.textContent).toContain(alice.author);
    expect(tooltip?.textContent).toContain(alice.commit);
    expect(tooltip?.textContent).toContain(new Date(alice.timeMs!).toLocaleString());
    v.dispatch({ effects: closeHoverTooltips });
    hoverLabel(v, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    v.dispatch({ selection: { anchor: 4 } });
    expect(hasHoverTooltips(v.state)).toBe(false);
  });

  it("closes an open tooltip when the setting is disabled", async () => {
    mocks.log.mockResolvedValue({ status: "ok", data: [{ message: "Full message" }] });
    const v = editor();
    await tick();
    hoverLabel(v, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(true);
    settings(false);
    expect(hasHoverTooltips(v.state)).toBe(false);
  });

  it("keeps the commit tooltip closed when the pointer is on a line-end lens, not the label", async () => {
    mocks.log.mockResolvedValue({ status: "ok", data: [{ message: "Full message" }] });
    const v = editor();
    await tick();
    // A plugin lens shares the blame's line-end offset; hovering it must not open the blame.
    const lens = document.createElement("span");
    lens.className = "cm-plugin-lens";
    v.dom.querySelector(".cm-line")!.appendChild(lens);
    lens.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    activateHover(v, 3, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(false);
    expect(mocks.log).not.toHaveBeenCalled();
    // Moving onto the label itself still opens it.
    hoverLabel(v, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(true);
  });

  it("refetches edits, saves and VCS refreshes", async () => {
    const v = editor();
    await tick();
    mocks.blame.mockResolvedValue({ status: "ok", data: [uncommitted, bob, uncommitted] });
    v.dispatch({ changes: { from: 0, insert: "x" } });
    expect(hint()).toBeNull();
    await tick();
    expect(mocks.blame).toHaveBeenLastCalledWith(ctx.path, "xone\ntwo\nthree", null);
    expect(hint()?.textContent).toBe("You, now · Uncommitted changes");
    _emitEditorEvent({ type: "docSaved", doc: 1, path: ctx.path });
    await tick();
    useVcs.setState({ version: 1 });
    await tick();
    expect(mocks.blame).toHaveBeenCalledTimes(4);
  });

  it("discards a response from an older document version", async () => {
    let resolve!: (result: { status: "ok"; data: BlameLine[] }) => void;
    mocks.blame.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const v = editor();
    await tick();
    v.dispatch({ changes: { from: 0, insert: "x" } });
    resolve({ status: "ok", data: [alice] });
    await vi.advanceTimersByTimeAsync(0);
    expect(hint()).toBeNull();
    mocks.blame.mockResolvedValue({ status: "ok", data: [uncommitted] });
    await tick();
    expect(hint()?.textContent).toBe("You, now · Uncommitted changes");
  });

  it("coalesces an in-flight blame when the caret moves", async () => {
    let resolve!: (result: { status: "ok"; data: BlameLine[] }) => void;
    mocks.blame.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const v = editor();
    await tick();
    v.dispatch({ selection: { anchor: 4 } });
    await tick();
    resolve({ status: "ok", data: [alice, bob] });
    await vi.advanceTimersByTimeAsync(0);
    expect(hint()?.textContent).toContain("Bob Jones");
    expect(mocks.blame).toHaveBeenCalledTimes(1);
  });

  it("leaves a click on a non-clickable label to the editor, which puts the caret at the line end (#3802)", async () => {
    settings(true, false);
    const v = editor();
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    expect(hint()?.textContent).toContain("Alice Smith");
    expect(label()?.hasAttribute("role")).toBe(false);
    expect(label()?.hasAttribute("tabindex")).toBe(false);
    label()!.click();
    label()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    pressLabel(v, 3);
    expect(v.state.selection.main.head).toBe(3);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("leaves a click on the uncommitted-changes label, which opens nothing, to the editor", async () => {
    const v = editor();
    v.dispatch({ selection: { anchor: 9 } });
    await tick();
    expect(hint()?.textContent).toBe("You, now · Uncommitted changes");
    expect(label()?.hasAttribute("role")).toBe(false);
    pressLabel(v, 13);
    expect(v.state.selection.main.head).toBe(13);
  });

  it("applies the clickable setting to an open editor without another git call", async () => {
    editor();
    await tick();
    expect(label()?.getAttribute("role")).toBe("button");
    settings(true, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(label()?.hasAttribute("role")).toBe(false);
    settings(true, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(label()?.getAttribute("role")).toBe("button");
    label()!.click();
    expect(mocks.action).toHaveBeenCalledWith("vcs.showCommit", alice.commit);
    expect(mocks.blame).toHaveBeenCalledTimes(1);
  });

  it("responds to the setting immediately", async () => {
    settings(false);
    editor();
    await tick();
    expect(mocks.blame).not.toHaveBeenCalled();
    settings(true);
    await tick();
    expect(hint()).not.toBeNull();
    settings(false);
    expect(hint()).toBeNull();
    await tick();
    expect(mocks.blame).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending response after disabling", async () => {
    let resolve!: (result: { status: "ok"; data: BlameLine[] }) => void;
    mocks.blame.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    editor();
    await tick();
    settings(false);
    resolve({ status: "ok", data: [alice] });
    await vi.advanceTimersByTimeAsync(0);
    expect(hint()).toBeNull();
    await tick();
    expect(hint()).toBeNull();
  });

  it.each(["untracked", "ignored"] as const)("skips %s paths", async (unstaged) => {
    useVcs.setState({
      byPath: new Map([[ctx.path, { path: ctx.path, relPath: "file.ts", unstaged, staged: null, renamedFrom: null }]]),
    });
    editor();
    await tick();
    expect(mocks.file).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
  });

  it("skips ignored paths missing from status and HEAD", async () => {
    mocks.file.mockResolvedValue({ status: "ok", data: null });
    editor();
    await tick();
    expect(mocks.blame).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
  });

  it("skips paths outside repositories", async () => {
    editor("one", { ...ctx, path: "/elsewhere/file.ts" });
    await tick();
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("skips large, virtual and read-only documents", async () => {
    editor("x".repeat(HEAVY_LIMIT + 1));
    await tick();
    expect(mocks.file).not.toHaveBeenCalled();
    expect(inlineBlame({ ...ctx, virtual: true })).toEqual([]);
    expect(inlineBlame({ ...ctx, readOnly: true })).toEqual([]);
  });

  it("cancels pending work when the view is destroyed", async () => {
    editor().destroy();
    view = undefined;
    await tick();
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("steps past a code-vision hint, including one that appears after the blame", async () => {
    // jsdom has no layout: the fake hint's inner box is a fixed 120px wide.
    class FakeHint extends WidgetType {
      toDOM() {
        const el = document.createElement("span");
        el.className = "cm-openidea-lensInlineInner";
        el.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
        return el;
      }
    }
    // A plugin's line-end message is a zero-width anchor with its text in an inner box.
    class FakeMessage extends WidgetType {
      toDOM() {
        const anchor = document.createElement("span");
        anchor.className = "cm-plugin-after";
        const inner = document.createElement("span");
        inner.getBoundingClientRect = () => ({ width: 70 }) as DOMRect;
        anchor.append(inner);
        return anchor;
      }
    }
    const lens = new Compartment();
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "one\ntwo\nthree", extensions: [inlineBlame(ctx), lens.of([])] }),
    });
    await tick();
    // the widget measures, and starts observing, in the task after its insertion
    await vi.advanceTimersByTimeAsync(10);
    expect(label()!.style.left).toBe("");

    // the hint shows up only after the blame mounted — the blame must still step past it
    view.dispatch({
      effects: lens.reconfigure(
        EditorView.decorations.of(
          Decoration.set([
            Decoration.widget({ widget: new FakeHint(), side: 1 }).range(3),
            Decoration.widget({ widget: new FakeMessage(), side: 1 }).range(3),
          ]),
        ),
      ),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(view.dom.querySelector(".cm-openidea-lensInlineInner")).not.toBeNull();
    // hint 120px, then the message's 70px: the label steps past the whole chain
    expect(label()!.style.left).toBe("calc(3ch + 190px)");

    // and it gives the space back when the hint and the message go away
    view.dispatch({ effects: lens.reconfigure([]) });
    await vi.advanceTimersByTimeAsync(10);
    expect(label()!.style.left).toBe("");
  });

  it("steps past a folded chip drawn after its anchor, including one that appears later", async () => {
    // jsdom has no layout: the chip's width is faked like the hint boxes above.
    class FakeChip extends WidgetType {
      toDOM() {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.getBoundingClientRect = () => ({ width: 18 }) as DOMRect;
        return el;
      }
    }
    const lens = new Compartment();
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "one\ntwo\nthree", extensions: [inlineBlame(ctx), lens.of([])] }),
    });
    await tick();
    await vi.advanceTimersByTimeAsync(10);
    expect(label()!.style.left).toBe("");

    // The chip lands after the blame's anchor only in a later update (the fold happens after
    // the blame mounted): the blame must still step past it. Side 3 mirrors the production DOM
    // order, where CodeMirror draws the fold's replace widget after the side-1/2 anchors.
    view.dispatch({
      effects: lens.reconfigure(
        EditorView.decorations.of(Decoration.set([Decoration.widget({ widget: new FakeChip(), side: 3 }).range(3)])),
      ),
    });
    await vi.advanceTimersByTimeAsync(10);
    // chip 18px: 3ch gap + chip
    expect(label()!.style.left).toBe("calc(3ch + 18px)");

    // and it gives the space back when the fold expands again
    view.dispatch({ effects: lens.reconfigure([]) });
    await vi.advanceTimersByTimeAsync(10);
    expect(label()!.style.left).toBe("");
  });

  it("is an out-of-flow, zero-width anchor so soft wrap cannot fold it onto a new row", () => {
    const anchor = inlineBlameTheme[".cm-vcs-inline-blame"];
    const inner = inlineBlameTheme[".cm-vcs-inline-blame-inner"];
    // The label no longer takes part in the line's flow: no soft-wrapped continuation row and
    // no line-height stretch, unlike the old in-flow `inline-block; nowrap` label.
    expect(anchor).toMatchObject({ width: "0", position: "relative", display: "inline-block" });
    expect(inner).toMatchObject({ position: "absolute", whiteSpace: "nowrap" });
    // The visible label is the pointer/click region; the anchor stays zero-width.
    expect(inlineBlameTheme['.cm-vcs-inline-blame-inner[role="button"]']).toEqual({ cursor: "pointer" });
  });

  it("caps the commit tooltip's height and scrolls inside it, so a long message stays on screen", () => {
    expect(inlineBlameTheme[".cm-vcs-inline-blame-tooltip"]).toMatchObject({
      maxHeight: expect.any(String),
      overflow: "auto",
    });
  });
});
