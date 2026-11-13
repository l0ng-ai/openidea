import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { View } from "@/bindings";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { FRAME_TAG } from "../views/frame";
import { PluginView } from "../views/PluginView";

vi.mock("@/platform/ipc", async (original) => ({ ...(await original()), isTauri: () => true }));

describe("html bodies in the app", () => {
  it("writes the document into the plugin scheme's host page, not a srcdoc that inherits the workbench CSP", async () => {
    const view: View = {
      toolbar: [],
      body: { kind: "html", value: "<p>chart</p><script>draw()</script>" },
      status: null,
    };
    setPluginsBackend({ ...createMemoryPluginsBackend([]), renderView: vi.fn(async () => view) });
    const { container } = render(<PluginView pluginId="charts" view="chart" />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("src")).toMatch(
      /^(openidea-plugin:\/\/localhost|http:\/\/openidea-plugin\.localhost)\/\.frame$/,
    );
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");

    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    // Not from the frame: ignored.
    window.dispatchEvent(new MessageEvent("message", { data: { tag: FRAME_TAG, ready: true }, source: window }));
    expect(post).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { data: { tag: FRAME_TAG, ready: true }, source: frame.contentWindow }),
    );
    expect(post).toHaveBeenCalledWith(
      { tag: FRAME_TAG, document: expect.stringContaining("<p>chart</p><script>draw()</script>") },
      "*",
    );
    const doc = (post.mock.calls[0]![0] as { document: string }).document;
    expect(doc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(doc).toContain("window.openidea");
  });
});
