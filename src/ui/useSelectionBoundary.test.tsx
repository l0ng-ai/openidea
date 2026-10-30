import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useSelectionBoundary } from "./useSelectionBoundary";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

function Pane() {
  const ref = useRef<HTMLDivElement>(null);
  useSelectionBoundary(ref);
  return (
    <div ref={ref}>
      <p>First message</p>
      <p>Last message</p>
    </div>
  );
}

function fixture() {
  const view = render(
    <>
      <div>Header</div>
      <Pane />
      <div>Reply to the agent</div>
      <div>Branch or tag</div>
    </>,
  );
  const text = (value: string) => view.getByText(value).firstChild!;
  const select = (anchor: Node, start: number, focus: Node, end: number) => {
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(anchor, start, focus, end);
    document.dispatchEvent(new Event("selectionchange"));
    return selection;
  };
  return { ...view, text, select };
}

it("clamps a downward selection before the composer and Git panel", () => {
  const { text, select } = fixture();
  const selection = select(text("Last message"), 5, text("Branch or tag"), 13);
  expect(selection.toString()).toBe("message");
  expect(selection.anchorNode).toBe(text("Last message"));
  expect(selection.anchorOffset).toBe(5);
});

it("clamps an upward selection while retaining its direction", () => {
  const { text, select } = fixture();
  const selection = select(text("First message"), 5, text("Header"), 0);
  expect(selection.toString()).toBe("First");
  expect(selection.anchorNode).toBe(text("First message"));
  expect(selection.anchorOffset).toBe(5);
});

it("preserves cross-message selection and lets the endpoint return inside", () => {
  const { text, select } = fixture();
  select(text("First message"), 6, text("Branch or tag"), 13);
  const selection = select(text("First message"), 6, text("Last message"), 4);
  expect(selection.toString()).toBe("messageLast");
  expect(selection.focusNode).toBe(text("Last message"));
});

it("leaves selections originating outside the conversation alone", () => {
  const { text, select } = fixture();
  const selection = select(text("Reply to the agent"), 0, text("Branch or tag"), 13);
  expect(selection.toString()).toBe("Reply to the agentBranch or tag");
});

it("removes the boundary listener when the pane unmounts", () => {
  const { text, select, unmount } = fixture();
  const first = text("First message");
  const last = text("Branch or tag");
  const container = first.parentElement!.parentElement!.parentElement!;
  const children = [...container.childNodes];
  unmount();
  container.append(...children);
  document.body.append(container);
  expect(select(first, 0, last, 13).toString()).toContain("Branch or tag");
  container.remove();
});
