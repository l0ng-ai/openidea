import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PluginInfo, ViewEvent } from "@/bindings";
import { useContributions } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG, frameDocument } from "../views/frame";
import { openPluginDialog, projectDialog, rememberedDialogSize, type DialogDecl } from "../views/dialog";

afterEach(() => {
  setPluginsBackend(null);
  usePlugins.setState({ plugins: [] });
  localStorage.clear();
});

/** Runs the bridge in a fake frame window at `search`; what it posts up and its keydown handler. */
function bridgeAt(search: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(frameDocument("", { dark: true, vars: {} }))![1]!;
  const sent: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void sent.push(m) };
  const listeners: Record<string, (e: unknown) => void> = {};
  const frameWindow: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
  };
  new Function("window", "document", "location", script)(
    frameWindow,
    { documentElement: document.createElement("html") },
    { search },
  );
  return { api: frameWindow.openidea as Record<string, unknown>, sent, keydown: listeners.keydown! };
}

const decl: DialogDecl = { id: "preview", title: "SQL Preview", web: "web/preview.html", width: 900, height: 600 };
const overlayId = "plugin.acme.sql.dialog.preview";
const registered = () => useContributions.getState().overlays.get(overlayId);

describe("frame bridge: openidea.dialog", () => {
  it("exists only in dialog pages and asks the workbench to close the dialog", () => {
    expect(bridgeAt("").api.dialog).toBeUndefined();
    expect(bridgeAt("?openidea=overlay").api.dialog).toBeUndefined();
    const { api, sent } = bridgeAt("?openidea=dialog");
    void (api.dialog as { close(): Promise<unknown> }).close();
    expect(sent.map((m) => m.op)).toEqual(["dialog.close"]);
  });

  it("hands Escape the page left alone to the dialog, only in dialog pages", async () => {
    const press = async (search: string, defaultPrevented = false) => {
      const { sent, keydown } = bridgeAt(search);
      keydown({ key: "Escape", code: "Escape", isComposing: false, defaultPrevented });
      await new Promise((r) => setTimeout(r, 0));
      return sent.filter((m) => m.key);
    };
    expect(await press("?openidea=dialog")).toHaveLength(1);
    expect(await press("?openidea=dialog", true)).toHaveLength(0);
    expect(await press("")).toHaveLength(0);
  });
});

describe("plugin dialogs", () => {
  async function opened() {
    const events: ViewEvent[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend([]),
      webPageUrl: async () => "about:blank",
      viewEvent: vi.fn(async (_p: string, _v: string, e: ViewEvent) => void events.push(e)),
    });
    usePlugins.setState({ plugins: [{ id: "acme.sql", hasCode: true, capabilities: [] } as unknown as PluginInfo] });
    const dispose = projectDialog("acme.sql", decl);
    const Overlay = registered()!.component;
    const result = render(<Overlay />);
    expect(result.container.textContent).toBe("");
    act(() => void expect(openPluginDialog("acme.sql", "preview")).toBe(true));
    const frame = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe");
      expect(f).not.toBeNull();
      return f!;
    });
    return { events, frame, dispose, result };
  }

  it("opens on views.reveal with its title and page, and tells the plugin when it closes", async () => {
    const { events, frame, dispose } = await opened();
    expect(screen.getByRole("dialog", { name: "SQL Preview" })).toBeInTheDocument();
    expect(frame.getAttribute("src")).toBe("about:blank?openidea=dialog");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(events).toEqual([{ kind: "closed" }]));
    dispose();
  });

  it("closes when its page asks", async () => {
    const { events, frame, dispose } = await opened();
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { tag: FRAME_TAG, call: 1, op: "dialog.close" },
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(events).toEqual([{ kind: "closed" }]);
    dispose();
  });

  it("leaves views.reveal to tool windows for ids it doesn't declare, and goes with its plugin", () => {
    expect(openPluginDialog("acme.sql", "preview")).toBe(false);
    const dispose = projectDialog("acme.sql", decl);
    expect(openPluginDialog("acme.sql", "tool")).toBe(false);
    expect(openPluginDialog("other", "preview")).toBe(false);
    dispose();
    expect(registered()).toBeUndefined();
    expect(openPluginDialog("acme.sql", "preview")).toBe(false);
  });

  it("reopens at the size the user gave it", () => {
    expect(rememberedDialogSize("acme.sql/preview")).toBeNull();
    localStorage.setItem("openidea.plugins.dialogSize.acme.sql/preview", JSON.stringify({ w: 700, h: 100 }));
    expect(rememberedDialogSize("acme.sql/preview")).toEqual({ w: 700, h: 200 });
    localStorage.setItem("openidea.plugins.dialogSize.acme.sql/preview", "not json");
    expect(rememberedDialogSize("acme.sql/preview")).toBeNull();
  });
});
