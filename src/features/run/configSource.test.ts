import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";

const files = new Map<string, string>();

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      fsReadText: (path: string) =>
        files.has(path) ? Promise.resolve(files.get(path)) : Promise.reject(new Error("not found")),
      findFilesNamed: (name: string) => Promise.resolve([...files.keys()].filter((p) => p.endsWith(`/${name}`))),
    },
  };
});

const { configSource, hasSource } = await import("./configSource");

const ROOT = "/w/shop";
const config = (over: Partial<RunConfig>): RunConfig => ({
  id: "c",
  name: "c",
  kind: "shell",
  command: "",
  args: [],
  cwd: ROOT,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...over,
});

describe("configSource", () => {
  beforeEach(() => {
    files.clear();
    useProject.setState({ project: { root: ROOT } as never });
  });

  it("opens a JVM application's main class, preferring the configuration's module", async () => {
    files.set(`${ROOT}/legacy/src/main/java/com/acme/App.java`, "package com.acme;\nclass App {}\n");
    files.set(
      `${ROOT}/api/src/main/java/com/acme/App.java`,
      "package com.acme;\n\n@SpringBootApplication\npublic class App {\n}\n",
    );
    files.set(`${ROOT}/api/src/main/java/org/other/App.java`, "class App {}\n");
    const app = config({ kind: "spring-boot", module: "api", params: { mainClass: "com.acme.App" } });
    expect(await configSource(app)).toEqual({ path: `${ROOT}/api/src/main/java/com/acme/App.java`, line: 3 });
  });

  it("opens a Kotlin file class at its main function", async () => {
    files.set(`${ROOT}/src/main/kotlin/demo/Main.kt`, "package demo\n\nfun main() {}\n");
    const app = config({ kind: "application", params: { mainClass: "demo.MainKt" } });
    expect(await configSource(app)).toEqual({ path: `${ROOT}/src/main/kotlin/demo/Main.kt`, line: 2 });
  });

  it("opens the script of an npm configuration in package.json", async () => {
    files.set(`${ROOT}/web/package.json`, '{\n  "scripts": {\n    "build": "vite build",\n    "dev": "vite"\n  }\n}\n');
    const dev = config({ kind: "npm", params: { packageDir: "web", command: "run", script: "dev" } });
    expect(await configSource(dev)).toEqual({ path: `${ROOT}/web/package.json`, line: 3 });
  });

  it("opens scripts and build files relative to the working directory", async () => {
    files.set(`${ROOT}/tools/run.py`, "print(1)\n");
    files.set(`${ROOT}/svc/pom.xml`, "<project/>\n");
    files.set(`${ROOT}/build.gradle.kts`, "plugins {}\n");
    expect(await configSource(config({ kind: "python", params: { mode: "script", script: "tools/run.py" } }))).toEqual({
      path: `${ROOT}/tools/run.py`,
      line: 0,
    });
    expect(await configSource(config({ kind: "maven", params: { projectDir: "svc" } }))).toEqual({
      path: `${ROOT}/svc/pom.xml`,
      line: 0,
    });
    expect(await configSource(config({ kind: "gradle", params: { projectDir: "" } }))).toEqual({
      path: `${ROOT}/build.gradle.kts`,
      line: 0,
    });
  });

  it("has nothing for configurations without a file, or whose file is gone", async () => {
    expect(hasSource(config({ kind: "jar-application" }))).toBe(false);
    expect(hasSource(config({ kind: "compound" }))).toBe(false);
    expect(await configSource(config({ kind: "shell", params: { mode: "script", script: "echo hi" } }))).toBeNull();
    expect(await configSource(config({ kind: "application", params: { mainClass: "com.acme.Gone" } }))).toBeNull();
  });
});
