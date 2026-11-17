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

const openMenu = (m: DocMeta) => {
  useDocMeta.setState({ [m.path]: m });
  useEditorStatus.setState({
    status: { path: m.path, doc: m.doc, line: 0, col: 0, offset: 0, selectedChars: 0, selectedLines: 0, carets: 1 },
  });
  const view = render(<EncodingStatus />);
  fireEvent.click(screen.getByRole("button", { name: "UTF-8" }));
  return view;
};

const item = (name: string) => screen.getByRole("menuitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
  useDocMeta.setState({}, true);
  useEditorStatus.setState({ status: null });
});

describe("encoding status of read-only library documents", () => {
  it("offers Reload for re-decodable sources, but never Convert or BOM changes", () => {
    const view = openMenu(meta());
    expect(item("Reload with Encoding").getAttribute("aria-disabled")).toBeNull();
    expect(item("Convert to Encoding").getAttribute("aria-disabled")).toBe("true");
    expect(item("Add UTF-8 BOM").getAttribute("aria-disabled")).toBe("true");
    view.unmount();
  });

  it("disables Reload for server-generated content that cannot be re-decoded", () => {
    const view = openMenu(meta({ canReloadEncoding: false }));
    expect(item("Reload with Encoding").getAttribute("aria-disabled")).toBe("true");
    view.unmount();
  });

  it("keeps Reload disabled while a file has unsaved changes", () => {
    const view = openMenu(meta({ path: "/p/Main.java", readOnly: false, dirty: true }));
    expect(item("Reload with Encoding").getAttribute("aria-disabled")).toBe("true");
    view.unmount();
  });

  it("reloading a virtual document re-decodes it and refreshes the content cache", async () => {
    setEncoding.mockResolvedValue({ encoding: "gbk", hasBom: false });
    const view = openMenu(meta());
    fireEvent.mouseEnter(item("Reload with Encoding"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "GBK" }));
    expect(setEncoding).toHaveBeenCalledWith(1, "gbk", true);
    await waitFor(() => expect(setMeta).toHaveBeenCalledWith({ encoding: "gbk", hasBom: false }));
    expect(invalidateVirtualDocument).toHaveBeenCalledWith(JDT);
    view.unmount();
  });
});
