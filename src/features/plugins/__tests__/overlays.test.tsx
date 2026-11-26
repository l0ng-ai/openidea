import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { PluginInfo } from "@/bindings";
import { setContext } from "@/platform/context";
import { useContributions } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG, frameDocument } from "../views/frame";
import { placeOverlay, projectOverlay, type OverlayDecl } from "../views/overlay";
import { WebView } from "../views/WebView";

afterEach(() => {
  setPluginsBackend(null);
  usePlugins.setState({ plugins: [] });
});

/** Runs the bridge in a fake frame window at `search`; what it posts up. */
function bridgeAt(search: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(frameDocument("", { dark: true, vars: {} }))![1]!;
  const sent: Array<{ call?: number; op?: string; args?: Record<string, unknown> }> = [];
  const parent = { postMessage: (m: (typeof sent)[number]) => void sent.push(m) };
  const frameWindow: Record<string, unknown> = { parent, addEventListener: () => {} };
  new Function("window", "document", "location", script)(
    frameWindow,
    { documentElement: document.createElement("html") },
    { search },
  );
  return { api: frameWindow.openidea as Record<string, unknown>, sent };
}

const decl = (over: Partial<OverlayDecl> = {}): OverlayDecl => ({
  id: "stage",
  web: "web/index.html",
  width: 260,
  height: 140,
  anchor: "bottom-right",
  interactive: true,
  ...over,
});

const overlayId = "plugin.acme.mascot.stage";
const registered = () => useContributions.getState().overlays.get(overlayId);

describe("frame bridge: openidea.overlay", () => {
  it("exists only in overlay pages", () => {
    expect(bridgeAt("").api.overlay).toBeUndefined();
    expect(bridgeAt("?openidea=editor-panel").api.overlay).toBeUndefined();
    expect(bridgeAt("?openidea=overlay").api.overlay).toBeDefined();
    expect(bridgeAt("?openidea=overlay").api.editor).toBeUndefined();
  });

  it("asks the workbench to read and move the overlay", () => {
    const { api, sent } = bridgeAt("?openidea=overlay");
    const overlay = api.overlay as { get(): Promise<unknown>; place(a: object): Promise<unknown> };
    void overlay.get();
    void overlay.place({ anchor: "top-left", width: 300 });
    expect(sent.map((m) => [m.op, m.args])).toEqual([
      ["overlay.get", undefined],
      ["overlay.place", { anchor: "top-left", width: 300, height: undefined }],
    ]);
  });
});

describe("placeOverlay", () => {
  const start = { anchor: "bottom-right", width: 260, height: 140 };

  it("applies what the page names and keeps the rest", () => {
    expect(placeOverlay(start, { anchor: "center" })).toEqual({ ...start, anchor: "center" });
    expect(placeOverlay(start, { width: 320.4, height: undefined })).toEqual({ ...start, width: 320 });
  });

  it("clamps sizes to 40–800 pixels and refuses what isn't a placement", () => {
    expect(placeOverlay(start, { width: 1, height: 5000 })).toEqual({ ...start, width: 40, height: 800 });
    expect(() => placeOverlay(start, { anchor: "left" })).toThrow("anchor");
    expect(() => placeOverlay(start, { width: "wide" })).toThrow("number");
    expect(() => placeOverlay(start, { height: Number.NaN })).toThrow("number");
  });
});

describe("overlays projection", () => {
  it("floats the overlay over the workbench only while `when` holds", () => {
    const dispose = projectOverlay("acme.mascot", decl({ when: "plugin.acme.mascot.showing" }));
    expect(registered()).toBeUndefined();
    setContext("plugin.acme.mascot.showing", true);
    expect(registered()).toBeDefined();
    setContext("plugin.acme.mascot.showing", false);
    expect(registered()).toBeUndefined();
    setContext("plugin.acme.mascot.showing", true);
    dispose();
    expect(registered()).toBeUndefined();
    setContext("plugin.acme.mascot.showing", false);
  });

  it("is always there without `when`", () => {
    const dispose = projectOverlay("acme.mascot", decl());
    expect(registered()).toBeDefined();
    dispose();
  });
});

