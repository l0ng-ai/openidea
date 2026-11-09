import { describe, expect, it } from "vitest";
import { isVirtualUri, virtualContainer, virtualName, virtualParent } from "./virtualDocs";
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
