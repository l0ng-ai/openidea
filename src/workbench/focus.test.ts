import { afterEach, describe, expect, it, vi } from "vitest";
import { setContext } from "@/platform/context";
import { EDITOR_AREA_SELECTOR, focusEditor, installFocusTracking } from "./focus";

describe("focus after popups", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setContext("popupOpen", false);
    vi.useRealTimers();
  });

  function setup() {
    document.body.innerHTML = `<div data-editor-area><div class="cm-content" tabindex="0"></div></div><button id="other">x</button>`;
    return document.querySelector<HTMLElement>(`${EDITOR_AREA_SELECTOR} .cm-content`)!;
  }

  it("waits for the restored editor to become visible before focusing it", () => {
    vi.useFakeTimers();
    const editor = setup();
    const area = editor.parentElement!;
    area.hidden = true;
    focusEditor();
    expect(document.activeElement).not.toBe(editor);
    area.hidden = false;
    vi.runAllTimers();
    expect(document.activeElement).toBe(editor);
  });

  it("returns focus to the editor when the last popup closes and focus was left nowhere", () => {
    vi.useFakeTimers();
    const editor = setup();
    const dispose = installFocusTracking(() => {});
    setContext("popupOpen", true);
    (document.activeElement as HTMLElement | null)?.blur();
    setContext("popupOpen", false);
    vi.runAllTimers();
    expect(document.activeElement).toBe(editor);
    dispose();
  });

  it("leaves focus alone when the popup handed it to another component", () => {
    vi.useFakeTimers();
    setup();
    const dispose = installFocusTracking(() => {});
    setContext("popupOpen", true);
    const other = document.getElementById("other")!;
    other.focus();
    setContext("popupOpen", false);
    vi.runAllTimers();
    expect(document.activeElement).toBe(other);
    dispose();
  });
});
