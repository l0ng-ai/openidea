import { afterEach, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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
it("adds no style rules to the page for another diff", async () => {
  render(<DiffEditor input={input("diff:first")} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(2));
  const before = rules();
  render(<DiffEditor input={input("diff:second")} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(4));
  expect(rules()).toBe(before);
});
