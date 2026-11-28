import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocFindBar } from "./DocFindBar";

function Harness({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = createRef<HTMLInputElement>();
  return (
    <DocFindBar
      query={query}
      onChange={setQuery}
      count={3}
      active={active}
      inputRef={inputRef}
      onNext={() => setActive((value) => (value + 1) % 3)}
      onPrevious={() => setActive((value) => (value + 2) % 3)}
      onClose={onClose}
    />
  );
}

describe("Documentation find bar", () => {
  it("shows the query, match count, navigation and no-match state", () => {
    const props = {
      onChange: vi.fn(),
      inputRef: createRef<HTMLInputElement>(),
      onNext: vi.fn(),
      onPrevious: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<DocFindBar {...props} query="beta" count={3} active={0} />);
    expect(screen.getByRole("textbox", { name: "Find in Documentation" })).toHaveValue("beta");
    expect(screen.getByRole("status")).toHaveTextContent("1/3");
    expect(screen.getByRole("button", { name: "Previous Match" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next Match" })).toBeEnabled();

    rerender(<DocFindBar {...props} query="missing" count={0} active={-1} />);
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(screen.getByRole("button", { name: "Previous Match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next Match" })).toBeDisabled();
  });

  it("navigates with Enter, Shift+Enter and the buttons, wrapping in both directions", () => {
    render(<Harness onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Find in Documentation" });
    fireEvent.change(input, { target: { value: "beta" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("2/3");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("1/3");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("3/3");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("1/3");

    fireEvent.click(screen.getByRole("button", { name: "Next Match" }));
    expect(screen.getByRole("status")).toHaveTextContent("2/3");
    fireEvent.click(screen.getByRole("button", { name: "Previous Match" }));
    expect(screen.getByRole("status")).toHaveTextContent("1/3");
  });

  it("closes on Escape but leaves Enter on a button to that button", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Find in Documentation" });
    fireEvent.change(input, { target: { value: "beta" } });

    fireEvent.keyDown(screen.getByRole("button", { name: "Next Match" }), { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("1/3");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
