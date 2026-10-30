import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, lineNumbers } from "@codemirror/view";
import { breakpointGutter, lookOf } from "../editor/breakpointGutter";
import { executionPoint } from "../editor/execution";
import { breakpointsOf, loadBreakpoints, toggleBreakpoint, updateBreakpoint } from "../breakpoints/store";
import { adoptSession, useExecutionPoint, useDebug, handleDebugEvent } from "../state";
import { getContext } from "@/platform/context";
import styles from "../editor/editor.module.css";

const ctx = { doc: 1, path: "/proj/a.py", language: "python", uiMode: null, readOnly: false };
const views: EditorView[] = [];

function makeView(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [lineNumbers(), breakpointGutter(ctx), executionPoint(ctx)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushFrame = () => new Promise((r) => requestAnimationFrame(r));

function gutterClasses(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].map((e) => e.className);
}

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.restoreAllMocks();
});

describe("breakpoint gutter", () => {
  it("renders markers as classes on line numbers and tracks edits", async () => {
    localStorage.clear();
    loadBreakpoints("/proj");
    const view = makeView("a\nb\nc\nd\ne");
    toggleBreakpoint(ctx.path, 2);
    await flush();
    expect(gutterClasses(view).filter((c) => c.includes(styles.bp!))).toHaveLength(1);
    // The number text is still rendered.
    expect(view.dom.querySelector(`.cm-lineNumbers .${styles.bp}`)?.textContent).toBe("3");

    view.dispatch({ changes: { from: 0, insert: "new\n" } });
    expect(breakpointsOf(ctx.path).map((b) => b.line)).toEqual([3]);

    const bp = breakpointsOf(ctx.path)[0]!;
    updateBreakpoint(ctx.path, bp.id, { enabled: false });
    await flush();
    expect(view.dom.querySelector(`.${styles.disabled}`)?.textContent).toBe("4");
  });
});

describe("breakpoint look", () => {
  it("shows the verified icon only while a session has bound it", () => {
    const b = { id: "1", line: 0, enabled: true, condition: null, logMessage: null, hitCondition: null };
    expect(lookOf(b, undefined, false, false)).toBe("normal");
    expect(lookOf(b, { verified: true } as never, false, true)).toBe("verified");
    expect(lookOf(b, { verified: false } as never, false, true)).toBe("unverified");
    expect(lookOf({ ...b, enabled: false }, { verified: true } as never, false, true)).toBe("disabled");
  });
});

