import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SqlHighlight } from "./SqlHighlight";

describe("SQL filter highlighting", () => {
  it("uses the console SQL language and theme to highlight keywords, strings and numbers", async () => {
    const { container } = render(<SqlHighlight text="name = 'active' AND id > 12" />);
    await waitFor(() => expect(container.querySelectorAll("span[class]").length).toBeGreaterThanOrEqual(3));
    expect(container.textContent).toContain("name = 'active' AND id > 12");
  });
  it("wraps the gaps between tokens so flex layout keeps single spaces", async () => {
    const { container } = render(<SqlHighlight text="age > 20 AND id = 1" />);
    await waitFor(() => expect(container.querySelectorAll("span[class]").length).toBeGreaterThanOrEqual(3));
    const bare = [...container.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
    expect(bare).toEqual([]);
    const spans = [...container.children].filter((n) => n.tagName === "SPAN");
    expect(spans.map((n) => n.textContent).join("")).toBe("age > 20 AND id = 1");
  });
});
