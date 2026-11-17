import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileEntry } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  entryKind: vi.fn(),
  nativeOpen: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, fsReadDir: mocks.readDir, fsEntryKind: mocks.entryKind },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.nativeOpen, save: vi.fn() }));

import { choosePath } from "@/platform/choosePath";
import { useRemote } from "@/platform/remote";
import { InputDialogsHost, parentPath } from "./inputDialogs";

const tree: Record<string, [string, "dir" | "file"][]> = {
  "/srv/app": [
    ["runner", "dir"],
    ["pom.xml", "file"],
  ],
  "/srv/app/runner": [
    ["plugins", "dir"],
    ["server.jar", "file"],
  ],
  "/srv": [["app", "dir"]],
};

function entry(dir: string, name: string, kind: "dir" | "file"): FileEntry {
  return {
    name,
    path: `${dir}/${name}`,
    kind,
    size: 0,
    mtimeMs: null,
    ignored: false,
    excluded: false,
    hidden: false,
  };
}

beforeEach(() => {
  mocks.readDir.mockImplementation(async (path: string) =>
    tree[path]
      ? { status: "ok", data: tree[path].map(([n, k]) => entry(path, n, k)) }
      : { status: "error", error: { kind: "notFound", message: `${path} not found`, detail: null } },
  );
  mocks.entryKind.mockImplementation(async (path: string) => {
    if (tree[path]) return { status: "ok", data: "dir" };
    if (Object.entries(tree).some(([d, es]) => es.some(([n, k]) => k === "file" && `${d}/${n}` === path)))
      return { status: "ok", data: "file" };
    return { status: "error", error: { kind: "notFound", message: "not found", detail: null } };
  });
  useRemote.setState({ session: { root: "/srv/app", os: "linux", commands: [] } as never });
  render(<InputDialogsHost />);
});

afterEach(() => {
  for (const d of screen.queryAllByRole("dialog")) fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
  cleanup();
  useRemote.setState({ session: null });
  vi.clearAllMocks();
});

const dialog = () => within(screen.getByRole("dialog"));

describe("choosePath in a remote window", () => {
  it("browses the remote host instead of opening the desktop's dialog", async () => {
    let result!: Promise<string | null>;
    act(() => {
      result = choosePath({ directory: false, title: "Select Library JAR", defaultPath: "/srv/app" });
    });
    await waitFor(() => expect(dialog().getByText("runner")).toBeTruthy());
    expect(dialog().getByText("pom.xml")).toBeTruthy();
    expect(mocks.nativeOpen).not.toHaveBeenCalled();

    fireEvent.click(dialog().getByText("runner"), { detail: 2 });
    await waitFor(() => expect(dialog().getByText("server.jar")).toBeTruthy());
    fireEvent.mouseDown(dialog().getByText("server.jar"));
    fireEvent.click(dialog().getByText("server.jar"));
    expect((dialog().getByRole("textbox") as HTMLInputElement).value).toBe("/srv/app/runner/server.jar");
    fireEvent.click(dialog().getByText("server.jar"), { detail: 2 });
    await expect(result).resolves.toBe("/srv/app/runner/server.jar");
  });

  it("lists only folders when choosing one, goes up, and returns the folder shown", async () => {
    let result!: Promise<string | null>;
    act(() => {
      result = choosePath({ directory: true, title: "Select Folder", defaultPath: "/srv/app" });
    });
    await waitFor(() => expect(dialog().getByText("runner")).toBeTruthy());
    expect(dialog().queryByText("pom.xml")).toBeNull();

    fireEvent.click(dialog().getByRole("button", { name: "Parent Folder" }));
    await waitFor(() => expect(dialog().getByText("app")).toBeTruthy());
    fireEvent.click(dialog().getByRole("button", { name: "OK" }));
    await expect(result).resolves.toBe("/srv");
  });

  it("starts in a file's folder and rejects a missing path", async () => {
    let result!: Promise<string | null>;
    act(() => {
      result = choosePath({ directory: false, title: "Select File", defaultPath: "/srv/app/pom.xml" });
    });
    await waitFor(() => expect(dialog().getByText("runner")).toBeTruthy());
    const field = dialog().getByRole("textbox");
    expect((field as HTMLInputElement).value).toBe("/srv/app/pom.xml");
    fireEvent.change(field, { target: { value: "/srv/app/missing.jar" } });
    fireEvent.click(dialog().getByRole("button", { name: "OK" }));
    await waitFor(() => expect(dialog().getByText("No such file or folder")).toBeTruthy());
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    await expect(result).resolves.toBeNull();
  });
});

describe("parentPath", () => {
  it("handles Unix and Windows paths and roots", () => {
    expect(parentPath("/srv/app")).toBe("/srv");
    expect(parentPath("/srv")).toBe("/");
    expect(parentPath("/")).toBeNull();
    expect(parentPath("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\");
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("/srv/app/")).toBe("/srv");
  });
});
