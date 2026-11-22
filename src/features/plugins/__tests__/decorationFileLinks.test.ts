import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecorationSet, PluginInfo } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { loadMarkdown } from "@/editor/lsp/markdown";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideEditorService, maybeEditorService, provideNotificationService } from "@/workbench/contributions";
import { enableRemote, disableRemote, useRemote } from "@/platform/remote";
import { createMemoryPluginsBackend, setPluginsBackend, tauriPluginsBackend } from "../backend";
import { decorationExtension, startPluginDecorations } from "../decorations";
import { handleRuntimeEvent } from "../runtimeUi";
import { usePlugins } from "../store";

// Host protocol fixture, NOT Git AI provider output: that checkout is read-only.
const plugin = "test.file-links";
const ctx: EditorDocContext = { doc: 1, path: "/p/source.ts", language: "typescript", uiMode: null, readOnly: false };
const range = { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } };
const decoration: DecorationSet = {
  root: "/p",
  path: ctx.path,
  setId: "source",
  tree: false,
  file: null,
  items: [
    {
      range,
      style: "highlight",
      hover: null,
      after: " + model",
      markdownHover: "**Other files / 其他文件**\n\n- [src/空 格\\[a\\]#%.rs](#openidea-file/other-0)",
    },
  ],
};
let editor: TextEditorHandle;
let info: PluginInfo;
let dispose: () => void;
const notify = vi.fn();
beforeEach(async () => {
  notify.mockClear();
  provideNotificationService({ notify });
  useProject.setState({ project: { root: "/p", trusted: true } as never, opening: false });
  useRemote.setState({ session: null });
  info = {
    ...(await createMemoryPluginsBackend().list()).plugins[0]!,
    id: plugin,
    enabled: true,
    hasCode: true,
    status: "active",
    activation: ["on-command:open-decoration-file"],
    capabilities: [{ id: "project.read", granted: true, optional: false, risk: "low", description: "Read project" }],
  };
  usePlugins.setState({ plugins: [info], ui: [] });
  setPluginsBackend(tauriPluginsBackend);
  vi.spyOn(commands, "pluginRunCommand").mockResolvedValue({ status: "ok", data: null });
  dispose = startPluginDecorations();
  editor = {
    ctx,
    view: new EditorView({
      state: EditorState.create({ doc: "😀text", extensions: [decorationExtension(ctx)] }),
      parent: document.body,
    }),
  };
  _addEditor(editor);
  await loadMarkdown();
});
afterEach(() => {
  _removeEditor(editor);
  editor.view.destroy();
  dispose();
  usePlugins.setState({ plugins: [], ui: [] });
  useProject.setState({ project: null });
  disableRemote();
  setPluginsBackend(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function openCard(value = decoration) {
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [value] });
  vi.useFakeTimers();
  try {
    const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
    label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(400);
  } finally {
    vi.useRealTimers();
  }
  const card = document.querySelector<HTMLElement>(".cm-tooltip .cm-lsp-hover")!;
  expect(card).not.toBeNull();
  return card;
}
it("dispatches a published Other files entry from the real floating card to its own plugin and source editor", async () => {
  const card = await openCard();
  const link = card.querySelector("a")!;
  expect(link.textContent).toBe("src/空 格[a]#%.rs");
  link.click();
  await vi.waitFor(() =>
    expect(commands.pluginRunCommand).toHaveBeenCalledWith(
      plugin,
      "open-decoration-file",
      '{"target":"other-0"}',
      { path: "/p/source.ts", language: "typescript", selections: [range] },
      [],
      null,
      null,
      expect.any(Number),
    ),
  );
});

it("never turns body links or generic file URLs into trusted plugin navigation", async () => {
  const previous = maybeEditorService();
  const openFile = vi.fn();
  provideEditorService({ openFile } as never);
  try {
    const card = await openCard({
      ...decoration,
      items: [
        {
          ...decoration.items[0]!,
          markdownHover: [
            "> [forged body](#openidea-file/other-0)",
            '<pre><a href="#openidea-file/other-0">forged code</a></pre>',
            "[outside](file:///outside/secret.rs)",
            "[missing](file:///p/missing.rs)",
            "[traversal](file:///p/../outside/secret.rs)",
            "[library](jdt://contents/a.class)",
            "[relative](src/other.rs)",
            "[wrong command](#openidea-file/../conversation-handoff)",
          ].join("\n\n"),
        },
      ],
    });
    for (const link of card.querySelectorAll("a")) link.click();
    await Promise.resolve();
    expect(commands.pluginRunCommand).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  } finally {
    provideEditorService(previous!);
  }
});
it("invalidates a card when project.read is revoked, even if granted again", async () => {
  const card = await openCard();
  usePlugins.setState({
    plugins: [{ ...info, capabilities: info.capabilities.map((c) => ({ ...c, granted: false })) }],
  });
  usePlugins.setState({ plugins: [info] });
  card.querySelector("a")!.click();
  await Promise.resolve();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
});
it("does not reuse a card after leaving and reopening the same project", async () => {
  const card = await openCard();
  const project = useProject.getState().project;
  useProject.setState({ project: null });
  useProject.setState({ project });
  card.querySelector("a")!.click();
  await Promise.resolve();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
});
it("cancels pending navigation when its source connection changes and never replays it", async () => {
  const remote = { root: "/p", host: "source-host", commands: ["plugin_run_command"] } as never;
  useRemote.setState({ session: remote });
  vi.mocked(commands.pluginRunCommand).mockImplementation(() => new Promise(() => {}));
  const cancel = vi.spyOn(commands, "cancelRequest").mockResolvedValue(undefined);
  const card = await openCard();
  card.querySelector("a")!.click();
  await vi.waitFor(() => expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1));
  const request = vi.mocked(commands.pluginRunCommand).mock.calls[0]![7];
  useRemote.setState({ session: null });
  useRemote.setState({ session: remote });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(request));
  card.querySelector("a")!.click();
  expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1);
});
it("withdraws publications from a previous host even when both hosts use the same project path", async () => {
  useRemote.setState({ session: { root: "/p", host: "first", commands: ["plugin_run_command"] } as never });
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [decoration] });
  expect(editor.view.dom.textContent).toContain(" + model");
  useRemote.setState({ session: { root: "/p", host: "second", commands: ["plugin_run_command"] } as never });
  expect(editor.view.dom.textContent).not.toContain(" + model");
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
});
it("dispatches the refreshed metadata entry but never the replaced card's detached entry", async () => {
  const card = await openCard();
  const oldLink = card.querySelector("a")!;
  handleRuntimeEvent({
    type: "decorationsChanged",
    pluginId: plugin,
    sets: [
      {
        ...decoration,
        items: [{ ...decoration.items[0]!, markdownHover: "**Other files**\n\n- [next.rs](#openidea-file/other-1)" }],
      },
    ],
  });
  oldLink.click();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
  card.querySelector("a")!.click();
  await vi.waitFor(() =>
    expect(commands.pluginRunCommand).toHaveBeenCalledWith(
      plugin,
      "open-decoration-file",
      '{"target":"other-1"}',
      { path: "/p/source.ts", language: "typescript", selections: [range] },
      [],
      null,
      null,
      expect.any(Number),
    ),
  );
});
it("does not navigate from an annotation shifted by edits before the hover opens", async () => {
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [decoration] });
  editor.view.dispatch({ changes: { from: 0, insert: "changed" } });
  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers();
  const link = document.querySelector<HTMLAnchorElement>(".cm-tooltip .cm-lsp-hover a")!;
  expect(link).not.toBeNull();
  link.click();
  await Promise.resolve();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
});

