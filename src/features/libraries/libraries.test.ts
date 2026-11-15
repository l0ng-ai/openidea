import { afterEach, describe, expect, it } from "vitest";
import { isLibraryPath, setLibraryRoots } from "@/editor/api";
import { librariesRoot, touchesManifest } from "./index";
import { mergeLibraryGroups } from "@/platform/libraries";

describe("External Libraries", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  it("groups each SDK's folders under one read-only root", () => {
    expect(librariesRoot([])).toBeNull();
    const root = librariesRoot([
      {
        name: "Python 3.12 (.venv)",
        kind: "python",
        roots: [
          { name: "python3.12", path: "/py/lib/python3.12" },
          { name: "site-packages", path: "/p/.venv/lib/python3.12/site-packages" },
        ],
      },
    ])!;
    expect(root).toMatchObject({ id: "externalLibraries", label: "External Libraries", readOnly: true });
    expect(root.children?.[0]).toMatchObject({ label: "< Python 3.12 (.venv) >", icon: "file-python" });
    expect(root.children?.[0]?.children?.map((c) => [c.label, c.path, c.detail])).toEqual([
      ["python3.12", "/py/lib/python3.12", "library root"],
      ["site-packages", "/p/.venv/lib/python3.12/site-packages", "library root"],
    ]);
  });

  it("gives each ecosystem's groups their icon", () => {
    const root = librariesRoot(
      ["jdk", "nodeCore", "nodeModules", "rust", "cargo", "go", "goModules", "maven", "gradle", "other"].map(
        (kind) => ({
          name: kind,
          kind,
          roots: [{ name: "r", path: `/libs/${kind}` }],
        }),
      ),
    )!;
    expect(Object.fromEntries(root.children!.map((g) => [g.label, g.icon]))).toEqual({
      "< jdk >": "file-java",
      nodeCore: "file-js",
      nodeModules: "file-npm",
      "< rust >": "file-rust",
      cargo: "file-cargo",
      "< go >": "file-go",
      goModules: "file-gomod",
      maven: "maven-project",
      gradle: "file-gradle",
      other: "library",
    });
  });

  it("lists SDKs first, then libraries by name, whatever order they were detected in", () => {
    const group = (name: string, kind: string) => ({ name, kind, roots: [{ name: "r", path: `/libs/${name}` }] });
    const detected = [
      group("Maven: org.junit:junit:4.13", "maven"),
      group("temurin-21", "jdk"),
      group("node_modules", "nodeModules"),
      group("Python 3.14", "python"),
      group("Cargo dependencies", "cargo"),
      group("Gradle: com.acme:lib:1.0", "gradle"),
      group("Go SDK 1.27.4", "go"),
      group("Maven: com.acme:core:2.1.27", "maven"),
      group("Node.js Core", "nodeCore"),
    ];
    const labels = (groups: typeof detected) => librariesRoot(groups)!.children!.map((g) => g.label);
    expect(labels(detected)).toEqual([
      "< Go SDK 1.27.4 >",
      "< Python 3.14 >",
      "< temurin-21 >",
      "Cargo dependencies",
      "Gradle: com.acme:lib:1.0",
      "Maven: com.acme:core:2.1.27",
      "Maven: org.junit:junit:4.13",
      "node_modules",
      "Node.js Core",
    ]);
    expect(labels([...detected].reverse())).toEqual(labels(detected));
  });

  it("lists archives (src.zip, dependency jars) as browsable roots", () => {
    const root = librariesRoot([
      {
        name: "temurin-21",
        kind: "jdk",
        roots: [
          { name: "temurin-21", path: "/jdk" },
          { name: "src.zip", path: "/jdk/lib/src.zip!" },
        ],
      },
      { name: "Maven: g:a:1", kind: "maven", roots: [{ name: "a-1-sources.jar", path: "/m2/g/a/1/a-1-sources.jar!" }] },
    ])!;
    expect(root.children?.[0]?.children?.map((c) => c.icon)).toEqual(["folder-library", "file-archive"]);
    // As in IDEA: SDKs in angle brackets, dependencies without.
    expect(root.children?.[0]).toMatchObject({ label: "< temurin-21 >" });
    expect(root.children?.[1]).toMatchObject({ label: "Maven: g:a:1", icon: "maven-project" });
    dispose = setLibraryRoots("test", ["/jdk/lib/src.zip!"]);
    expect(isLibraryPath("/jdk/lib/src.zip!/java.base/java/lang/String.java")).toBe(true);
  });

  it("refreshes on manifest changes outside node_modules", () => {
    expect(touchesManifest(["/p/src/main.rs", "/p/Cargo.toml"])).toBe(true);
    expect(touchesManifest(["C:\\p\\go.mod"])).toBe(true);
    expect(touchesManifest(["/p/.venv/pyvenv.cfg"])).toBe(true);
    expect(touchesManifest(["/p/pnpm-workspace.yaml", "/p/Gemfile.lock"])).toBe(true);
    expect(touchesManifest(["/p/node_modules/react/package.json"])).toBe(false);
    expect(touchesManifest(["/p/src/package.json.bak", "/p/README.md"])).toBe(false);
  });

  it("refreshes when an applied Gradle script or properties file changes", () => {
    expect(touchesManifest(["/p/gradle/dependencies.gradle"])).toBe(true);
    expect(touchesManifest(["C:\\p\\gradle\\dependencies.gradle.kts"])).toBe(true);
    expect(touchesManifest(["/p/gradle.properties"])).toBe(true);
    expect(touchesManifest(["/p/node_modules/tool/dependencies.gradle"])).toBe(false);
  });

  it("marks files below library roots for read-only editors", () => {
    dispose = setLibraryRoots("test", ["/py/lib/python3.12"]);
    expect(isLibraryPath("/py/lib/python3.12/os.py")).toBe(true);
    expect(isLibraryPath("/py/lib/python3.120/x.py")).toBe(false);
    dispose();
    expect(isLibraryPath("/py/lib/python3.12/os.py")).toBe(false);
  });

  it("merges streamed module groups without dropping ecosystems or distinct roots", () => {
    const group = (kind: string, path: string) => ({ name: kind, kind, roots: [{ name: "dep", path }] });
    expect(
      mergeLibraryGroups([
        group("cargo", "/cargo/serde"),
        group("nodeModules", "/web/node_modules/dep"),
        group("maven", "/m2/dep.jar!"),
        group("nodeModules", "/api/node_modules/dep"),
        group("cargo", "/cargo/serde"),
      ]),
    ).toEqual([
      group("cargo", "/cargo/serde"),
      {
        name: "nodeModules",
        kind: "nodeModules",
        roots: [
          { name: "dep", path: "/web/node_modules/dep" },
          { name: "dep", path: "/api/node_modules/dep" },
        ],
      },
      group("maven", "/m2/dep.jar!"),
    ]);
  });
});
