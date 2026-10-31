import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNode } from "./model";
import {
  canPaste,
  copySelection,
  importExternal,
  paste,
  refreshOsClipboard,
  selectionAfterDelete,
  transfer,
} from "./operations";
import { IpcError } from "@/platform/ipc";
import { closeFileRefactorDialog, pendingFileRefactorDialog } from "./FileRefactorDialogs";
import { useRemote } from "@/platform/remote";
import { provideNotificationService } from "@/workbench/contributions";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { initProjectTree, loadDir, setClipboard, setSelection, useProjectTree } from "./store";
import { setOsClipboardForTests } from "./clipboard";

let fs: MemoryFs;
const notify = vi.fn();

const node = (path: string, dir = false): ProjectNode => ({
  key: path,
  path,
  chain: [path],
  label: path.slice(path.lastIndexOf("/") + 1),
  dir,
  root: path === "/p",
  entry: null,
  ignored: false,
  excluded: false,
  symlink: false,
});

describe("selectionAfterDelete", () => {
  const rows = [node("/p", true), node("/p/a", true), node("/p/a/x.ts"), node("/p/b", true), node("/p/c.md")];

  it("selects the next surviving row, skipping the deleted folder's children", () => {
    expect(selectionAfterDelete(rows, ["/p/a"])).toBe("/p/b");
  });

  it("falls back to the previous row at the end of the list", () => {
    expect(selectionAfterDelete(rows, ["/p/c.md"])).toBe("/p/b");
    expect(selectionAfterDelete(rows, ["/p/b", "/p/c.md"])).toBe("/p/a/x.ts");
  });

  it("returns null when nothing visible was deleted", () => {
    expect(selectionAfterDelete(rows, ["/elsewhere"])).toBeNull();
  });
});

// Local OS paths and remote project paths may be identical strings.
describe("OS file imports", () => {
  beforeEach(async () => {
    fs = new MemoryFs({ "/p/target": null, "/p/local.txt": "client" }, "/p");
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "p");
    await loadDir("/p");
    useRemote.setState({ session: { sshConfig: "ssh", root: "/p", host: "host", commands: ["fs_copy"] } });
    provideNotificationService({ notify });
    notify.mockClear();
  });

  afterEach(() => {
    useRemote.setState({ session: null });
    setProjectFsForTests(null);
    setOsClipboardForTests(null);
  });

  it.each(["paste", "drop"])(
    "%s imports a client path under the remote root and keeps conflict names",
    async (entry) => {
      setOsClipboardForTests({
        files: async () => ["/p/local.txt"],
        hasFiles: async () => true,
        setFiles: async () => false,
      });
      const imported = vi.spyOn(fs, "importLocal");
      for (let i = 0; i < 2; i++) {
        if (entry === "paste") await paste("/p/target");
        else await importExternal(["/p/local.txt"], "/p/target");
      }
      expect(imported.mock.calls).toEqual([
        ["/p/local.txt", "/p/target/local.txt", expect.anything()],
        ["/p/local.txt", "/p/target/local copy.txt", expect.anything()],
      ]);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("reports upload failure and continues with the next file", async () => {
    const imported = vi.spyOn(fs, "importLocal").mockRejectedValueOnce(new Error("SSH disconnected"));
    await importExternal(["/missing.txt", "/p/local.txt"], "/p/target");
    expect(imported).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Some items could not be copied", body: "missing.txt: SSH disconnected" }),
    );
    expect(fs.nodes.has("/p/target/local.txt")).toBe(true);
  });

  it("reports a clipboard read failure", async () => {
    setOsClipboardForTests({
      files: async () => {
        throw new Error("clipboard unavailable");
      },
      hasFiles: async () => true,
      setFiles: async () => false,
    });
    await paste("/p/target");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Cannot access the clipboard", body: "clipboard unavailable" }),
    );
  });

  it.each([false, true])("falls back to internal clipboard (cut=%s) when another app holds it", async (cut) => {
    setOsClipboardForTests({
      files: async () => {
        throw new Error("busy");
      },
      hasFiles: async () => false,
      setFiles: async () => false,
    });
    setClipboard({ paths: ["/p/local.txt"], cut });
    await paste("/p/target");
    expect(pendingFileRefactorDialog()).toEqual(
      expect.objectContaining({ kind: cut ? "move" : "copy", paths: ["/p/local.txt"] }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops a multi-path import quietly on cancellation", async () => {
    const imported = vi
      .spyOn(fs, "importLocal")
      .mockRejectedValueOnce(new IpcError({ kind: "cancelled", message: "Cancelled" }));
    await importExternal(["/p/local.txt", "/p/another.txt"], "/p/target");
    expect(imported).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports skipped entries while keeping the imported folder", async () => {
    vi.spyOn(fs, "importLocal").mockResolvedValueOnce(["bundle/pipe: skipped special file"]);
    expect(await transfer(["/bundle"], "/p/target", "copy", undefined, "local")).toBe("/p/target/bundle");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "bundle/pipe: skipped special file" }));
  });

  it("keeps internal remote copies on the project filesystem", async () => {
    const imported = vi.spyOn(fs, "importLocal");
    const copied = vi.spyOn(fs, "copy");
    await transfer(["/p/local.txt"], "/p/target", "copy");
    expect(copied).toHaveBeenCalledWith("/p/local.txt", "/p/target/local.txt");
    expect(imported).not.toHaveBeenCalled();
  });
});

