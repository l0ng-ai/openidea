import { describe, expect, it, vi } from "vitest";
import { _provideDocumentAttacher } from "@/editor/api";
import { createMemoryBackend } from "@/editor/core/backend";
import { attachDocument } from "@/editor/core/model/attachment";
import { DocumentManager } from "@/editor/core/model/document";
import { useProject } from "@/platform/project";
import { stagedDocument, stagedDocumentLifecycle } from "../stagedDocument";
import type { DiffData } from "../diffInput";
import { imageDiffKind, readImageSide } from "../imageDiffInput";

const { vcsImageAt, fsReadImage } = vi.hoisted(() => ({
  vcsImageAt: vi.fn(async () => ({ status: "ok", data: "revision" })),
  fsReadImage: vi.fn(async () => ({ status: "ok", data: "working tree" })),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    vcsImageAt,
    fsReadImage,
    vcsStagedText: async () => ({ status: "ok", data: { text: "clean", version: "v1" } }),
  },
}));

const change = (path: string): DiffData => ({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });

describe("Git image diff input", () => {
  it.each(["png", "JPG", "jpeg", "WeBp", "svg"])("supports .%s", (extension) => {
    expect(imageDiffKind(change("icon." + extension))).toBe(extension === "svg" ? "svg" : "raster");
  });

  it("keeps other binary files, line ranges and inline text diffs in the original viewer", () => {
    expect(imageDiffKind(change("movie.mp4"))).toBeNull();
    expect(imageDiffKind({ ...change("icon.svg"), line: 12 })).toBeNull();
    expect(imageDiffKind({ ...change("icon.png"), left: { type: "text", label: "patch", text: "patch" } })).toBeNull();
  });

  it("labels a mixed image-format rename as raster and ignores an absent side's extension", () => {
    const data = change("new.svg");
    expect(imageDiffKind({ ...data, left: { type: "rev", rev: "HEAD", path: "old.png" } })).toBe("raster");
    expect(imageDiffKind({ ...data, left: { type: "text", label: "missing", text: "", absent: true } })).toBe("svg");
  });

  it("loads the renamed revision and index by their individual paths, and reads the working file from disk", async () => {
    const path = "/r/new.png";
    expect(await readImageSide(path, { type: "rev", rev: "HEAD", path: "/r/old.png" })).toBe("revision");
    expect(vcsImageAt).toHaveBeenCalledWith("/r/old.png", "HEAD");
    await readImageSide(path, { type: "rev", rev: ":0" });
    expect(vcsImageAt).toHaveBeenCalledWith(path, ":0");
    expect(await readImageSide(path, { type: "worktree" })).toBe("working tree");
    expect(fsReadImage).toHaveBeenCalledWith(path);
    expect(await readImageSide(path, { type: "text", text: "", label: "missing", absent: true })).toBeNull();
  });

  it("reads an unsaved SVG even after its text editor unmounts", async () => {
    const path = "/r/inactive.svg";
    const backend = createMemoryBackend({ [path]: "<svg/>" });
    const manager = new DocumentManager(backend, { settings: () => ({ files: { autoSave: false } }), notify: vi.fn() });
    manager.start();
    _provideDocumentAttacher((file) => attachDocument(manager, file));
    try {
      const source = await attachDocument(manager, path);
      source.edit({ from: 4, insert: ' id="draft"' });
      await source.synced();
      source.release();
      const url = await readImageSide(path, { type: "worktree" });
      expect(decodeURIComponent(url!)).toContain('<svg id="draft"/>');
      expect(backend.files.get(path)).toBe("<svg/>");
    } finally {
      _provideDocumentAttacher(null);
      manager.releaseProjectDocuments();
      manager.stop();
    }
  });

  it("uses a dirty SVG index draft only on its matching index side", async () => {
    const path = "/r/new.svg";
    const old = "/r/old.svg";
    const project = useProject.getState().project;
    useProject.setState({ project: { root: "/r" } as never });
    const doc = stagedDocument(old, "image-test")!;
    try {
      await doc.reload();
      doc.edit({ from: 0, to: 5, insert: "<svg/>" });
      expect(decodeURIComponent((await readImageSide(path, { type: "rev", rev: ":0", path: old }))!)).toContain(
        "<svg/>",
      );
      expect(await readImageSide(path, { type: "rev", rev: "HEAD", path: old })).toBe("revision");
      expect(await readImageSide(path, { type: "rev", rev: ":0" })).toBe("revision");
    } finally {
      doc.discard();
      await stagedDocumentLifecycle().close({ key: "image-test", kind: "diff" });
      useProject.setState({ project });
    }
  });
});
