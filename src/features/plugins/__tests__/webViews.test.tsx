import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { PluginInfo, ViewEvent } from "@/bindings";
import { addFileIconProvider, fileIconName, registerExternalIcons } from "@/ui";
import { addContributedFileTemplate, fileTemplates, isBuiltinFileTemplate } from "@/features/templates/files/store";
import { createMemoryPluginsBackend, setPluginsBackend, webSchemeUrl } from "../backend";
import { usePlugins } from "../store";
import { FRAME_TAG, frameDocument } from "../views/frame";
import {
  WebView,
  minimalChange,
  validChanges,
  type DocumentState,
  type FrameDocument,
  type TextChange,
} from "../views/WebView";

afterEach(() => {
  setPluginsBackend(null);
  usePlugins.setState({ plugins: [] });
});

/** An in-memory document with the custom editor session's versioning. */
function memoryDocument(text: string) {
  let version = 0;
  const listeners = new Set<(s: DocumentState) => void>();
  const apply = (changes: readonly TextChange[]) => {
    for (const c of [...changes].reverse()) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
    version++;
  };
  const doc: FrameDocument & { external(changes: TextChange[]): void; text(): string } = {
    read: () => ({ version, text, readOnly: false, name: "a.draw" }),
    edit: (at, changes) => {
      if (at !== version) throw new Error("stale");
      apply(changes);
      return version;
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    external: (changes) => {
      apply(changes);
      for (const l of listeners) l({ version, text });
    },
    text: () => text,
  };
  return doc;
}

describe("web view helpers", () => {
  it("turns a replacement into the smallest change", () => {
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("accepts only sorted, in-range, non-overlapping edits", () => {
    expect(
      validChanges(
        [
          { from: 0, to: 1, insert: "x" },
          { from: 2, to: 2, insert: "y" },
        ],
        3,
      ),
    ).toHaveLength(2);
    expect(() =>
      validChanges(
        [
          { from: 2, to: 2, insert: "" },
          { from: 0, to: 1, insert: "" },
        ],
        3,
      ),
    ).toThrow();
    expect(() => validChanges([{ from: 0, to: 4, insert: "" }], 3)).toThrow();
    expect(() => validChanges([{ from: 0.5, to: 1, insert: "" }], 3)).toThrow();
    expect(() => validChanges("nope", 3)).toThrow();
  });

  it("spells scheme URLs the way each webview expects", () => {
    expect(webSchemeUrl("acme.draw/abc/web/index.html", false)).toBe(
      "openidea-plugin://localhost/acme.draw/abc/web/index.html",
    );
    expect(webSchemeUrl("p/r/web/a b.html", true)).toBe("http://openidea-plugin.localhost/p/r/web/a%20b.html");
  });
});

describe("frame bridge", () => {
  it("asks the workbench for the document and edits it, and hears of changes made elsewhere", async () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(frameDocument("", { dark: true, vars: {} }))![1]!;
    const sent: Array<{ call: number; op: string; args: unknown }> = [];
    // In jsdom the frame is its own parent: catch what the bridge posts "up".
    const post = vi.spyOn(window, "postMessage").mockImplementation((m: unknown) => {
      const msg = m as { call?: number; op?: string; args?: unknown };
      if (typeof msg.call === "number") sent.push(msg as (typeof sent)[number]);
    });
    const reply = (data: object) =>
      window.dispatchEvent(new MessageEvent("message", { data: { tag: FRAME_TAG, ...data }, source: window }));
    try {
      new Function(script)();
      const api = (window as unknown as { openidea: Record<string, never> }).openidea as unknown as {
        document: {
          get(): Promise<unknown>;
          edit(v: number, e: TextChange[]): Promise<{ version: number }>;
          replace(v: number, t: string): Promise<unknown>;
          onChange(fn: (s: DocumentState) => void): void;
        };
        saveFile(o: { name: string; data: string }): Promise<string | null>;
      };
      const got = api.document.get();
      expect(sent.at(-1)).toMatchObject({ op: "document.get" });
      reply({ reply: sent.at(-1)!.call, value: { version: 3, text: "abc", readOnly: false } });
      await expect(got).resolves.toEqual({ version: 3, text: "abc", readOnly: false });

      const edited = api.document.edit(3, [{ from: 0, to: 1, insert: "X" }]);
      expect(sent.at(-1)).toMatchObject({ op: "document.edit", args: { version: 3 } });
      reply({ reply: sent.at(-1)!.call, error: "stale" });
      await expect(edited).rejects.toThrow("stale");

      const saved = api.saveFile({ name: "a.svg", data: "<svg/>" });
      await waitFor(() => expect(sent.at(-1)).toMatchObject({ op: "saveFile", args: { name: "a.svg" } }));
      expect(new TextDecoder().decode((sent.at(-1)!.args as { bytes: Uint8Array }).bytes)).toBe("<svg/>");
      reply({ reply: sent.at(-1)!.call, value: "/tmp/a.svg" });
      await expect(saved).resolves.toBe("/tmp/a.svg");

      const changes: DocumentState[] = [];
      api.document.onChange((s) => changes.push(s));
      reply({ document: { version: 4, text: "xyz" } });
      expect(changes).toEqual([{ version: 4, text: "xyz" }]);
    } finally {
      post.mockRestore();
      delete (window as unknown as { openidea?: unknown }).openidea;
    }
  });
});

describe("WebView", () => {
  function setup(hasCode: boolean) {
    const events: ViewEvent[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend([]),
      webPageUrl: async () => "about:blank",
      viewEvent: vi.fn(async (_p: string, _v: string, e: ViewEvent) => void events.push(e)),
    });
    usePlugins.setState({
      plugins: [{ id: "acme.draw", hasCode, capabilities: [] } as unknown as PluginInfo],
    });
    const doc = memoryDocument("hello world");
    const view = render(<WebView pluginId="acme.draw" view="draw" label="Draw" document={doc} doc={7} />);
    return { events, doc, view };
  }

  async function frameOf(container: HTMLElement) {
    const frame = await waitFor(() => {
      const f = container.querySelector("iframe");
      expect(f).not.toBeNull();
      return f!;
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => void posted.push(m as never));
    const send = (data: object) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { tag: FRAME_TAG, ...data }, source: frame.contentWindow }),
      );
    return { frame, posted, send };
  }

  it("loads the page sandboxed, from its URL, without clipboard access unless granted", async () => {
    const { view } = setup(false);
    const { frame } = await frameOf(view.container);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("about:blank");
    expect(frame.getAttribute("allow")).toBeNull();
  });

  it("serves the document to the page: versioned edits, replace, stale versions, outside changes", async () => {
    const { view, doc } = setup(false);
    const { posted, send } = await frameOf(view.container);
    const replyTo = async (id: number) =>
      waitFor(() => {
        const r = posted.find((m) => m.reply === id);
        expect(r).toBeDefined();
        return r!;
      });

    send({ call: 1, op: "document.get" });
    expect((await replyTo(1)).value).toEqual({ version: 0, text: "hello world", readOnly: false, name: "a.draw" });

    send({ call: 2, op: "document.edit", args: { version: 0, edits: [{ from: 0, to: 5, insert: "HELLO" }] } });
    expect((await replyTo(2)).value).toEqual({ version: 1 });
    expect(doc.text()).toBe("HELLO world");

    send({ call: 3, op: "document.edit", args: { version: 0, edits: [] } });
    expect((await replyTo(3)).error).toBe("stale");

    send({ call: 4, op: "document.replace", args: { version: 1, text: "HELLO there" } });
    expect((await replyTo(4)).value).toEqual({ version: 2 });
    expect(doc.text()).toBe("HELLO there");

    send({ call: 5, op: "document.edit", args: { version: 2, edits: [{ from: 0, to: 99, insert: "" }] } });
    expect(String((await replyTo(5)).error)).toContain("in range");

    // Changes made elsewhere reach the page; its own are not echoed back.
    const before = posted.filter((m) => m.document).length;
    doc.external([{ from: 0, to: 0, insert: "> " }]);
    await waitFor(() => expect(posted.filter((m) => m.document)).toHaveLength(before + 1));
    expect(posted.at(-1)).toMatchObject({ document: { version: 3, text: "> HELLO there" } });

    send({ call: 6, op: "nope" });
    expect(String((await replyTo(6)).error)).toContain("unknown request");
  });

  it("follows the installed package: a new revision reloads the page, an unchanged one keeps it", async () => {
    let url = "openidea-plugin://localhost/acme.draw/r1/web/index.html";
    setPluginsBackend({ ...createMemoryPluginsBackend([]), webPageUrl: async () => url });
    const info = (version: string) =>
      ({ id: "acme.draw", version, hasCode: false, capabilities: [] }) as unknown as PluginInfo;
    usePlugins.setState({ plugins: [info("1.0.0")] });
    const view = render(<WebView pluginId="acme.draw" view="draw" label="Draw" />);
    const { frame } = await frameOf(view.container);
    expect(frame.getAttribute("src")).toContain("/r1/");

    // Plugins refreshed, same package: the same frame, not reloaded.
    usePlugins.setState({ plugins: [info("1.0.0")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toContain("/r1/");

    url = "openidea-plugin://localhost/acme.draw/r2/web/index.html";
    usePlugins.setState({ plugins: [info("1.0.1")] });
    await waitFor(() => expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain("/r2/"));
  });

  it("forwards the page's messages to the plugin's code only when it has code", async () => {
    for (const hasCode of [false, true]) {
      const { view, events } = setup(hasCode);
      const { send } = await frameOf(view.container);
      send({ text: "hi" });
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual(hasCode ? [{ kind: "message", text: "hi" }] : []);
      view.unmount();
    }
  });

  it("refuses pty-spawn messages when process:<program> capability is not granted", async () => {
    const { view, events } = setup(true);
    const { posted, send } = await frameOf(view.container);
    send({ text: JSON.stringify({ op: "pty-spawn", sessionId: "s1", program: "sh", args: ["-i"] }) });
    await waitFor(() =>
      expect(
        posted.some(
          (m) =>
            typeof m.text === "string" &&
            m.text.includes('"op":"pty-data"') &&
            m.text.includes("process:sh capability not granted"),
        ),
      ).toBe(true),
    );
    expect(events).toEqual([]);
    view.unmount();
  });
});

describe("contributed file icons and templates", () => {
  it("resolves a plugin's file icon before the built-in one, and stops when removed", () => {
    const builtin = fileIconName("a.excalidraw");
    const unregister = registerExternalIcons([["ext:fileIcon/acme/draw", "<svg viewBox='0 0 16 16'/>"]]);
    const remove = addFileIconProvider((name) => (name.endsWith(".excalidraw") ? "ext:fileIcon/acme/draw" : null));
    try {
      expect(fileIconName("a.excalidraw")).toBe("ext:fileIcon/acme/draw");
      expect(fileIconName("a.txt")).not.toBe("ext:fileIcon/acme/draw");
    } finally {
      remove();
      unregister();
    }
    expect(fileIconName("a.excalidraw")).toBe(builtin);
  });

  it("adds a plugin's template to the New menu like a built-in", () => {
    const remove = addContributedFileTemplate({
      id: "plugin.acme.draw",
      name: "Drawing",
      icon: "file-text",
      extension: "draw",
      nameStyle: "asis",
      kinds: [{ id: "file", label: "Drawing", body: "{}" }],
    });
    expect(fileTemplates().some((t) => t.id === "plugin.acme.draw")).toBe(true);
    expect(isBuiltinFileTemplate("plugin.acme.draw")).toBe(true);
    remove();
    expect(fileTemplates().some((t) => t.id === "plugin.acme.draw")).toBe(false);
  });
});
