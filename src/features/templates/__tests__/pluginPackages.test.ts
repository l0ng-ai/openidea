import { afterEach, describe, expect, it, vi } from "vitest";
import { packageFor, createFromTemplate } from "../files/create";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";
import type { FileTemplate } from "../files/model";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { commands } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  call: (result: unknown) => result,
  commands: {
    fsReadDir: vi.fn(async () => [{ kind: "file", name: "sibling.go", path: "/p/sibling.go" }]),
    fsReadText: mocks.read,
    fsCreateFile: vi.fn(),
  },
}));

const plugin = (extension: string): FileTemplate => ({
  id: "plugin.demo.repo",
  name: "Repository",
  icon: "file",
  extension,
  nameStyle: "asis",
  inferPackage: true,
  kinds: [{ id: "file", label: "Repository", body: "$PACKAGE$" }],
});

afterEach(() => {
  useProject.setState({ project: null });
  vi.clearAllMocks();
});

describe("plugin package inference uses built-in rules", () => {
  it.each(["java", "kt"])("uses custom source roots for %s", async (extension) => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    useProjectRoots.setState({ root: "/p", detected: [{ path: "generated", kind: "source", detectedFrom: null }] });
    const dir = "/p/generated/com/acme";
    expect(await packageFor(plugin(extension), dir)).toBe("com.acme");
    const builtin = BUILTIN_FILE_TEMPLATES.find((t) => t.extension === extension)!;
    expect(await packageFor(plugin(extension), dir)).toBe(await packageFor(builtin, dir));
  });
  it.each(["java", "kt"])("uses source sets reported by a Gradle sync for %s", async (extension) => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    useProjectRoots.setState({
      root: "/p",
      detected: [
        { path: "src/gen", kind: "source", detectedFrom: "Gradle" },
        { path: "lib/src/gen", kind: "source", detectedFrom: "lib/Gradle" },
      ],
    });
    const builtin = BUILTIN_FILE_TEMPLATES.find((t) => t.extension === extension)!;
    expect(await packageFor(builtin, "/p/src/gen/com/acme")).toBe("com.acme");
    expect(await packageFor(builtin, "/p/lib/src/gen/com/acme")).toBe("com.acme");
  });
  it("keeps the packages of a synced Gradle project's standard source and resource roots", async () => {
    // Root shapes a Gradle sync reports for the default layout.
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    useProjectRoots.setState({
      root: "/p",
      detected: [
        { path: "src/main/java", kind: "source", detectedFrom: "Gradle" },
        { path: "src/main/resources", kind: "resources", detectedFrom: "Gradle" },
        { path: "src/test/java", kind: "test", detectedFrom: "Gradle" },
        { path: "src/test/resources", kind: "testResources", detectedFrom: "Gradle" },
      ],
    });
    const java = BUILTIN_FILE_TEMPLATES.find((t) => t.extension === "java")!;
    expect(await packageFor(java, "/p/src/main/java/com/acme")).toBe("com.acme");
    expect(await packageFor(java, "/p/src/test/java/com/acme")).toBe("com.acme");
    expect(await packageFor(java, "/p/src/main/java")).toBe("");
  });
  it("uses source folders from an Eclipse .classpath", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    useProjectRoots.setState({
      root: "/p",
      detected: [{ path: "app/source", kind: "source", detectedFrom: "app/.classpath" }],
    });
    const java = BUILTIN_FILE_TEMPLATES.find((t) => t.extension === "java")!;
    expect(await packageFor(java, "/p/app/source/com/acme")).toBe("com.acme");
  });
  it("infers language from an exact filename when extension is omitted", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    expect(await packageFor({ ...plugin(""), fileName: "Order.java" }, "/p/src/main/java/com/acme")).toBe("com.acme");
  });
  it("uses the actual fixed filename instead of a conflicting declared extension", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    expect(await packageFor({ ...plugin("txt"), fileName: "Order.java" }, "/p/src/main/java/com/acme")).toBe(
      "com.acme",
    );
    expect(await packageFor({ ...plugin("java"), fileName: ".dockerignore" }, "/p/src/main/java/com/acme")).toBe("");
  });
  it("uses the nearest .csproj for C#", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    const csproj = { kind: "file", name: "Shop.csproj", path: "/p/src/Shop/Shop.csproj" };
    const readDir = vi
      .mocked(commands.fsReadDir)
      .mockImplementation((async (dir: string) => (dir === "/p/src/Shop" ? [csproj] : [])) as never);
    mocks.read.mockResolvedValue(
      "<Project><PropertyGroup><RootNamespace>Acme.Shop</RootNamespace></PropertyGroup></Project>",
    );
    try {
      expect(await packageFor(plugin("cs"), "/p/src/Shop/Orders/Api")).toBe("Acme.Shop.Orders.Api");
      expect(await packageFor(plugin("cs"), "/p/tools")).toBe("");
    } finally {
      readDir.mockReset();
    }
  });
  it("uses an existing Go package", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    mocks.read.mockResolvedValue("package service\n");
    expect(await packageFor(plugin("go"), "/p/pkg/store")).toBe("service");
  });
  it("uses Composer PSR-4 namespaces for PHP", async () => {
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    mocks.read.mockImplementation(async (path: string) => {
      if (path !== "/p/composer.json") throw new Error("missing");
      return JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } });
    });
    expect(await packageFor(plugin("php"), "/p/src/Http")).toBe("App\\Http");
  });
  it("does not infer a package for ordinary file formats", async () => {
    expect(await packageFor(plugin("md"), "/p/src/main/java/com/acme")).toBe("");
  });
  it("checks cancellation after async package inference and before filesystem creation", async () => {
    await createFromTemplate(plugin("md"), plugin("md").kinds[0]!, "/p", "Readme", undefined, {}, () => true);
    expect(commands.fsCreateFile).not.toHaveBeenCalled();
  });
});
