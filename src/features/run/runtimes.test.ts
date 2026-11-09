import { beforeEach, expect, it, vi } from "vitest";

const { entries, pythonNear } = vi.hoisted(() => ({
  entries: new Map<string, string[]>(),
  pythonNear: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: (promise: Promise<unknown>) => promise,
  commands: {
    fsReadDir: async (dir: string) => (entries.get(dir) ?? []).map((name) => ({ name })),
    sdkPythonEffective: pythonNear,
    sdkLocateTools: async () => ({ compileDir: "/tmp/run", tools: [] }),
  },
}));
import { useProject } from "@/platform/project";
import { clearRuntimeCache, rootMarkers, toolEnv } from "./runtimes";

beforeEach(() => {
  useProject.setState({ settings: null });
  entries.clear();
  pythonNear.mockReset().mockResolvedValue("/env/python");
  clearRuntimeCache();
});

it("a nested runtime wins and a package boundary blocks a parent's runtime", async () => {
  entries.set("/repo", ["deno.json"]);
  entries.set("/repo/apps/node", ["package.json"]);
  entries.set("/repo/apps/bun", ["bun.lock", "package.json"]);
  expect(await rootMarkers("/repo", "/repo/apps/node/src/main.ts")).toEqual({ deno: false, bun: false });
  expect(await rootMarkers("/repo", "/repo/apps/bun/src/main.ts")).toEqual({ deno: false, bun: true });
  expect(await rootMarkers("/repo", "/repo/apps/deno/src/main.ts")).toEqual({ deno: true, bun: false });
});

it("a nested Deno project is discovered under a Node root", async () => {
  entries.set("/repo", ["package.json"]);
  entries.set("/repo/apps/deno", ["deno.jsonc"]);
  expect(await rootMarkers("/repo", "/repo/apps/deno/main.ts")).toEqual({ deno: true, bun: false });
});

it("the production Python runtime query includes the source directory", async () => {
  const env = await toolEnv(["python3"], "/repo/apps/python/src/main.py", "/repo", true);
  expect(pythonNear).toHaveBeenCalledWith("/repo/apps/python/src");
  expect(env.python).toBe("/env/python");
});

it("target PHP and Node runs do not require locally installed interpreters", async () => {
  useProject.setState({
    settings: { languages: { php: { runTarget: "plugin-target:php" }, node: { runTarget: "plugin-target:node" } } },
  });
  const env = await toolEnv(["php", "node", "npx", "tsx"], "/repo/main.php", "/repo", false, true);
  expect(env.php).toBe("php");
  expect(env.tool("node")).toBeUndefined();
  expect(env.tool("npx")).toBeUndefined();
  expect(env.tool("tsx")).toBeUndefined();
});
