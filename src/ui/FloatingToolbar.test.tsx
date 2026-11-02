import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FloatingToolbar } from "./FloatingToolbar";
import styles from "./FloatingToolbar.module.css";

function Fixture({ hideOnTyping = true }: { hideOnTyping?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="editor">
      <input aria-label="Source" />
      <FloatingToolbar targetRef={ref} hideOnTyping={hideOnTyping}>
        <button type="button">Preview</button>
      </FloatingToolbar>
    </div>
  );
}

describe("editor floating toolbar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("appears on mouse activity, stays under the pointer, then fades after inactivity", () => {
    render(<Fixture />);
    const editor = screen.getByTestId("editor");
    const button = screen.getByRole("button", { name: "Preview" });
    const toolbar = button.parentElement!;
    expect(toolbar).not.toHaveClass(styles.visible!);
    fireEvent.pointerMove(editor);
    expect(toolbar).toHaveClass(styles.visible!);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.pointerMove(button);
    act(() => vi.advanceTimersByTime(5000));
    expect(toolbar).toHaveClass(styles.visible!);
    fireEvent.pointerMove(editor);
    act(() => vi.advanceTimersByTime(1400));
    expect(toolbar).not.toHaveClass(styles.visible!);
  });

  it("hides while editing but remains available to keyboard users", () => {
    render(<Fixture />);
    const source = screen.getByRole("textbox", { name: "Source" });
    const button = screen.getByRole("button", { name: "Preview" });
    const toolbar = button.parentElement!;
    fireEvent.pointerMove(source);
    fireEvent.keyDown(source, { key: "a" });
    expect(toolbar).not.toHaveClass(styles.visible!);
    act(() => button.focus());
    fireEvent.pointerLeave(screen.getByTestId("editor"));
    act(() => vi.advanceTimersByTime(5000));
    expect(toolbar).toHaveClass(styles.visible!);
    act(() => source.focus());
    expect(toolbar).not.toHaveClass(styles.visible!);
  });

  it("returns focus to the editor when Escape dismisses a focused toolbar", () => {
    render(<Fixture />);
    const source = screen.getByRole("textbox", { name: "Source" });
    const button = screen.getByRole("button", { name: "Preview" });
    act(() => source.focus());
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Escape" });
    expect(source).toHaveFocus();
    expect(button.parentElement).not.toHaveClass(styles.visible!);
  });

  it("lets browser controls stay visible during typing and dismisses them with Escape", () => {
    render(<Fixture hideOnTyping={false} />);
    const source = screen.getByRole("textbox", { name: "Source" });
    const toolbar = screen.getByRole("button", { name: "Preview" }).parentElement!;
    fireEvent.pointerMove(source);
    fireEvent.keyDown(source, { key: "a" });
    expect(toolbar).toHaveClass(styles.visible!);
    fireEvent.keyDown(source, { key: "Escape" });
    expect(toolbar).not.toHaveClass(styles.visible!);
  });

  it("releases timers when the editor closes", () => {
    const { unmount } = render(<Fixture />);
    const before = vi.getTimerCount();
    fireEvent.pointerMove(screen.getByTestId("editor"));
    expect(vi.getTimerCount()).toBe(before + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});
