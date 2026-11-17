import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "../DiffEditor";

afterEach(cleanup);

const pane = (index: number) =>
  EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[index]!)!;

it("keeps text typed into a blank diff while its tab is hidden and unmounted", async () => {
  const input = {
    kind: "diff",
    key: "diff:blank",
    data: {
      path: "",
      left: { type: "text", text: "", label: "", editable: true },
      right: { type: "text", text: "", label: "", editable: true },
    },
  } as unknown as EditorInput;
  const first = render(<DiffEditor input={input} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  act(() => {
    pane(0).dispatch({ changes: { from: 0, insert: "left text" } });
    pane(1).dispatch({ changes: { from: 0, insert: "right text" } });
  });
  first.unmount();

  render(<DiffEditor input={input} />);
  await waitFor(() => expect(pane(0).state.doc.toString()).toBe("left text"));
  expect(pane(1).state.doc.toString()).toBe("right text");
});
