import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import type { DependencyVersions } from "@/bindings";

const dependencyVersions = vi.fn();
const cancelRequest = vi.fn(async () => {});
const lspCodeActions = vi.fn(async () => ({ status: "error", error: { kind: "unavailable", message: "No server" } }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, dependencyVersions, cancelRequest, lspCodeActions },
  };
});
const { activate, versionCompletions } = await import("./index");
const { editorContributions, contributedIntentions } = await import("@/editor/api");
const { diagnosticsFor } = await import("@/editor/lsp/diagnostics");
const { lspDoc } = await import("@/editor/lsp/lsp");
const { quickFixesAt, applyCodeAction, showIntentions } = await import("@/editor/lsp/intentions");
const { useLspPopup, closePopup } = await import("@/editor/lsp/popupStore");
const { useProject } = await import("@/platform/project");
const { DEPENDENCY_INSPECTION } = await import("@/platform/inspections");
const text = '# 中文 😀\n[dependencies]\ntokio = { version = "0.2", features = ["full"] }\n';
const from = text.indexOf('"0.2"') + 1;
const item: DependencyVersions = {
  dependency: { package: "tokio", requirement: "0.2", from, to: from + 3 },
  versions: ["2.0.0-beta.1", "1.10.0", "1.9.0", "0.2.1"],
  update: { latest: "1.10.0", replacement: "1.10" },
};
let deactivate: () => void;
const views: EditorView[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  dependencyVersions.mockResolvedValue({ status: "ok", data: [item] });
  useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
  deactivate = activate();
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  deactivate();
  closePopup();
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
  vi.useRealTimers();
});
function editor(path = "/p/Cargo.toml", readOnly = false) {
  const ctx = { doc: 7, path, language: "toml", uiMode: "TOML", readOnly };
  const contribution = editorContributions().find((c) => c.id === "dependency-versions")!;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor: from },
      extensions: [lspDoc.of(ctx), contribution.extensions(ctx)],
    }),
  });
  views.push(view);
  return view;
}
async function settle() {
  await vi.advanceTimersByTimeAsync(550);
}

