import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PluginInfo } from "@/bindings";
import { registerActions } from "@/platform/actions";
import { useContributions } from "@/workbench/contributions";
import { usePlugins } from "../store";
import { startViewUi } from "../uiPoints";
import { registerContentActions } from "../views/contentActions";
import {
  PluginContentEditor,
  closeContentSession,
  pluginContentEditorDocument,
  pluginContentEditorIcon,
  pluginContentEditorTitle,
} from "../views/contentEditor";
import {
  PLUGIN_CONTENT_EDITOR_KIND,
  contentTabData,
  contentTabKey,
  handleContentTabReplyText,
  registerContentTabSender,
} from "../views/contentTab";

const plugin = { id: "probe", enabled: true, hasCode: false, capabilities: [] } as unknown as PluginInfo;
const spec = {
  key: "service-config",
  title: "service.toml",
  fileName: "service.toml",
  language: "toml",
  content: 'name = "demo"\nreplicas = 2\n',
  readOnly: false,
  actions: [
    { id: "reload", label: "Reload", icon: "rerun" as const },
    { id: "diff", label: "Diff", icon: "diff" as const },
    { id: "save", label: "Apply", icon: "green-checkmark" as const, primary: true, save: true },
  ],
};

let stopActions: () => void;
beforeEach(() => {
  stopActions = registerContentActions();
});

afterEach(() => {
  cleanup();
  closeContentSession(contentTabKey("probe", "inspector", "service-config"));
  stopActions();
  usePlugins.setState({ plugins: [] });
  vi.restoreAllMocks();
});

function setup(overrides: Partial<typeof spec> = {}) {
  usePlugins.setState({ plugins: [plugin] });
  const sent: Array<Record<string, unknown>> = [];
  const offSender = registerContentTabSender("probe", "inspector", (msg) => {
    const text = (msg as { text?: string }).text;
    if (text) sent.push(JSON.parse(text) as Record<string, unknown>);
  });
  const data = contentTabData("probe", "inspector", { ...spec, ...overrides }, 100);
  const key = contentTabKey("probe", "inspector", data.key);
  const input = { kind: PLUGIN_CONTENT_EDITOR_KIND, key, data };
  const rendered = render(<PluginContentEditor input={input} />);
  const content = () => rendered.container.querySelector(".cm-content")!;
  const view = () => EditorView.findFromDOM(content() as HTMLElement)!;
  return {
    sent,
    offSender,
    rendered,
    input,
    view,
    reply: (payload: Record<string, unknown>) =>
      act(() => {
        handleContentTabReplyText("probe", JSON.stringify({ op: "content-tab-reply", ...payload }));
      }),
  };
}

