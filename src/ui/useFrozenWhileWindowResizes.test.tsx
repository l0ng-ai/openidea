import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WINDOW_RESIZE_SETTLE_MS, useFrozenWhileWindowResizes } from "./useFrozenWhileWindowResizes";

function Frozen() {
  const ref = useRef<HTMLDivElement>(null);
  useFrozenWhileWindowResizes(ref);
  return (
    <div data-testid="parent">
      <div ref={ref} data-testid="view" />
    </div>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps the view at its size while the window resizes and releases it once the drag pauses", () => {
  const { getByTestId } = render(<Frozen />);
  const view = getByTestId("view");
  const parent = getByTestId("parent");
  view.getBoundingClientRect = () => ({ width: 300, height: 120 }) as DOMRect;

  act(() => void window.dispatchEvent(new Event("resize")));
  expect(view.style.width).toBe("300px");
  expect(view.style.height).toBe("120px");
  expect(view.style.flexGrow).toBe("0");
  expect(parent.style.overflow).toBe("hidden");

  // Still dragging: the size taken at the start stays.
  view.getBoundingClientRect = () => ({ width: 200, height: 80 }) as DOMRect;
  act(() => vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS - 1));
  act(() => void window.dispatchEvent(new Event("resize")));
  act(() => vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS - 1));
  expect(view.style.width).toBe("300px");

  act(() => vi.advanceTimersByTime(1));
  expect(view.style.width).toBe("");
  expect(view.style.height).toBe("");
  expect(view.style.flex).toBe("");
  expect(parent.style.overflow).toBe("");
});

it("releases the view when it unmounts mid-drag", () => {
  const { getByTestId, unmount } = render(<Frozen />);
  const parent = getByTestId("parent");
  act(() => void window.dispatchEvent(new Event("resize")));
  expect(parent.style.overflow).toBe("hidden");
  unmount();
  expect(parent.style.overflow).toBe("");
});
