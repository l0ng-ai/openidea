import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorStatus } from "../controller";
import type { DocMeta } from "../model/document";

const setEncoding = vi.fn();
const setMeta = vi.fn();

vi.mock("../controller", async () => {
  const { create } = await import("zustand");
  return {
    editorController: () => ({
      manager: { get: () => ({ setMeta }), backend: { setEncoding } },
      slots: new Map(),
    }),
    useEditorStatus: create<{ status: EditorStatus | null }>(() => ({ status: null })),
    useGotoLine: create(() => ({ open: false })),
    useTabs: create(() => ({ panes: {}, activePane: "" })),
    isTextInput: () => true,
  };
});

vi.mock("@/platform/virtualDocs", () => ({
  isVirtualUri: (s: string) => s.startsWith("jdt:") || s.startsWith("jar:"),
  invalidateVirtualDocument: vi.fn(),
}));

const { useEditorStatus } = await import("../controller");
const { useDocMeta } = await import("../model/document");
const { invalidateVirtualDocument } = await import("@/platform/virtualDocs");
const { EncodingStatus } = await import("./StatusItems");

const JDT = "jdt://contents/lib.jar/p/C.class?=x";

const meta = (patch: Partial<DocMeta> = {}): DocMeta => ({
  doc: 1,
  path: JDT,
  language: "java",
  uiMode: "Java",
  encoding: "utf-8",
  hasBom: false,
  lineEnding: "lf",
  readOnly: true,
  dirty: false,
  canReloadEncoding: true,
  banner: null,
  indent: { tabSize: 4, insertSpaces: true },
  ...patch,
});

const openPicker = (m: DocMeta) => {
  useDocMeta.setState({ [m.path]: m });
  useEditorStatus.setState({
    status: { path: m.path, doc: m.doc, line: 0, col: 0, offset: 0, selectedChars: 0, selectedLines: 0, carets: 1 },
  });
  const view = render(<EncodingStatus />);
  fireEvent.click(screen.getByRole("button", { name: "UTF-8" }));
  return view;
};

const choose = (name: string) => fireEvent.click(screen.getByRole("option", { name }));
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  useDocMeta.setState({}, true);
  useEditorStatus.setState({ status: null });
});

describe("encoding status of read-only library documents", () => {
  it("offers Reload for re-decodable sources, but never Convert or BOM changes", () => {
    const view = openPicker(meta());
    expect(button("Add UTF-8 BOM").disabled).toBe(true);
    choose("GBK");
    expect(button("Reload").disabled).toBe(false);
    expect(button("Convert").disabled).toBe(true);
    view.unmount();
  });

  it("disables encoding changes for server-generated read-only content", () => {
    const view = openPicker(meta({ canReloadEncoding: false }));
    expect(screen.getByRole("option", { name: "GBK" }).querySelector("[aria-disabled=true]")).not.toBeNull();
    choose("GBK");
    expect(screen.queryByRole("dialog", { name: "Change File Encoding" })).toBeNull();
    expect(setEncoding).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps Reload disabled while a file has unsaved changes", () => {
    const view = openPicker(meta({ path: "/p/Main.java", readOnly: false, dirty: true }));
    choose("GBK");
    expect(button("Reload").disabled).toBe(true);
    expect(button("Convert").disabled).toBe(false);
    view.unmount();
  });

  it("reloading a virtual document re-decodes it and refreshes the content cache", async () => {
    setEncoding.mockResolvedValue({ encoding: "gbk", hasBom: false });
    const view = openPicker(meta());
    choose("GBK");
    fireEvent.click(button("Reload"));
    expect(setEncoding).toHaveBeenCalledWith(1, "gbk", true);
    await waitFor(() => expect(setMeta).toHaveBeenCalledWith({ encoding: "gbk", hasBom: false }));
    expect(invalidateVirtualDocument).toHaveBeenCalledWith(JDT);
    view.unmount();
  });
});

it("filters encodings by typing and allows cancelling without a document change", () => {
  const view = openPicker(meta({ readOnly: false }));
  const search = screen.getByPlaceholderText("Search…");
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("option", { name: "UTF-8" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "1252" } });
  expect(screen.queryByRole("option", { name: "GBK" })).toBeNull();
  fireEvent.keyDown(search, { key: "Enter" });
  const cancel = button("Cancel");
  expect(document.activeElement).toBe(cancel);
  expect(setEncoding).not.toHaveBeenCalled();
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Change File Encoding" })).toBeNull();
  expect(setEncoding).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button("UTF-8"));
  view.unmount();
});

it("converts the current text when Convert is chosen", async () => {
  setEncoding.mockResolvedValue({ encoding: "gbk", hasBom: false });
  const view = openPicker(meta({ path: "/p/Main.java", readOnly: false }));
  choose("GBK");
  fireEvent.click(button("Convert"));
  expect(setEncoding).toHaveBeenCalledWith(1, "gbk", false);
  await waitFor(() => expect(setMeta).toHaveBeenCalledWith({ encoding: "gbk", hasBom: false, dirty: true }));
  view.unmount();
});
