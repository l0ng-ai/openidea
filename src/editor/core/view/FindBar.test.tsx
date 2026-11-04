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
import { FindPanel, seedFind, useFindOptions, useFindPreferences, useFindSessions, type FindTarget } from "./FindBar";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useFindOptions.setState({ search: "", regexp: false, caseSensitive: false, wholeWord: false });
  useFindSessions.setState({}, true);
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

describe("Find bars on different editors", () => {
  function editor(id: string, doc: string) {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, extensions: [findExtension()] }),
    });
    const target: FindTarget = { id, view: () => view, watch: () => () => {}, isOpen: () => true };
    disposers.push(() => view.destroy());
    return { view, target };
  }
  const panel = (target: FindTarget) => {
    const r = render(
      <FindPanel key={target.id} target={target} version={target.id} replace={false} seq={0} onClose={() => {}} />,
    );
    return { ...r, field: screen.getByRole("textbox", { name: "Find" }) };
  };

  it("keeps each editor's query and caret", () => {
    const a = editor("a", "alpha\nbeta\nalpha");
    const b = editor("b", "one\ntwo\nalpha\nthree");
    disposers.push(registerEditorActions(), installKeyboardDispatcher());

    seedFind(a.target, false);
    const barA = panel(a.target);
    setSearch(barA.field, "alpha");
    expect(a.view.state.sliceDoc(a.view.state.selection.main.from, a.view.state.selection.main.to)).toBe("alpha");
    barA.unmount();

    // B has its caret on "two"; opening its bar starts from A's search without moving the caret.
    b.view.dispatch({ selection: { anchor: 5 } });
    seedFind(b.target, false);
    const barB = panel(b.target);
    expect(barB.field).toHaveValue("alpha");
    expect(b.view.state.selection.main.head).toBe(5);
    setSearch(barB.field, "three");
    expect(b.view.state.sliceDoc(b.view.state.selection.main.from, b.view.state.selection.main.to)).toBe("three");
    barB.unmount();

    // Back on A: its own query, and showing the bar again leaves the caret where it was.
    a.view.dispatch({ selection: { anchor: 8 } });
    const againA = panel(a.target);
    expect(againA.field).toHaveValue("alpha");
    expect(a.view.state.selection.main.head).toBe(8);
    expect(screen.getByText("?/2")).toBeInTheDocument();
    againA.unmount();
    expect(useFindSessions.getState().b?.search).toBe("three");
    // A new bar starts from the last search, from whichever editor it came.
    expect(useFindOptions.getState().search).toBe("three");
  });

  it("re-seeds an open bar from a new selection without touching other bars", () => {
    const a = editor("a", "alpha beta");
    const b = editor("b", "gamma");
    seedFind(b.target, false);
    act(() => useFindSessions.setState({ b: { ...useFindSessions.getState().b!, search: "gamma" } }));
    seedFind(a.target, false);
    a.view.dispatch({ selection: { anchor: 6, head: 10 } });
    seedFind(a.target, false);
    expect(useFindSessions.getState().a?.search).toBe("beta");
    expect(useFindSessions.getState().b?.search).toBe("gamma");
  });
});
