import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DebugSessionId, Variable } from "@/bindings";
import { showHint } from "@/editor/lsp/hint";
import { valueHint } from "../editor/valueTooltip";

vi.mock("../ui/ValueHintTree", () => ({
  mountValueTree: (host: HTMLElement) => {
    host.append(Object.assign(document.createElement("div"), { className: "tree" }));
    return { unmount: () => {} };
  },
}));

const session = 7 as DebugSessionId;
const order: Variable = {
  name: "order",
  value: "Order@12",
  typeName: "Order",
  variablesReference: 3,
  evaluateName: "order",
} as Variable;
let view: EditorView;
const expand = () => {
  const button = document.querySelector<HTMLButtonElement>("[aria-label='Expand value']")!;
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  button.click();
};

beforeEach(() => {
  vi.useFakeTimers();
  view = new EditorView({ state: EditorState.create({ doc: "order.total" }), parent: document.body });
});
afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

describe("value hint", () => {
  it("keeps a hint whose value was expanded past the hint's timeout", () => {
    showHint(view, () => valueHint("order", order, session), { pos: 0, timeout: 4000 });
    expand();
    expect(document.querySelector(".cm-lsp-hint .tree")).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(document.querySelector(".cm-lsp-hint .tree")).not.toBeNull();
  });

  it("hands an expanded hover hint to its pin instead of growing in place", () => {
    const pin = vi.fn();
    showHint(view, () => valueHint("order", order, session, 400, { pin }), { pos: 0 });
    expand();
    expect(pin).toHaveBeenCalled();
    expect(document.querySelector(".tree")).toBeNull();
  });
});
