import { afterEach, describe, expect, it, vi } from "vitest";
import type { JavaLaunchInfo, RunConfig } from "@/platform/ipc";
import { resolveJavaCommand } from "@/platform/javaLaunch";

const ipc = vi.hoisted(() => ({
  javaResolveLaunch: vi.fn(),
  javaDebugServer: vi.fn(async () => ({ status: "ok", data: 5005 })),
  fsReadDir: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));

import { javaLaunchConfig } from "../java";

const config: RunConfig = {
  id: "main",
  name: "Main",
  kind: "application",
  command: "java",
  args: ["-cp", "${classpath}", "Main"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
};

afterEach(() => vi.restoreAllMocks());

const hosts = [
  { client: "Win32", host: "Linux", separator: ":", paths: ["/p/classes", "/lib/a;b.jar"] },
  { client: "MacIntel", host: "Windows", separator: ";", paths: ["C:\\p\\classes", "D:\\lib\\a.jar"] },
  { client: "MacIntel", host: "Mac", separator: ":", paths: ["/p/classes", "/lib/a.jar"] },
  { client: "Win32", host: "Windows", separator: ";", paths: ["C:\\p\\classes", "D:\\lib\\a.jar"] },
  { client: "Linux x86_64", host: "Linux", separator: ":", paths: ["/p/classes", "/lib/a.jar"] },
];

describe.each(hosts)("Java launch on $host from $client", ({ client, separator, paths }) => {
  const info: JavaLaunchInfo = {
    build: "succeeded",
    projectRoot: null,
    classPaths: paths,
    modulePaths: paths,
    pathListSeparator: separator,
    javaHome: null,
    javaExec: "java",
    shortenCommandLine: null,
    errors: [],
    errorCount: 0,
    hints: [],
  };

  it.each(["${classpath}", "${testClasspath}"])("joins %s and module paths using the host separator", (placeholder) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(client);
    const result = resolveJavaCommand({ ...config, args: ["-cp", placeholder, "Main"] }, info);
    expect(result.args).toEqual(["--module-path", paths.join(separator), "-cp", paths.join(separator), "Main"]);
  });

  it.each(["java-debug", "kotlin-debug-adapter"])(
    "splits explicit classpaths for %s without damaging paths",
    async (adapter) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(client);
      ipc.javaResolveLaunch.mockResolvedValue({ status: "ok", data: info });
      const result = await javaLaunchConfig(
        { ...config, debugAdapter: adapter, args: ["-cp", paths.join(separator), "Main"] },
        "/p",
      );
      expect(JSON.parse(result.extraJson!).classPaths).toEqual(paths);
    },
  );
});