describe("plugin-backed content editor tabs", () => {
  it("validates open-content-tab requests and rejects invalid icons, duplicate actions, path separators and disabled plugins", () => {
    usePlugins.setState({ plugins: [plugin] });
    for (const bad of [
      { title: "" },
      { title: "x".repeat(257) },
      { key: "x".repeat(129) },
      { fileName: "sub/service.toml" },
      { fileName: "sub\\service.toml" },
      { language: "x".repeat(65) },
      { content: 123 },
      { content: "a\0b" },
      { readOnly: "nope" },
      { actions: [{ id: "a", label: "A", icon: "not-a-builtin-icon" }] },
      { actions: [spec.actions[0], spec.actions[0]] },
      {
        actions: [
          { id: "s1", label: "S1", save: true },
          { id: "s2", label: "S2", save: true },
        ],
      },
    ]) {
      expect(() => contentTabData("probe", "inspector", { ...spec, ...bad }, 100)).toThrow();
    }
    expect(() => contentTabData("probe", "inspector", spec, (2 << 20) + 1)).toThrow();
    usePlugins.setState({ plugins: [{ ...plugin, enabled: false }] });
    expect(() => contentTabData("probe", "inspector", spec, 100)).toThrow();
  });

  it("derives tab title and file icon from fileName/title without hardcoding YAML", () => {
    usePlugins.setState({ plugins: [plugin] });
    const tomlData = contentTabData("probe", "inspector", spec, 100);
    const tomlInput = { kind: PLUGIN_CONTENT_EDITOR_KIND, key: "k1", data: tomlData };
    expect(pluginContentEditorTitle(tomlInput)).toBe("service.toml");
    expect(pluginContentEditorIcon(tomlInput)).toBe("file-toml");

    const jsonData = contentTabData("probe", "inspector", { ...spec, title: "Config", fileName: "settings.json" }, 100);
    const jsonInput = { kind: PLUGIN_CONTENT_EDITOR_KIND, key: "k2", data: jsonData };
    expect(pluginContentEditorIcon(jsonInput)).toBe("file-json");
  });

  it("tracks dirty state, Undo/Redo, discard, and close-with-changes Save lifecycle", async () => {
    const f = setup();
    try {
      expect(f.view().state.doc.toString()).toBe(spec.content);
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);

      // Edit the document: marks the tab dirty.
      act(() => {
        f.view().dispatch({
          changes: { from: f.view().state.doc.length, insert: 'env = "prod"\n' },
        });
      });
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
      expect(screen.getByText(/Modified/)).toBeInTheDocument();

      // Undo and Redo through the document lifecycle.
      await act(() => pluginContentEditorDocument.undo!(f.input));
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);
      await act(() => pluginContentEditorDocument.redo!(f.input));
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);

      // Prepare close freezes editing until cancelClose.
      await act(() => pluginContentEditorDocument.prepareClose(f.input));
      expect(f.view().state.facet(EditorState.readOnly)).toBe(true);
      act(() => pluginContentEditorDocument.cancelClose(f.input));
      expect(f.view().state.facet(EditorState.readOnly)).toBe(false);

      // A failed save rejects and leaves the tab dirty.
      const failedSave = pluginContentEditorDocument.save(f.input);
      expect(f.sent.at(-1)).toMatchObject({
        op: "content-tab-action",
        key: "service-config",
        action: "save",
        content: `${spec.content}env = "prod"\n`,
      });
      f.reply({ requestId: f.sent.at(-1)!.requestId, error: "validation failed" });
      await expect(failedSave).rejects.toThrow("validation failed");
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
      await waitFor(() => expect(screen.getByText("validation failed")).toBeInTheDocument());

      // A succeeding save clears the dirty state.
      const okSave = pluginContentEditorDocument.save(f.input);
      f.reply({ requestId: f.sent.at(-1)!.requestId, saved: true, status: "Saved to cluster" });
      await expect(okSave).resolves.toBeUndefined();
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);
      await waitFor(() => expect(screen.getByText("Saved to cluster")).toBeInTheDocument());

      // Discard reverts unsaved edits to the last saved baseline.
      act(() => {
        f.view().dispatch({
          changes: { from: f.view().state.doc.length, insert: "temp = true\n" },
        });
      });
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
      await act(() => pluginContentEditorDocument.discard(f.input));
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);
      expect(f.view().state.doc.toString()).toBe(`${spec.content}env = "prod"\n`);
    } finally {
      f.offSender();
    }
  });

  it("dispatches toolbar actions, updates content on reload, and opens the IDE diff viewer on diff replies", async () => {
    const diffs: unknown[] = [];
    const unregisterDiff = registerActions([
      {
        id: "vcs.openDiff",
        title: "Open Diff",
        run: ({ arg }) => void diffs.push(arg),
      },
    ]);
    const f = setup();
    try {
      // Click Reload action -> plugin replies with new content.
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(f.sent.at(-1)).toMatchObject({ action: "reload" }));
      f.reply({
        requestId: f.sent.at(-1)!.requestId,
        content: 'name = "demo"\nreplicas = 5\n',
        status: "Reloaded",
      });
      await waitFor(() => expect(f.view().state.doc.toString()).toBe('name = "demo"\nreplicas = 5\n'));
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);

      // Click Diff action -> plugin replies with left/right diff, opening vcs.openDiff.
      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      await waitFor(() => expect(f.sent.at(-1)).toMatchObject({ action: "diff" }));
      f.reply({
        requestId: f.sent.at(-1)!.requestId,
        diff: {
          left: 'name = "demo"\nreplicas = 2\n',
          right: 'name = "demo"\nreplicas = 5\n',
          leftLabel: "Live",
          rightLabel: "Edited",
          title: "Diff: service.toml",
        },
      });
      await waitFor(() => expect(diffs).toHaveLength(1));
      expect(diffs[0]).toEqual({
        path: "service.toml",
        title: "Diff: service.toml",
        left: { type: "text", text: 'name = "demo"\nreplicas = 2\n', label: "Live" },
        right: { type: "text", text: 'name = "demo"\nreplicas = 5\n', label: "Edited" },
      });
    } finally {
      f.offSender();
      unregisterDiff();
    }
  });

  it.each([undefined, "normalized = true\n"])("keeps later edits dirty when a save returns %j", async (replacement) => {
    const f = setup();
    try {
      act(() => f.view().dispatch({ changes: { from: 0, insert: "first = true\n" } }));
      const savedText = f.view().state.doc.toString();
      const saving = pluginContentEditorDocument.save(f.input);
      act(() => f.view().dispatch({ changes: { from: 0, insert: "later = true\n" } }));
      f.reply({ requestId: f.sent.at(-1)!.requestId, saved: true, content: replacement });
      await saving;
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
      expect(f.view().state.doc.toString()).toBe(`later = true\n${savedText}`);
      await act(() => pluginContentEditorDocument.discard(f.input));
      expect(f.view().state.doc.toString()).toBe(replacement ?? savedText);
    } finally {
      f.offSender();
    }
  });

  it.each([{ saved: false }, { content: "rejected replacement", error: "validation failed" }])(
    "keeps failed saves dirty for reply %j",
    async (reply) => {
      const f = setup();
      try {
        act(() => f.view().dispatch({ changes: { from: 0, insert: "edited = true\n" } }));
        const editedText = f.view().state.doc.toString();
        const saving = pluginContentEditorDocument.save(f.input);
        f.reply({ requestId: f.sent.at(-1)!.requestId, ...reply });
        await expect(saving).rejects.toThrow();
        expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
        expect(f.view().state.doc.toString()).toBe(editedText);
      } finally {
        f.offSender();
      }
    },
  );

  it("preserves unsaved changes when a reply makes the document read-only", async () => {
    const f = setup();
    try {
      act(() => f.view().dispatch({ changes: { from: 0, insert: "edited = true\n" } }));
      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      await waitFor(() => expect(f.sent.at(-1)).toMatchObject({ action: "diff" }));
      f.reply({ requestId: f.sent.at(-1)!.requestId, readOnly: true });
      await waitFor(() => expect(f.view().state.facet(EditorState.readOnly)).toBe(true));
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
      const saving = pluginContentEditorDocument.save(f.input);
      f.reply({ requestId: f.sent.at(-1)!.requestId, saved: true });
      await saving;
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);
    } finally {
      f.offSender();
    }
  });

  it("rejects an unsuccessful save while the editor is unmounted", async () => {
    const f = setup();
    try {
      act(() => f.view().dispatch({ changes: { from: 0, insert: "edited = true\n" } }));
      f.rendered.unmount();
      const saving = pluginContentEditorDocument.save(f.input);
      let prepared = false;
      const preparing = pluginContentEditorDocument.prepareClose(f.input).then(() => {
        prepared = true;
      });
      await Promise.resolve();
      expect(prepared).toBe(false);
      f.reply({ requestId: f.sent.at(-1)!.requestId, saved: false });
      await expect(saving).rejects.toThrow();
      await preparing;
      expect(prepared).toBe(true);
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(true);
    } finally {
      f.offSender();
    }
  });

  it("drains pending toolbar actions before deciding whether a tab can close", async () => {
    const f = setup();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(f.sent.at(-1)).toMatchObject({ action: "reload" }));
      let prepared = false;
      const preparing = pluginContentEditorDocument.prepareClose(f.input).then(() => {
        prepared = true;
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(prepared).toBe(false);
      expect(f.view().state.facet(EditorState.readOnly)).toBe(true);
      f.reply({ requestId: f.sent.at(-1)!.requestId, content: "loaded = true\n" });
      await preparing;
      expect(prepared).toBe(true);
      expect(f.view().state.doc.toString()).toBe("loaded = true\n");
      act(() => pluginContentEditorDocument.cancelClose(f.input));
      expect(f.view().state.facet(EditorState.readOnly)).toBe(false);
    } finally {
      f.offSender();
    }
  });

  it("supports readOnly mode and registers the editor kind with EditorDocumentLifecycle", () => {
    const f = setup({ readOnly: true });
    try {
      expect(f.view().state.facet(EditorState.readOnly)).toBe(true);
      expect(f.view().contentDOM.getAttribute("contenteditable")).toBe("false");
      expect(pluginContentEditorDocument.isDirty(f.input)).toBe(false);
    } finally {
      f.offSender();
    }

    const dispose = startViewUi(() => {});
    try {
      const kind = useContributions.getState().editorKinds.get(PLUGIN_CONTENT_EDITOR_KIND)!;
      expect(kind.keepAlive).toBe(true);
      expect(kind.document).toBe(pluginContentEditorDocument);
    } finally {
      dispose();
    }
  });
});
