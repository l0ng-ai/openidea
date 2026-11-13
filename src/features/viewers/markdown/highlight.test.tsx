import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setSearchQuery } from "@codemirror/search";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { findExtension, findNext, findPrevious, makeQuery, setFindOpen, type FindOptions } from "@/editor/core/cm/find";
import { fontZoom } from "@/editor/core/cm/prefs";
import { seedFind, useFindOptions, useFindSessions, type FindTarget } from "@/editor/core/view/FindBar";
import { FIND_CURRENT_HIGHLIGHT, FIND_HIGHLIGHT, SELECTION_MATCH_HIGHLIGHT } from "./highlight";
import { registerMarkdownLiveSource, useLiveMarkdown } from "./live";
import { MarkdownEditor } from "./MarkdownEditor";
import { useMarkdownModes } from "./modes";

const path = "/p/README.md";
const ctx: EditorDocContext = { doc: 1, path, language: "markdown", uiMode: null, readOnly: false };

function highlightTexts(name: string): string[] {
  const registry = (globalThis as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
  const set = registry.get(name);
  return set ? [...set].map((r) => r.toString()) : [];
}

const defaultFindOptions: FindOptions = {
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
};

describe("Markdown preview search & selection highlights", () => {
  const disposers: Array<() => void> = [];
  let view: EditorView;

  const openEditor = (doc: string) => {
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [fontZoom, findExtension(), live.extensions(ctx)],
      }),
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    return view;
  };

  beforeEach(() => {
    disposers.push(registerMarkdownLiveSource());
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "preview" } })));
  });

  afterEach(() => {
    cleanup();
    view?.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveMarkdown.setState({}, true);
    useFindOptions.setState({
      search: "",
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
      replace: "",
      context: "any",
      preserveCase: false,
    });
    useFindSessions.setState({}, true);
    window.getSelection()?.removeAllRanges();
  });

  it("highlights all Command+F matches and tracks the current match across steps", () => {
    openEditor("# Hello world\n\nSay **hello** and `HELLO` again.\n");
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );

    act(() => {
      view.dispatch({
        effects: [setFindOpen.of(true), setSearchQuery.of(makeQuery({ ...defaultFindOptions, search: "hello" }))],
      });
      findNext(view);
    });

    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["Hello"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual(["hello", "HELLO"]);

    act(() => {
      findNext(view);
    });
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["hello"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual(["Hello", "HELLO"]);

    act(() => {
      findPrevious(view);
    });
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["Hello"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual(["hello", "HELLO"]);

    act(() => {
      view.dispatch({ effects: setFindOpen.of(false) });
    });
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual([]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual([]);
  });

  it("honours Match Case, Words and Regex options and spans inline markup", () => {
    openEditor("cat scatter **cat**s `cat`12\n");
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );

    // Whole word: matches only the standalone "cat"
    act(() => {
      view.dispatch({
        effects: [
          setFindOpen.of(true),
          setSearchQuery.of(makeQuery({ ...defaultFindOptions, search: "cat", wholeWord: true })),
        ],
      });
      findNext(view);
    });
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["cat"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual([]);

    // Spanning inline markup (`**cat**s`) in the rendered preview
    act(() => {
      view.dispatch({
        effects: [setSearchQuery.of(makeQuery({ ...defaultFindOptions, search: "cats" }))],
      });
    });
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual(["cats"]);

    // Case-sensitive + regex (`cat\d+` does not match because `cat` and `12` are separated by backticks in source,
    // while `cat` with caseSensitive matches all 4 lowercase occurrences)
    act(() => {
      view.dispatch({
        effects: [
          setSearchQuery.of(
            makeQuery({ ...defaultFindOptions, search: "s[a-z]+r", regexp: true, caseSensitive: true }),
          ),
        ],
      });
      findNext(view);
    });
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["scatter"]);
  });

  it("opens a collapsed <details> when stepping to a match inside it", () => {
    openEditor("Outside token\n\n<details>\n<summary>More</summary>\n\nHidden token\n\n</details>\n");
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    const details = preview.querySelector("details")!;
    expect(details.open).toBe(false);

    // First match is outside; the hidden match inside <details> is not painted while closed.
    act(() => {
      view.dispatch({
        effects: [setFindOpen.of(true), setSearchQuery.of(makeQuery({ ...defaultFindOptions, search: "token" }))],
      });
      findNext(view);
    });
    expect(details.open).toBe(false);
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["token"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual([]);

    // Stepping to the second match opens <details> and highlights it as current.
    act(() => {
      findNext(view);
    });
    expect(details.open).toBe(true);
    expect(highlightTexts(FIND_CURRENT_HIGHLIGHT)).toEqual(["token"]);
    expect(highlightTexts(FIND_HIGHLIGHT)).toEqual(["token"]);
  });

  it("auto-highlights all other occurrences when a word is selected in the preview", async () => {
    openEditor("alpha beta alpha gamma alpha\n");
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "split" } })));
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    const p = preview.querySelector("p")!;
    const textNode = p.firstChild as Text;

    // A retained editor selection must not suppress a new preview selection.
    act(() => view.dispatch({ selection: EditorSelection.single(6, 10) }));

    // Select the first "alpha" (0..5) in the preview
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    // The 2 other occurrences in the preview are highlighted, and the split editor highlights all 3.
    expect(highlightTexts(SELECTION_MATCH_HIGHLIGHT)).toEqual(["alpha", "alpha"]);
    await waitFor(() => {
      expect(view.contentDOM.querySelectorAll(".cm-selectionMatch")).toHaveLength(3);
    });

    // Collapsing both selections clears both highlights.
    act(() => view.dispatch({ selection: EditorSelection.cursor(0) }));
    sel.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(highlightTexts(SELECTION_MATCH_HIGHLIGHT)).toEqual([]);
    await waitFor(() => {
      expect(view.contentDOM.querySelectorAll(".cm-selectionMatch")).toHaveLength(0);
    });
  });

  it("auto-highlights occurrences in the preview when a word is selected in the editor", () => {
    openEditor("beta alpha beta\n");
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "split" } })));
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );

    act(() => {
      view.dispatch({ selection: EditorSelection.single(0, 4) });
    });
    expect(highlightTexts(SELECTION_MATCH_HIGHLIGHT)).toEqual(["beta", "beta"]);

    act(() => {
      view.dispatch({ selection: EditorSelection.cursor(0) });
    });
    expect(highlightTexts(SELECTION_MATCH_HIGHLIGHT)).toEqual([]);
  });

  it("refreshes cached ranges after asynchronous preview text changes", async () => {
    openEditor("token\n");
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    act(() => {
      view.dispatch({
        effects: [setFindOpen.of(true), setSearchQuery.of(makeQuery({ ...defaultFindOptions, search: "token" }))],
      });
      findNext(view);
    });
    const paragraph = screen.getByRole("document", { name: "Markdown preview" }).querySelector("p")!;
    paragraph.innerHTML = "new <strong>token</strong>";
    await waitFor(() => {
      const registry = (globalThis as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
      const current = [...registry.get(FIND_CURRENT_HIGHLIGHT)!][0]!;
      expect(current.startContainer.parentElement?.tagName).toBe("STRONG");
      expect(current.toString()).toBe("token");
    });
  });

  it("seeds Command+F from a word selected in the Markdown preview", () => {
    openEditor("first second third\n");
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-id", "pane-1");
    document.body.appendChild(pane);
    disposers.push(() => pane.remove());

    render(
      <MarkdownEditor path={path} tabId="t">
        <div ref={(el) => void (el && view && el.appendChild(view.dom))} />
      </MarkdownEditor>,
      { container: pane },
    );

    const preview = screen.getByRole("document", { name: "Markdown preview" });
    const textNode = preview.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 12);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const target: FindTarget = {
      id: "t",
      view: () => view,
      watch: () => () => {},
      isOpen: () => true,
    };
    act(() => {
      seedFind(target, false);
    });

    expect(useFindSessions.getState().t?.search).toBe("second");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("second");
  });
});
