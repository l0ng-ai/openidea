import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import type { EditorService } from "@/workbench/contributions";
import * as contributions from "@/workbench/contributions";
import { invalidateVirtualDocument } from "@/platform/virtualDocs";
import { registerLibrarySourcesActions } from "./librarySources";
import { VirtualBanner } from "./view/Banner";

const ipc = vi.hoisted(() => ({ support: vi.fn(), sources: vi.fn(), cancel: vi.fn(), choose: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { lspCanDownloadSources: ipc.support, lspLibrarySources: ipc.sources, cancelRequest: ipc.cancel },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: ipc.choose }));
vi.mock("@/platform/virtualDocs", async (original) => ({
  ...(await original<typeof import("@/platform/virtualDocs")>()),
  invalidateVirtualDocument: vi.fn(),
}));

const path = "jdt://contents/lib-1.jar/p/Lib.class?=demo/escaped-jar-path";
let active = path;
const openFile = vi.fn(async (p: string) => {
  active = p;
});
const closePath = vi.fn(async () => true);
let off: () => void;

beforeEach(() => {
  ipc.support.mockResolvedValue({ status: "ok", data: true });
  ipc.cancel.mockResolvedValue(undefined);
  active = path;
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
    activePath: () => active,
    activeCursor: () => ({ path, line: 8, col: 12 }),
    openPaths: () => [path],
    openFile,
    closePath,
  } as unknown as EditorService);
  off = registerLibrarySourcesActions();
});

afterEach(() => {
  off();
  useProject.setState({ project: null });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const banner = (uri = path, decompiled = true) =>
  render(<VirtualBanner path={uri} decompiled={decompiled} description="lib-1.jar" />);

it("downloads with progress, cancellation and the declaration position, then replaces the decompiled tab", async () => {
  let finish!: (value: unknown) => void;
  ipc.sources.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  banner();
  fireEvent.click(await screen.findByRole("button", { name: "Download Sources" }));
  await waitFor(() => expect(ipc.sources).toHaveBeenCalled());
  expect(screen.getByText("Loading library sources…")).toBeTruthy();
  const request = ipc.sources.mock.calls[0]![0];
  expect(ipc.sources).toHaveBeenCalledWith(request, path, { line: 8, col: 12 }, null);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(ipc.cancel).toHaveBeenCalledWith(request));
  const source = "jar:file:///m2/lib-1-sources.jar!/p/Lib.java";
  await act(async () => finish({ status: "ok", data: { path: source, range: { start: { line: 24, col: 5 } } } }));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith(source, { selection: { line: 24, col: 5 } }));
  expect(closePath).toHaveBeenCalledWith(path);
  expect(invalidateVirtualDocument).toHaveBeenCalledWith(path);
});

it("keeps the decompiled view and offers a retry when sources do not exist", async () => {
  ipc.sources.mockResolvedValue({ status: "ok", data: null });
  banner();
  fireEvent.click(await screen.findByRole("button", { name: "Download Sources" }));
  expect(await screen.findByText("Sources not found")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download Sources" })).toBeTruthy();
  expect(openFile).not.toHaveBeenCalled();
});

it("shows download errors and clears progress", async () => {
  const notify = vi.fn();
  vi.spyOn(contributions, "notifications").mockReturnValue({ notify } as never);
  ipc.sources.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "repository offline" } });
  banner();
  fireEvent.click(await screen.findByRole("button", { name: "Download Sources" }));
  expect(await screen.findByText("Cannot load library sources")).toBeTruthy();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("repository offline") }));
  expect(screen.queryByText("Loading library sources…")).toBeNull();
});

it("does not offer JVM actions on source or assembly documents", () => {
  const first = banner("jdt://contents/lib.jar/p/Lib.class", false);
  expect(screen.queryByRole("button")).toBeNull();
  first.unmount();
  banner("csharp:/p/App.csproj/decompiled/Lib.cs");
  expect(screen.queryByRole("button")).toBeNull();
  expect(ipc.support).not.toHaveBeenCalled();
});

it("chooses an archive for a library without a supported download", async () => {
  ipc.support.mockResolvedValue({ status: "ok", data: false });
  ipc.choose.mockResolvedValue("/tmp/library-sources.zip");
  ipc.sources.mockResolvedValue({ status: "ok", data: null });
  banner();
  fireEvent.click(screen.getByRole("button", { name: "Choose Sources…" }));
  await waitFor(() =>
    expect(ipc.sources).toHaveBeenCalledWith(
      expect.any(Number),
      path,
      { line: 8, col: 12 },
      "/tmp/library-sources.zip",
    ),
  );
  expect(screen.queryByRole("button", { name: "Download Sources" })).toBeNull();
});

it("cancels on project change and ignores the previous project's result", async () => {
  let finish!: (value: unknown) => void;
  ipc.sources.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const running = executeAction("editor.downloadSources", path);
  await waitFor(() => expect(ipc.sources).toHaveBeenCalled());
  act(() => useProject.setState({ project: null }));
  expect(ipc.cancel).toHaveBeenCalled();
  finish({ status: "ok", data: null });
  await running;
  expect(openFile).not.toHaveBeenCalled();
});
