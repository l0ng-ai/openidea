import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";
import { useExecutionPoint } from "../state";
import { useOverlays } from "../ui/popoverStore";
import {
  calleeName,
  installSmartStepPicking,
  locateStepTargets,
  smartStepTargets,
  startInlineSmartStep,
  targetsOnLine,
} from "../editor/smartStep";

const ipc = vi.hoisted(() => ({ debugStepInTarget: vi.fn() }));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: Promise<unknown>) => p,
    commands: {
      ...real.commands,
      debugStepInTarget: (...a: unknown[]) => (ipc.debugStepInTarget(...a), Promise.resolve(null)),
    },
  };
});

const target = (id: number, label: string, column: number | null = null, endColumn: number | null = null) => ({
  id,
  label,
  line: null,
  column,
  endColumn,
});

describe("locating Smart Step Into targets", () => {
  it("names the callee of a label", () => {
    expect(calleeName("parse(str(i))")).toBe("parse");
    expect(calleeName("java.lang.String.valueOf(int)")).toBe("valueOf");
    expect(calleeName("<lambda>")).toBeNull();
  });

  it("places targets by name, in line order, or by adapter columns", () => {
    const line = "    x = parse(str(i)) + str (j)";
    const r = locateStepTargets(line, 3, [target(1, "str(i)"), target(2, "parse(str(i))"), target(3, "str(j)")]);
    expect(r).toEqual([
      { id: 2, from: 8, to: 13 },
      { id: 1, from: 14, to: 17 },
      { id: 3, from: 24, to: 27 },
    ]);
    expect(locateStepTargets(line, 3, [target(7, "whatever", 8, 13), target(8, "x", 14)])).toEqual([
      { id: 7, from: 8, to: 13 },
      { id: 8, from: 14, to: 17 },
    ]);
    expect(locateStepTargets(line, 3, [target(1, "missing()")])).toBeNull();
  });

  it("rejects identifier suffixes, preserving UTF-16 offsets and nested calls", () => {
    const line = "𐐀foo() αfoo() $foo() _foo() foo(foo())";
    const from = line.indexOf("foo(foo");
    expect(locateStepTargets(line, 0, [target(1, "foo()"), target(2, "foo()")])).toEqual([
      { id: 1, from, to: from + 3 },
      { id: 2, from: from + 4, to: from + 7 },
    ]);
    expect(targetsOnLine("𐐀foo() bar()", 0, [target(1, "foo()"), target(2, "bar()")]).map((t) => t.id)).toEqual([2]);
  });

  it("keeps only the paused line's calls when the adapter lists the whole function", () => {
    const line = "        total = add(total, square(i))";
    const all = [target(0, "square(i)"), target(1, "add(total, square(i))"), target(2, 'print("total", total)')];
    expect(targetsOnLine(line, 11, all).map((t) => t.id)).toEqual([0, 1]);
    expect(
      targetsOnLine(line, 11, [
        { ...target(5, "print()"), line: 11 },
        { ...target(6, "add()"), line: 12 },
      ]).map((t) => t.id),
    ).toEqual([5]);
    expect(targetsOnLine("pass", 0, all)).toBe(all);
  });
});

describe("picking in the editor", () => {
  const views: EditorView[] = [];
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    cleanup.splice(0).forEach((d) => d());
    views.splice(0).forEach((v) => v.destroy());
    useOverlays.setState({ smartStep: null });
    useExecutionPoint.setState({ path: null, line: 0, top: true, values: {} });
    ipc.debugStepInTarget.mockReset();
  });

  function setup() {
    const ctx = { doc: 1, path: "/p/app.py", language: "python", uiMode: null, readOnly: false };
    const view = new EditorView({
      state: EditorState.create({ doc: "def f():\n    x = parse(str(i))\n", extensions: [smartStepTargets(ctx)] }),
      parent: document.body,
    });
    views.push(view);
    const handle: TextEditorHandle = { view, ctx };
    _addEditor(handle);
    cleanup.push(() => _removeEditor(handle), installSmartStepPicking());
    useExecutionPoint.setState({ path: "/p/app.py", line: 1, top: true });
    return view;
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const key = (k: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  const marked = (view: EditorView) =>
    [...view.dom.querySelectorAll("[data-step-target]")].map((e) => [e.textContent, e.getAttribute("aria-current")]);

  it("highlights the calls, moves with arrows and steps in with Enter", async () => {
    const view = setup();
    expect(startInlineSmartStep(3, 1, [target(1, "str(i)"), target(2, "parse(str(i))")])).toBe(true);
    await flush();
    expect(marked(view)).toEqual([
      ["parse", null],
      ["str", "true"],
    ]);
    key("ArrowLeft");
    await flush();
    expect(marked(view)[0]).toEqual(["parse", "true"]);
    key("Enter");
    expect(ipc.debugStepInTarget).toHaveBeenCalledWith(3, 1, 2);
    expect(useOverlays.getState().smartStep).toBeNull();
    await flush();
    expect(marked(view)).toEqual([]);
  });

  it("Escape cancels; a click on a call steps into it", async () => {
    const view = setup();
    startInlineSmartStep(3, 1, [target(1, "str(i)"), target(2, "parse(str(i))")]);
    key("Escape");
    expect(useOverlays.getState().smartStep).toBeNull();
    expect(ipc.debugStepInTarget).not.toHaveBeenCalled();

    startInlineSmartStep(3, 1, [target(1, "str(i)"), target(2, "parse(str(i))")]);
    await flush();
    const parse = view.dom.querySelector("[data-step-target='2']")!;
    parse.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ipc.debugStepInTarget).toHaveBeenCalledWith(3, 1, 2);
  });

  it("uses the dialog when the line is not open or the calls cannot be placed", () => {
    setup();
    expect(startInlineSmartStep(3, 1, [target(1, "a()"), target(2, "b()")])).toBe(false);
    useExecutionPoint.setState({ path: "/p/other.py" });
    expect(startInlineSmartStep(3, 1, [target(1, "str(i)"), target(2, "parse(str(i))")])).toBe(false);
    expect(useOverlays.getState().smartStep).toBeNull();
  });
});
