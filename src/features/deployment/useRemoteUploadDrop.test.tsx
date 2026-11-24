import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { RemoteEntry } from "@/platform/ipc";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import { uploadFolderAt, useRemoteUploadDrop } from "./useRemoteUploadDrop";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  remote: false,
  native: false,
  nativeEvent: null as null | ((event: { payload: { type: string; position?: { x: number; y: number } } }) => void),
  nativeOff: vi.fn(),
  files: null as null | ((paths: readonly string[], x: number, y: number) => boolean),
  pointer: null as null | {
    over: (data: unknown, x: number, y: number) => void;
    drop: (data: { payload: string }, x: number, y: number) => void;
    leave: () => void;
  },
  filesOff: vi.fn(),
  pointerOff: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/actions", () => ({ executeAction: mocks.execute }));
vi.mock("@/platform/ipc", () => ({ isTauri: () => mocks.native }));
vi.mock("@/platform/nativeDrop", () => ({ nativeDropPoint: (point: { x: number; y: number }) => point }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.nativeEvent) => {
      mocks.nativeEvent = handler;
      return mocks.nativeOff;
    },
  }),
}));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: () => mocks.remote }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
vi.mock("@/workbench/fileDrop", () => ({
  registerFileDropHandler: (handler: typeof mocks.files) => {
    mocks.files = handler;
    return mocks.filesOff;
  },
}));
vi.mock("@/ui", () => ({
  FILES_DRAG: "files",
  registerDropTarget: (_element: unknown, target: typeof mocks.pointer) => {
    mocks.pointer = target;
    return mocks.pointerOff;
  },
}));

const entry = (path: string, isDir: boolean): RemoteEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDir,
  isSymlink: false,
  size: 0,
  mtime: null,
  permissions: "",
});
const entries = new Map([entry("/srv/assets", true), entry("/srv/assets/icon.svg", false)].map((e) => [e.path, e]));
const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "demo" };
function View() {
  const view = useRef<HTMLDivElement>(null);
  const folder = useRemoteUploadDrop(view, server, "/srv", entries);
  return (
    <div ref={view} data-testid="view">
      <div role="toolbar">Actions</div>
      <div data-tree-key="/srv/assets">assets</div>
      <div data-tree-key="/srv/assets/icon.svg">icon.svg</div>
      <div data-tree-key="loading">Loading</div>
      <output>{folder}</output>
    </div>
  );
}
let hit: Element | null;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote = false;
  mocks.native = false;
  mocks.nativeEvent = null;
  hit = null;
  document.elementFromPoint = () => hit;
});
afterEach(cleanup);

it("uses native hover events for feedback without uploading twice, and removes the native listener", async () => {
  mocks.native = true;
  const { unmount } = render(<View />);
  await waitFor(() => expect(mocks.nativeEvent).not.toBeNull());
  hit = screen.getByText("assets");
  act(() => mocks.nativeEvent!({ payload: { type: "enter", position: { x: 10, y: 10 } } }));
  expect(screen.getByRole("status")).toHaveTextContent("/srv/assets");
  act(() => mocks.nativeEvent!({ payload: { type: "drop" } }));
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  mocks.files!(["C:/Downloads/a.txt"], 10, 10);
  expect(mocks.execute).toHaveBeenCalledOnce();
  unmount();
  expect(mocks.nativeOff).toHaveBeenCalledOnce();
});

it("targets directories, file parents and blank root space, and rejects controls/outside/loading rows", () => {
  render(<View />);
  const view = screen.getByTestId("view");
  for (const [label, target] of [
    ["assets", "/srv/assets"],
    ["icon.svg", "/srv/assets"],
    ["Loading", null],
    ["Actions", null],
  ] as const) {
    hit = screen.getByText(label);
    expect(uploadFolderAt(view, "/srv", entries, 10, 10)).toBe(target);
  }
  hit = view;
  expect(uploadFolderAt(view, "/srv", entries, 10, 10)).toBe("/srv");
  hit = document.body;
  expect(uploadFolderAt(view, "/srv", entries, 10, 10)).toBeNull();
});

it("routes desktop and Project drops to the same upload action and clears hover feedback", () => {
  const { unmount } = render(<View />);
  hit = screen.getByText("assets");
  expect(mocks.files!(["C:/Downloads/banner.svg"], 10, 10)).toBe(true);
  expect(mocks.execute).toHaveBeenLastCalledWith("deployment.uploadLocalInto", {
    server: "demo",
    paths: ["C:/Downloads/banner.svg"],
    target: "/srv/assets",
  });
  act(() => mocks.pointer!.over(null, 10, 10));
  expect(screen.getByRole("status")).toHaveTextContent("/srv/assets");
  act(() => mocks.pointer!.drop({ payload: "/project/assets/\n/project/a.txt" }, 10, 10));
  expect(mocks.execute).toHaveBeenLastCalledWith("deployment.uploadLocalInto", {
    server: "demo",
    paths: ["/project/assets", "/project/a.txt"],
    target: "/srv/assets",
  });
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  unmount();
  expect(mocks.filesOff).toHaveBeenCalledOnce();
  expect(mocks.pointerOff).toHaveBeenCalledOnce();
});

it("consumes unsupported desktop drops in remote IDE windows while accepting host Project paths", () => {
  mocks.remote = true;
  render(<View />);
  hit = screen.getByText("assets");
  expect(mocks.files!(["C:/Downloads/banner.svg"], 10, 10)).toBe(true);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledOnce();
  act(() => mocks.pointer!.drop({ payload: "/remote/project/a.txt" }, 10, 10));
  expect(mocks.execute).toHaveBeenCalledWith(
    "deployment.uploadLocalInto",
    expect.objectContaining({ paths: ["/remote/project/a.txt"] }),
  );
});
