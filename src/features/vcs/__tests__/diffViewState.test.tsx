import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor, type DiffViewState } from "../DiffEditor";

afterEach(cleanup);

const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
const inputFor = (mode: "split" | "unified") =>
  ({
    kind: "diff",
    key: `diff:view-state:${mode}`,
    data: {
      path: "",
      mode,
      left: { type: "text", text: [...lines, "old end"].join("\n"), label: "" },
      right: { type: "text", text: [...lines, "new end"].join("\n"), label: "" },
    },
  }) as unknown as EditorInput;
const input = inputFor("split");

const pane = (index: number) =>
  EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[index]!)!;
const collapsed = () => document.querySelectorAll(".cm-collapsedLines").length;

// An all-in-one diff block scrolled away unmounts; back in view it shows the diff as it was left.
it("keeps a remounted diff's selection and expanded unchanged lines", async () => {
  const viewState: DiffViewState = {};
  const first = render(<DiffEditor input={input} viewState={viewState} fit />);
  await waitFor(() => expect(collapsed()).toBe(2));
  act(() => (document.querySelector(".cm-collapsedLines") as HTMLElement).click());
  expect(collapsed()).toBe(0);
  act(() => pane(1).dispatch({ selection: { anchor: 3, head: 10 } }));
  first.unmount();

  render(<DiffEditor input={input} viewState={viewState} fit />);
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  expect(collapsed()).toBe(0);
  expect(pane(1).state.selection.main).toMatchObject({ anchor: 3, head: 10 });
});

it("keeps them in the unified viewer too", async () => {
  const viewState: DiffViewState = {};
  const unified = inputFor("unified");
  const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
  const first = render(<DiffEditor input={unified} viewState={viewState} fit />);
  await waitFor(() => expect(collapsed()).toBe(1));
  act(() => (document.querySelector(".cm-collapsedLines") as HTMLElement).click());
  expect(collapsed()).toBe(0);
  act(() => view().dispatch({ selection: { anchor: 3, head: 10 } }));
  first.unmount();

  render(<DiffEditor input={unified} viewState={viewState} fit />);
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(1));
  expect(collapsed()).toBe(0);
  expect(view().state.selection.main).toMatchObject({ anchor: 3, head: 10 });
});