describe("breakpoint click area", () => {
  class Icon extends GutterMarker {
    toDOM() {
      return document.createElement("span");
    }
  }

  it("toggles from empty space in other gutters but leaves their markers alone", () => {
    localStorage.clear();
    loadBreakpoints("/proj");
    const view = new EditorView({
      state: EditorState.create({
        doc: "a\nb",
        extensions: [
          lineNumbers(),
          gutter({
            class: "extra",
            renderEmptyElements: true,
            lineMarker: (_v, line) => (line.from > 0 ? new Icon() : null),
          }),
          breakpointGutter(ctx),
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    const down = (el: Element) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    };
    const cells = view.dom.querySelectorAll(".extra .cm-gutterElement");
    down(cells[cells.length - 1]!.firstElementChild!);
    expect(breakpointsOf(ctx.path)).toHaveLength(0);
    down(cells[0]!);
    expect(breakpointsOf(ctx.path)).toHaveLength(1);
  });
});

describe("breakpoint gutter clicks", () => {
  // Plain and modifier clicks act on release, so a drag over the gutter can select lines.
  const click = (view: EditorView, init: MouseEventInit) => {
    const cell = view.dom.querySelector(".cm-lineNumbers .cm-gutterElement:not([style*='hidden'])")!;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
    cell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...init }));
  };

  it("⇧-click adds a non-suspending logging breakpoint, ⌥-click a temporary one", () => {
    localStorage.clear();
    loadBreakpoints("/proj");
    const view = makeView("a\nb");
    click(view, { shiftKey: true });
    expect(breakpointsOf(ctx.path)[0]).toMatchObject({ line: 0, suspend: false, logHit: true });
    // Modifier clicks leave an existing breakpoint alone; a plain click removes it.
    click(view, { altKey: true });
    click(view, { shiftKey: true });
    expect(breakpointsOf(ctx.path)).toHaveLength(1);
    click(view, {});
    expect(breakpointsOf(ctx.path)).toHaveLength(0);
    click(view, { altKey: true });
    expect(breakpointsOf(ctx.path)[0]).toMatchObject({ line: 0, temporary: true });
  });

  it("middle-click enables / disables an existing breakpoint", () => {
    localStorage.clear();
    loadBreakpoints("/proj");
    const view = makeView("a\nb");
    click(view, { button: 1 });
    expect(breakpointsOf(ctx.path)).toHaveLength(0);
    toggleBreakpoint(ctx.path, 0);
    click(view, { button: 1 });
    expect(breakpointsOf(ctx.path)[0]!.enabled).toBe(false);
    click(view, { button: 1 });
    expect(breakpointsOf(ctx.path)[0]!.enabled).toBe(true);
  });
});

describe("execution point", () => {
  it("highlights the suspended line and shows inline values", async () => {
    const view = makeView("x = 1\ny = x + 1\nprint(y)");
    useExecutionPoint.setState({ path: ctx.path, line: 1, top: true, values: { x: "1", y: "2" } });
    await flush();
    const line = view.dom.querySelectorAll(".cm-line")[1]!;
    expect(line.className).toContain(styles.execLine);
    const inline = [...view.dom.querySelectorAll(`.${styles.inlineValue}`)].map((e) => e.textContent);
    expect(inline).toEqual(["x: 1", "y: 2, x: 1"]);
    useExecutionPoint.setState({ path: null, values: {} });
    await flush();
    expect(view.dom.querySelector(`.${styles.execLine}`)).toBeNull();
  });
});

describe("session events", () => {
  it("tracks pause / continue / termination and publishes context keys", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adoptSession(77);
    handleDebugEvent(77, { kind: "output", category: "stdout", output: "hel" });
    handleDebugEvent(77, { kind: "output", category: "stdout", output: "lo\n" });
    await flushFrame();
    expect(useDebug.getState().console[77]!.map((l) => l.text)).toEqual(["hello\n"]);
    expect(getContext().debugSessionActive).toBe(true);
    handleDebugEvent(77, {
      kind: "stopped",
      threadId: 1,
      reason: "breakpoint",
      description: null,
      allThreadsStopped: true,
    });
    const s = useDebug.getState().sessions[77]!;
    expect(s.status).toBe("paused");
    expect(s.hits).toBe(1);
    expect(getContext().debugSessionPaused).toBe(true);
    handleDebugEvent(77, { kind: "continued", threadId: 1, allThreadsContinued: true });
    expect(useDebug.getState().sessions[77]!.status).toBe("running");
    expect(getContext().debugSessionPaused).toBe(false);
    handleDebugEvent(77, { kind: "exited", code: 0 });
    handleDebugEvent(77, { kind: "terminated" });
    expect(useDebug.getState().sessions[77]!.status).toBe("terminated");
    expect(getContext().debugSessionActive).toBe(false);
  });

  it("ignores sessions this window did not start, but adopts children of its own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adoptSession(90, { name: "app", adapter: "js-debug" });
    // Another window's session: no session, no console, no tool window.
    handleDebugEvent(91, { kind: "started", name: "other", adapter: "debugpy", parent: null });
    handleDebugEvent(91, {
      kind: "stopped",
      threadId: 1,
      reason: "breakpoint",
      description: null,
      allThreadsStopped: true,
    });
    handleDebugEvent(91, { kind: "output", category: "stdout", output: "x\n" });
    expect(useDebug.getState().sessions[91]).toBeUndefined();
    expect(useDebug.getState().console[91]).toBeUndefined();
    // A child of someone else's session is not ours either.
    handleDebugEvent(93, { kind: "started", name: "child", adapter: "debugpy", parent: 91 });
    expect(useDebug.getState().sessions[93]).toBeUndefined();
    // A child the adapter of our session started is adopted with its parent.
    handleDebugEvent(92, { kind: "started", name: "worker", adapter: "js-debug", parent: 90 });
    handleDebugEvent(92, { kind: "output", category: "stdout", output: "child\n" });
    await flushFrame();
    const child = useDebug.getState().sessions[92]!;
    expect([child.name, child.parent, child.status]).toEqual(["worker", 90, "running"]);
    expect(useDebug.getState().console[92]!.map((l) => l.text)).toEqual(["child\n"]);
    handleDebugEvent(92, { kind: "terminated" });
    handleDebugEvent(90, { kind: "terminated" });
    expect(getContext().debugSessionActive).toBe(false);
  });
});
