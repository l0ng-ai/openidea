import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { provideEditorService } from "@/workbench/contributions";
import { FindToolWindow } from "../find/FindToolWindow";
import { disposeFindWindow, openEditorResults, useFindViewOptions } from "../find/windowStore";

afterEach(disposeFindWindow);

it("shows highlighted result lines and navigates on a single click", async () => {
  const openFile = vi.fn(async () => {});
  provideEditorService({
    openFile,
    openInput: async () => {},
    activePath: () => null,
    activeCursor: () => null,
    saveAll: async () => {},
  });
  useFindViewOptions.setState({ preview: false });
  openEditorResults({
    title: "Occurrences of 'foo'",
    query: {
      pattern: "foo",
      isRegex: false,
      wholeWord: true,
      caseSensitive: true,
      include: [],
      exclude: [],
      scope: { kind: "files", paths: ["/p/a.ts"] },
      maxMatches: 0,
    },
    read: () => ({
      path: "/p/a.ts",
      relPath: "a.ts",
      matches: [{ line: 5, text: "  foo()", textOffset: 0, ranges: [[2, 5]] }],
    }),
  });
  render(<FindToolWindow />);
  const match = await screen.findByRole("treeitem", { name: /6.*foo/ });
  expect(match.querySelector("mark")).toHaveTextContent("foo");
  fireEvent.mouseDown(match, { button: 0 });
  expect(openFile).toHaveBeenCalledWith("/p/a.ts", {
    focus: false,
    selection: { line: 5, col: 2, endLine: 5, endCol: 5 },
  });
});
