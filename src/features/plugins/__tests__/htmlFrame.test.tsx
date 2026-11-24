import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { View } from "@/bindings";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { FRAME_TAG } from "../views/frame";
import { PluginView } from "../views/PluginView";

vi.mock("@/platform/ipc", async (original) => ({ ...(await original()), isTauri: () => true }));

describe("html bodies in the app", () => {
  it.each([false, true])(
    "writes the document into the plugin host page with an earlier theme message: %s",
    async (themeFirst) => {
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
      if (themeFirst) frame.contentWindow!.postMessage({ tag: FRAME_TAG, theme: { dark: true, vars: {} } }, "*");
      const ready = (source: Window | null) =>
        window.dispatchEvent(new MessageEvent("message", { data: { tag: FRAME_TAG, ready: true }, source }));
      // The listener is added in an effect that can run after the frame is in the DOM.
      await waitFor(() => {
        ready(frame.contentWindow);
        expect(post).toHaveBeenCalledWith(
          { tag: FRAME_TAG, document: expect.stringContaining("<p>chart</p><script>draw()</script>") },
          "*",
        );
      });
      const documentCall = post.mock.calls.find(([message]) => typeof message?.document === "string")!;
      const doc = (documentCall[0] as { document: string }).document;
      expect(doc).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(doc).toContain("window.openidea");

      // Not from the frame: ignored.
      post.mockClear();
      ready(window);
      expect(post).not.toHaveBeenCalled();
    },
  );
});
