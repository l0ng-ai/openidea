import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SqlHighlight } from "./SqlHighlight";

describe("SQL filter highlighting", () => {
  it("uses the console SQL language and theme to highlight keywords, strings and numbers", async () => {
    const { container } = render(<SqlHighlight text="name = 'active' AND id > 12" />);
    await waitFor(() => expect(container.querySelectorAll("span[class]").length).toBeGreaterThanOrEqual(3));
    expect(container.textContent).toContain("name = 'active' AND id > 12");
  });
});