it("activates the published file entry with the keyboard without changing the editor selection", async () => {
  const card = await openCard();
  const before = editor.view.state.selection;
  const link = card.querySelector("a")!;
  link.focus();
  expect(document.activeElement).toBe(link);
  await userEvent.setup().keyboard("{Enter}");
  expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1);
  expect(editor.view.state.selection).toBe(before);
});
it.each(["disabled", "failed", "undeclared", "untrusted", "opening", "backend", "remote-api", "remote-root"])(
  "fails closed when the card's %s context is no longer eligible",
  async (change) => {
    const card = await openCard();
    if (change === "disabled") usePlugins.setState({ plugins: [{ ...info, enabled: false }] });
    if (change === "failed") usePlugins.setState({ plugins: [{ ...info, status: "failed" }] });
    if (change === "undeclared") usePlugins.setState({ plugins: [{ ...info, activation: [] }] });
    if (change === "untrusted") useProject.setState({ project: { ...useProject.getState().project!, trusted: false } });
    if (change === "opening") useProject.setState({ opening: true });
    if (change === "backend") setPluginsBackend(createMemoryPluginsBackend());
    if (change === "remote-api") useRemote.setState({ session: { root: "/p", commands: [] } as never });
    if (change === "remote-root")
      useRemote.setState({ session: { root: "/other", commands: ["plugin_run_command"] } as never });
    card.querySelector("a")!.click();
    await Promise.resolve();
    expect(commands.pluginRunCommand).not.toHaveBeenCalled();
  },
);

