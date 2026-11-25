import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { PluginInfo } from "@/bindings";
import { registerAction } from "@/platform/actions";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG } from "../views/frame";
import { WebView } from "../views/WebView";

let uninstall = () => {};
afterEach(() => {
  uninstall();
  setPluginsBackend(null);
  usePlugins.setState({ plugins: [] });
  useKeymap.setState({ overrides: {} });
  Reflect.deleteProperty(navigator, "userActivation");
  vi.restoreAllMocks();
});

/** What a browser reports after the user's own input in the frame (`isActive`), or long after it. */
function reportUserActivation(isActive: boolean) {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive } });
}

async function mount(capabilities: { id: string; granted: boolean }[]) {
  setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => "about:blank" });
  usePlugins.setState({
    plugins: [{ id: "evil.view", hasCode: false, enabled: true, capabilities } as unknown as PluginInfo],
  });
  const view = render(<WebView pluginId="evil.view" view="v" label="V" />);
  const frame = await waitFor(() => {
    const found = view.container.querySelector("iframe");
    expect(found).not.toBeNull();
    return found!;
  });
  return frame;
}

/** What page script in the frame can post at any time, with no user gesture. */
function pass(frame: HTMLIFrameElement, key: KeyboardEventInit) {
  window.dispatchEvent(new MessageEvent("message", { data: { tag: FRAME_TAG, key }, source: frame.contentWindow }));
}

const SAVE = { key: "s", code: "KeyS", metaKey: true };
const RUN = { key: "F10", code: "F10", shiftKey: true };

function bind() {
  const save = vi.fn();
  const run = vi.fn();
  registerAction({ id: "file.save", title: "Save", run: save });
  registerAction({ id: "t.runSelected", title: "Run 'app'", run });
  useKeymap.setState({ overrides: { "file.save": ["Meta+S"], "t.runSelected": ["Shift+F10"] } });
  uninstall = installKeyboardDispatcher(window);
  return { save, run };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("keys a plugin web view passes on", () => {
  it("run nothing while the user is not in the frame", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { save, run } = bind();
    const frame = await mount([]);
    pass(frame, SAVE);
    pass(frame, RUN);
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("run nothing while the window has no focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { save } = bind();
    const frame = await mount([]);
    frame.focus();
    pass(frame, SAVE);
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("run a safe action, and only a safe one, for a plugin without ide.commands", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { save, run } = bind();
    const frame = await mount([{ id: "clipboard", granted: true }]);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    pass(frame, SAVE);
    pass(frame, RUN);
    await flush();
    expect(save).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("run any bound action for a plugin granted ide.commands, but still only while the user is in the frame", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { run } = bind();
    const frame = await mount([{ id: "ide.commands", granted: true }]);
    pass(frame, RUN);
    await flush();
    expect(run).not.toHaveBeenCalled();
    frame.focus();
    pass(frame, RUN);
    await flush();
    expect(run).toHaveBeenCalledOnce();
  });

  it("run nothing when the user has not touched the frame lately, even if the page took the focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    reportUserActivation(false);
    const { save } = bind();
    const frame = await mount([]);
    // The page can call focus() on itself; it cannot give itself user activation.
    frame.focus();
    expect(document.activeElement).toBe(frame);
    pass(frame, SAVE);
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("run a safe action right after the user pressed a key in the frame", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    reportUserActivation(true);
    const { save } = bind();
    const frame = await mount([]);
    frame.focus();
    pass(frame, SAVE);
    await flush();
    expect(save).toHaveBeenCalledOnce();
  });

  it("do not run any bound action for a plugin whose ide.commands is declared but not granted", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { run } = bind();
    const frame = await mount([{ id: "ide.commands", granted: false }]);
    frame.focus();
    pass(frame, RUN);
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
});
