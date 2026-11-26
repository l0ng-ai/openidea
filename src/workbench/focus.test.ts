import { afterEach, describe, expect, it, vi } from "vitest";
import { setContext } from "@/platform/context";
import { installFocusScopeTracking } from "@/ui/focusScope";
import { EDITOR_AREA_SELECTOR, focusEditor, installFocusTracking, notifyFocusElement } from "./focus";

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

  it("leaves the caret to the next editor when focus moves between editors", () => {
    document.body.innerHTML = `<div class="cm-content" contenteditable="true" tabindex="0">first</div><div class="cm-content" contenteditable="true" tabindex="0">second</div>`;
    const [first, second] = document.querySelectorAll<HTMLElement>(".cm-content");
    const dispose = installFocusTracking(() => {});
    first!.focus();
    document.getSelection()!.collapse(first!.firstChild, 3);
    let caretLeft: Node | null = null;
    const probe = () => (caretLeft = document.getSelection()!.anchorNode);
    document.addEventListener("focusout", probe);
    second!.focus();
    document.removeEventListener("focusout", probe);
    expect(caretLeft).toBe(first!.firstChild);
    dispose();
  });

  it("drops the editor's caret when focus moves to a menu, so focusing the editor again cannot scroll to it", () => {
    document.body.innerHTML = `<div class="cm-content" contenteditable="true" tabindex="0">first line</div><button id="other">x</button>`;
    const editor = document.querySelector<HTMLElement>(".cm-content")!;
    const dispose = installFocusTracking(() => {});
    editor.focus();
    document.getSelection()!.collapse(editor.firstChild, 3);
    // WebKit keeps the caret during a mouse press; jsdom moves the selection on focus, so check
    // what is left once the editor has lost focus.
    let caretLeft: Node | null = null;
    const probe = () => (caretLeft = document.getSelection()!.anchorNode);
    document.addEventListener("focusout", probe);
    document.getElementById("other")!.focus();
    document.removeEventListener("focusout", probe);
    expect(caretLeft).toBeNull();
    dispose();
  });

  it.each([
    '<div contenteditable="true" tabindex="0">draft message</div>',
    '<div class="cm-content" contenteditable="false" tabindex="0">preview text</div>',
  ])("keeps the selection in an unrelated editable or read-only preview: %s", (markup) => {
    document.body.innerHTML = `${markup}<button id="other">x</button>`;
    const content = document.body.firstElementChild as HTMLElement;
    const dispose = installFocusTracking(() => {});
    content.focus();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(content.firstChild!, 1, content.firstChild!, 5);
    let selectedOnBlur = "";
    const probe = () => (selectedOnBlur = selection.toString());
    document.addEventListener("focusout", probe);
    document.getElementById("other")!.focus();
    document.removeEventListener("focusout", probe);
    dispose();
    expect(selectedOnBlur).toBe(content.textContent!.slice(1, 5));
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

describe("focus tracking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tells whether focus entered the editor area", () => {
    document.body.innerHTML = `<div data-editor-area><div class="cm-content" tabindex="0"></div></div><section data-toolwindow="project" tabindex="-1"></section><button id="other">x</button>`;
    const calls: Array<[string | null, boolean]> = [];
    const dispose = installFocusTracking((id, editor) => calls.push([id, editor]));
    document.querySelector<HTMLElement>(".cm-content")!.focus();
    document.querySelector<HTMLElement>("[data-toolwindow]")!.focus();
    document.getElementById("other")!.focus();
    expect(calls).toEqual([
      [null, true],
      ["project", false],
      [null, false],
    ]);
    dispose();
  });

  it("tracks focus entering sandboxed plugin iframes and updates focus-scope highlighting", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    document.body.innerHTML = `
      <div data-editor-area>
        <section data-pane-id="p1" data-focus-scope=""><iframe id="ed-frame" tabindex="0"></iframe></section>
      </div>
      <section data-toolwindow="plugin.k8s.view" data-focus-scope="">
        <iframe id="tw-frame" tabindex="0"></iframe>
      </section>`;
    const calls: Array<[string | null, boolean]> = [];
    const disposeScope = installFocusScopeTracking();
    const dispose = installFocusTracking((id, editor) => calls.push([id, editor]));

    const twFrame = document.getElementById("tw-frame") as HTMLIFrameElement;
    const edFrame = document.getElementById("ed-frame") as HTMLIFrameElement;
    let active: Element | null = twFrame;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });

    // Window blur when activeElement is an iframe inside a tool window tracks it and marks its focus scope.
    window.dispatchEvent(new Event("blur"));
    // Repeated bridge notification for the same iframe is deduplicated.
    notifyFocusElement(twFrame);
    expect(calls).toEqual([["plugin.k8s.view", false]]);
    expect(document.querySelector('[data-toolwindow="plugin.k8s.view"]')).toHaveAttribute("data-focus-active", "");

    // Switching to an iframe inside an editor pane updates both tracking and focus-scope highlight.
    active = edFrame;
    notifyFocusElement(edFrame);
    expect(calls).toEqual([
      ["plugin.k8s.view", false],
      [null, true],
    ]);
    expect(document.querySelector('[data-pane-id="p1"]')).toHaveAttribute("data-focus-active", "");
    expect(document.querySelector('[data-toolwindow="plugin.k8s.view"]')).not.toHaveAttribute("data-focus-active");

    Reflect.deleteProperty(document, "activeElement");
    dispose();
    disposeScope();
    vi.restoreAllMocks();
  });
});
