import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNode } from "./model";
import { importExternal, paste, selectionAfterDelete, transfer } from "./operations";
import { useRemote } from "@/platform/remote";
import { provideNotificationService } from "@/workbench/contributions";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { initProjectTree, loadDir } from "./store";
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
        setFiles: async () => {},
      });
      const imported = vi.spyOn(fs, "importLocal");
      for (let i = 0; i < 2; i++) {
        if (entry === "paste") await paste("/p/target");
        else await importExternal(["/p/local.txt"], "/p/target");
      }
      expect(imported.mock.calls).toEqual([
        ["/p/local.txt", "/p/target/local.txt"],
        ["/p/local.txt", "/p/target/local copy.txt"],
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
      setFiles: async () => {},
    });
    await paste("/p/target");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Cannot access the clipboard", body: "clipboard unavailable" }),
    );
  });

  it("keeps internal remote copies on the project filesystem", async () => {
    const imported = vi.spyOn(fs, "importLocal");
    const copied = vi.spyOn(fs, "copy");
    await transfer(["/p/local.txt"], "/p/target", "copy");
    expect(copied).toHaveBeenCalledWith("/p/local.txt", "/p/target/local.txt");
    expect(imported).not.toHaveBeenCalled();
  });
});
