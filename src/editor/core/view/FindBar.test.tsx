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
import { findExtension, findResultLines, findScope, setFindScope } from "../cm/find";
import {
  FindPanel,
  findWordAtCaret,
  searchAgain,
  seedFind,
  useFindOptions,
  useFindPreferences,
  useFindSessions,
  type FindTarget,
} from "./FindBar";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useFindOptions.setState({ search: "", regexp: false, caseSensitive: false, wholeWord: false, context: "any" });
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

describe("Find Word at Caret", () => {
  function editor(doc: string, anchor: number, head = anchor) {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, selection: { anchor, head }, extensions: [findExtension()] }),
    });
    const target: FindTarget = { id: "word", view: () => view, watch: () => () => {}, isOpen: () => false };
    disposers.push(() => view.destroy());
    return { view, target };
  }
  const selected = (view: EditorView) => {
    const { from, to } = view.state.selection.main;
    return [from, to];
  };

  it("finds the next occurrence of the word around the caret and makes it the last search", () => {
    const { view, target } = editor("foo bar foo\nfoo", 1);
    expect(findWordAtCaret(target, true)).toBe(true);
    expect(selected(view)).toEqual([8, 11]);
    expect(useFindOptions.getState().search).toBe("foo");
    // Find Next goes on with it, wrapping to the start.
    searchAgain(target, true);
    expect(selected(view)).toEqual([12, 15]);
    searchAgain(target, true);
    expect(selected(view)).toEqual([0, 3]);
  });

  it("Find Previous Word at Caret searches backwards, wrapping to the end", () => {
    const { view, target } = editor("foo bar foo\nfoo", 13);
    expect(findWordAtCaret(target, false)).toBe(true);
    expect(selected(view)).toEqual([8, 11]);
    const first = editor("foo bar foo\nfoo", 1);
    findWordAtCaret(first.target, false);
    expect(selected(first.view)).toEqual([12, 15]);
  });

  it("takes the word ending or starting at the caret", () => {
    const end = editor("foo foo", 3);
    findWordAtCaret(end.target, true);
    expect(selected(end.view)).toEqual([4, 7]);
    // As in IDEA, the search starts at the caret: at a word's start that word is the next match.
    const start = editor("foo foo", 4);
    findWordAtCaret(start.target, true);
    expect(selected(start.view)).toEqual([4, 7]);
  });

  it("matches case, not whole words, and literally, whatever the last search used", () => {
    useFindOptions.setState({ caseSensitive: false, wholeWord: true, regexp: true, context: "inComments" });
    const { view, target } = editor("foo Foo foobar", 1);
    findWordAtCaret(target, true);
    expect(selected(view)).toEqual([8, 11]);
    expect(useFindOptions.getState()).toMatchObject({
      search: "foo",
      caseSensitive: true,
      wholeWord: false,
      regexp: false,
      context: "any",
    });
  });

  it("searches for the selected text instead of a word", () => {
    const { view, target } = editor("a.b axb a.b", 0, 3);
    findWordAtCaret(target, true);
    expect(selected(view)).toEqual([8, 11]);
    expect(useFindOptions.getState().search).toBe("a.b");
  });

  it("reads identifiers with $, _, digits and non-Latin letters as one word", () => {
    const ident = editor("$el_1 = $el_1 + el", 2);
    findWordAtCaret(ident.target, true);
    expect(selected(ident.view)).toEqual([8, 13]);
    const cyrillic = editor("привет мир привет", 2);
    findWordAtCaret(cyrillic.target, true);
    expect(selected(cyrillic.view)).toEqual([11, 17]);
  });

  it("does nothing without a word at the caret", () => {
    useFindOptions.setState({ search: "keep" });
    const { view, target } = editor("foo  + foo", 5);
    expect(findWordAtCaret(target, true)).toBe(false);
    expect(selected(view)).toEqual([5, 5]);
    expect(useFindOptions.getState().search).toBe("keep");
  });

  it("searches the whole file even when the bar was limited to a selection", () => {
    const { view, target } = editor("foo x foo y foo", 1);
    view.dispatch({ effects: setFindScope.of({ from: 0, to: 9 }) });
    findWordAtCaret(target, false);
    expect(selected(view)).toEqual([12, 15]);
    expect(view.state.field(findScope, false)).toBeNull();
  });

  it("puts the word into an open bar", () => {
    const { view, target } = editor("alpha beta alpha beta", 7);
    seedFind(target, false);
    act(() => useFindSessions.setState({ word: { ...useFindSessions.getState().word!, search: "other" } }));
    render(<FindPanel target={target} version={0} replace={false} seq={0} onClose={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Find" });
    act(() => void findWordAtCaret({ ...target, isOpen: () => true }, true));
    expect(field).toHaveValue("beta");
    expect(useFindSessions.getState().word?.search).toBe("beta");
    expect(selected(view)).toEqual([17, 21]);
    expect(screen.getByRole("button", { name: /Match Case/ })).toHaveAttribute("aria-pressed", "true");
  });
});
