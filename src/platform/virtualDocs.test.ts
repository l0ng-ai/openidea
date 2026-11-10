import { describe, expect, it } from "vitest";
import { isVirtualUri, libraryEntryPaths, virtualContainer, virtualName, virtualParent } from "./virtualDocs";
import { basename, dirname, relativeDir, relativePath } from "./project";

const JDT =
  "jdt://contents/spring-boot-4.1.1.jar/org.springframework.boot/SpringApplication.class?=demo/%5C/m2%5C/spring-boot-4.1.1.jar%3Corg.springframework.boot%28SpringApplication.class";

describe("virtual document URIs", () => {
  it("tells URIs from file paths", () => {
    expect(isVirtualUri(JDT)).toBe(true);
    expect(isVirtualUri("untitled:Untitled-1")).toBe(true);
    expect(isVirtualUri("/Users/me/a.java")).toBe(false);
    expect(isVirtualUri("C:\\src\\a.java")).toBe(false);
    expect(isVirtualUri("file:///a.java")).toBe(false);
    expect(isVirtualUri(null)).toBe(false);
  });

  it("names and locates library classes", () => {
    expect(virtualName(JDT)).toBe("SpringApplication.class");
    expect(virtualParent(JDT)).toBe("jdt://contents/spring-boot-4.1.1.jar/org.springframework.boot");
    expect(virtualContainer(JDT)).toBe("spring-boot-4.1.1.jar › org.springframework.boot");
    // `jar:` targets (official Kotlin LSP, sources jars), in both URI forms.
    for (const prefix of ["jar:///", "jar:file:///"])
      expect(
        virtualContainer(
          `${prefix}home/me/.m2/repository/spring-boot-3.5.16-sources.jar!/org/springframework/boot/SpringApplicationExtensions.kt`,
        ),
      ).toBe("spring-boot-3.5.16-sources.jar › org.springframework.boot");
    expect(virtualContainer("jar:///tmp/my%20libs/a.jar!/Root.class")).toBe("a.jar");
    expect(virtualName("jar:///tmp/a.jar!/org/x/Y.class")).toBe("Y.class");
  });

  it("makes path helpers URI-aware", () => {
    expect(basename(JDT)).toBe("SpringApplication.class");
    expect(basename(dirname(JDT))).toBe("org.springframework.boot");
    expect(relativePath("/p", JDT)).toBe("spring-boot-4.1.1.jar › org.springframework.boot › SpringApplication.class");
    expect(relativeDir("/p", JDT)).toBe("spring-boot-4.1.1.jar › org.springframework.boot");
    expect(relativePath("/p", "/p/src/A.java")).toBe("src/A.java");
  });
});

