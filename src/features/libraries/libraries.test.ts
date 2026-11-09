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
    expect(root.children?.map((g) => g.icon)).toEqual([
      "file-java",
      "file-js",
      "file-npm",
      "file-rust",
      "file-cargo",
      "file-go",
      "file-gomod",
      "maven-project",
      "file-gradle",
      "library",
    ]);
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
    expect(root.children?.[1]).toMatchObject({ label: "< Maven: g:a:1 >", icon: "maven-project" });
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
