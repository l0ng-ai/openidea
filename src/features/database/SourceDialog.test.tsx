import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceDialog } from "./SourceDialog";

describe("new data source", () => {
  it("does not save passwords unless asked to", () => {
    render(<SourceDialog initial={null} />);
    const boxes = screen.getAllByRole("checkbox", { name: "Save password" }) as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.map((b) => b.checked)).toEqual(boxes.map(() => false));
  });
});