describe("an overlay's frame", () => {
  async function shown(over: Partial<OverlayDecl> = {}) {
    setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => "about:blank" });
    usePlugins.setState({
      plugins: [{ id: "acme.mascot", hasCode: false, capabilities: [] } as unknown as PluginInfo],
    });
    const dispose = projectOverlay("acme.mascot", decl(over));
    const Overlay = registered()!.component;
    const result = render(<Overlay />);
    const frame = await waitFor(() => {
      const f = result.container.querySelector("iframe");
      expect(f).not.toBeNull();
      return f!;
    });
    const box = result.container.querySelector<HTMLElement>("[data-plugin-overlay]")!;
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m as never));
    const request = async (call: number, op: string, args?: object) => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { tag: FRAME_TAG, call, op, args }, source: frame.contentWindow }),
        );
      });
      return waitFor(() => {
        const r = posted.find((m) => m.reply === call);
        expect(r).toBeDefined();
        return r!;
      });
    };
    return { frame, box, request, dispose };
  }

  it("loads as an overlay, out of the tab order, without taking the focus", async () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    const { frame, box, dispose } = await shown();
    expect(frame.getAttribute("src")).toBe("about:blank?openidea=overlay");
    expect(frame.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(input);
    expect(box.dataset.pluginOverlay).toBe("acme.mascot/stage");
    expect([box.dataset.v, box.dataset.h]).toEqual(["bottom", "right"]);
    expect([box.style.width, box.style.height]).toEqual(["260px", "140px"]);
    expect(box.dataset.interactive).toBe("true");
    dispose();
    input.remove();
  });

  it("lets clicks through when it isn't interactive", async () => {
    const { box, dispose } = await shown({ interactive: false });
    expect(box.dataset.interactive).toBe("false");
    dispose();
  });

  it("answers openidea.overlay: the page moves and resizes it", async () => {
    const { box, request, dispose } = await shown();
    expect((await request(1, "overlay.get")).value).toEqual({ anchor: "bottom-right", width: 260, height: 140 });
    const moved = await request(2, "overlay.place", { anchor: "center", width: 320, height: 2000 });
    expect(moved.value).toEqual({ anchor: "center", width: 320, height: 800 });
    await waitFor(() => expect([box.dataset.v, box.dataset.h]).toEqual(["middle", "center"]));
    expect([box.style.width, box.style.height]).toEqual(["320px", "800px"]);
    expect(String((await request(3, "overlay.place", { anchor: "nowhere" })).error)).toContain("anchor");
    expect((await request(4, "overlay.get")).value).toEqual({ anchor: "center", width: 320, height: 800 });
    dispose();
  });

  it("shows nothing when its page can't be loaded", async () => {
    setPluginsBackend({
      ...createMemoryPluginsBackend([]),
      webPageUrl: async () => {
        throw new Error("plugin is not enabled");
      },
    });
    const dispose = projectOverlay("acme.mascot", decl());
    const Overlay = registered()!.component;
    const { container } = render(<Overlay />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toBe("");
    dispose();
  });
});

describe("WebView elsewhere", () => {
  it("refuses openidea.overlay requests from other web views", async () => {
    setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => "about:blank" });
    usePlugins.setState({
      plugins: [{ id: "acme.mascot", hasCode: false, capabilities: [] } as unknown as PluginInfo],
    });
    const { container } = render(<WebView pluginId="acme.mascot" view="tool" label="tool" />);
    const frame = await waitFor(() => {
      const f = container.querySelector("iframe");
      expect(f).not.toBeNull();
      return f!;
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m as never));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { tag: FRAME_TAG, call: 1, op: "overlay.get" },
        source: frame.contentWindow,
      }),
    );
    await waitFor(() => expect(String(posted.find((m) => m.reply === 1)?.error)).toContain("not an overlay"));
  });
});
