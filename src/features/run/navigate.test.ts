import { afterEach, describe, expect, it, vi } from "vitest";
import { jvmFrameTarget } from "./links";
import { useBuildModel } from "@/platform/buildModel";
import type { MavenModel, MavenProject } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";

const files: Record<string, string> = {
  "/p/src/main/java/com/acme/Util.java": "package com.acme;\nclass Util {}",
  "/p/other/Util.java": "package org.other;\nclass Util {}",
  "/p/src/main/kotlin/Orders.kt": "package com.acme.orders\nfun main() {}",
  "/p/cypress/e2e/cart.cy.ts":
    'describe("cart", () => {\n  it("adds", () => {});\n  context("totals", () => {\n    it("adds", () => {});\n  });\n});',
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

const { declarationLine, resolveTarget } = await import("./navigate");

describe("JS tests without a line", () => {
  it("are found in their file by describe chain and name", async () => {
    expect(await declarationLine("/p/cypress/e2e/cart.cy.ts", ["cart", "totals", "adds"])).toBe(4);
    expect(await declarationLine("/p/cypress/e2e/cart.cy.ts", ["cart", "adds"])).toBe(2);
    expect(await declarationLine("/p/cypress/e2e/cart.cy.ts", ["cart", "gone"])).toBeUndefined();
    // The first call loads the run targets' parsers.
  }, 60_000);
});

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

/** A Maven project of the multi-module fixture: its folder, artifact and the modules it depends on. */
function moduleProject(dir: string, artifactId: string, dependsOn: string[] = []): MavenProject {
  return {
    pom: dir ? `${dir}/pom.xml` : "pom.xml",
    dir,
    groupId: "com.example",
    artifactId,
    version: "1.0",
    packaging: dir ? "jar" : "pom",
    displayName: artifactId,
    parent: null,
    modules: [],
    aggregated: !!dir,
    plugins: [],
    dependencies: dependsOn.map((target) => ({
      groupId: "com.example",
      artifactId: target,
      version: "1.0",
      type: "jar",
      classifier: null,
      scope: "compile",
      optional: false,
      children: [],
    })),
    profiles: [],
    javaVersion: 8,
    command: "mvn",
    options: [],
    env: {},
  };
}

describe("JVM stack frames of a multi-module build", () => {
  afterEach(() => useBuildModel.setState({ root: null, model: null, gradleOffline: false }));

  /** module-a/b/c each hold com.example.task.DoTaskController; app depends on module-c only. */
  const multiModule = (): MavenModel => ({
    projects: [
      moduleProject(
        "",
        "repro-parent",
        ["module-a", "module-b", "module-c", "app"].map((d) => `unused-${d}`),
      ),
      moduleProject("module-a", "module-a"),
      moduleProject("module-b", "module-b"),
      moduleProject("module-c", "module-c"),
      moduleProject("app", "app", ["module-c"]),
    ],
    profiles: [],
    syncedAt: 0,
    stale: false,
    syncError: null,
  });

  it("opens the copy the run's module depends on, not the first one the index lists", async () => {
    const tail = "src/main/java/com/example/task/DoTaskController.java";
    const dirs = ["module-a", "module-b", "module-c"];
    for (const dir of dirs) files[`/p/${dir}/${tail}`] = "package com.example.task;\nclass DoTaskController {}";
    useBuildModel.setState({ root: "/p", model: { maven: multiModule() }, gradleOffline: false });
    try {
      // The frame names module-c's class, whose line 107 throws; module-a's copy is what a
      // name-only lookup finds first.
      expect(
        await resolveTarget(
          jvmFrameTarget("com.example.task.DoTaskController", "DoTaskController.java", 107),
          "/p/app",
          "app",
        ),
      ).toBe(`/p/module-c/${tail}`);
    } finally {
      for (const dir of dirs) delete files[`/p/${dir}/${tail}`];
    }
  });

  it("keeps the name-only lookup when the run's module is unknown", async () => {
    const tail = "src/main/java/com/example/task/DoTaskController.java";
    for (const dir of ["module-a", "module-c"]) files[`/p/${dir}/${tail}`] = "package com.example.task;";
    useBuildModel.setState({ root: "/p", model: { maven: multiModule() }, gradleOffline: false });
    try {
      expect(
        await resolveTarget(jvmFrameTarget("com.example.task.DoTaskController", "DoTaskController.java", 107), "/p"),
      ).toBe(`/p/module-a/${tail}`);
    } finally {
      for (const dir of ["module-a", "module-c"]) delete files[`/p/${dir}/${tail}`];
    }
  });
});