describe("project clipboard ownership", () => {
  beforeEach(async () => {
    fs = new MemoryFs({ "/p/target": null, "/p/source.txt": "source", "/other.txt": "other" }, "/p");
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "p");
    await loadDir("/p");
    setSelection(new Set(["/p/source.txt"]), "/p/source.txt");
    closeFileRefactorDialog();
  });

  afterEach(() => {
    useRemote.setState({ session: null });
    setProjectFsForTests(null);
    setOsClipboardForTests(null);
    closeFileRefactorDialog();
  });

  const cases = [false, true].flatMap((handedOff) =>
    ["same", "other", "empty", "error"].flatMap((osList) =>
      [false, true].flatMap((cut) => ["focus", "paste"].map((entry) => ({ handedOff, osList, cut, entry }))),
    ),
  );

  it.each(cases)("hand-off=$handedOff OS=$osList cut=$cut on $entry", async ({ handedOff, osList, cut, entry }) => {
    const files = vi.fn(async () => {
      if (osList === "error") throw new Error("busy");
      return osList === "same" ? ["/p/source.txt"] : osList === "other" ? ["/other.txt"] : [];
    });
    const setFiles = vi.fn(async () => handedOff);
    setOsClipboardForTests({ files, hasFiles: async () => osList === "same" || osList === "other", setFiles });
    copySelection(cut);
    const clipboard = useProjectTree.getState().clipboard;
    expect(clipboard).toEqual(expect.objectContaining({ paths: ["/p/source.txt"], cut }));
    expect(setFiles).toHaveBeenCalledWith(["/p/source.txt"]);
    const stale = handedOff && (osList === "other" || osList === "empty");
    if (entry === "focus") await refreshOsClipboard();
    else await paste("/p/target");
    expect(useProjectTree.getState().clipboard).toBe(stale ? null : clipboard);
    expect(canPaste()).toBe(!(handedOff && osList === "empty"));
    // canPaste only consults cached state, even when called repeatedly by menus.
    canPaste();
    expect(files).toHaveBeenCalledTimes(1);
    if (entry === "paste") {
      if (osList === "other") {
        expect(fs.nodes.has("/p/target/other.txt")).toBe(true);
        expect(fs.nodes.has("/p/target/source.txt")).toBe(false);
        expect(pendingFileRefactorDialog()).toBeNull();
      } else if (stale) {
        expect(pendingFileRefactorDialog()).toBeNull();
        expect(fs.nodes.has("/p/target/source.txt")).toBe(false);
      } else {
        expect(pendingFileRefactorDialog()).toEqual(
          expect.objectContaining({ kind: cut ? "move" : "copy", paths: ["/p/source.txt"] }),
        );
      }
    }
  });

  it.each([false, true])("keeps the internal clipboard after a rejected hand-off (cut=%s)", async (cut) => {
    setOsClipboardForTests({
      files: async () => [],
      hasFiles: async () => false,
      setFiles: async () => {
        throw new Error("unavailable");
      },
    });
    copySelection(cut);
    await refreshOsClipboard();
    await paste("/p/target");
    expect(pendingFileRefactorDialog()?.kind).toBe(cut ? "move" : "copy");
  });

  it.each([false, true].flatMap((cut) => ["same", "other", "empty", "error"].map((osList) => ({ cut, osList }))))(
    "keeps remote paths internal (cut=$cut OS=$osList)",
    async ({ cut, osList }) => {
      useRemote.setState({ session: { sshConfig: "ssh", root: "/p", host: "host", commands: ["fs_copy"] } });
      const setFiles = vi.fn(async () => true);
      setOsClipboardForTests({
        files: async () => {
          if (osList === "error") throw new Error("busy");
          return osList === "same" ? ["/p/source.txt"] : osList === "other" ? ["/other.txt"] : [];
        },
        hasFiles: async () => false,
        setFiles,
      });
      copySelection(cut);
      await refreshOsClipboard();
      await paste("/p/target");
      expect(setFiles).not.toHaveBeenCalled();
      expect(useProjectTree.getState().clipboard?.paths).toEqual(["/p/source.txt"]);
      expect(pendingFileRefactorDialog()?.kind).toBe(cut ? "move" : "copy");
      if (!cut) {
        const copied = vi.spyOn(fs, "copy");
        const imported = vi.spyOn(fs, "importLocal");
        const dialog = pendingFileRefactorDialog()!;
        if (dialog.kind !== "copy") throw new Error("expected Copy dialog");
        await dialog.copy("/p/target", null, false);
        expect(copied).toHaveBeenCalledWith("/p/source.txt", "/p/target/source.txt");
        expect(imported).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for the hand-off before reading the OS clipboard", async () => {
    let finish!: (written: boolean) => void;
    const files = vi.fn(async () => ["/p/source.txt"]);
    setOsClipboardForTests({
      files,
      hasFiles: async () => false,
      setFiles: () =>
        new Promise((r) => {
          finish = r;
        }),
    });
    copySelection(true);
    const refreshing = refreshOsClipboard();
    await Promise.resolve();
    expect(files).not.toHaveBeenCalled();
    finish(true);
    await refreshing;
    expect(useProjectTree.getState().clipboard?.cut).toBe(true);
  });

  it("ignores a stale read that completes after a newer Copy", async () => {
    let finish!: (paths: string[]) => void;
    setOsClipboardForTests({
      files: () =>
        new Promise((r) => {
          finish = r;
        }),
      hasFiles: async () => true,
      setFiles: async () => true,
    });
    copySelection(true);
    const refreshing = refreshOsClipboard();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    copySelection(false);
    const newer = useProjectTree.getState().clipboard;
    finish([]);
    await refreshing;
    expect(useProjectTree.getState().clipboard).toBe(newer);
    expect(canPaste()).toBe(true);
  });
});