describe("Cargo dependency versions", () => {
  it("publishes a weak warning and fixes only the version through context actions", async () => {
    const view = editor();
    await settle();
    expect(dependencyVersions).toHaveBeenCalledWith(7, null, expect.any(Number));
    expect(diagnosticsFor("/p/Cargo.toml")).toMatchObject([
      {
        severity: "info",
        message: "A newer version is available: 1.10.0",
        range: { start: { line: 2, col: 21 }, end: { line: 2, col: 24 } },
      },
    ]);
    const [fix] = contributedIntentions(view);
    expect(fix?.label).toBe("Update to 1.10");
    await fix!.run();
    expect(view.state.doc.toString()).toBe(text.replace('"0.2"', '"1.10"'));
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
  });
  it("provides direct and hover quick fixes even without a language server", async () => {
    const view = editor();
    await settle();
    const [fix] = await quickFixesAt(view, from, from + 3);
    expect(fix?.title).toBe("Update to 1.10");
    await applyCodeAction(view, fix!);
    expect(view.state.doc.toString()).toContain('version = "1.10", features = ["full"]');
  });
  it.each(["0.10", "^0.10", "=0.10.3"])(
    "shows the exact replacement %s with weak-warning inspection controls",
    async (replacement) => {
      dependencyVersions.mockResolvedValue({
        status: "ok",
        data: [{ ...item, update: { latest: "0.10.3", replacement } }],
      });
      const view = editor();
      await settle();
      await showIntentions(view);
      const popup = useLspPopup.getState().popup;
      expect(popup?.kind).toBe("list");
      if (popup?.kind !== "list") throw new Error("Missing intentions");
      expect(popup.title).toBe("Intentions");
      expect(popup.items).toHaveLength(1);
      expect(popup.items[0]).toMatchObject({ label: `Update to ${replacement}`, icon: "bulb", quickFix: true });
      expect(popup.items[0]!.submenu).toHaveLength(2);
      await popup.items[0]!.run();
      expect(view.state.doc.toString()).toBe(text.replace('"0.2"', `"${replacement}"`));
    },
  );
  it("keeps diagnostics when one of two split editors closes", async () => {
    editor();
    const split = editor();
    await settle();
    split.destroy();
    views.pop();
    expect(diagnosticsFor("/p/Cargo.toml")).toHaveLength(1);
  });
  it("invalidates fixes immediately after edits and rejects a stale fix callback", async () => {
    const view = editor();
    await settle();
    const [fix] = contributedIntentions(view);
    view.dispatch({ changes: { from: 0, insert: "# edit\n" } });
    expect(contributedIntentions(view)).toEqual([]);
    await fix!.run();
    expect(view.state.doc.toString()).toBe("# edit\n" + text);
  });
  it("discards delayed responses after an edit, project switch or editor close", async () => {
    let resolve!: (value: unknown) => void;
    dependencyVersions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = editor();
    await settle();
    view.dispatch({ changes: { from: 0, insert: "# edit\n" } });
    resolve({ status: "ok", data: [item] });
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
    await settle();
    useProject.setState({ project: { root: "/other" } as never });
    resolve({ status: "ok", data: [item] });
    await settle();
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
    expect(cancelRequest).toHaveBeenCalled();
    const other = editor("/other/Cargo.toml");
    await settle();
    other.destroy();
    views.pop();
    resolve({ status: "ok", data: [item] });
    await settle();
    expect(diagnosticsFor("/other/Cargo.toml")).toEqual([]);
  });
  it("stays silent offline, with compatible versions and for non-Cargo or readonly files", async () => {
    dependencyVersions.mockRejectedValue(new Error("offline"));
    editor();
    await settle();
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
    dependencyVersions.mockResolvedValue({ status: "ok", data: [{ ...item, update: null }] });
    editor("/p/sub/Cargo.toml");
    await settle();
    expect(diagnosticsFor("/p/sub/Cargo.toml")).toEqual([]);
    dependencyVersions.mockClear();
    editor("/p/other.toml");
    editor("/p/readonly/Cargo.toml", true);
    await settle();
    expect(dependencyVersions).not.toHaveBeenCalled();
  });
  it("honours the inspection profile and cleans up on close", async () => {
    const view = editor();
    await settle();
    useProject.setState({
      settings: { inspections: { default: { [DEPENDENCY_INSPECTION]: { enabled: false } } } } as never,
    });
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
    expect(contributedIntentions(view)).toEqual([]);
    view.destroy();
    views.pop();
    await settle();
    expect(diagnosticsFor("/p/Cargo.toml")).toEqual([]);
  });
  it("completes only at a parsed dependency version, preserving descending source order", async () => {
    const view = editor();
    const source = view.state.languageDataAt<(ctx: CompletionContext) => Promise<unknown>>(
      "openideaCompletion",
      from,
    )[0]!;
    const result = await source(new CompletionContext(view.state, from + 3, true, view));
    expect(result).toMatchObject({
      from,
      to: from + 3,
      filter: false,
      options: item.versions.map((label) => ({ label })),
    });
    expect(dependencyVersions).toHaveBeenLastCalledWith(7, from + 3, expect.any(Number));
    dependencyVersions.mockResolvedValue({ status: "ok", data: [] });
    expect(await source(new CompletionContext(view.state, 0, true, view))).toBeNull();
  });
  it("replaces the whole version and retains a simple requirement operator", () => {
    const state = EditorState.create({ doc: "^1.2" });
    const context = new CompletionContext(state, 4, true);
    const result = versionCompletions({ ...item, dependency: { ...item.dependency, from: 0, to: 4 } }, context);
    expect(result.options[0]).toMatchObject({ label: "2.0.0-beta.1", apply: "^2.0.0-beta.1" });
  });
});
