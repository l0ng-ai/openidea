import { afterEach, describe, expect, it } from "vitest";
import { clampSelectionToRow } from "./clampSelection";

function conversation() {
  document.body.innerHTML = `
    <div id="reply"><p>First paragraph.</p><p id="last">Last paragraph.</p>
      <div style="user-select: none">Nov 11 05:58 PM</div></div>
    <div id="user"><span>Next message</span></div>`;
  const text = (id: string) => document.getElementById(id)!.firstChild as Text;
  return {
    reply: document.getElementById("reply")!,
    last: text("last"),
    next: document.querySelector("#user span")!.firstChild as Text,
  };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("clampSelectionToRow", () => {
  it("ends a selection that ran into the next message at the row's last selectable text", () => {
    const { reply, last, next } = conversation();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(last, 0, next, 4);
    clampSelectionToRow(selection, reply);
    expect(selection.toString()).toBe("Last paragraph.");
  });

  it("leaves a selection inside the row alone", () => {
    const { reply, last } = conversation();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(last, 0, last, 4);
    clampSelectionToRow(selection, reply);
    expect(selection.toString()).toBe("Last");
  });

  it("collapses a selection made entirely outside the row", () => {
    const { reply, next } = conversation();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(next, 0, next, 4);
    clampSelectionToRow(selection, reply);
    expect(selection.isCollapsed).toBe(true);
  });
});
