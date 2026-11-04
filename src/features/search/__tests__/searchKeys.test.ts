import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { claimSearchKeys } from "../everywhere/SearchEverywhere";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
});

describe("Search Everywhere's query field", () => {
  it("keeps ⌥↵ and the navigation keys from the editor's actions behind the popup", () => {
    const intentions = vi.fn();
    const extend = vi.fn();
    useKeymap.setState({ overrides: { "t.intentions": ["Alt+Enter"], "t.extend": ["Alt+ArrowUp"] } } as never);
    setContext("textEditorActive", true);
    const input = document.body.appendChild(document.createElement("input"));
    const other = document.body.appendChild(document.createElement("input"));
    disposers.push(
      registerAction({ id: "t.intentions", title: "Show Context Actions", run: intentions }),
      registerAction({ id: "t.extend", title: "Extend Selection", run: extend }),
      installKeyboardDispatcher(window),
      claimSearchKeys(() => input),
    );
    const press = (target: HTMLElement, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
    press(input, "Enter");
    press(input, "ArrowUp");
    expect(intentions).not.toHaveBeenCalled();
    expect(extend).not.toHaveBeenCalled();
    press(other, "Enter");
    expect(intentions).toHaveBeenCalledOnce();
  });
});
