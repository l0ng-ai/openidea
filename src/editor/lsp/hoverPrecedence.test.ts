/** Issue #57: ⌘/Ctrl-hover info and the plain hover popups never stack. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips } from "@codemirror/view";
import { CONTRIBUTED_HOVER, type ContributedHover } from "@/editor/api";
import { usePlatform } from "@/platform/platformInfo";
import {
  isNavigationGesture,
  navigationModifierHeld,
  pointerTarget,
  resetNavigationModifier,
} from "@/platform/navigationModifier";
import { hoverExtension, hoverSource } from "./hover";

const docHover: ContributedHover = (state, pos) => {
  const w = state.wordAt(pos);
  return w ? { from: w.from, to: w.to, markdown: "package query" } : null;
};

function editor() {
  const state = EditorState.create({
    doc: "query.FlightPlan",
    extensions: [hoverExtension(), EditorState.languageData.of(() => [{ [CONTRIBUTED_HOVER]: docHover }])],
  });
  const parent = document.body.appendChild(document.createElement("div"));
  return new EditorView({ state, parent });
}

const key = (type: "keydown" | "keyup", k: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, ...init }));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe.each([
  { os: "windows", mod: "Control", flag: "ctrlKey", other: "metaKey" },
  { os: "macos", mod: "Meta", flag: "metaKey", other: "ctrlKey" },
] as const)("navigation modifier on $os", ({ os, mod, flag, other }) => {
  let view: EditorView | null = null;
  beforeEach(() => {
    usePlatform.setState({ os });
    resetNavigationModifier();
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.replaceChildren();
    resetNavigationModifier();
  });

  it("tracks the platform's modifier alone, pressed and released", () => {
    expect(navigationModifierHeld()).toBe(false);
    key("keydown", mod, { [flag]: true });
    expect(navigationModifierHeld()).toBe(true);
    key("keyup", mod);
    expect(navigationModifierHeld()).toBe(false);
    // With ⇧/⌥ it is another gesture; the other platform's Ctrl/⌘ is not it.
    key("keydown", "Shift", { [flag]: true, shiftKey: true });
    expect(navigationModifierHeld()).toBe(false);
    key("keydown", mod === "Meta" ? "Control" : "Meta", { [other]: true });
    expect(navigationModifierHeld()).toBe(false);
    const both = new MouseEvent("mousemove", { [flag]: true, [other]: true });
    expect(isNavigationGesture(both)).toBe(false);
    expect(isNavigationGesture(new MouseEvent("mousemove", { [flag]: true }))).toBe(true);
  });

  it("learns the state from mouse moves and forgets it when the window loses focus", () => {
    expect(navigationModifierHeld()).toBe(false);
    window.dispatchEvent(new MouseEvent("mousemove", { [flag]: true }));
    expect(navigationModifierHeld()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(navigationModifierHeld()).toBe(false);
  });

  it("modifier held before hovering: no documentation popup", async () => {
    view = editor();
    expect(await hoverSource(view, 2)).not.toBeNull();
    key("keydown", mod, { [flag]: true });
    expect(await hoverSource(view, 2)).toBeNull();
  });

  it("modifier pressed while the documentation popup is open: it closes", async () => {
    view = editor();
    activateHover(view, 2, 1);
    await settle();
    expect(hasHoverTooltips(view.state)).toBe(true);
    key("keydown", mod, { [flag]: true });
    expect(hasHoverTooltips(view.state)).toBe(false);
  });

  it("modifier pressed while the request is in flight: the late answer is dropped", async () => {
    view = editor();
    const pending = hoverSource(view, 2);
    key("keydown", mod, { [flag]: true });
    expect(await pending).toBeNull();
  });

  it("modifier released: nothing stale is left and the next hover shows documentation again", async () => {
    view = editor();
    key("keydown", mod, { [flag]: true });
    activateHover(view, 2, 1);
    await settle();
    expect(hasHoverTooltips(view.state)).toBe(false);
    key("keyup", mod);
    expect(hasHoverTooltips(view.state)).toBe(false);
    activateHover(view, 2, 1);
    await settle();
    expect(hasHoverTooltips(view.state)).toBe(true);
  });

  it("keeps a popup the pointer is in (select + copy with the modifier)", async () => {
    view = editor();
    activateHover(view, 2, 1);
    await settle();
    const tooltip = view.dom.querySelector(".cm-tooltip")!;
    tooltip.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(pointerTarget()).toBe(tooltip);
    key("keydown", mod, { [flag]: true });
    expect(hasHoverTooltips(view.state)).toBe(true);
  });

  it("no documentation popup over an inlay hint (it has its own tooltip)", async () => {
    view = editor();
    const inlay = view.contentDOM.appendChild(document.createElement("span"));
    inlay.className = "cm-lsp-inlay";
    inlay.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(await hoverSource(view, 2)).toBeNull();
  });
});
