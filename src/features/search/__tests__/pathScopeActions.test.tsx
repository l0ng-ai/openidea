import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { activate } from "../index";
import { hideFindPopup, useFindPopup } from "../find/store";
import { BookmarksView } from "../bookmarks/BookmarksView";
import { useBookmarks } from "../bookmarks/store";

let dispose: (() => void) | void;
let stopKeys: () => void;

beforeEach(() => {
  dispose = activate();
  stopKeys = installKeyboardDispatcher();
  setContext("projectOpen", true);
  setContext("focusedDirectory", undefined);
  useFindPopup.setState({ open: false, scopeTab: "directory", directory: "ideaIssues", pattern: "" });
});

afterEach(() => {
  stopKeys();
  dispose?.();
  setContext("focusedDirectory", undefined);
  setContext("projectOpen", false);
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
});

describe.each([false, true])("path scope, replace=%s", (replace) => {
  const id = replace ? "find.replaceInPath" : "find.inPath";

  it.each(["intellij-macos", "intellij-windows"])("takes the focused directory through %s shortcuts", (preset) => {
    useKeymap.setState({ preset, overrides: {} });
    setContext("focusedDirectory", "E:/documents/temp/documents");
    fireEvent.keyDown(window, {
      key: replace ? "r" : "f",
      code: replace ? "KeyR" : "KeyF",
      metaKey: preset === "intellij-macos",
      ctrlKey: preset === "intellij-windows",
      shiftKey: true,
    });
    expect(useFindPopup.getState()).toMatchObject({
      open: true,
      replace,
      scopeTab: "directory",
      directory: "E:/documents/temp/documents",
    });
  });

  it("keeps explicit directory/path precedence and a query-only argument", async () => {
    setContext("focusedDirectory", "/selected");
    await executeAction(id, { directory: "/explicit", path: "/legacy", query: "needle" });
    expect(useFindPopup.getState()).toMatchObject({ directory: "/explicit", pattern: "needle" });
    await executeAction(id, { path: "/legacy" });
    expect(useFindPopup.getState().directory).toBe("/legacy");
    await executeAction(id, { query: "other" });
    expect(useFindPopup.getState()).toMatchObject({ directory: "/selected", pattern: "other" });
  });

  it("keeps the previous scope when no path tree owns focus", async () => {
    await executeAction(id);
    expect(useFindPopup.getState()).toMatchObject({ scopeTab: "directory", directory: "ideaIssues" });
    hideFindPopup();
    useFindPopup.setState({ scopeTab: "project" });
    await executeAction(id);
    expect(useFindPopup.getState().scopeTab).toBe("project");
  });

  it("uses bookmark folders, files and line bookmarks, but not lists or editor focus", async () => {
    useBookmarks.setState({
      lists: [{ id: "default", name: "Bookmarks" }],
      defaultList: "default",
      paths: [
        { path: "/p/documents", dir: true, list: "default", created: 1 },
        { path: "/p/src/main.ts", dir: false, list: "default", created: 2 },
      ],
      items: [{ path: "/p/src/main.ts", line: 0, text: "hello", list: "default", created: 3 }],
    });
    render(
      <>
        <BookmarksView />
        <input aria-label="Editor" />
      </>,
    );
    const tree = screen.getByRole("tree", { name: "Bookmarks" });
    tree.focus();
    for (const [key, directory] of [
      ["Home", undefined],
      ["ArrowDown", "/p/documents"],
      ["ArrowDown", "/p/src"],
      ["ArrowDown", "/p/src"],
    ] as const) {
      fireEvent.keyDown(tree, { key });
      expect(getContext().focusedDirectory).toBe(directory);
      await act(() => executeAction(id));
      expect(useFindPopup.getState().directory).toBe(directory ?? "ideaIssues");
      act(() => hideFindPopup());
    }
    screen.getByLabelText("Editor").focus();
    expect(getContext().focusedDirectory).toBeUndefined();
  });
});
