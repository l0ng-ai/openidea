import { afterEach, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fontExtension } from "@/editor/core/cm/setup";
import type { EditorSettings } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "../DiffEditor";

afterEach(cleanup);

const input = (key: string) =>
  ({
    kind: "diff",
    key,
    data: {
      path: "",
      left: { type: "text", text: "one\ntwo\n", label: "" },
      right: { type: "text", text: "one\nthree\n", label: "" },
    },
  }) as unknown as EditorInput;

const rules = () =>
  [...document.styleSheets].reduce((n, sheet) => n + sheet.cssRules.length, 0) +
  (document.adoptedStyleSheets ?? []).reduce((n, sheet) => n + sheet.cssRules.length, 0);

// A theme created per editor adds its rules to the page again, and the browser then restyles every
// element: in the all-in-one diff that was about 90 ms per file block mounted while scrolling.
it.each([false, true])("adds no style rules to the page for another diff (fit: %s)", async (fit) => {
  render(<DiffEditor input={input("diff:first")} fit={fit} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(2));
  const before = rules();
  render(<DiffEditor input={input("diff:second")} fit={fit} />);
  render(<DiffEditor input={input("diff:third")} fit={fit} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(6));
  expect(rules()).toBe(before);
});

// Every diff pane carries the editor font settings (`viewerEditorLook`), which the app always has.
it("adds no style rules for another editor with the same font settings", () => {
  const settings = { fontSize: 15, lineHeight: 22 } as EditorSettings;
  const mount = () =>
    new EditorView({ state: EditorState.create({ extensions: fontExtension(settings) }), parent: document.body });
  const views = [mount()];
  const before = rules();
  views.push(mount(), mount());
  expect(rules()).toBe(before);
  views.forEach((v) => v.destroy());
});
