import { describe, expect, it } from "vitest";
import { collapsedSummary } from "./NotebookEditor";

describe("a folded notebook cell", () => {
  it("shows a code cell's first non-blank line and its output count", () => {
    expect(collapsedSummary({ cellType: "code", source: "\n  import pandas as pd\nx = 1", outputs: [{}, {}] })).toEqual(
      {
        text: "import pandas as pd",
        outputs: 2,
      },
    );
  });

  it("shows a Markdown heading without its marks, and no outputs", () => {
    expect(collapsedSummary({ cellType: "markdown", source: "## Results\nbody", outputs: [] })).toEqual({
      text: "Results",
      outputs: 0,
    });
  });

  it("is empty for a blank cell", () => {
    expect(collapsedSummary({ cellType: "code", source: "  \n", outputs: [] })).toEqual({ text: "", outputs: 0 });
  });
});
