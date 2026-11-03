import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TodoView, useTodoView, useTodoViewOptions } from "./TodoView";
import { useTodos } from "./store";
import { setLocalChanges } from "@/workbench/contributions";

describe("TodoView", () => {
  it("renders grouped items with the keyword emphasised and filters by keyword", () => {
    act(() =>
      useTodos.setState({
        scannedOnce: true,
        scanned: new Map([
          [
            "/p/src/a.ts",
            [
              { path: "/p/src/a.ts", line: 4, col: 3, keyword: "TODO", text: "TODO: wire it" },
              { path: "/p/src/a.ts", line: 9, col: 3, keyword: "FIXME", text: "FIXME broken" },
            ],
          ],
        ]),
      }),
    );
    render(<TodoView />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("(5, 4)")).toBeInTheDocument();
    expect(screen.getByText(": wire it")).toBeInTheDocument();
    act(() => useTodoView.getState().toggleKeyword("FIXME"));
    expect(screen.getByText("1 item")).toBeInTheDocument();
    act(() => useTodoView.getState().showAll());
  });

  it("lists only changed files on the Changes tab, by change list", () => {
    let clear = () => {};
    act(() => {
      clear = setLocalChanges("vcs", [
        { id: "default", name: "Changes", active: true, files: [{ path: "/p/src/b.ts" }] },
        { id: "ui", name: "UI work", active: false, files: [{ path: "/p/src/a.ts" }] },
      ]);
      useTodos.setState({
        scannedOnce: true,
        scanned: new Map([
          ["/p/src/a.ts", [{ path: "/p/src/a.ts", line: 0, col: 3, keyword: "TODO", text: "TODO a" }]],
          ["/p/src/b.ts", [{ path: "/p/src/b.ts", line: 0, col: 3, keyword: "TODO", text: "TODO b" }]],
        ]),
      });
      useTodoView.getState().setTab("changes");
    });
    render(<TodoView />);
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).toBeNull();
    fireEvent.click(screen.getByLabelText("Changelist"));
    fireEvent.click(screen.getByRole("option", { name: /UI work/ }));
    expect(useTodoView.getState().changelist).toBe("ui");
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("b.ts")).toBeNull();
    act(() => {
      useTodoView.setState({ tab: "project", changelist: null });
      clear();
    });
  });

  it("shows the preview pane and does not autoscroll by default, as IDEA", () => {
    expect(useTodoViewOptions.getState()).toEqual({ preview: true, autoscroll: false });
    render(<TodoView />);
    expect(screen.getByText("Select an item to preview")).toBeInTheDocument();
    act(() => useTodoViewOptions.setState({ preview: false }));
    expect(screen.queryByText("Select an item to preview")).toBeNull();
    act(() => useTodoViewOptions.setState({ preview: true }));
  });

  it("previews read-only until Allow editing is checked", async () => {
    act(() =>
      useTodos.setState({
        scannedOnce: true,
        scanned: new Map([
          ["/p/src/a.ts", [{ path: "/p/src/a.ts", line: 4, col: 3, keyword: "TODO", text: "TODO: x" }]],
        ]),
      }),
    );
    render(<TodoView />);
    // Select the file group so the preview has an item (trees select on mousedown).
    fireEvent.mouseDown(screen.getByText("a.ts").closest("[role=treeitem]")!);
    await screen.findByText("(5, 4)");
    const check = screen.getByLabelText("Allow editing") as HTMLInputElement;
    expect(check.checked).toBe(false);
    // Read-only preview: lines render, no CodeMirror editor.
    expect(document.querySelector(".cm-editor")).toBeNull();
    fireEvent.click(check);
    expect(screen.getByLabelText("Allow editing")).toBeChecked();
    // No document attacher in tests: the editable pane degrades to its error
    // state ("editor not started") instead of crashing.
    await screen.findByText("editor not started");
    // Unchecking returns to the read-only preview.
    fireEvent.click(screen.getByLabelText("Allow editing"));
    await waitFor(() => expect(screen.queryByText("editor not started")).toBeNull());
  });
});