it.each([
  ["notFound", "No such file: removed.rs"],
  ["permissionDenied", "project.read is required"],
] as const)("shows a native %s failure to the user", async (kind, message) => {
  vi.mocked(commands.pluginRunCommand).mockResolvedValue({ status: "error", error: { kind, message, data: null } });
  const card = await openCard();
  card.querySelector("a")!.click();
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        title: "Cannot open plugin file",
        body: message,
      }),
    ),
  );
  expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1);
});
it("keeps native cancellation quiet without retrying", async () => {
  vi.mocked(commands.pluginRunCommand).mockResolvedValue({
    status: "error",
    error: { kind: "cancelled", message: "cancelled", data: null },
  });
  const card = await openCard();
  card.querySelector("a")!.click();
  await vi.waitFor(() => expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(notify).not.toHaveBeenCalled();
});

it("never falls back to local decoration snapshots when the remote lacks the snapshot API", async () => {
  const snapshots = vi.spyOn(commands, "pluginDecorationSets").mockResolvedValue({ [plugin]: [decoration] });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  useRemote.setState({ session: { root: "/p", host: "remote", commands: ["plugin_run_command"] } as never });
  await Promise.resolve();
  expect(snapshots).not.toHaveBeenCalled();
  expect(editor.view.dom.textContent).not.toContain(" + model");
});
it("opens only the current host's snapshot after a same-path publication from another host", async () => {
  useRemote.setState({
    session: { root: "/p", host: "remote", commands: ["plugin_run_command", "plugin_decoration_sets"] } as never,
  });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const snapshots = vi.spyOn(commands, "pluginDecorationSets").mockResolvedValue({ [plugin]: [decoration] });
  handleRuntimeEvent({
    type: "decorationsChanged",
    pluginId: plugin,
    sets: [
      {
        ...decoration,
        items: [
          {
            ...decoration.items[0]!,
            markdownHover: "**Other files**\n\n- [LOCAL](#openidea-file/local-token)",
          },
        ],
      },
    ],
  });
  await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1));
  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers();
  const link = document.querySelector<HTMLAnchorElement>(".cm-tooltip .cm-lsp-hover a")!;
  expect(link.textContent).toBe("src/空 格[a]#%.rs");
  link.click();
  await vi.waitFor(() =>
    expect(commands.pluginRunCommand).toHaveBeenCalledWith(
      plugin,
      "open-decoration-file",
      '{"target":"other-0"}',
      { path: "/p/source.ts", language: "typescript", selections: [range] },
      [],
      null,
      null,
      expect.any(Number),
    ),
  );
});
it("drops a pending old-host snapshot after reconnecting at the same root", async () => {
  let release!: (sets: Record<string, DecorationSet[]>) => void;
  const fresh = { ...decoration, items: [{ ...decoration.items[0]!, after: " + new host" }] };
  const snapshots = vi
    .spyOn(commands, "pluginDecorationSets")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ [plugin]: [fresh] });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  useRemote.setState({
    session: { root: "/p", host: "first", commands: ["plugin_run_command", "plugin_decoration_sets"] } as never,
  });
  await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1));
  useRemote.setState({
    session: { root: "/p", host: "second", commands: ["plugin_run_command", "plugin_decoration_sets"] } as never,
  });
  await vi.waitFor(() => expect(editor.view.dom.textContent).toContain(" + new host"));
  release({ [plugin]: [decoration] });
  await Promise.resolve();
  expect(snapshots).toHaveBeenCalledTimes(2);
  expect(editor.view.dom.textContent).toContain(" + new host");
  expect(editor.view.dom.textContent).not.toContain(" + model");
});
it("does not cancel a card operation when an invalidation returns the same authoritative snapshot", async () => {
  const card = await openCard();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const snapshots = vi
    .spyOn(commands, "pluginDecorationSets")
    .mockResolvedValue({ [plugin]: structuredClone([decoration]) });
  vi.mocked(commands.pluginRunCommand).mockImplementation(() => new Promise(() => {}));
  const cancel = vi.spyOn(commands, "cancelRequest").mockResolvedValue(undefined);
  card.querySelector("a")!.click();
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [] });
  await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(cancel).not.toHaveBeenCalled();
  expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1);
});

it("waits for enableRemote to install the invoke route before reading its snapshot", async () => {
  const invoke = vi.fn(async (cmd: string) =>
    cmd === "remote_invoke" ? JSON.stringify({ [plugin]: [decoration] }) : {},
  );
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1, unregisterCallback: () => {} });
  enableRemote({ root: "/p", host: "remote", commands: ["plugin_run_command", "plugin_decoration_sets"] } as never);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["remote_invoke"]);
  await vi.waitFor(() => expect(editor.view.dom.textContent).toContain(" + model"));
});
it("withdraws stale navigation and reports an authoritative snapshot refresh failure", async () => {
  const card = await openCard();
  const link = card.querySelector("a")!;
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(commands, "pluginDecorationSets").mockRejectedValue(new Error("Source host unavailable"));
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [] });
  await vi.waitFor(() => expect(card.isConnected).toBe(false));
  link.click();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Cannot refresh plugin annotations",
      body: "Source host unavailable",
    }),
  );
});
it("suspends new navigation until an invalidated snapshot is validated, without cancelling equal data", async () => {
  const card = await openCard();
  const link = card.querySelector("a")!;
  let release!: (sets: Record<string, DecorationSet[]>) => void;
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const snapshots = vi.spyOn(commands, "pluginDecorationSets").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  handleRuntimeEvent({ type: "decorationsChanged", pluginId: plugin, sets: [] });
  await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1));
  link.click();
  expect(commands.pluginRunCommand).not.toHaveBeenCalled();
  release({ [plugin]: structuredClone([decoration]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  link.click();
  expect(commands.pluginRunCommand).toHaveBeenCalledTimes(1);
});
