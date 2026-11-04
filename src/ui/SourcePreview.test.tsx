import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourcePreview } from "./SourcePreview";

/** A stable loader reference (a new function reloads, like the real module-level ones). */
const loadOf = (content: string) => () => Promise.resolve(content);

describe("SourcePreview", () => {
  it("renders the loaded lines around the current one", async () => {
    const { container } = render(
      <SourcePreview
        path="/p/a.ts"
        line={1}
        load={loadOf("one\ntwo\nthree")}
        highlights={[{ line: 1, ranges: [[0, 3]] }]}
      />,
    );
    await screen.findByText("two");
    expect(container.querySelector('[data-line="1"] mark')?.textContent).toBe("two");
    expect(container.querySelector('[data-line="0"]')?.textContent).toContain("one");
  });

  it("makes its text selectable as a selection boundary", async () => {
    const { container } = render(<SourcePreview path="/p/a.ts" line={0} load={loadOf("// TODO")} />);
    await screen.findByText("// TODO");
    // The scroll pane is a selection scope: drags stay inside, text stays copyable.
    expect(container.querySelector("[data-selection-scope]")).toBeTruthy();
  });
});
