import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginInfo, ViewEvent } from "@/bindings";
import { addFileIconProvider, fileIconName, registerExternalIcons } from "@/ui";
import { provideEditorService, type EditorInput, type EditorService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { isToolWindowVisible, resetToolWindowLayout, showToolWindow } from "@/workbench/toolwindows/store";
import { ToolWindowLayout } from "@/workbench/toolwindows/ToolWindows";
import {
  addContributedFileTemplate,
  fileTemplates,
  isBuiltinFileTemplate,
  mergeFileTemplates,
} from "@/features/templates/files/store";
import { createMemoryPluginsBackend, setPluginsBackend, webSchemeUrl } from "../backend";
import { defineViewUiPoints } from "../uiPoints";
import { clearUiContributions, syncUiContributions } from "../projection";
import { usePlugins } from "../store";
import * as ptyModule from "../views/ptyBridge";
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
    bytes: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00])),
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
  it("accepts bounded zoom only from its parent with the bridge tag", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(frameDocument("", { dark: true, vars: {} }))![1]!;
    const parent = {};
    const handlers = new Map<string, (e: { source: object; data: object }) => void>();
    const root = document.createElement("html");
    const frameWindow = {
      parent,
      addEventListener: (type: string, fn: (e: { source: object; data: object }) => void) => handlers.set(type, fn),
    };
    new Function("window", "document", script)(frameWindow, { documentElement: root });
    const send = (source: object, data: object) => handlers.get("message")!({ source, data });
    send({}, { tag: FRAME_TAG, fontZoomDelta: 1 });
    send(parent, { tag: "other", fontZoomDelta: 1 });
    send(parent, { tag: FRAME_TAG, fontZoomDelta: NaN });
    send(parent, { tag: FRAME_TAG, fontZoomDelta: 100 });
    expect(root.style.zoom).toBe("");
    send(parent, { tag: FRAME_TAG, fontZoomDelta: 1 });
    expect(root.style.zoom).toBe("1.08");
    send(parent, { tag: FRAME_TAG, fontZoomDelta: -1 });
    expect(root.style.zoom).toBe("");
    send(parent, { tag: FRAME_TAG, fontZoomDelta: 1 });
    send(parent, { tag: FRAME_TAG, fontZoomDelta: 0 });
    expect(root.style.zoom).toBe("");
  });

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
          bytes(): Promise<Uint8Array>;
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

      const bytes = api.document.bytes();
      expect(sent.at(-1)).toMatchObject({ op: "document.bytes" });
      reply({ reply: sent.at(-1)!.call, value: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]) });
      await expect(bytes).resolves.toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]));

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
      plugins: [{ id: "acme.draw", hasCode, enabled: true, capabilities: [] } as unknown as PluginInfo],
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

    send({ call: 2, op: "document.bytes" });
    expect(await replyTo(2)).toMatchObject({ value: { 0: 0x25, 1: 0x50, 2: 0x44, 3: 0x46, 4: 0, byteLength: 5 } });

    send({ call: 3, op: "document.edit", args: { version: 0, edits: [{ from: 0, to: 5, insert: "HELLO" }] } });
    expect((await replyTo(3)).value).toEqual({ version: 1 });
    expect(doc.text()).toBe("HELLO world");

    send({ call: 4, op: "document.edit", args: { version: 0, edits: [] } });
    expect((await replyTo(4)).error).toBe("stale");

    send({ call: 5, op: "document.replace", args: { version: 1, text: "HELLO there" } });
    expect((await replyTo(5)).value).toEqual({ version: 2 });
    expect(doc.text()).toBe("HELLO there");

    send({ call: 6, op: "document.edit", args: { version: 2, edits: [{ from: 0, to: 99, insert: "" }] } });
    expect(String((await replyTo(6)).error)).toContain("in range");

    // Changes made elsewhere reach the page; its own are not echoed back.
    const before = posted.filter((m) => m.document).length;
    doc.external([{ from: 0, to: 0, insert: "> " }]);
    await waitFor(() => expect(posted.filter((m) => m.document)).toHaveLength(before + 1));
    expect(posted.at(-1)).toMatchObject({ document: { version: 3, text: "> HELLO there" } });

    send({ call: 7, op: "nope" });
    expect(String((await replyTo(7)).error)).toContain("unknown request");
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

  it("opens a streaming log editor tab only when process:<program> capability is granted", async () => {
    const opened: EditorInput[] = [];
    provideEditorService({
      openFile: async () => {},
      openVirtual: () => {},
      openInput: async (input: EditorInput) => void opened.push(input),
      openDiff: () => {},
      openMerge: () => {},
      closeFile: () => {},
      activeFile: () => null,
    } as unknown as EditorService);

    const { view, events } = setup(true);
    const { send } = await frameOf(view.container);
    const payload = {
      op: "open-log-tab",
      title: "App Logs",
      key: "shared",
      program: "tail",
      args: ["-f", "app.log"],
      toggles: [{ id: "verbose", label: "Verbose", args: ["-v"] }],
    };

    // Denied when process:tail is not granted.
    send({ text: JSON.stringify(payload) });
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toHaveLength(0);
    expect(events).toHaveLength(0);

    // Granted when process:tail is granted.
    usePlugins.setState({
      plugins: [
        {
          id: "acme.draw",
          enabled: true,
          hasCode: true,
          capabilities: [{ id: "process:tail", granted: true }],
        } as unknown as PluginInfo,
      ],
    });
    send({ text: JSON.stringify(payload) });
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({
      kind: "pluginLog",
      key: `pluginLog:${JSON.stringify(["acme.draw", "draw", "shared"])}`,
      data: {
        view: "draw",
        pluginId: "acme.draw",
        title: "App Logs",
        program: "tail",
        args: ["-f", "app.log"],
        toggles: [{ id: "verbose", label: "Verbose", args: ["-v"] }],
      },
    });
    view.unmount();
  });

  it("closes frame PTYs on plugin changes, navigation, window teardown and unmount", async () => {
    const original = ptyModule.ptyBridge;
    const closes: ReturnType<typeof vi.fn>[] = [];
    const spy = vi.spyOn(ptyModule, "ptyBridge").mockImplementation((...args) => {
      const bridge = original(...args);
      const close = vi.fn(bridge.close);
      closes.push(close);
      return { ...bridge, close };
    });
    try {
      const { view } = setup(true);
      const { frame, send, posted } = await frameOf(view.container);
      for (const change of [
        (p: PluginInfo) => ({ ...p, enabled: false }),
        (p: PluginInfo) => ({ ...p, enabled: true, capabilities: [] }),
        (p: PluginInfo) => ({ ...p, version: "2.0.0" }),
      ]) {
        const close = closes.at(-1)!;
        act(() => usePlugins.setState((s) => ({ plugins: s.plugins.map(change) })));
        expect(close).toHaveBeenCalled();
      }
      const close = closes.at(-1)!;
      act(() => {
        frame.dispatchEvent(new Event("load"));
        frame.dispatchEvent(new Event("load"));
      });
      expect(close).toHaveBeenCalled();
      const windowClose = closes.at(-1)!;
      act(() => window.dispatchEvent(new Event("pagehide")));
      expect(windowClose).toHaveBeenCalled();
      // Another window cannot request a PTY through this frame's listener.
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { tag: FRAME_TAG, text: JSON.stringify({ op: "pty-spawn", sessionId: "s", program: "sh" }) },
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(posted.filter((m) => m.text)).toEqual([]);
      send({ text: "message" });
      view.unmount();
      expect(closes.every((close) => close.mock.calls.length > 0)).toBe(true);
    } finally {
      spy.mockRestore();
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
            m.text.includes('"op":"pty-error"') &&
            m.text.includes("process:sh capability not granted"),
        ),
      ).toBe(true),
    );
    expect(events).toEqual([]);
    view.unmount();
  });

  it("opens a generic plugin content editor tab and reports invalid requests via content-tab-error", async () => {
    const opened: EditorInput[] = [];
    provideEditorService({
      openFile: async () => {},
      openVirtual: () => {},
      openInput: async (input: EditorInput) => void opened.push(input),
      openDiff: () => {},
      openMerge: () => {},
      closeFile: () => {},
      activeFile: () => null,
    } as unknown as EditorService);

    const { view, events } = setup(true);
    usePlugins.setState({
      plugins: [{ id: "acme.draw", enabled: true, hasCode: true, capabilities: [] } as unknown as PluginInfo],
    });
    const { posted, send } = await frameOf(view.container);

    // Invalid payload sends content-tab-error back to the frame.
    send({ text: JSON.stringify({ op: "open-content-tab", title: "", content: "x" }) });
    await waitFor(() =>
      expect(posted.some((m) => typeof m.text === "string" && m.text.includes('"op":"content-tab-error"'))).toBe(true),
    );
    expect(opened).toHaveLength(0);

    // Valid payload opens a pluginContent editor tab.
    send({
      text: JSON.stringify({
        op: "open-content-tab",
        key: "cfg",
        title: "service.toml",
        fileName: "service.toml",
        language: "toml",
        content: 'name = "demo"\n',
        actions: [{ id: "save", label: "Apply", icon: "green-checkmark", primary: true, save: true }],
      }),
    });
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({
      kind: "pluginContent",
      key: `pluginContent:${JSON.stringify(["acme.draw", "draw", "cfg"])}`,
      data: {
        pluginId: "acme.draw",
        view: "draw",
        key: "cfg",
        title: "service.toml",
        fileName: "service.toml",
        language: "toml",
        content: 'name = "demo"\n',
        readOnly: false,
      },
    });
    expect(events).toHaveLength(0);
    view.unmount();
  });

  it("keeps the standard tool-window header unless header = 'none', preserves it while loading or on error, and renders keyboard-operable corner actions with inset vars when ready", async () => {
    resetToolWindowLayout();
    const prevProject = useProject.getState().project;
    useProject.setState({ project: { root: "/proj", name: "proj", trusted: true } as never });
    const undefine = defineViewUiPoints();
    try {
      let resolveUrl!: (url: string) => void;
      let rejectUrl!: (err: Error) => void;
      let mode: "pending" | "ready" | "error" = "ready";
      setPluginsBackend({
        ...createMemoryPluginsBackend([]),
        webPageUrl: () =>
          mode === "ready"
            ? Promise.resolve("about:blank")
            : mode === "error"
              ? Promise.reject(new Error("page missing"))
              : new Promise<string>((res, rej) => {
                  resolveUrl = res;
                  rejectUrl = rej;
                }),
      });
      const plugin = { id: "acme.kube", version: "1.0.0", hasCode: false, capabilities: [] } as unknown as PluginInfo;
      usePlugins.setState({ plugins: [plugin] });

      // 1. Default web view (without header = "none"): keeps the standard <header>.
      syncUiContributions(
        [
          {
            pluginId: "acme.kube",
            point: "views",
            key: "normal",
            decl: { id: "normal", title: "Normal View", location: "bottom", web: "web/index.html" },
          },
        ],
        [plugin],
      );
      showToolWindow("plugin.acme.kube.normal");
      const first = render(<ToolWindowLayout editor={null} />);
      const normal = await frameOf(first.container);
      fireEvent.load(normal.frame);
      expect(
        normal.posted.some((m) => (m.theme as { vars: Record<string, string> })?.vars["--openidea-corner-inset-width"]),
      ).toBe(false);
      expect(first.container.querySelector('[data-toolwindow="plugin.acme.kube.normal"] header')).not.toBeNull();
      expect(screen.getByText("Normal View")).toBeInTheDocument();
      first.unmount();
      clearUiContributions();

      // 2. Loading state with header = "none": keeps the standard <header> (title + Options + Hide) until ready.
      mode = "pending";
      syncUiContributions(
        [
          {
            pluginId: "acme.kube",
            point: "views",
            key: "cluster",
            decl: {
              id: "cluster",
              title: "Cluster Explorer",
              location: "bottom",
              web: "web/index.html",
              header: "none",
            },
          },
        ],
        [plugin],
      );
      showToolWindow("plugin.acme.kube.cluster");
      const second = render(<ToolWindowLayout editor={null} />);
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      expect(screen.getByText("Cluster Explorer")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();

      // A resolved URL is still loading until the iframe has loaded.
      act(() => resolveUrl("https://plugin.invalid/revision-1"));
      const { frame, posted } = await frameOf(second.container);
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      fireEvent.load(frame);
      await waitFor(() =>
        expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).toBeNull(),
      );
      expect(second.container.querySelector("iframe")).toBe(frame);
      await waitFor(() =>
        expect(
          posted.some(
            (m) =>
              (m.theme as { vars?: Record<string, string> } | undefined)?.vars?.["--openidea-corner-inset-width"] ===
                "64px" &&
              (m.theme as { vars?: Record<string, string> } | undefined)?.vars?.["--openidea-corner-inset-height"] ===
                "34px",
          ),
        ).toBe(true),
      );

      act(() => usePlugins.setState({ plugins: [{ ...plugin, version: "1.0.1" }] }));
      act(() => resolveUrl("https://plugin.invalid/revision-2"));
      await waitFor(() => expect(frame).toHaveAttribute("src", "https://plugin.invalid/revision-2"));
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      expect(second.container.querySelector("iframe")).toBe(frame);
      fireEvent.load(frame);
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).toBeNull();

      act(() => usePlugins.setState({ plugins: [{ ...plugin, version: "1.0.2" }] }));
      act(() => rejectUrl(new Error("page missing")));
      await waitFor(() => expect(screen.getByText("page missing")).toBeInTheDocument());
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      act(() => usePlugins.setState({ plugins: [{ ...plugin, version: "1.0.3" }] }));
      act(() => resolveUrl("https://plugin.invalid/revision-2"));
      const recovered = await frameOf(second.container);
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      fireEvent.load(recovered.frame);
      expect(second.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).toBeNull();

      const user = userEvent.setup();
      const optionsBtn = screen.getByRole("button", { name: "Options" });
      optionsBtn.focus();
      expect(document.activeElement).toBe(optionsBtn);
      await user.keyboard("{Enter}");
      expect(optionsBtn).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{Escape}");
      expect(optionsBtn).toHaveAttribute("aria-expanded", "false");

      const hideBtn = screen.getByRole("button", { name: "Hide" });
      await user.tab();
      expect(document.activeElement).toBe(hideBtn);
      await user.keyboard(" ");
      expect(isToolWindowVisible("plugin.acme.kube.cluster")).toBe(false);
      second.unmount();

      // 4. Error state with header = "none": keeps the standard <header> so the user still has title, Options, and Hide.
      mode = "pending";
      act(() => usePlugins.setState({ plugins: [{ ...plugin, version: "1.0.1" }] }));
      showToolWindow("plugin.acme.kube.cluster");
      const third = render(<ToolWindowLayout editor={null} />);
      act(() => rejectUrl(new Error("page missing")));
      await waitFor(() => expect(screen.getByText("page missing")).toBeInTheDocument());
      expect(third.container.querySelector('[data-toolwindow="plugin.acme.kube.cluster"] header')).not.toBeNull();
      expect(screen.getByText("Cluster Explorer")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
      third.unmount();
    } finally {
      clearUiContributions();
      undefine();
      useProject.setState({ project: prevProject });
      resetToolWindowLayout();
    }
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

  it("projects filename and variable declarations through contributions and withdraws them", () => {
    const undefine = defineViewUiPoints();
    try {
      syncUiContributions(
        [
          {
            pluginId: "fixture",
            point: "fileTemplates",
            key: "ignore",
            decl: {
              id: "ignore",
              name: "Ignore",
              extension: "",
              fileName: ".dockerignore",
              body: "$OUTPUT$",
              variables: [{ name: "OUTPUT", prompt: "Output folder" }],
            },
          },
        ],
        [{ id: "fixture" } as PluginInfo],
      );
      expect(fileTemplates().find((t) => t.id === "plugin.fixture.ignore")).toMatchObject({
        fileName: ".dockerignore",
        extension: "",
        inferPackage: true,
        variables: [{ name: "OUTPUT", prompt: "Output folder" }],
        kinds: [{ body: "$OUTPUT$" }],
      });
      clearUiContributions();
      expect(fileTemplates().some((t) => t.id === "plugin.fixture.ignore")).toBe(false);
    } finally {
      clearUiContributions();
      undefine();
    }
  });

  it("inherits new declaration fields without losing a legacy template customization", () => {
    const legacy = {
      id: "plugin.fixture.repository",
      name: "Custom Repository",
      icon: "file-text",
      extension: "java",
      nameStyle: "asis" as const,
      kinds: [{ id: "file", label: "File", body: "// custom $ENTITY$ $PACKAGE$" }],
    };
    const remove = addContributedFileTemplate({
      ...legacy,
      name: "Repository",
      fileName: "Repository.java",
      inferPackage: true,
      variables: [{ name: "ENTITY", prompt: "Entity class" }],
      kinds: [{ id: "file", label: "File", body: "$END$" }],
    });
    try {
      expect(
        mergeFileTemplates({ templates: { [legacy.id]: legacy }, deleted: [] }).find((t) => t.id === legacy.id),
      ).toMatchObject({
        name: "Custom Repository",
        fileName: "Repository.java",
        inferPackage: true,
        variables: [{ name: "ENTITY", prompt: "Entity class" }],
        kinds: legacy.kinds,
      });
    } finally {
      remove();
    }
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
