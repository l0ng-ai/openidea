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
import { formatInlineBlame, inlineBlame, relativeBlameDate } from "../inlineBlame";
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

function settings(enabled: boolean) {
  useProject.setState({ settings: { vcs: { git: { inlineBlame: enabled } } } as Settings });
}

function editor(doc = "one\ntwo\nthree", context = ctx) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [inlineBlame(context)] }),
  });
  return view;
}

const hint = () => view?.dom.querySelector<HTMLElement>(".cm-vcs-inline-blame");
const tick = () => vi.advanceTimersByTimeAsync(300);

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
    await tick();
    expect(hint()?.textContent).toContain("Alice Smith");
    expect(mocks.blame).toHaveBeenCalledTimes(1);
    expect(mocks.file).toHaveBeenCalledTimes(1);
    expect(hint()?.contentEditable).toBe("false");
    hint()?.click();
    expect(mocks.action).toHaveBeenCalledWith("vcs.showCommit", alice.commit);
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
    activateHover(v, 3, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(true);
    const tooltip = v.dom.querySelector(".cm-vcs-inline-blame-tooltip");
    expect(tooltip?.textContent).toContain(message);
    expect(tooltip?.textContent).toContain(alice.author);
    expect(tooltip?.textContent).toContain(alice.commit);
    expect(tooltip?.textContent).toContain(new Date(alice.timeMs!).toLocaleString());
    v.dispatch({ effects: closeHoverTooltips });
    activateHover(v, 3, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    v.dispatch({ selection: { anchor: 4 } });
    expect(hasHoverTooltips(v.state)).toBe(false);
  });

  it("closes an open tooltip when the setting is disabled", async () => {
    mocks.log.mockResolvedValue({ status: "ok", data: [{ message: "Full message" }] });
    const v = editor();
    await tick();
    activateHover(v, 3, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasHoverTooltips(v.state)).toBe(true);
    settings(false);
    expect(hasHoverTooltips(v.state)).toBe(false);
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
    /** Stands in for the code-vision anchor's inner box (jsdom has no layout, so it is 120px wide). */
    class FakeHint extends WidgetType {
      toDOM() {
        const el = document.createElement("span");
        el.className = "cm-openidea-lensInlineInner";
        el.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
        return el;
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
    expect(hint()!.style.marginLeft).toBe("");

    // the hint shows up only after the blame mounted — the blame must still step past it
    view.dispatch({
      effects: lens.reconfigure(
        EditorView.decorations.of(Decoration.set([Decoration.widget({ widget: new FakeHint(), side: 1 }).range(0)])),
      ),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(view.dom.querySelector(".cm-openidea-lensInlineInner")).not.toBeNull();
    expect(hint()!.style.marginLeft).toBe("calc(3ch + 120px)");

    // and it gives the space back when the hint goes away
    view.dispatch({ effects: lens.reconfigure([]) });
    await vi.advanceTimersByTimeAsync(10);
    expect(hint()!.style.marginLeft).toBe("");
  });
});
