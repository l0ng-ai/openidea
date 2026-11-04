import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ fsReadText: vi.fn(), gradlePublishedCatalog: vi.fn() }));
vi.mock("@/platform/ipc", () => ({
  call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
    const r = await p;
    if (r.status !== "ok") throw r.error;
    return r.data;
  },
  commands: ipc,
  onIdeEvent: () => () => {},
}));

import {
  accessorSegments,
  catalogEntry,
  chainAt,
  declaredCatalogs,
  parseCatalog,
  readCatalogs,
} from "./versionCatalog";

const toml = `[versions]
springBoot = "3.5.16"
kotlin = "2.2.0" # comment

[libraries]
spring-boot-starter = { module = "org.springframework.boot:spring-boot-starter", version.ref = "springBoot" }
"jackson_kotlin" = "com.fasterxml.jackson.module:jackson-module-kotlin:2.19.0"
groovy.module = "org.apache.groovy:groovy"

[bundles]
web = [
  "spring-boot-starter",
  "jackson_kotlin",
]

[plugins]
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
`;

describe("Gradle version catalogs", () => {
  const catalog = parseCatalog("libs", "/p/gradle/libs.versions.toml", toml);

  it("reads the aliases of each table with where they are declared", () => {
    expect(catalog.entries.map((e) => [e.section, e.alias, e.line, e.col])).toEqual([
      ["versions", "springBoot", 1, 0],
      ["versions", "kotlin", 2, 0],
      ["libraries", "spring-boot-starter", 5, 0],
      ["libraries", "jackson_kotlin", 6, 1],
      ["libraries", "groovy", 7, 0],
      ["bundles", "web", 10, 0],
      ["plugins", "kotlin-jvm", 16, 0],
    ]);
    expect(catalog.entries[1]!.value).toBe('"2.2.0"');
  });

  it("maps build script accessors to entries the way Gradle generates them", () => {
    expect(accessorSegments("spring-boot_starter.web")).toEqual(["spring", "boot", "starter", "web"]);
    const alias = (segments: string[]) => catalogEntry(catalog, segments)?.alias;
    expect(alias(["spring", "boot", "starter"])).toBe("spring-boot-starter");
    expect(alias(["jackson", "kotlin"])).toBe("jackson_kotlin");
    expect(alias(["versions", "springBoot", "get"])).toBe("springBoot");
    expect(alias(["bundles", "web"])).toBe("web");
    expect(alias(["plugins", "kotlin", "jvm"])).toBe("kotlin-jvm");
    expect(alias(["spring", "web"])).toBeUndefined();
  });

  it("finds the accessor chain under the caret", () => {
    const line = "    implementation(libs.spring.boot.starter)";
    expect(chainAt(line, line.indexOf("boot"))).toEqual({
      from: line.indexOf("libs"),
      to: line.indexOf(")"),
      segments: ["libs", "spring", "boot", "starter"],
    });
    expect(chainAt(line, 6)).toBeNull();
  });

  it("reads catalogs declared in settings", () => {
    const settings = `dependencyResolutionManagement {
      versionCatalogs {
        create("commonLibs") { from(files("../shared/common.versions.toml")) }
        create('tools') {
          from(files('gradle/tools.versions.toml'))
        }
        create("platformLibs") { from("com.acme:platform-catalog:1.4.0") }
      }
    }`;
    expect(declaredCatalogs(settings)).toEqual([
      { name: "commonLibs", file: "../shared/common.versions.toml" },
      { name: "tools", file: "gradle/tools.versions.toml" },
      { name: "platformLibs", artifact: "com.acme:platform-catalog:1.4.0" },
    ]);
  });

  it("reads a published catalog from where a build downloaded it", async () => {
    const files: Record<string, string> = {
      "/p/settings.gradle.kts": `dependencyResolutionManagement { versionCatalogs {
        create("platformLibs") { from("com.acme:platform-catalog:1.4.0") }
        create("later") { from("com.acme:later:1.0") }
      } }`,
      "/cache/platform-catalog-1.4.0.toml": '[libraries]\nspring-core = "org.springframework:spring-core:6.2.0"\n',
    };
    ipc.fsReadText.mockImplementation(async (path: string) =>
      path in files ? { status: "ok", data: files[path] } : { status: "error", error: { kind: "notFound" } },
    );
    ipc.gradlePublishedCatalog.mockImplementation(async (coordinates: string) => ({
      status: "ok",
      data: coordinates === "com.acme:platform-catalog:1.4.0" ? "/cache/platform-catalog-1.4.0.toml" : null,
    }));
    const { catalogs, complete } = await readCatalogs("/p/build.gradle.kts", "/p");
    expect(catalogs.map((c) => [c.name, c.path])).toEqual([["platformLibs", "/cache/platform-catalog-1.4.0.toml"]]);
    expect(catalogEntry(catalogs[0]!, ["spring", "core"])?.value).toBe('"org.springframework:spring-core:6.2.0"');
    // `later` isn't downloaded yet: read again next time.
    expect(complete).toBe(false);
  });
});
