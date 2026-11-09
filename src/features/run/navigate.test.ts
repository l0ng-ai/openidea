import { afterEach, describe, expect, it, vi } from "vitest";
import { jvmFrameTarget } from "./links";
import { useRemote } from "@/platform/remote";

const files: Record<string, string> = {
  "/p/src/main/java/com/acme/Util.java": "package com.acme;\nclass Util {}",
  "/p/other/Util.java": "package org.other;\nclass Util {}",
  "/p/src/main/kotlin/Orders.kt": "package com.acme.orders\nfun main() {}",
};
const symbols = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  nextRequestId: () => 1,
  call: async (v: unknown) => v,
  commands: {
    fsReadDir: async () => [],
    fsReadText: async (path: string) => files[path] ?? "",
    findFilesNamed: async (name: string) => Object.keys(files).filter((p) => p.endsWith(`/${name}`)),
    indexStatus: async () => ({ files: Object.keys(files).length }),
    findFiles: async (name: string, limit: number) =>
      Object.keys(files)
        .filter((p) => p.endsWith(`/${name}`))
        .slice(0, limit)
        .map((path) => ({ path, relPath: path.slice(3) })),
    lspWorkspaceSymbols: async () => symbols.list,
  },
}));

const { resolveTarget } = await import("./navigate");

describe("JVM stack frame resolution", () => {
  afterEach(() => {
    symbols.list = [];
    useRemote.setState({ session: null });
  });

  it("picks the file of the frame's package, not any file of that name", async () => {
    expect(await resolveTarget(jvmFrameTarget("com.acme.Util", "Util.java", 3), "/p")).toBe(
      "/p/src/main/java/com/acme/Util.java",
    );
    expect(await resolveTarget(jvmFrameTarget("org.other.Util", "Util.java", 3), "/p")).toBe("/p/other/Util.java");
  });

  it("finds Kotlin files outside their package directory by their package declaration", async () => {
    expect(await resolveTarget(jvmFrameTarget("com.acme.orders.OrdersKt", "Orders.kt", 1), "/p")).toBe(
      "/p/src/main/kotlin/Orders.kt",
    );
  });

  it.each(["java", "kt", "scala", "groovy"])("keeps the package in a crowded %s source lookup", async (ext) => {
    const otherPaths = Array.from({ length: 60 }, (_, i) => `/p/module${i}/src/other${i}/AService.${ext}`);
    const source = `/p/service/src/main/${ext}/com/example/AService.${ext}`;
    for (const [i, path] of otherPaths.entries()) files[path] = `package other${i};`;
    files[source] = "package com.example;";
    symbols.list = [
      {
        name: "AService",
        kind: "class",
        container: "com.example",
        location: { path: "jdt://contents/AService.class", uri: "jdt://contents/AService.class" },
      },
    ];
    try {
      expect(await resolveTarget(jvmFrameTarget("com.example.AService", `AService.${ext}`, 52), "/p")).toBe(source);
    } finally {
      for (const path of [...otherPaths, source]) delete files[path];
    }
  });

  it.each([false, true])(
    "finds nonstandard package directories beyond the fuzzy limit (old remote: %s)",
    async (legacy) => {
      if (legacy)
        useRemote.setState({
          session: {
            target: { kind: "wsl", distro: "Ubuntu" },
            root: "/p",
            host: "Ubuntu",
            os: "linux",
            commands: ["find_files", "index_status"],
          },
        });
      const others = Array.from({ length: 65 }, (_, i) => `/p/other${i}/Orders.kt`);
      const source = "/p/special/src/Orders.kt";
      for (const [i, path] of others.entries()) files[path] = `package other${i}`;
      files[source] = "package com.example.orders\nfun main() {}";
      try {
        expect(await resolveTarget(jvmFrameTarget("com.example.orders.OrdersKt", "Orders.kt", 1), "/p")).toBe(source);
      } finally {
        for (const path of [...others, source]) delete files[path];
      }
    },
  );

  it("library classes open the language server's source, else nothing", async () => {
    expect(await resolveTarget(jvmFrameTarget("java.util.ArrayList", "ArrayList.java", 427), "/p")).toBeNull();
    symbols.list = [
      {
        name: "ArrayList",
        kind: "class",
        container: "java.util",
        location: { path: "jdt://contents/ArrayList.class", uri: "jdt://contents/ArrayList.class" },
      },
    ];
    expect(await resolveTarget(jvmFrameTarget("java.util.ArrayList", "ArrayList.java", 427), "/p")).toBe(
      "jdt://contents/ArrayList.class",
    );
    // Same simple name in another package isn't it.
    expect(await resolveTarget(jvmFrameTarget("java.awt.List$X", "List.java", 1), "/p")).toBeNull();
  });
});
