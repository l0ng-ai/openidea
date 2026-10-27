import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, _setActiveEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom, setFontZoom } from "@/editor/core/cm/prefs";
import { useContextKeys } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { activate } from "../index";
import { useLiveMarkdown } from "./live";

const ctx: EditorDocContext = { doc: 1, path: "/repo/test.md", language: "markdown", uiMode: null, readOnly: false };

describe("Markdown font zoom", () => {
  let dispose = () => {};
  let uninstall = () => {};
  let view: EditorView | undefined;
  afterEach(() => {
    uninstall();
    _setActiveEditor(null);
    view?.destroy();
    view = undefined;
    dispose();
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
    localStorage.clear();
  });

  it("shares zoom across open Markdown files and restores it when editors are recreated", async () => {
    dispose = activate();
    const extension = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const createView = (context: EditorDocContext) =>
      new EditorView({
        state: EditorState.create({ doc: "# Title", extensions: [fontZoom, extension.extensions(context)] }),
      });
    const otherCtx = { ...ctx, path: "/repo/other.md" };
    view = createView(ctx);
    const other = createView(otherCtx);
    const handle = { view: other, ctx: otherCtx };
    _addEditor(handle);
    view.dispatch({ effects: setFontZoom.of(4) });
    await Promise.resolve();
    expect(other.state.field(fontZoom)).toBe(4);
    expect(useLiveMarkdown.getState()[otherCtx.path]?.fontZoom).toBe(4);
    _removeEditor(handle);
    other.destroy();
    view.destroy();
    useLiveMarkdown.setState({}, true);
    view = createView(otherCtx);
    expect(view.state.field(fontZoom)).toBe(4);
    expect(useLiveMarkdown.getState()[otherCtx.path]?.fontZoom).toBe(4);
    view.dispatch({ effects: setFontZoom.of(0) });
    view.destroy();
    view = createView(ctx);
    expect(view.state.field(fontZoom)).toBe(0);
  });

  it("zooms the editor and publishes the same zoom for the preview only when the editor is focused", async () => {
    dispose = activate();
    const extension = editorContributions()
      .find((c) => c.id === "viewers.markdownLive")!
      .extensions(ctx);
    view = new EditorView({ state: EditorState.create({ doc: "# Title", extensions: [fontZoom, extension] }) });
    _setActiveEditor({ view, ctx });
    useContextKeys.setState({ textEditorActive: true, editorLangId: "markdown", editorFocus: true });
    useKeymap.setState({ preset: "intellij-macos", overrides: {} });
    uninstall = installKeyboardDispatcher(window);
    const press = (code: string, key: string, shiftKey = false) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code, key, metaKey: true, shiftKey, cancelable: true }));
    press("Equal", "=");
    await Promise.resolve();
    expect(view.state.field(fontZoom)).toBe(1);
    expect(useLiveMarkdown.getState()[ctx.path]?.fontZoom).toBe(1);
    press("Equal", "+", true);
    await Promise.resolve();
    expect(view.state.field(fontZoom)).toBe(2);
    press("Minus", "-");
    await Promise.resolve();
    expect(useLiveMarkdown.getState()[ctx.path]?.fontZoom).toBe(1);
    view.dispatch({ effects: setFontZoom.of(36) });
    press("Equal", "=");
    await Promise.resolve();
    expect(view.state.field(fontZoom)).toBe(36);
    useContextKeys.setState({ editorFocus: false });
    press("Minus", "-");
    await Promise.resolve();
    expect(view.state.field(fontZoom)).toBe(36);
  });
});
