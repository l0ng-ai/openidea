import { afterEach, describe, expect, it } from "vitest";
import { FOCUS_ACTIVE_ATTR, installFocusScopeTracking } from "./focusScope";

describe("focus scopes", () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    document.body.innerHTML = "";
  });

  function setup() {
    document.body.innerHTML = `
      <section id="editor" data-focus-scope><button id="editorTab">a</button></section>
      <section id="services" data-focus-scope>
        <button id="tree">tree</button>
        <div id="results" data-focus-scope><button id="grid">grid</button></div>
      </section>
      <div data-popup><button id="menuItem">menu</button></div>`;
    dispose = installFocusScopeTracking();
    const el = (id: string) => document.getElementById(id)!;
    const active = () =>
      ["editor", "services", "results"].filter((id) => el(id).hasAttribute(FOCUS_ACTIVE_ATTR)).join(",");
    return { el, active };
  }

  it("marks the focused scope with its enclosing scopes and moves the mark with focus", () => {
    const { el, active } = setup();
    el("editorTab").focus();
    expect(active()).toBe("editor");
    el("grid").focus();
    expect(active()).toBe("services,results");
    el("tree").focus();
    expect(active()).toBe("services");
  });

  it("keeps the marks while focus is in a popup or nowhere", () => {
    const { el, active } = setup();
    el("grid").focus();
    el("menuItem").focus();
    expect(active()).toBe("services,results");
    el("menuItem").blur();
    expect(document.activeElement).toBe(document.body);
    expect(active()).toBe("services,results");
  });

  it("marks the scope already holding focus on install and clears the marks on dispose", () => {
    document.body.innerHTML = `<section id="editor" data-focus-scope><button id="tab">a</button></section>`;
    document.getElementById("tab")!.focus();
    dispose = installFocusScopeTracking();
    const editor = document.getElementById("editor")!;
    expect(editor.hasAttribute(FOCUS_ACTIVE_ATTR)).toBe(true);
    dispose();
    dispose = () => {};
    expect(editor.hasAttribute(FOCUS_ACTIVE_ATTR)).toBe(false);
  });
});
