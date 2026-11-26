import { describe, expect, it } from "vitest";
import { folderKind, outputFolderKind } from "./folderKind";
import { validateProjectStructure, type RootFolder } from "@/platform/languageSettings";
import { directoryIconName } from "@/ui/folderPresentation";
const build = {
  modules: new Map([
    ["", "maven"],
    ["app", "gradle"],
  ] as const),
  spring: false,
};
const roots: RootFolder[] = [
  { path: "src/main/java", kind: "source", detectedFrom: "pom.xml" },
  { path: "src/test/java", kind: "test", detectedFrom: "pom.xml" },
  { path: "src/main/resources", kind: "resources", detectedFrom: "pom.xml" },
  { path: "src/test/resources", kind: "testResources", detectedFrom: "pom.xml" },
];
const kind = (rel: string, excluded = false, rs = roots) =>
  folderKind({ path: `/p/${rel}`, excluded }, rs, "/p", build);
describe("JVM folder presentation", () => {
  it.each([
    ["src/main/java", "source"],
    ["src/test/java", "test"],
    ["src/main/resources", "resources"],
    ["src/test/resources", "testResources"],
    ["src/main/java/com/example", "package"],
    ["src/test/java/com", "package"],
    ["src/main/resources/templates", "plain"],
    ["plain", "plain"],
  ])("%s: %s", (path, expected) => expect(kind(path)).toBe(expected));
  it.each([
    ["target/generated-sources", "generatedSource"],
    ["target/generated-test-sources", "generatedTest"],
    ["app/build/generated", "generatedSource"],
    ["app/build/classes/kotlin", "compiled"],
    ["target/classes", "compiled"],
    ["target/site/apidocs", "javadoc"],
    ["app/build/docs/javadoc", "javadoc"],
  ])("%s: %s", (path, expected) => {
    expect(kind(path)).toBe(expected);
    expect(kind(path, true)).toBe("excluded");
    expect(outputFolderKind(path, new Map())).toBeNull();
  });
  it("shows packages below source sets a Gradle sync or an Eclipse .classpath reported", () => {
    const noModules = { modules: new Map(), spring: false };
    for (const detectedFrom of ["Gradle", "lib/Gradle", "lib/.classpath"]) {
      const rs: RootFolder[] = [{ path: "lib/src", kind: "source", detectedFrom }];
      expect(folderKind({ path: "/p/lib/src/com/example", excluded: false }, rs, "/p", noModules)).toBe("package");
    }
  });
  it("shows packages below custom marked JVM source roots", () => {
    expect(kind("custom/com/example", false, [{ path: "custom", kind: "source", detectedFrom: null }])).toBe("package");
  });
  it("keeps marks and generated source roots ahead of output and exclusion", () => {
    expect(
      kind("target/generated-sources", true, [
        { path: "target/generated-sources", kind: "source", detectedFrom: "pom.xml" },
      ]),
    ).toBe("source");
    expect(kind("target/classes", false, [{ path: "target/classes", kind: "test", detectedFrom: null }])).toBe("test");
    expect(
      kind("src/main/java/com", false, [...roots, { path: "src/main/java/com", kind: "excluded", detectedFrom: null }]),
    ).toBe("excluded");
  });
  it.each(["generated-sources", "src/main/java/classes", "other/build/generated", "build/generated"])(
    "does not guess output roles for %s",
    (path) => expect(outputFolderKind(path, build.modules)).toBeNull(),
  );
  it("isolates output folder detection for attached workspace members from the primary relative key space", () => {
    const emptyStructure = validateProjectStructure(undefined);
    const attached = [
      { root: "/other", structure: emptyStructure, detected: [] },
      { root: "/web", structure: emptyStructure, detected: [] },
    ];
    expect(
      directoryIconName({
        path: "/other/target/generated-sources/gen",
        root: "/p",
        roots: [],
        attached,
        build: {
          modules: new Map([
            ["", "gradle"],
            ["/other", "maven"],
          ]),
          spring: false,
        },
      }),
    ).toBe("folder-generated-source");
    expect(
      directoryIconName({
        path: "/web/target/classes",
        root: "/p",
        roots: [],
        attached,
        build: {
          modules: new Map([
            ["", "maven"],
            ["/other", "maven"],
          ]),
          spring: false,
        },
      }),
    ).toBe("folder");
  });
});
