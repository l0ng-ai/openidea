import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Scrollbar } from "./Scrollbar";

function Harness({ onScroll }: { onScroll: (top: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ position: "relative" }}>
      <Scrollbar target={ref} contentHeight={1000} />
      <div ref={ref} data-testid="scroller" onScroll={(e) => onScroll(e.currentTarget.scrollTop)} />
    </div>
  );
}

describe("Scrollbar", () => {
  it("notifies scroll listeners synchronously while the thumb is dragged", () => {
    const onScroll = vi.fn();
    const { getByTestId, container } = render(<Harness onScroll={onScroll} />);
    const scroller = getByTestId("scroller");
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000 },
      scrollTop: { get: () => top, set: (v: number) => (top = v) },
    });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      top = Math.max(0, Math.min(900, options.top ?? top));
    }) as typeof scroller.scrollTo;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    onScroll.mockClear();

    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    track.setPointerCapture = () => {};
    thumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: 10 }));
    track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 46 }));

    // A 32px thumb travels 68px of the track for 900px of content: 36px ≈ 476px.
    expect(top).toBeCloseTo((36 / 68) * 900);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenLastCalledWith(top);
  });
});
