import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePlatform } from "@/platform/platformInfo";
import { installFullscreenEscapeGuard } from "./fullscreenEscape";

let fullscreen = true;
let dispose = () => {};
const escape = (target: EventTarget) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  fullscreen = true;
  usePlatform.setState({ os: "macos" });
  dispose = installFullscreenEscapeGuard(window, () => fullscreen);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

describe("Escape in full screen", () => {
  it("is marked handled when nothing handles it, so the window stays in full screen", () => {
    expect(escape(document.body).defaultPrevented).toBe(true);
  });

  it("is marked handled when a handler stops it", () => {
    const popup = document.body.appendChild(document.createElement("div"));
    popup.addEventListener("keydown", (e) => e.stopPropagation());
    expect(escape(popup).defaultPrevented).toBe(true);
    // The next key press is not affected by a listener left behind.
    fullscreen = false;
    expect(escape(document.body).defaultPrevented).toBe(false);
  });

  it("reaches other handlers not yet default-prevented", () => {
    let seen: boolean | null = null;
    const onKey = (e: KeyboardEvent) => (seen = e.defaultPrevented);
    window.addEventListener("keydown", onKey);
    escape(document.body);
    window.removeEventListener("keydown", onKey);
    expect(seen).toBe(false);
  });

  it("is left alone outside full screen and on other systems", () => {
    fullscreen = false;
    expect(escape(document.body).defaultPrevented).toBe(false);
    fullscreen = true;
    usePlatform.setState({ os: "windows" });
    expect(escape(document.body).defaultPrevented).toBe(false);
  });
});
