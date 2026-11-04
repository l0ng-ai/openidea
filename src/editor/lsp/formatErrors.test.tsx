import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IdeError } from "@/bindings";
import { getAction, registerAction } from "@/platform/actions";
import { commands, IpcError } from "@/platform/ipc";
import { useEditorRegistry } from "@/editor/api";
import { registerLspActions } from "./actions";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { Balloons } from "@/workbench/Notifications";
import {
  balloonTimeout,
  clearNotifications,
  notificationServiceImpl,
  useNotifications,
} from "@/workbench/notificationStore";
import { formatDocument } from "./format";
import * as lsp from "./lsp";

const views: EditorView[] = [];
const viewFor = (path = "/project/file.css") => {
  const view = new EditorView({
    state: EditorState.create({
      doc: ".card {",
      extensions: [lsp.lspDoc.of({ doc: 1, path, language: "css", uiMode: null, readOnly: false })],
    }),
  });
  views.push(view);
  return view;
};
const failWith = (error: IdeError) => vi.spyOn(lsp, "lspRequest").mockRejectedValue(new IpcError(error));

beforeEach(() => {
  clearNotifications();
  provideNotificationService(notificationServiceImpl);
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  clearNotifications();
  vi.restoreAllMocks();
  _resetI18nForTests();
});

describe.each(["prettier", "oxfmt"])("%s formatter errors", (name) => {
  const tool = { type: "tool", tool: name, missing: false } as const;
  const display = name === "prettier" ? "Prettier" : name;
  it("uses structured missing-tool information to request the shared install prompt", async () => {
    const prompt = vi.fn();
    const dispose = registerAction({
      id: "tools.promptInstall",
      title: "Install Missing Tool",
      run: ({ arg }) => prompt(arg),
    });
    try {
      failWith({ kind: "notFound", message: "unrelated diagnostic", data: { ...tool, missing: true } });
      await formatDocument(viewFor());
      expect(prompt).toHaveBeenCalledWith({ name, sticky: true });
      await formatDocument(viewFor(), { explicit: false, onSave: true });
      expect(prompt).toHaveBeenLastCalledWith({ name, sticky: false });
      expect(useNotifications.getState().items).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("does not treat text alone or a broken custom executable as a missing installation", async () => {
    const prompt = vi.fn();
    const dispose = registerAction({
      id: "tools.promptInstall",
      title: "Install Missing Tool",
      run: ({ arg }) => prompt(arg),
    });
    try {
      const request = failWith({ kind: "unavailable", message: "Prettier is not installed" });
      const view = viewFor();
      await formatDocument(view, { explicit: false });
      expect(useNotifications.getState().items).toHaveLength(0);
      request.mockRejectedValue(new IpcError({ kind: "notFound", message: "custom executable missing", data: tool }));
      await formatDocument(view);
      expect(prompt).not.toHaveBeenCalled();
      expect(useNotifications.getState().items).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("keeps stderr untranslated in a Chinese notification and replaces failures per file, including on save", async () => {
    await setLocale("zh");
    const previous = useProject.getState().settings;
    useProject.setState({ settings: null });
    try {
      const stderr = "Formatting timed out";
      failWith({ kind: "invalidInput", message: stderr, data: tool });
      const view = viewFor();
      for (let i = 0; i < 3; i++) await formatDocument(view, { explicit: false, onSave: true });
      const notes = useNotifications.getState().items;
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ sticky: false, title: `${display} 格式化失败` });
      expect(balloonTimeout(notes[0]!)).toBe(10000);
      render(<Balloons />);
      expect(screen.getByRole("alert")).toHaveTextContent(stderr);
      expect(screen.queryByText("格式化超时")).toBeNull();
      expect(view.state.doc.toString()).toBe(".card {");
      await act(async () => {
        await formatDocument(viewFor("/project/other.css"));
      });
      expect(useNotifications.getState().items).toHaveLength(2);
    } finally {
      useProject.setState({ settings: previous });
    }
  });

  it("localizes the timeout explanation by kind and ignores cancellation", async () => {
    await setLocale("zh");
    const request = failWith({ kind: "timedOut", message: "arbitrary backend text", data: tool });
    const view = viewFor();
    await formatDocument(view);
    expect(useNotifications.getState().items[0]).toMatchObject({ body: `${display} 格式化超时`, sticky: false });
    clearNotifications();
    request.mockRejectedValue(new IpcError({ kind: "cancelled", message: "cancelled", data: tool }));
    await formatDocument(view);
    expect(useNotifications.getState().items).toHaveLength(0);
  });
});

describe("Reformat with Prettier / oxfmt", () => {
  it.each([
    ["code.reformatWithPrettier", "prettier"],
    ["code.reformatWithOxfmt", "oxfmt"],
  ])("%s asks the backend for %s whatever the settings select", async (id, tool) => {
    vi.spyOn(lsp, "lspRequest").mockImplementation(async (request) => {
      await request();
      return [] as never;
    });
    const lspFormat = vi.spyOn(commands, "lspFormat").mockResolvedValue({ status: "ok", data: [] });
    const view = viewFor("/project/app.ts");
    const previous = useEditorRegistry.getState().active;
    const dispose = registerLspActions();
    try {
      useEditorRegistry.setState({ active: { view, ctx: view.state.facet(lsp.lspDoc)! } as never });
      await getAction(id)!.run({ ctx: {} } as never);
      await vi.waitFor(() => expect(lspFormat).toHaveBeenCalledWith(1, null, expect.objectContaining({ tool })));
    } finally {
      dispose();
      useEditorRegistry.setState({ active: previous });
    }
  });
});