describe("libraryEntryPaths", () => {
  const M2 = "/Users/me/.m2/repository/org/springframework/boot/spring-boot/4.1.1";
  it.each([
    // The reported case: Go to Declaration into a Maven jar through jdtls.
    [
      "jdtls class in a Maven jar",
      `jdt://contents/spring-boot-4.1.1.jar/org.springframework.boot/SpringApplication.class?=demo/${encodeURIComponent(
        `${M2}/spring-boot-4.1.1.jar`.replace(/\//g, "\\/"),
      )}%3Corg.springframework.boot%28SpringApplication.class`,
      [`${M2}/spring-boot-4.1.1.jar!/org/springframework/boot/SpringApplication.class`],
    ],
    [
      "jdtls class in a Gradle jar, default package",
      "jdt://contents/a.jar//C.class?=p/%5C/g%5C/files-2.1%5C/a.jar%3C%28C.class",
      ["/g/files-2.1/a.jar!/C.class"],
    ],
    [
      "jdtls JDK class (module in lib/src.zip)",
      "jdt://contents/java.base/java.lang/String.class?=p/%5C/jdk%5C/lib%5C/jrt-fs.jar%60java.base=/javadoc_location=/x=/%3Cjava.lang%28String.class",
      ["/jdk/lib/src.zip!/java.base/java/lang/String.java"],
    ],
    [
      "jdtls JDK 8 class (rt.jar, src.zip in the home)",
      "jdt://contents/rt.jar/java.lang/String.class?=p/%5C/jdk8%5C/jre%5C/lib%5C/rt.jar%3Cjava.lang%28String.class",
      ["/jdk8/jre/lib/rt.jar!/java/lang/String.class", "/jdk8/src.zip!/java/lang/String.java"],
    ],
    [
      "jdtls class on Windows",
      "jdt://contents/a.jar/p/C.class?=x/%5C/C:%5C/m2%5C/a.jar%3Cp%28C.class",
      ["C:/m2/a.jar!/p/C.class"],
    ],
    [
      "Kotlin LSP class (jar:///)",
      "jar:///home/me/.gradle/a-1.0.jar!/org/x/Y.class",
      ["/home/me/.gradle/a-1.0.jar!/org/x/Y.class"],
    ],
    [
      "sources jar entry (jar:file:///), binary jar listed instead",
      "jar:file:///m2/my%20lib/a-1.0-sources.jar!/org/x/Y.kt",
      ["/m2/my lib/a-1.0-sources.jar!/org/x/Y.kt", "/m2/my lib/a-1.0.jar!/org/x/Y.class"],
    ],
    ["decompiled class on disk", "file:///lib/classes/p/C.class", ["/lib/classes/p/C.class"]],
    // Plain paths (src.zip entries, Go modules, node_modules, crates, site-packages) are revealed as they are.
    ["archive entry path", "/jdk/lib/src.zip!/java.base/java/lang/String.java", []],
    ["Go module file", "/Users/me/go/pkg/mod/github.com/x/y@v1.0.0/y.go", []],
    ["node_modules file", "/p/node_modules/react/index.js", []],
    ["Cargo crate file", "/Users/me/.cargo/registry/src/index.crates.io-1/serde-1.0.200/src/lib.rs", []],
    ["site-packages file", "/p/.venv/lib/python3.12/site-packages/requests/api.py", []],
    ["other virtual document", "untitled:Untitled-1", []],
  ])("%s", (_, uri, expected) => {
    expect(libraryEntryPaths(uri)).toEqual(expected);
  });

  const GRADLE = "/home/me/.gradle/caches/modules-2/files-2.1/org.example/a/1.0";
  const SOURCES = `${GRADLE}/sourceHash/a-1.0-sources.jar`;
  const BINARY = `${GRADLE}/binaryHash/a-1.0.jar!`;

  it.each([
    `jar:file://${SOURCES}!/org/x/Y.java`,
    `jdt://contents/a-1.0-sources.jar/org.x/Y.class?=p/${encodeURIComponent(SOURCES)}%3Corg.x%28Y.class`,
  ])("finds a Gradle binary jar in a different hash directory for %s", (uri) => {
    expect(libraryEntryPaths(uri, [BINARY])).toEqual([
      ...(uri.startsWith("jar:") ? [`${SOURCES}!/org/x/Y.java`] : []),
      `${GRADLE}/sourceHash/a-1.0.jar!/org/x/Y.class`,
      `${BINARY}/org/x/Y.class`,
    ]);
  });

  it("keeps the direct Gradle binary match ahead of other hash directories", () => {
    expect(
      libraryEntryPaths(`jar:file://${SOURCES}!/org/x/Y.java`, [BINARY, `${GRADLE}/sourceHash/a-1.0.jar!`]),
    ).toEqual([`${SOURCES}!/org/x/Y.java`, `${GRADLE}/sourceHash/a-1.0.jar!/org/x/Y.class`]);
  });

  it("does not match Gradle jars from another version, artifact or file name", () => {
    expect(
      libraryEntryPaths(`jar:file://${SOURCES}!/org/x/Y.java`, [
        BINARY.replace("/1.0/", "/2.0/"),
        BINARY.replace("/a/", "/b/"),
        `${GRADLE}/binaryHash/b-1.0.jar!`,
        `${GRADLE}/binaryHash/a-1.0.jar`,
      ]),
    ).toEqual([`${SOURCES}!/org/x/Y.java`, `${GRADLE}/sourceHash/a-1.0.jar!/org/x/Y.class`]);
  });
});
