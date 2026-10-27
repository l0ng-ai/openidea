import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { installKeyboardDispatcher, registerKeyClaim, useKeymap } from "@/platform/keymap";
import { conflictRows, handlerFor, VIM_EDITOR_ATTR, VIM_KEYS, vimKeyClaim } from "../conflicts";
import { DEFAULT_VIM_SETTINGS, parseVimSettings, type VimSettings } from "../settings";

describe("vim shortcut conflicts", () => {
  it("defaults like IdeaVim: typical Vim keys to Vim, Escape to the IDE first", () => {
    for (const k of ["Ctrl+R", "Ctrl+V", "Ctrl+D", "Ctrl+W", "Ctrl+U", "Ctrl+["]) expect(handlerFor(k, {})).toBe("vim");
    expect(handlerFor("Escape", {})).toBe("ide");
    expect(handlerFor("Ctrl+C", {})).toBe("ide");
    expect(handlerFor("Meta+R", {})).toBeNull();
    expect(handlerFor("Ctrl+R", { "Ctrl+R": "ide" })).toBe("ide");
  });

  it("lists the IDE actions bound to each Vim key", () => {
    const rows = conflictRows(
      [
        ["Ctrl+R", "run.run"],
        ["Ctrl+D", "run.debug"],
        ["Ctrl+W Ctrl+X", "t.chord"],
        ["Meta+R", "other"],
      ],
      { "Ctrl+D": "ide" },
    );
    expect(rows).toHaveLength(VIM_KEYS.length);
    const row = (s: string) => rows.find((r) => r.stroke === s)!;
    expect(row("Ctrl+R")).toMatchObject({ actions: ["run.run"], current: "vim" });
    expect(row("Ctrl+D")).toMatchObject({ actions: ["run.debug"], current: "ide" });
    expect(row("Ctrl+W").actions).toEqual(["t.chord"]);
    expect(row("Ctrl+V").actions).toEqual([]);
  });

  it("parses stored settings defensively", () => {
    expect(parseVimSettings(null)).toEqual(DEFAULT_VIM_SETTINGS);
    expect(parseVimSettings("{bad")).toEqual(DEFAULT_VIM_SETTINGS);
    expect(parseVimSettings('{"enabled":true,"handlers":{"Ctrl+R":"ide","Ctrl+V":"nope"}}')).toEqual({
      enabled: true,
      handlers: { "Ctrl+R": "ide" },
    });
  });
});

describe("keyboard dispatcher with Vim mode", () => {
  let settings: VimSettings;
  let disposers: Array<() => void> = [];
  const run = vi.fn();
  const esc = vi.fn();
  let editor: HTMLElement;
  let plain: HTMLElement;

  beforeEach(() => {
    run.mockReset();
    esc.mockReset();
    settings = { enabled: true, handlers: {} };
    document.body.innerHTML = `<div class="cm-editor" ${VIM_EDITOR_ATTR}="true"><div class="cm-content" tabindex="0"></div></div><div id="plain" tabindex="0"></div>`;
    editor = document.querySelector(".cm-content")!;
    plain = document.querySelector("#plain")!;
    useKeymap.setState({ overrides: { "t.ctrlR": ["Ctrl+R"], "t.escape": ["Escape"] } });
    disposers = [
      registerAction({ id: "t.ctrlR", title: "Ctrl R", run }),
      registerAction({ id: "t.escape", title: "Escape", run: esc }),
      registerKeyClaim(vimKeyClaim(() => settings)),
      installKeyboardDispatcher(window),
    ];
  });
  afterEach(() => {
    disposers.reverse().forEach((d) => d());
    useKeymap.setState({ overrides: {} });
  });

  const press = (target: HTMLElement, code: string, init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const ctrlR = (target: HTMLElement) => press(target, "KeyR", { key: "r", ctrlKey: true });

  it("leaves a Vim-handled key to the focused Vim editor", async () => {
    const e = ctrlR(editor);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("runs the IDE action when the handler is IDE", async () => {
    settings.handlers["Ctrl+R"] = "ide";
    const e = ctrlR(editor);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });

  it("runs the IDE action when Vim mode is off or focus is outside a Vim editor", async () => {
    ctrlR(plain);
    settings.enabled = false;
    ctrlR(editor);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives Escape to the IDE first by default, to Vim when configured", async () => {
    press(editor, "Escape", { key: "Escape" });
    await Promise.resolve();
    expect(esc).toHaveBeenCalledOnce();
    settings.handlers.Escape = "vim";
    const e = press(editor, "Escape", { key: "Escape" });
    await Promise.resolve();
    expect(esc).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(false);
  });
});
