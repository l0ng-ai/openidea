import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction, WorkspaceEdit } from "@/bindings";

const ipc = vi.hoisted(() => ({
  phpLaravelCreateTranslation: vi.fn(),
  applyWorkspaceEdit: vi.fn(async () => ({ status: "ok" as const, data: null })),
  lspResolveCommand: vi.fn(),
  lspExecuteCodeAction: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@/editor/api", async (orig) => ({
  ...(await orig<typeof import("@/editor/api")>()),
  whenAllSynced: async () => {},
}));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const {
  CREATE_TRANSLATION_COMMAND,
  CreateTranslationDialog,
  chosenTexts,
  initialRows,
  registerCreateTranslation,
  rowsError,
  translationRequestOf,
} = await import("./createTranslation");
const { applyCodeAction } = await import("./intentions");
const { lspDoc } = await import("./lsp");

const request = {
  key: "messages.saved",
  locales: [
    { locale: "en", text: "Saved", exists: false },
    { locale: "fr", text: "Enregistré", exists: true },
    { locale: "de", text: "Saved", exists: false },
  ],
};
const edit: WorkspaceEdit = { files: [], label: null } as unknown as WorkspaceEdit;
const action: CodeAction = {
  title: "Create translation key 'messages.saved'…",
  kind: "refactor.rewrite",
  server: 3,
  isPreferred: false,
  disabledReason: null,
  edit: null,
  data: null,
  command: { title: "Create", command: CREATE_TRANSLATION_COMMAND, arguments: [JSON.stringify(request)] },
};

const view = () =>
  new EditorView({
    state: EditorState.create({
      doc: "<?php\n__('messages.saved');\n",
      extensions: [lspDoc.of({ doc: 7, path: "/p/app/Probe.php", language: "php" } as never)],
    }),
  });

describe("create translation key request", () => {
  it("reads the command's JSON argument and drops malformed locales", () => {
    expect(translationRequestOf([JSON.stringify(request)])).toEqual(request);
    expect(translationRequestOf([request])).toEqual(request);
    expect(translationRequestOf(['{"key":"a","locales":[{"locale":"en"},null,{"locale":"fr","text":"x"}]}'])).toEqual({
      key: "a",
      locales: [{ locale: "fr", text: "x", exists: false }],
    });
    expect(translationRequestOf(["not json"])).toBeNull();
    expect(translationRequestOf([])).toBeNull();
  });

  it("writes only the chosen locales that lack the key", () => {
    const rows = initialRows(request);
    expect(rows.map((r) => r.checked)).toEqual([true, false, true]);
    expect(chosenTexts(rows)).toEqual([
      { locale: "en", text: "Saved" },
      { locale: "de", text: "Saved" },
    ]);
    expect(rowsError(rows)).toBeNull();
    expect(rowsError(rows.map((r) => ({ ...r, checked: false })))).toBe("Choose at least one locale");
    expect(rowsError(rows.map((r) => (r.locale === "de" ? { ...r, text: " " } : r)))).toBe(
      "Enter the text of every chosen locale",
    );
  });
});

describe("create translation key dialog", () => {
  let off: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.phpLaravelCreateTranslation.mockResolvedValue({ status: "ok", data: edit });
    off = registerCreateTranslation();
    render(<CreateTranslationDialog />);
  });
  afterEach(() => {
    off();
    cleanup();
  });

  it("opens from the code action and writes the texts asked for", async () => {
    const v = view();
    await act(async () => applyCodeAction(v, action));
    expect(ipc.lspResolveCommand).not.toHaveBeenCalled();
    expect(ipc.lspExecuteCodeAction).not.toHaveBeenCalled();
    expect(screen.getByText("messages.saved")).toBeTruthy();

    const fr = screen.getByRole("textbox", { name: "Text in fr" }) as HTMLInputElement;
    expect(fr.value).toBe("Enregistré");
    expect(fr.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Text in en" }), { target: { value: "It's saved" } });
    // Leave German out.
    fireEvent.click(screen.getByRole("checkbox", { name: "de" }));
    expect((screen.getByRole("textbox", { name: "Text in de" }) as HTMLInputElement).disabled).toBe(true);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
    expect(ipc.phpLaravelCreateTranslation).toHaveBeenCalledWith("messages.saved", [
      { locale: "en", text: "It's saved" },
    ]);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create" })).toBeNull());
    expect(notify).toHaveBeenCalled();
    v.destroy();
  });

  it("keeps the dialog open with the engine's error, and can't create with no locale chosen", async () => {
    ipc.phpLaravelCreateTranslation.mockResolvedValue({
      status: "error",
      error: { kind: "invalid", message: "The translation key 'messages.saved' can't be added" },
    });
    const v = view();
    await act(async () => applyCodeAction(v, action));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
    await waitFor(() => expect(screen.getByText("The translation key 'messages.saved' can't be added")).toBeTruthy());
    expect(ipc.applyWorkspaceEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "en" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "de" }));
    expect(screen.getByText("Choose at least one locale")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    v.destroy();
  });
});
