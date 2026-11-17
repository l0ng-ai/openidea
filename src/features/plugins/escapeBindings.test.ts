import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { addEscapeBinding, escapeAction, escapeBindings } from "./escapeBindings";

const off: (() => void)[] = [];
afterEach(() => {
  off.splice(0).forEach((dispose) => dispose());
  setContext("plugin.scope.active", false);
});

const escape = (view: EditorView) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Escape", keyCode: 27 }), "editor");

describe("plugin Escape bindings", () => {
  it("run only after the editor's own Escape handling found nothing to do", () => {
    const run = vi.fn();
    off.push(registerAction({ id: "plugin.scope.clear", title: "Clear", run }));
    off.push(addEscapeBinding("plugin.scope.clear", "plugin.scope.active"));
    const view = new EditorView({
      state: EditorState.create({
        doc: "one two",
        selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
        extensions: [EditorState.allowMultipleSelections.of(true), escapeBindings, keymap.of(defaultKeymap)],
      }),
    });
    setContext("plugin.scope.active", true);
    // Extra carets first: Escape keeps the main one, the plugin is not asked.
    expect(escape(view)).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(escape(view)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    // Its `when` is false: Escape is left to whatever else handles it.
    setContext("plugin.scope.active", false);
    expect(escape(view)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("prefers the latest binding whose when holds and skips missing actions", () => {
    off.push(registerAction({ id: "plugin.a.clear", title: "A", run: () => {} }));
    off.push(registerAction({ id: "plugin.b.clear", title: "B", run: () => {} }));
    off.push(addEscapeBinding("plugin.a.clear", "plugin.scope.active"));
    const b = addEscapeBinding("plugin.b.clear", "plugin.scope.active");
    off.push(addEscapeBinding("plugin.gone.clear", "plugin.scope.active"));
    setContext("plugin.scope.active", true);
    expect(escapeAction()).toBe("plugin.b.clear");
    b();
    expect(escapeAction()).toBe("plugin.a.clear");
  });
});
