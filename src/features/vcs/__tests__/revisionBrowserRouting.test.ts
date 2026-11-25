import { beforeEach, describe, expect, it, vi } from "vitest";

const editor = vi.hoisted(() => ({ openFile: vi.fn(), openInput: vi.fn() }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  editorService: () => editor,
}));

import { openRevisionFile } from "../revisionInput";
import { useVcs } from "../store";

beforeEach(() => {
  editor.openFile.mockReset();
  editor.openInput.mockReset();
  useVcs.setState({ root: "/project" });
});

describe("openRevisionFile", () => {
  it("routes project revisions through the registered read-only file URI", () => {
    openRevisionFile("/repo", "a".repeat(40), "old/name.ts");

    const uri = editor.openFile.mock.calls[0]![0] as string;
    const hex = uri.slice("git-revision:".length).split("/", 1)[0]!;
    const encoded = Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({
      repo: "/repo",
      revision: "a".repeat(40),
      path: "old/name.ts",
    });
    expect(editor.openFile).toHaveBeenCalledWith(uri, { focus: true });
    expect(editor.openInput).not.toHaveBeenCalled();
  });

  it("routes external revisions through the standalone read-only editor input", () => {
    useVcs.setState({ root: null });
    openRevisionFile("/external/repo", "b".repeat(40), "src/file.ts", true);

    expect(editor.openInput).toHaveBeenCalledWith({
      kind: "git-revision",
      key: `git-revision:/external/repo\0${"b".repeat(40)}\0src/file.ts`,
      data: { repo: "/external/repo", revision: "b".repeat(40), path: "src/file.ts", external: true },
    });
    expect(editor.openFile).not.toHaveBeenCalled();
  });
});
