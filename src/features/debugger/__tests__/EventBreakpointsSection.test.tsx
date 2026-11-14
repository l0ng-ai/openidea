import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { EventBreakpointsSection } from "../js/EventBreakpointsSection";
import { forgetRefusals, setRefused } from "../js/refusals";

afterEach(() => forgetRefusals(4));

describe("JavaScript events and requests section", () => {
  it("says so when the debugger of a page does not take these breakpoints", () => {
    render(<EventBreakpointsSection />);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => setRefused(4, "eventBreakpoints", "unknown request"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The debugger of the running page does not take these breakpoints: unknown request",
    );
    act(() => setRefused(4, "eventBreakpoints", null));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
