import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { executeAction, registerAction } from "@/platform/actions";
import * as hints from "@/editor/lsp/hint";
import { setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { menuGroupItems } from "@/workbench/contributions";
import { navigationExtension } from "@/editor/lsp/navigation";
import { activate } from "../index";
import { adoptSession, publishContext, useDebug } from "../state";
import { quickEvaluateMouse, quickEvaluateMouseDown } from "../editor/quickEvaluate";
import { useOverlays } from "../ui/popoverStore";

const ipc = vi.hoisted(() => ({
  debugEvaluateIn: vi.fn(async () => ({
    status: "ok",
    data: {
      name: "result",
      value: "42",
      typeName: "int",
      variablesReference: 0,
      evaluateName: null,
    },
  })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});
const editor = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  activeEditor: () => editor.current,
}));

let view: EditorView;
let dispose: () => void;
let uninstall: () => void;
const doc = "total + order.items";
function session(adapter = "debugpy", status: "paused" | "running" | "terminated" = "paused") {
  adoptSession(7, { adapter });
  useDebug.setState((s) => ({ sessions: { 7: { ...s.sessions[7]!, status, selectedFrame: 10 } }, active: 7 }));
  publishContext();
}
function click() {
  const e = new MouseEvent("mousedown", { button: 0, altKey: true, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(e);
  return e;
}
beforeEach(() => {
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, active: null });
  setContext("textEditorActive", true);
  usePlatform.setState({ os: "macos" });
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  dispose = activate();
  uninstall = installKeyboardDispatcher(window);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [navigationExtension(), quickEvaluateMouse()] }),
    parent: document.body,
  });
  editor.current = { view, ctx: { path: "/p/app.py" } };
  vi.spyOn(view, "posAtCoords").mockReturnValue(16);
});
afterEach(() => {
  uninstall();
  dispose();
  view.destroy();
  editor.current = null;
  document.body.replaceChildren();
  useDebug.setState({ sessions: {}, active: null });
  publishContext();
  useKeymap.setState({ overrides: {} });
  vi.restoreAllMocks();
});

describe("paused editor evaluation", () => {
  it.each(["java-debug", "js-debug", "debugpy"])("evaluates the clicked member through %s", async (adapter) => {
    session(adapter);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(click().defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.querySelector(".cm-lsp-hint")?.textContent).toContain("order.items = 42"));
    expect(ipc.debugEvaluateIn).toHaveBeenCalledExactlyOnceWith(7, 10, "order.items", "hover");
    expect(view.state.selection.main.head).toBe(16);
  });

  it.each(["intellij-macos", "intellij-windows"])("preserves a clicked selection with %s", async (preset) => {
    const showHint = vi.spyOn(hints, "showHint");
    useKeymap.setState({ preset });
    session();
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    click();
    await vi.waitFor(() => expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(7, 10, doc, "hover"));
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(doc.length);
    await vi.waitFor(() =>
      expect(showHint).toHaveBeenCalledWith(view, expect.any(Function), { pos: 16, timeout: 60_000 }),
    );
  });

  it("uses a selected expression spanning several lines", async () => {
    session();
    const text = "(total +\n order.items)";
    view.dispatch({ changes: { from: 0, to: doc.length, insert: text }, selection: { anchor: 0, head: text.length } });
    click();
    await vi.waitFor(() => expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(7, 10, text, "hover"));
  });

  it("lets a higher priority custom mouse action win the shared gesture", () => {
    session();
    const run = vi.fn();
    const remove = registerAction({ id: "test.mouseOverride", title: "Custom", run });
    useKeymap.setState({ overrides: { "test.mouseOverride": ["Alt+Button1"] } });
    try {
      click();
      expect(run).toHaveBeenCalledOnce();
      expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it.each(["none", "running", "terminated"] as const)("leaves Option+click to the editor when %s", async (status) => {
    if (status !== "none") session("debugpy", status);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const dispatch = vi.spyOn(view, "dispatch");
    const e = new MouseEvent("mousedown", { button: 0, altKey: true, cancelable: true });
    expect(quickEvaluateMouseDown(e, view)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
  });

  it("honours removal of the mouse binding", () => {
    session();
    useKeymap.setState({ overrides: { "debug.quickEvaluate": ["Meta+Alt+F8"] } });
    click();
    expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
  });

  it.each(["none", "running", "paused", "terminated"] as const)(
    "shows the contributed menu only while paused: %s",
    async (status) => {
      if (status !== "none") session("debugpy", status);
      const items = menuGroupItems("editor", { paths: ["/p/app.py"], text: doc });
      const evaluate = items.find((item) => item.kind === "action" && item.action === "debug.evaluate");
      expect(!!evaluate).toBe(status === "paused");
      if (evaluate) {
        view.dispatch({ selection: { anchor: 16 } });
        await executeAction("debug.evaluate");
        expect(useOverlays.getState().evaluate?.expression).toBe("order.items");
      }
      expect(menuGroupItems("editorTab", { paths: ["/p/app.py"] })).toEqual([]);
    },
  );
});
