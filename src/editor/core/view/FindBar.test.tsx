import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { executeAction, registerAction } from "@/platform/actions";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { getContext } from "@/platform/context";
import { provideFindResults } from "@/workbench/contributions";
import { registerEditorActions } from "../actions";
import { findExtension, findResultLines } from "../cm/find";
import { FindPanel, useFindOptions, useFindPreferences, type FindTarget } from "./FindBar";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useFindOptions.setState({ search: "", regexp: false, caseSensitive: false, wholeWord: false });
  useFindPreferences.setState({ scrollToResults: true });
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
});

function setup() {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "foo\nFOO\nfoo",
      extensions: [findExtension(), EditorState.allowMultipleSelections.of(true)],
    }),
  });
  const target: FindTarget = {
    id: "test-find",
    view: () => view,
    watch: () => () => {},
    isOpen: () => true,
    results: (options) => ({
      title: `Occurrences of '${options.search}'`,
      query: {
        pattern: options.search,
        isRegex: options.regexp,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        include: [],
        exclude: [],
        scope: { kind: "files", paths: ["/a.ts"] },
        maxMatches: 0,
      },
      read: () => ({ path: "/a.ts", relPath: "a.ts", matches: findResultLines(view.state, options) }),
    }),
  };
  disposers.push(() => view.destroy(), registerEditorActions(), installKeyboardDispatcher());
  const panel = render(<FindPanel target={target} version={0} replace={false} seq={0} onClose={() => {}} />);
  disposers.push(panel.unmount);
  return { view, field: screen.getByRole("textbox", { name: "Find" }) };
}

const setSearch = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

describe("Find bar More actions", () => {
  it("opens current results from the menu and reserves Alt+F7 while focused", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const usages = vi.fn();
    disposers.push(provideFindResults(open), registerAction({ id: "find.usages", title: "Find Usages", run: usages }));
    const { field } = setup();
    setSearch(field, "foo");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Open Results in Find Window/ }));
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0].read().matches).toHaveLength(3);
    field.focus();
    fireEvent.keyDown(field, { key: "F7", code: "F7", altKey: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(usages).not.toHaveBeenCalled();
    setSearch(field, "missing");
    fireEvent.keyDown(field, { key: "F7", code: "F7", altKey: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(usages).not.toHaveBeenCalled();
    expect(getContext().findBarHasResults).toBe(false);
  });

  it.each(["intellij-macos", "intellij-windows", "vscode-macos", "vscode-windows", "eclipse-macos", "eclipse-windows"])(
    "exports with Alt+F7 in the %s preset",
    (preset) => {
      useKeymap.setState({ preset });
      const open = vi.fn();
      disposers.push(provideFindResults(open));
      const { field } = setup();
      setSearch(field, "foo");
      fireEvent.keyDown(field, { key: "F7", code: "F7", altKey: true });
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it("honors a rebound shortcut and releases it outside the bar", () => {
    const open = vi.fn();
    const other = vi.fn();
    useKeymap.setState({ overrides: { "find.openInWindow": ["Alt+F8"], "find.usages": ["Alt+F8"] } });
    disposers.push(provideFindResults(open), registerAction({ id: "find.usages", title: "Find Usages", run: other }));
    const { field, view } = setup();
    setSearch(field, "foo");
    fireEvent.keyDown(field, { key: "F8", code: "F8", altKey: true });
    expect(open).toHaveBeenCalledOnce();
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "F8", code: "F8", altKey: true });
    expect(other).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["", "missing", "["])("disables export for %j", async (query) => {
    const user = userEvent.setup();
    const { field } = setup();
    if (query === "[") act(() => useFindOptions.setState({ regexp: true }));
    setSearch(field, query);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: /Open Results in Find Window/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("runs existing multiple cursor actions on the searched editor", async () => {
    const user = userEvent.setup();
    const { field, view } = setup();
    setSearch(field, "foo");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Select All Occurrences/ }));
    expect(view.state.selection.ranges).toHaveLength(2);
    field.focus();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Unselect Occurrence/ }));
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it("turns off incremental selection while retaining results and explicit navigation", async () => {
    const { field, view } = setup();
    await act(async () => {
      await executeAction("find.scrollToResults");
    });
    expect(useFindPreferences.getState().scrollToResults).toBe(false);
    setSearch(field, "foo");
    expect(view.state.selection.main.empty).toBe(true);
    await waitFor(() => expect(screen.getByText("?/3")).toBeInTheDocument());
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(view.state.selection.main.empty).toBe(false);
  });
});
