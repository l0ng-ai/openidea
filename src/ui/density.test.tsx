import { afterEach, describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { List } from "./List";
import { Tree } from "./Tree";
import { compactRowHeight, setCompactMode, useChromeIconSize, useRowHeight } from "./density";
import { setIconAppearance } from "./iconAppearance";

afterEach(() => {
  setCompactMode(false);
  setIconAppearance(null);
});

describe("compact mode density", () => {
  it("takes 2px off row heights and 4px off chrome icons, like IDEA's compact theme keys", () => {
    expect(compactRowHeight(24, false)).toBe(24);
    expect(compactRowHeight(24, true)).toBe(22);
    expect(compactRowHeight(26, true)).toBe(24);
    const rows = renderHook(() => [useRowHeight(), useRowHeight(26), useChromeIconSize()]);
    expect(rows.result.current).toEqual([24, 26, 20]);
    act(() => setCompactMode(true));
    expect(rows.result.current).toEqual([22, 24, 16]);
  });

  it("shrinks default tree rows, keeping a theme or explicit row height", () => {
    const tree = (rowHeight?: number) => (
      <Tree
        roots={[{ key: "a" }]}
        getKey={(n) => n.key}
        getLabel={(n) => n.key}
        getChildren={() => undefined}
        isExpandable={() => false}
        rowHeight={rowHeight}
        aria-label="t"
      />
    );
    const { container, rerender } = render(tree());
    const row = () => container.querySelector<HTMLElement>('[role="treeitem"]');
    expect(row()?.style.height).toBe("24px");
    act(() => setCompactMode(true));
    expect(row()?.style.height).toBe("22px");
    act(() => setIconAppearance({ rowHeight: 30 }));
    expect(row()?.style.height).toBe("30px");
    rerender(tree(40));
    expect(row()?.style.height).toBe("40px");
  });

  it("shrinks default list rows", () => {
    const { container } = render(<List items={["a", "b"]} getKey={(s) => s} renderItem={(s) => s} aria-label="l" />);
    const option = () => container.querySelector<HTMLElement>('[role="option"]');
    expect(option()?.style.height).toBe("24px");
    act(() => setCompactMode(true));
    expect(option()?.style.height).toBe("22px");
  });
});
