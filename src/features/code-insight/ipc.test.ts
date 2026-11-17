import { describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

vi.mock("@/platform/ipc", async (importOriginal) => {
  const ipc = await importOriginal<typeof import("@/platform/ipc")>();
  const doc = (path: string) => Promise.resolve({ status: "ok", data: { id: 3, path } });
  return {
    ...ipc,
    isTauri: () => true,
    commands: {
      ...ipc.commands,
      docOpen: (path: string) => (opened.push(`file ${path}`), doc(path)),
      docOpenVirtual: (uri: string) => (opened.push(`virtual ${uri}`), doc(uri)),
      docClose: () => Promise.resolve(),
    },
  };
});

const { withDocument } = await import("./ipc");

describe("withDocument", () => {
  it("opens a library type through its language server, a project file from disk", async () => {
    const uri = "jdt://contents/java.base/java.util/UUID.class?=demo/%5C/jdk%5C/lib%5C/jrt-fs.jar%60java.base";
    await withDocument(uri, async (doc) => doc);
    await withDocument("/p/src/App.java", async (doc) => doc);
    expect(opened).toEqual([`virtual ${uri}`, "file /p/src/App.java"]);
  });
});
